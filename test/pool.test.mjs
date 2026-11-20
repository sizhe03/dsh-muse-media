// Tests for the decisions that spend real allowance.
//
// `lib/pool.js` holds the pure decision layer: eligibility, ranking, cooldown handling, reset-date
// parsing and failure classification. None of it needs a browser, and every function here decides
// whether a generation runs, on which account, or whether a task stops.
//
// Every assertion below is written against the module's actual contract — shapes and field names were
// read from the source, not assumed. Three of them corrected earlier guesses:
//
//   - `isReadingStale(quota, now)` takes a **Date**, not a timestamp.
//   - `maySwitchAccount` requires a failure whose `accountAttributable` is set; classifying by `kind`
//     alone is not what it reads.
//   - `looksLikeQuotaText` recognises *exhaustion* wording, not the steady-state panel text.
import { test } from "node:test";
import assert from "node:assert/strict";

import { ACCOUNT_STATUS } from "../lib/store.js";
import {
  FAILURE,
  MuseFailure,
  asFailure,
  eligibility,
  resetOrdinal,
  isReadingStale,
  rankAccounts,
  cooldownPatch,
  clearCooldown,
  accountAttemptLimit,
  maySwitchAccount,
  parseRetryInstant,
  looksLikeQuotaText,
  looksLikeRateLimit,
  looksLikeSignInWall,
} from "../lib/pool.js";

const NOW = new Date("2026-11-20T12:00:00+08:00");
const NOW_MS = NOW.getTime();

/** A usable account with sensible defaults. */
const account = (over = {}) => ({
  id: "acc-01",
  label: "acc-01",
  status: ACCOUNT_STATUS.READY,
  quota: { usedPct: 10, reset: "11月22日", at: NOW_MS - 60_000 },
  ...over,
});

/**
 * A failure built the way the module builds them.
 *
 * `switchPermitted` is a getter derived from `kind`, so it cannot be assigned — earlier versions of
 * these tests set a field that no longer decides anything.
 */
const failure = (kind) => new MuseFailure("x", { kind, code: kind });

/* ============================================================
 * reset dates — this decides which account runs, so a wrong parse reorders everything
 * ========================================================== */

test("reset dates parse from every format the panel and locale produce", () => {
  for (const raw of ["11月22日", "Nov 22", "11/22", "2026-11-22"]) {
    const parsed = resetOrdinal(raw, NOW);
    assert.equal(typeof parsed, "number", `"${raw}" should parse to an instant`);
    const date = new Date(parsed);
    assert.equal(date.getMonth(), 10, `"${raw}" should be November`);
    assert.equal(date.getDate(), 22, `"${raw}" should be the 22nd`);
  }
});

test("a reset date already past rolls to next year", () => {
  // On 2026-11-20, "11月2日" can only mean 2027: this year's reset already happened.
  const parsed = resetOrdinal("11月2日", NOW);
  assert.equal(typeof parsed, "number");
  assert.equal(new Date(parsed).getFullYear(), 2027, "a past reset must roll forward");
});

test("an impossible date is rejected rather than silently corrected", () => {
  assert.equal(resetOrdinal("2月31日", NOW), undefined);
});

test("an unparseable reset yields nothing instead of guessing", () => {
  for (const raw of ["", "下周", "soon", "???", undefined, null]) {
    assert.equal(resetOrdinal(raw, NOW), undefined, `"${raw}" must not produce a date`);
  }
});

/* ============================================================
 * staleness — a reading taken before its reset is worthless
 * ========================================================== */

test("a reading taken before its own reset instant is stale", () => {
  // Read on the 21st, reset printed as the 22nd: still valid at NOW.
  const fresh = { usedPct: 30, reset: "11月22日", at: new Date("2026-11-21T10:00:00+08:00").getTime() };
  assert.equal(isReadingStale(fresh, NOW), false);

  /**
   * A reading whose printed reset day fell *before* its own read time can only name next year,
   * because a reset that already passed cannot lie in the future. So the figure is not stale —
   * it describes an allowance that has just been renewed, and `resetOrdinal` rolls it forward.
   *
   * Staleness therefore needs a reading that is old in absolute terms while still naming a reset
   * ahead of the moment it was taken: read long ago, reset printed after that read, and that reset
   * has since passed. This is the case that actually happens — a browser left closed for a week.
   */
  const longAgo = new Date("2026-11-10T10:00:00+08:00").getTime();
  const stale = { usedPct: 90, reset: "11月15日", at: longAgo };
  assert.equal(isReadingStale(stale, NOW), true, "the printed reset has passed since the read");
});

test("a reading with no reset date is not called stale", () => {
  // Without a date there is nothing to compare; reporting stale would trigger a refresh loop.
  assert.equal(isReadingStale({ usedPct: 10, at: NOW_MS }, NOW), false);
  assert.equal(isReadingStale(undefined, NOW), false);
  assert.equal(isReadingStale({ usedPct: 10, at: 0 }, NOW), false);
});

/* ============================================================
 * eligibility — the gate that decides whether a send is allowed
 * ========================================================== */

test("a ready account with no cooldown is usable and explains itself", () => {
  const verdict = eligibility(account(), NOW_MS);
  assert.equal(verdict.usable, true);
  assert.equal(verdict.needsRecheck, false);
  assert.ok(verdict.label || verdict.message, "a verdict always carries readable text");
});

test("a missing account is refused, not treated as usable", () => {
  const verdict = eligibility(undefined, NOW_MS);
  assert.equal(verdict.usable, false);
  assert.equal(verdict.maySwitch, false, "no account is not a reason to borrow another");
});

test("a disabled account is refused", () => {
  const verdict = eligibility(account({ status: ACCOUNT_STATUS.DISABLED }), NOW_MS);
  assert.equal(verdict.usable, false);
});

test("an expired cooldown means re-check, never trust", () => {
  // G5: reaching the reset instant only permits a re-check; the account is not declared recovered.
  const expired = account({
    cooldown: { usableUntil: NOW_MS - 1_000, reason: "rate-limited", setAt: NOW_MS - 61_000 },
  });
  const verdict = eligibility(expired, NOW_MS);

  assert.equal(verdict.needsRecheck, true, "the deadline permits a re-check");
  assert.equal(verdict.usable, false, "but a re-check must happen before any send");
});

test("only a dead sign-in may switch accounts", () => {
  // Spending another account's allowance is justified only when the first cannot work at all.
  assert.equal(eligibility(account({ status: ACCOUNT_STATUS.NEEDS_LOGIN })).maySwitch, true);
  assert.equal(eligibility(account({ status: ACCOUNT_STATUS.NEW })).maySwitch, false, "an unmeasured account must not take a task");
  assert.equal(eligibility(account({ status: ACCOUNT_STATUS.DISABLED })).maySwitch, false);
});

/* ============================================================
 * ranking — expiry drives the choice
 * ========================================================== */

test("the account whose allowance expires soonest runs first", () => {
  const result = rankAccounts([
    account({ id: "late", quota: { usedPct: 5, reset: "11月27日", at: NOW_MS - 60_000 } }),
    account({ id: "soon", quota: { usedPct: 80, reset: "11月21日", at: NOW_MS - 60_000 } }),
  ]);

  assert.ok(Array.isArray(result.ordered), "rankAccounts returns { ordered, verdicts }");
  assert.equal(result.ordered[0].id, "soon", "the earlier reset wins even with more used");
  assert.equal(result.verdicts.length, 2, "every account gets a verdict");
});

test("a stale reading is refreshed before anything else", () => {
  const result = rankAccounts([
    account({ id: "fresh", quota: { usedPct: 10, reset: "11月21日", at: NOW_MS - 1_000 } }),
    // Read three days ago, reset printed as two days ago: the number cannot be trusted.
    account({ id: "stale", quota: { usedPct: 10, reset: "11月18日", at: NOW_MS - 86_400_000 * 3 } }),
  ]);
  assert.equal(result.ordered[0].id, "stale", "an out-of-date reading is refreshed first");
});

test("an excluded account is never returned", () => {
  const result = rankAccounts([account({ id: "a" }), account({ id: "b" })], { excluded: new Set(["a"]) });
  assert.deepEqual(
    result.ordered.map((entry) => entry.id),
    ["b"],
  );
});

test("the picked account breaks ties but never overrides an earlier reset", () => {
  const sameDay = "11月22日";
  const tied = rankAccounts(
    [
      account({ id: "other", quota: { usedPct: 50, reset: sameDay, at: NOW_MS - 60_000 } }),
      account({ id: "picked", selected: true, quota: { usedPct: 50, reset: sameDay, at: NOW_MS - 60_000 } }),
    ],
    { preferredId: "picked" },
  );
  assert.equal(tied.ordered[0].id, "picked", "equal conditions put the picked account first");

  const earlier = rankAccounts(
    [
      account({ id: "picked", selected: true, quota: { usedPct: 50, reset: "11月27日", at: NOW_MS - 60_000 } }),
      account({ id: "sooner", quota: { usedPct: 50, reset: "11月21日", at: NOW_MS - 60_000 } }),
    ],
    { preferredId: "picked" },
  );
  assert.equal(earlier.ordered[0].id, "sooner", "an earlier reset outranks the pick");
});

/* ============================================================
 * cooldown recording
 * ========================================================== */

test("a cooldown records the instant it was given", () => {
  const resetAt = NOW_MS + 120_000;
  const patch = cooldownPatch({ reason: "rate-limited", resetAt, at: NOW_MS });

  assert.ok(patch.cooldown, "the patch writes account.cooldown");
  assert.equal(patch.cooldown.usableUntil, resetAt, "the given instant is kept exactly");
  assert.equal(patch.cooldown.reason, "rate-limited");
});

test("clearing a cooldown leaves no deadline behind", () => {
  const cleared = clearCooldown();
  assert.ok(cleared.cooldown === null || cleared.cooldown === undefined, "no usableUntil survives");
});

/* ============================================================
 * switch budget
 * ========================================================== */

test("the attempt limit stays within its ceiling", () => {
  assert.equal(accountAttemptLimit(undefined), 2, "default is two accounts per task");
  assert.equal(accountAttemptLimit(0), 2, "zero is not a valid limit");
  assert.equal(accountAttemptLimit(99), 5, "clamped to the ceiling");
});

test("switching stops at the attempt limit", () => {
  const signedOut = failure(FAILURE.SIGNED_OUT);
  assert.equal(maySwitchAccount(signedOut, ["a"], 2), true);
  assert.equal(maySwitchAccount(signedOut, ["a", "b"], 2), false, "must not exceed the limit");
});

test("only a sign-out permits a switch, even though other failures exclude the account", () => {
  // Excluding an account ends its attempts in this task. Replacing it spends another account's
  // allowance, which only a dead sign-in justifies — a rate limit or exhaustion follows the
  // request, so switching would just move the same limit to someone else.
  const signedOut = failure(FAILURE.SIGNED_OUT);
  const limited = failure(FAILURE.RATE_LIMITED);
  const exhausted = failure(FAILURE.QUOTA_EXHAUSTED);

  assert.equal(signedOut.accountAttributable, true, "all three exclude the account");
  assert.equal(limited.accountAttributable, true);
  assert.equal(exhausted.accountAttributable, true);

  assert.equal(signedOut.switchPermitted, true, "only the sign-out permits a replacement");
  assert.equal(limited.switchPermitted, false);
  assert.equal(exhausted.switchPermitted, false);

  assert.equal(maySwitchAccount(signedOut, [], 2), true);
  assert.equal(maySwitchAccount(limited, [], 2), false, "a rate limit stops the task");
  assert.equal(maySwitchAccount(exhausted, [], 2), false, "an exhausted allowance stops the task");
});

test("a non-failure is never a reason to switch", () => {
  assert.equal(maySwitchAccount(new Error("plain"), [], 2), false);
  assert.equal(maySwitchAccount(undefined, [], 2), false);
});

/* ============================================================
 * failure classification
 * ========================================================== */

test("a sign-in wall is recognised in both languages", () => {
  for (const text of ["请先登录以继续", "请登录", "Sign in to continue", "Sign in to muse.ai"]) {
    assert.equal(looksLikeSignInWall(text), true, `"${text}" proves a dead session`);
  }
  assert.equal(looksLikeSignInWall("生成完成"), false);
});

test("a rate limit is recognised in the wording the panel uses", () => {
  for (const text of ["Too many requests", "rate limit exceeded", "请求过多", "操作过于频繁"]) {
    assert.equal(looksLikeRateLimit(text), true, `"${text}" proves a limit`);
  }
  // Ordinary progress text must not look like a limit.
  assert.equal(looksLikeRateLimit("生成完成"), false);
  assert.equal(looksLikeRateLimit("正在生成，请稍候"), false);
});

test("quota text means exhaustion, not a healthy reading", () => {
  // The panel's steady-state text ("已使用 24%") is not exhaustion and must not classify as one;
  // matching it would turn every read into a false "out of quota" verdict.
  assert.equal(looksLikeQuotaText("已使用 24%"), false);
  assert.equal(looksLikeQuotaText("免费版"), false);

  for (const text of ["本周额度已用完", "额度已耗尽", "You are out of weekly credits", "weekly limit reached"]) {
    assert.equal(looksLikeQuotaText(text), true, `"${text}" is exhaustion`);
  }
});

test("a retry instant is read from the wording the page uses", () => {
  const now = Date.now();

  const seconds = parseRetryInstant("请 30 秒后重试", now);
  assert.ok(seconds !== undefined && seconds > now, "30 seconds resolves to a future instant");

  const minutes = parseRetryInstant("retry in 2 minutes", now);
  assert.ok(minutes !== undefined && minutes > seconds, "two minutes lands later than thirty seconds");

  const hours = parseRetryInstant("1 小时后重试", now);
  assert.ok(hours !== undefined && hours > minutes);
});

test("a bare number is read as seconds", () => {
  const now = Date.now();
  const instant = parseRetryInstant("120", now);
  assert.ok(instant !== undefined && instant > now);
  assert.ok(instant - now <= 125_000, "120 means 120 seconds, not 120 minutes");
});

test("no retry wording yields nothing rather than a default", () => {
  assert.equal(parseRetryInstant("生成完成", Date.now()), undefined);
  assert.equal(parseRetryInstant("", Date.now()), undefined);
});

test("an unknown error becomes a classified failure, never a bare throw", () => {
  const converted = asFailure(new Error("something odd"), { stage: "generate" });
  assert.ok(converted instanceof MuseFailure);
  assert.ok(converted.kind, "every failure carries a kind so the task can decide what to do");
  assert.equal(converted.stage, "generate");
});

test("a failure keeps the code and retry instant a caller branches on", () => {
  const original = new MuseFailure("rate limited", { kind: FAILURE.RATE_LIMITED, code: "RATE_LIMITED", retryAt: 123 });
  const passedThrough = asFailure(original, {});
  assert.equal(passedThrough.code, "RATE_LIMITED");
  assert.equal(passedThrough.retryAt, 123);
});
