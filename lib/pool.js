/**
 * Account selection, cooldown bookkeeping, and the shared-fault rule from G5.
 *
 * The policy in one paragraph: a request remembers the account the user had
 * selected when it was queued, and that account is tried first even if another
 * one has been idle longer. Only a *provable* problem with that account lets a
 * task move on — a verified sign-out, or a verified weekly-quota exhaustion.
 * Everything else (no network, page not ready, browser crashed, an unknown
 * upstream error) ends the attempt and leaves every account's health exactly as
 * it was, because a fault shared by all accounts is not evidence about one.
 *
 * That asymmetry is the whole point of this file: a bug in "which account do I
 * pick" silently spends somebody's quota, while a bug in "should I blame this
 * account" silently disables a healthy one.
 */

import { ACCOUNT_STATUS } from "./store.js";

/** Failure classes, so callers never hand-matching on message text. */
export const FAILURE = {
  /** The authenticated session check said this account is signed out. */
  SIGNED_OUT: "signed-out",
  /** A verified weekly-quota exhaustion for this account. */
  QUOTA_EXHAUSTED: "quota-exhausted",
  /** A rate limit with its own retry hint. */
  RATE_LIMITED: "rate-limited",
  /** A reference upload never became ready. */
  ATTACHMENT_INCOMPLETE: "attachment-incomplete",
  /** Network, page-not-ready, browser crash, or anything unattributable. */
  SHARED: "shared",
  /** The tool's own timeout; the page may still be working. */
  TIMEOUT: "timeout",
  /** Input the plugin itself refused. */
  INVALID: "invalid",
};

/**
 * Failure classes that may exclude one account for the **rest of this task**.
 *
 * Exclusion is not switching. A rate limit or an exhausted allowance does exclude the
 * account — retrying the same one inside the task is pointless — but it must also stop
 * the task rather than route it to a second account, because that would spend another
 * account's allowance to work around a limit that follows the request.
 */
const ACCOUNT_ATTRIBUTABLE = new Set([FAILURE.SIGNED_OUT, FAILURE.QUOTA_EXHAUSTED, FAILURE.RATE_LIMITED]);

/**
 * Failure classes that justify spending a **different** account's allowance.
 *
 * Exactly one: a verified sign-out. The account cannot work at all, and the failure says
 * nothing about the prompt, so another account can carry the same task. A rate limit or an
 * exhausted allowance is a stop condition — the goal is explicit that switching is only
 * permitted for the sign-out case.
 *
 * The two sets were one set before, and that made `maySwitchAccount` return true for a
 * rate limit and for exhaustion. `#runAccountLoop` happened to refuse those earlier, so the
 * behaviour was right — but a function whose answer is only correct because its caller
 * ignores it is one refactor away from spending real quota on someone else's account.
 */
const SWITCH_PERMITTED = new Set([FAILURE.SIGNED_OUT]);

/**
 * A typed failure carrying the stage it came from.
 *
 * The stage matters for reporting: "附件上传未确认" and "页面没有就绪" are the
 * same class (`SHARED`) but different sentences to the user, and A16 requires
 * the send-instant failures to name where they happened.
 */
export class MuseFailure extends Error {
  constructor(
    message,
    {
      code = "MUSE_ERROR",
      kind = FAILURE.SHARED,
      stage = undefined,
      cause,
      diagnosticTail = undefined,
      retryAt = undefined,
    } = {},
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MuseFailure";
    this.code = code;
    this.kind = kind;
    this.stage = stage;
    /** Page text kept for a human, never used to decide an account's fate. */
    this.diagnosticTail = diagnosticTail;
    /**
     * The recovery instant a rate limit named, when it named one.
     *
     * A 429 carries its own retry moment, which is *not* the weekly reset. This
     * travels with the failure so the caller can schedule against it instead of
     * discarding it and later mistaking a healthy weekly panel for a recovery.
     */
    this.retryAt = retryAt;
  }

  get accountAttributable() {
    return ACCOUNT_ATTRIBUTABLE.has(this.kind);
  }

  /**
   * Whether this failure permits trying a different account for the same task.
   *
   * Narrower than `accountAttributable` on purpose: an account can be excluded from further
   * attempts while the task itself must stop. See `SWITCH_PERMITTED`.
   */
  get switchPermitted() {
    return SWITCH_PERMITTED.has(this.kind);
  }
}

/** Turn any thrown value into a `MuseFailure` without losing its class. */
export function asFailure(error, fallback = {}) {
  if (error instanceof MuseFailure) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new MuseFailure(message, { ...fallback, cause: error });
}

/**
 * Whether an account can be used right now, and if not, whether a *different*
 * account may be tried instead.
 *
 * The distinction that matters is `maySwitch`:
 *
 *   - A **verified sign-out** is about this account alone, so another account
 *     may carry the task (G5's first table row, A15).
 *   - A **cooldown** — a weekly-quota exhaustion or a rate limit — is a stop
 *     condition for the *task*, not a reason to shop for another account. The
 *     goal is explicit: "遇到限流或额度耗尽，本次任务停止；自动换号仅适用于
 *     G5 明列的登录失效情形". Treating a cooldown as `signed-out` (which is what
 *     the first version did) submitted the very next request to a second
 *     account and charged it — exactly the behaviour G5 forbids.
 *
 * `needsRecheck` marks a cooldown whose deadline has passed: recovery is proven
 * by a fresh check, never assumed from the clock.
 */
export function eligibility(account, now = Date.now()) {
  if (account === undefined) {
    return { usable: false, reason: "no-account", label: "没有可用账号", needsRecheck: false, maySwitch: false };
  }
  if (account.status === ACCOUNT_STATUS.DISABLED) {
    return { usable: false, reason: "disabled", label: "账号已停用", needsRecheck: false, maySwitch: false };
  }
  if (account.status === ACCOUNT_STATUS.NEEDS_LOGIN) {
    // The one account-attributable, switch-permitted condition (G5, A15).
    return { usable: false, reason: "needs-login", label: "需要重新登录", needsRecheck: false, maySwitch: true };
  }
  if (account.status === ACCOUNT_STATUS.NEW) {
    /**
     * A never-signed-in account does **not** authorise a switch.
     *
     * G5's table permits a second account for exactly one condition: "已认证会话
     * 检查明确返回该账号登录失效". An account that has never been logged in has no
     * authenticated session whose failure could be checked — it is a setup
     * mistake, not a sign-out, and quietly spending a spare account's quota on it
     * hides the mistake from the person who can fix it. The task stops with a
     * login prompt instead.
     */
    return {
      usable: false,
      reason: "not-signed-in",
      label: "尚未登录",
      needsRecheck: false,
      maySwitch: false,
    };
  }
  const cooldown = account.cooldown;
  if (cooldown !== undefined && cooldown.reason !== undefined) {
    if (cooldown.usableUntil !== undefined && cooldown.usableUntil > now) {
      return {
        usable: false,
        reason: "cooling",
        label: `限流/额度冷却中，${new Date(cooldown.usableUntil).toLocaleString()} 后可复核`,
        needsRecheck: false,
        /** A cooldown stops the task; it never redirects it to another account. */
        maySwitch: false,
        cooldown,
      };
    }
    return {
      usable: false,
      reason: "cooling-expired",
      label:
        cooldown.usableUntil === undefined
          ? "限流/额度状态恢复时间未知，需手动复核"
          : "冷却到期，需重新校验",
      needsRecheck: true,
      maySwitch: false,
      cooldown,
    };
  }
  return { usable: true, reason: "ready", label: "可用", needsRecheck: false, maySwitch: false };
}

/**
 * When does an account's weekly allowance next reset, as a sortable number?
 *
 * The panel prints a bare `11月22日` / `Nov 22` — no year, no zone — so this cannot
 * be an instant. What it *can* be is an ordinal: which reset comes first.
 *
 * The year matters even when it is absent. On 20 December, an account resetting
 * `1月2日` resets in thirteen days, and one resetting `12月20日` resets today; a raw
 * month comparison would put January first and burn the wrong allowance. So a
 * month/day that has already passed this year is read as next year.
 *
 * Two honest limits:
 *
 *   - **A reset day is not a countdown.** Only the ordering is trustworthy, never
 *     the distance; nothing here decides "expired" from the clock.
 *   - **An account whose reset day is already behind us is treated as unknown.**
 *     Its stored percentage was measured before that reset, so the number no
 *     longer describes the current period. Unknown sorts last: preferring it
 *     would spend quota that may already have been renewed, while the account we
 *     *can* reason about sits idle until its own deadline.
 *
 * Returns epoch ms of the nominal reset day (midnight UTC, only for ordering), or
 * `undefined` when the text names no usable date.
 */
export function resetOrdinal(raw, now = new Date()) {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim().normalize("NFKC");
  if (text === "") return undefined;

  // A full instant is better than a bare day.
  const exact = parseResetInstant(text, now);
  if (exact !== undefined) return exact;

  /**
   * `11月22日`, `11 月 22 日`, `11/22`, `Nov 22`, `November 22`.
   *
   * Month names are matched case-insensitively against a fixed table rather than
   * `Date.parse`, which would silently invent a year and a zone.
   */
  const MONTHS = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
    may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
    sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
    dec: 12, december: 12,
  };

  let month;
  let day;

  const numeric = /(?:^|[^\d])(\d{1,2})\s*(?:月|-|\/)\s*(\d{1,2})\s*(?:日|\b)/.exec(text);
  if (numeric !== null) {
    month = Number(numeric[1]);
    day = Number(numeric[2]);
  } else {
    const named = /([A-Za-z]{3,9})\.?\s+(\d{1,2})/.exec(text);
    if (named !== null) {
      month = MONTHS[named[1].toLowerCase()];
      day = Number(named[2]);
    }
  }

  if (!Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;

  const year = now.getUTCFullYear();
  const thisYear = Date.UTC(year, month - 1, day);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  // A day already behind us belongs to next year's cycle. A day *today* is still
  // this cycle: the reset has not necessarily run yet, and treating it as next
  // year would bury the most urgent account.
  const at = thisYear < today ? Date.UTC(year + 1, month - 1, day) : thisYear;

  // Guard the day-of-month: `2月31日` must not roll into March.
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined;

  return at;
}

/**
 * Is this reading describing a period that has already ended?
 *
 * The test is "has the reset named in this reading already happened since the
 * reading was taken" — so the reset day is interpreted **relative to the moment
 * it was read** (`quota.at`), then compared with now.
 *
 * Both naive formulations are wrong, and each fails in a way that matters:
 *
 *   - Comparing `quota.at < reset` treats every fresh reading as stale, because a
 *     panel always prints the *next* reset, so the reading is always before it.
 *   - Comparing `reset < now` is meaningless here, because `resetOrdinal` pushes a
 *     past-looking day into next year to keep ordering sane — it would report
 *     `11月1日` on `11月20日` as next year and call a dead reading fresh.
 *
 * Anchoring on the reading moment gets both right: a reading taken 11月20日 that
 * names 11月22日 has its reset in the future and is current; a reading taken
 * 11月1日 that named 11月1日 describes a period that has since ended.
 *
 * A reading taken on the very day it names is treated as stale. That errs toward
 * re-measuring, which costs one refresh and cannot waste an expiry — the opposite
 * error hides a whole cycle of unused quota.
 *
 * Returns `false` when there is not enough information: an account that was never
 * read is handled by "no reading sorts last", and calling it stale would conflate
 * "unmeasured" with "expired".
 */
export function isReadingStale(quota, now = new Date()) {
  if (quota === undefined || quota === null) return false;
  const at = quota.at;
  if (typeof at !== "number" || at <= 0) return false;
  // Interpret the printed reset day as of when it was printed.
  const reset = resetOrdinal(quota.reset, new Date(at));
  if (reset === undefined) return false;
  return reset <= now.getTime();
}

/**
 * Candidate order for one task.
 *
 * **Ordered by "which allowance expires first"**, with one exception that stops
 * a trap: an account whose reading may already be stale is put **first**, so the
 * run refreshes it.
 *
 * The weekly allowance is lost at its reset whether or not it was spent, and the
 * extra allowance never expires — so the quota closest to being thrown away is
 * the one most worth spending.
 *
 * ### The starvation trap
 *
 * A reading can only be refreshed while that account's browser is running, and a
 * browser only runs when that account is used. So if "an unreliable reading sorts
 * last" were the rule, the account would never run, never be re-read, and never
 * stop being unreliable — a permanent starvation. It is worse than it sounds:
 * `resetOrdinal` pushes a date that has already passed into *next year* (correct
 * for ordering), so a stale `11月1日` would sort a full twelve months out and the
 * account would be invisible forever.
 *
 * The asymmetry that fixes it: a stale reading is not a reason to *deprioritise*
 * an account, it is a reason to *re-measure* it. So a stale row goes first — one
 * generation both refreshes the number and spends quota that is otherwise at risk
 * of expiring unseen.
 *
 * ### How staleness is decided
 *
 * From `quota.at` (when the panel was read) and `quota.reset` (the next reset day
 * those numbers belong to). If the reading was taken on or after the reset day
 * the account currently claims, the numbers describe the current period and are
 * trustworthy. If it was taken *before* that day, the panel has since reset at
 * least once and the percentage no longer describes anything — that is stale.
 *
 * No clock-based guessing beyond that: a reading taken after its own reset day is
 * accepted as current, because the reset day printed today is already the *next*
 * one.
 *
 * Ties fall back to the most-spent account (nearer the end of its quota, so one
 * completes rather than two half-used), then the user's pick, then longest idle.
 * Any fixed order would do for a tie — two accounts resetting at the same moment
 * lose the same amount whichever absorbs a request — but it must not wobble.
 */
export function rankAccounts(accounts, { preferredId, excluded = new Set(), now = Date.now() } = {}) {
  const rows = accounts.map((account) => ({
    account,
    state: eligibility(account, now),
    reset: resetOrdinal(account.quota?.reset, new Date(now)),
    /** True when the stored percentage predates the period it claims to describe. */
    stale: isReadingStale(account.quota, new Date(now)),
    /**
     * True when this account has never been measured at all.
     *
     * It also needs to go early, for the same structural reason as a stale one: a
     * reading only appears once the account runs. Being "new" justifies one
     * delay — an established account with a known expiry should take the first
     * task — but not an indefinite one, and `neverMeasuredFirst` supplies the
     * bound. A brand-new account is therefore placed first only after every
     * already-measured account has had its turn since it was added.
     */
    unmeasured: account.quota === undefined || typeof account.quota?.at !== "number",
  }));

  const preferred = rows.find((row) => row.account.id === preferredId);

  /**
   * Has every measured account been used more recently than this one was added?
   *
   * This is the bound on "new accounts go last". Once each known account has run
   * since the new one appeared, the new one can no longer be deferred without
   * starving it: the only way to learn its quota is to run it.
   */
  const neverMeasuredFirst = (row) => {
    if (row.unmeasured !== true) return false;
    const addedAt = row.account.createdAt ?? 0;
    const measured = rows.filter((other) => other.unmeasured !== true && other.state.usable);
    if (measured.length === 0) return true;
    return measured.every((other) => (other.account.lastUsedAt ?? 0) > addedAt);
  };

  const ordered = rows
    .filter((row) => row.state.usable)
    .filter((row) => !excluded.has(row.account.id))
    .sort((a, b) => {
      /**
       * 0a. An account that has never been measured, once every measured account
       *     has run since it was added.
       */
      const aDue = neverMeasuredFirst(a) ? 0 : 1;
      const bDue = neverMeasuredFirst(b) ? 0 : 1;
      if (aDue !== bDue) return aDue - bDue;

      /**
       * 0b. A possibly-stale reading goes FIRST, so this run refreshes it.
       *
       * This is what breaks the starvation loop: a reading can only be refreshed
       * while that account runs, so "stale sorts last" would keep it stale
       * forever. One generation re-measures it and spends quota that would
       * otherwise expire unseen.
       */
      const aStale = a.stale === true ? 0 : 1;
      const bStale = b.stale === true ? 0 : 1;
      if (aStale !== bStale) return aStale - bStale;

      // 1. Soonest reset first. An unknown reset day sorts last.
      const aReset = a.reset ?? Number.POSITIVE_INFINITY;
      const bReset = b.reset ?? Number.POSITIVE_INFINITY;
      if (aReset !== bReset) return aReset - bReset;

      // 2. Same reset: the more-spent account finishes its quota first.
      const aUsed = a.account.quota?.usedPct ?? -1;
      const bUsed = b.account.quota?.usedPct ?? -1;
      if (aUsed !== bUsed) return bUsed - aUsed;

      // 3. Then the user's pick, so a deliberate choice still settles a tie.
      const aPicked = a.account.id === preferredId ? 0 : 1;
      const bPicked = b.account.id === preferredId ? 0 : 1;
      if (aPicked !== bPicked) return aPicked - bPicked;

      // 4. Finally longest idle, for a stable order across runs.
      const aLast = a.account.lastUsedAt ?? 0;
      const bLast = b.account.lastUsedAt ?? 0;
      if (aLast !== bLast) return aLast - bLast;
      return a.account.createdAt - b.account.createdAt;
    });

  return {
    ordered: ordered.map((row) => row.account),
    /** Every row with its verdict, for the "why can't this run" message. */
    verdicts: rows.map((row) => ({
      id: row.account.id,
      label: row.account.label,
      usable: row.state.usable,
      reason: row.state.reason,
      message: row.state.label,
      needsRecheck: row.state.needsRecheck,
    })),
    preferred:
      preferred === undefined
        ? undefined
        : {
            id: preferred.account.id,
            usable: preferred.state.usable,
            reason: preferred.state.reason,
            message: preferred.state.label,
          },
  };
}

/**
 * The first usable candidate, plus the account that should be blamed when the
 * preferred one is failing in an attributable way.
 */
export function pickFirst(accounts, options = {}) {
  const ranked = rankAccounts(accounts, options);
  return { account: ranked.ordered[0], ranked };
}

/**
 * Record a cooldown.
 *
 * `usableUntil` is only set when a concrete instant is known. The goal is
 * emphatic that a merely-plausible date must stay "unknown" rather than become
 * a wrong timer, so `resetAt` is `undefined` for an unparsed upstream string.
 */
export function cooldownPatch({ reason, resetAt, raw, at = Date.now() }) {
  return {
    cooldown: {
      reason,
      usableUntil: resetAt === undefined ? undefined : resetAt,
      raw: raw === undefined ? undefined : raw,
      setAt: at,
    },
  };
}

/** Clear a cooldown after a successful re-check. */
export function clearCooldown() {
  return { cooldown: null };
}

/**
 * Whether a stopped task is allowed to try one more account.
 *
 * The goal suggests at most two different accounts per task, first one
 * included; the config can lower it but not raise it past what the goal
 * describes, so nothing here silently retries forever.
 */
/**
 * Upper bound on accounts one task may try, if the config says nothing.
 *
 * The original goal suggested two. That ceiling was also **hard-clamped** in two
 * places, so setting `maxAccountsPerTask: 3` silently did nothing — a knob that
 * only accepted two values. It now honours what it is given, up to a sane maximum
 * that stops a misconfiguration from grinding through every account on a shared
 * fault.
 */
export const DEFAULT_MAX_ACCOUNTS_PER_TASK = 2;
export const MAX_ACCOUNTS_PER_TASK_CEILING = 5;

/** Resolve the configured limit to a usable integer. */
export function accountAttemptLimit(maxAccounts) {
  const requested = Number(maxAccounts);
  if (!Number.isFinite(requested) || requested < 1) return DEFAULT_MAX_ACCOUNTS_PER_TASK;
  return Math.max(1, Math.min(Math.floor(requested), MAX_ACCOUNTS_PER_TASK_CEILING));
}

export function maySwitchAccount(failure, attempted, maxAccounts) {
  if (!(failure instanceof MuseFailure)) return false;
  // `switchPermitted`, not `accountAttributable`: excluding an account and replacing it are
  // different decisions, and only a sign-out authorises the second one.
  if (!failure.switchPermitted) return false;
  return attempted.length < accountAttemptLimit(maxAccounts);
}

/**
 * Parse the reset text Muse prints into a concrete instant.
 *
 * Two rules, both from G5's "恢复时间未知" branch:
 *
 * 1. **A bare date is not an instant.** Upstream prints `Sep 30` — no year, no
 *    time of day, no time zone. Turning that into "Sep 30 00:00 UTC" invents
 *    two facts upstream never stated (the local zone and the clock time), and a
 *    wrong deadline is worse than none: the plugin would re-check at a moment
 *    it has no reason to trust. So a date-only string yields `undefined`, and
 *    the caller keeps the raw text with "恢复时间未知".
 * 2. **Only a full instant resolves.** A string that names year, month, day
 *    *and* a time (with an explicit offset) is precise enough to schedule from.
 *    Nothing else is.
 *
 * Anything unparsed returns `undefined`; a parsed-but-impossible date (`Feb 31`)
 * also returns `undefined` rather than rolling into March.
 */
export function parseResetInstant(raw, now = new Date()) {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (text === "") return undefined;

  // Only a string that carries an explicit clock time and offset is an instant.
  // ISO 8601 with a zone designator, e.g. `2026-09-30T00:00:00Z` or
  // `2026-09-30T08:00:00+08:00`.
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})$/i.exec(text);
  if (iso === null) {
    // No offset means no instant this plugin can trust. `now` is accepted so
    // callers share one clock, and so a future upstream format that *does*
    // resolve can be added here without changing the signature.
    void now;
    return undefined;
  }
  const [, year, month, day, hour, minute, second, zone] = iso;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (
    !Number.isInteger(monthNumber) ||
    monthNumber < 1 ||
    monthNumber > 12 ||
    !Number.isInteger(dayNumber) ||
    dayNumber < 1 ||
    dayNumber > 31
  ) {
    return undefined;
  }

  /**
   * Reject an impossible calendar date **before** applying the offset.
   *
   * `Feb 31` has to be refused, but the check cannot run on the post-offset UTC
   * value: `2026-11-21T01:00:00+08:00` is the previous day in UTC (the 20th at
   * 17:00), so comparing the offset result's date against the written date
   * rejected every positive offset. That is why `+08:00` parsed as unknown while
   * the same instant written in `Z` parsed fine — one bug wearing two symptoms.
   *
   * A local-time round trip validates the calendar fields without moving them.
   */
  const written = new Date(Date.UTC(2000, monthNumber - 1, dayNumber));
  if (written.getUTCMonth() !== monthNumber - 1 || written.getUTCDate() !== dayNumber) {
    return undefined;
  }

  let offsetMinutes = 0;
  if (zone.toUpperCase() !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2, 4));
    if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours > 23 || minutes > 59) {
      return undefined;
    }
    offsetMinutes = sign * (hours * 60 + minutes);
  }
  const utc = Date.UTC(
    Number(year),
    monthNumber - 1,
    dayNumber,
    Number(hour),
    Number(minute),
    Number(second ?? "0"),
  ) - offsetMinutes * 60_000;
  const candidate = new Date(utc);
  if (Number.isNaN(candidate.getTime())) return undefined;
  return utc;
}

/**
 * Detect a weekly-quota message in one piece of page text.
 *
 * Attribution is the caller's job: this only recognises the vocabulary. The
 * goal forbids cooling an account because a *history message* or the *user's
 * own prompt* mentions quota words, so callers must pass text that came from
 * this round's assistant output.
 */
const QUOTA_PATTERNS = [
  /(?:weekly|this week'?s)\s+(?:limit|quota|credits?)[^\n]{0,80}(?:reached|used up|exhausted|exceeded)/i,
  /(?:reached|hit|exceeded)[^\n]{0,40}(?:your\s+)?(?:weekly|plan'?s?)\s+(?:limit|quota)/i,
  /(?:out of|no more)\s+(?:weekly\s+)?(?:credits?|quota|generations?)/i,
  /(?:本周|每週|每周)[^\n]{0,20}(?:額度|额度|限額|限额)[^\n]{0,20}(?:已用完|用盡|用尽|耗盡|耗尽|超過|超过)/,
  /(?:額度|额度|限額|限额)[^\n]{0,20}(?:已用完|用盡|用尽|耗盡|耗尽)/,
  /(?:rate limit|too many requests|429)/i,
];

export function looksLikeQuotaText(text) {
  if (typeof text !== "string" || text === "") return false;
  return QUOTA_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Whether assistant text says the *content* was refused.
 *
 * Muse declines prompts that read as sexual, violent or otherwise disallowed. It says so in prose, so
 * the only reliable signal is the wording — and the wording is not documented, which is why this is
 * broad and returns the sentence rather than a boolean. Advice differs from a region block: rephrasing
 * can succeed, so the user must not be told to give up.
 */
export function looksLikeContentRefusal(text) {
  if (typeof text !== "string" || text === "") return undefined;
  const patterns = [
    /(?:content|usage|community)\s+polic(?:y|ies)/i,
    /(?:can(?:no|')t|cannot|unable to|not able to|won't)\s+(?:help|assist|create|generate|make)/i,
    /(?:violat|against)\w*\s+(?:our|the)\s+(?:polic|guideline|term)/i,
    /(?:inappropriate|explicit|sexual|adult|nsfw|violent|graphic|harmful)\s+(?:content|material|imagery|request)/i,
    /(?:shows?|depicts?)\s+(?:nudity|sexual|violence)/i,
    /不(?:能|可以|会)(?:帮|为你|协助)?(?:生成|创作|制作|完成)/,
    /(?:违反|不符合|触及)\S{0,6}(?:政策|规定|准则|规范)/,
    /(?:色情|性暗示|露骨|成人内容|暴力|血腥|不当内容|敏感内容)/,
  ];
  for (const pattern of patterns) {
    const found = pattern.exec(text);
    if (found !== null) {
      // Return the sentence around the match, so the error can quote what the page said.
      const start = Math.max(0, text.lastIndexOf(".", found.index) + 1);
      const end = text.indexOf(".", found.index + found[0].length);
      return text.slice(start, end === -1 ? undefined : end + 1).trim().slice(0, 240);
    }
  }
  return undefined;
}

/**
 * Whether assistant text says this account's region has no video generation.
 *
 * Bound to the **account**, not to the request or the network. Measured over two months with seven
 * accounts: six stable, one flagged at registration that still could not generate video two months
 * later while its image generation kept working. So:
 *
 *   - another attempt will not help;
 *   - changing IP will not help;
 *   - rephrasing will not help;
 *   - images on the same account are unaffected.
 *
 * Muse answers 403 for an unsupported region, which is why the status code is matched as text here:
 * the plugin drives the page and never sees the response itself.
 */
export function looksLikeRegionRefusal(text) {
  if (typeof text !== "string" || text === "") return undefined;
  const patterns = [
    // Wording that names the mismatch directly.
    /(?:not|un)\s*available\s+in\s+your\s+(?:country|region|location|area)/i,
    /(?:country|region|location)\s+(?:is\s+)?not\s+(?:supported|available|eligible)/i,
    /(?:unsupported|restricted)\s+(?:country|region|location)/i,
    /(?:video|videos)\s+(?:generation\s+)?(?:is\s+)?(?:not\s+available|unavailable)/i,
    // Muse answers 403 for an unsupported region, and says so in the reply.
    /\b403\b[^\n]{0,40}(?:region|country|location|地区|国家)/i,
    /(?:region|country|location|地区|国家)[^\n]{0,40}\b403\b/i,
    // Chinese wording observed from the service.
    /(?:国家|地区|所在地|所在地区|区域)\S{0,12}(?:不可用|不支持|无法使用|不能使用|暂未开放|未开放|限制|受限)/,
    /(?:不可用|不支持|无法使用|限制|受限)\S{0,10}(?:国家|地区|所在地区)/,
    /(?:视频(?:生成)?)\S{0,14}(?:不可用|不支持|被限制|受限)/,
  ];
  for (const pattern of patterns) {
    const found = pattern.exec(text);
    if (found !== null) {
      // Return the sentence around the match so the error can quote what the page said.
      const begin = Math.max(0, text.lastIndexOf(".", found.index) + 1);
      const finish = text.indexOf(".", found.index + found[0].length);
      return text.slice(begin, finish === -1 ? undefined : finish + 1).trim().slice(0, 240);
    }
  }
  return undefined;
}

/** Whether the text is specifically a *rate limit* (a separate signal). */
export function looksLikeRateLimit(text) {
  if (typeof text !== "string" || text === "") return false;
  return /rate limit|too many requests|\b429\b|請求過多|请求过多|操作過於頻繁|操作过于频繁/i.test(text);
}

/** Whether page text reads as a sign-in wall rather than a signed-in page. */
export function looksLikeSignInWall(text) {
  if (typeof text !== "string") return false;
  return /\b(log ?in|sign ?in|sign up|create an account|continue with google|use another account)\b|登录|登入|註冊|注册/i.test(
    text,
  );
}

/**
 * Read a retry instant out of an upstream rate-limit message.
 *
 * A 429 is not a weekly quota: it comes with its own recovery moment, and that
 * moment is *shorter and different* from the weekly reset. Dropping it (the
 * earlier behaviour, which stored only the verbatim text) meant the next task
 * re-checked the **weekly** panel, saw a healthy 19%, and resumed — the rate
 * limit was never actually cleared (A17).
 *
 * Accepted spellings, all relative to `now`:
 *
 *   - `Retry-After: 120` (seconds) — the HTTP header, forwarded into the text;
 *   - `retry in 2 minutes`, `请 30 秒后重试`, `2 分钟后重试` — relative phrasings;
 *   - an ISO instant or `retry at <date>`.
 *
 * Returns epoch ms, or `undefined` when the message names no usable moment —
 * in which case the caller keeps the cooldown with an unknown deadline rather
 * than inventing one.
 */
export function parseRetryInstant(text, now = Date.now()) {
  if (typeof text !== "string") return undefined;
  const raw = text.trim();
  if (raw === "") return undefined;

  // A bare number of seconds, as `Retry-After` carries it.
  const bareSeconds = /^\s*(\d{1,6})\s*$/.exec(raw);
  if (bareSeconds !== null) {
    const seconds = Number(bareSeconds[1]);
    if (seconds > 0 && seconds <= 86_400) return now + seconds * 1000;
    return undefined;
  }

  // `Retry-After: 120` / `retry-after=120`
  const header = /retry[-\s]?after\s*[:=]\s*(\d{1,6})/i.exec(raw);
  if (header !== null) {
    const seconds = Number(header[1]);
    if (seconds > 0 && seconds <= 86_400) return now + seconds * 1000;
  }

  // Relative phrasings in seconds, minutes or hours, English and Chinese.
  const relative =
    /(\d{1,5})\s*(seconds?|secs?|s|秒|分钟|分鐘|分|minutes?|mins?|m|小时|小時|hours?|h)\s*(?:后|後|later|from now|retry|再)?/i.exec(
      raw,
    );
  if (relative !== null && /retry|重试|重試|try again|later|后|後/i.test(raw)) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const secondsPer = /^(?:h|hour|小时|小時)/.test(unit)
      ? 3600
      : /^(?:m|分钟|分鐘|分|min)/.test(unit)
        ? 60
        : 1;
    const seconds = amount * secondsPer;
    if (seconds > 0 && seconds <= 86_400) return now + seconds * 1000;
  }

  // An explicit instant: reuse the strict ISO reader.
  const iso = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2}))/i.exec(raw);
  if (iso !== null) {
    const at = parseResetInstant(iso[1], new Date(now));
    if (at !== undefined) return at;
  }

  return undefined;
}
