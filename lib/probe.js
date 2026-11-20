/**
 * The conversation reachability probe (G6).
 *
 * One tap in the settings card sends a message containing a freshly minted code
 * and then watches the *right* assistant bubble for the echo. Three things make
 * this harder than "is new text on screen", and each one is a rule here:
 *
 * 1. **Attribution.** A bubble count cannot say which reply belongs to this
 *    round. So the round is anchored on the user bubble whose text equals this
 *    probe's message exactly, and only assistant bubbles strictly after it and
 *    before the next user bubble are read. The anchor is re-located on every
 *    sample: Muse re-renders, and a stale node reference would silently read a
 *    previous reply.
 *
 * 2. **Completion.** Text that stops changing for 180 ms while the Stop control
 *    is hidden is stable; text that stops changing while Stop is still up is
 *    just a paused stream. The baseline is therefore only taken from a sample
 *    where Stop is already hidden, and three consecutive samples must agree.
 *    Anything that perturbs that — new text, Stop appearing, a failed read, a
 *    lost anchor — throws the counter away and starts again.
 *
 * 3. **Verdict.** Exact echo is green, a single echo inside other text is
 *    yellow, and everything else waits for the 60 s deadline. A code that
 *    appears at second 58 but never satisfies the completion rule is a timeout,
 *    not a pass: the deadline outranks the sighting.
 */

import { MuseFailure, FAILURE } from "./pool.js";

/** The words the probe sends, before the code. */
const PROBE_PREFIX = "[连通测试] 请只回复";

/** Sampling cadence, matching the reference implementation's ~60 ms. */
const SAMPLE_MS = 60;

/** How many identical samples after the baseline count as "complete". */
const STABLE_SAMPLES = 3;

/** Unambiguous alphabet: no O/0, I/1, or lookalike pairs, and uppercase only. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * A monotonic millisecond clock.
 *
 * G6 asks for 单调时钟, and the distinction is not pedantry: `Date.now()` follows
 * the wall clock, so an NTP correction or a DST-style adjustment in the middle
 * of a 60-second test can move the deadline by seconds in either direction —
 * either manufacturing a timeout or granting extra time. `performance.now()` is
 * a monotonic counter relative to an arbitrary origin, which is exactly the
 * property the rule exists for. It is available in Node and in a page; the
 * fallback exists only for a runtime that lacks it, and is still better than
 * silently reverting without saying so.
 */
export function monotonicNow() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

/**
 * Mint one short code.
 *
 * Randomness comes from the runtime's CSPRNG. Length is 7 because the goal's
 * example is 7 characters and a shorter code collides with ordinary words
 * inside a longer reply.
 */
export function mintCode(length = 7, random = (size) => crypto.getRandomValues(new Uint8Array(size))) {
  const bytes = random(length);
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
  }
  return `MUSE-${out}`;
}

/** The exact message a probe sends for `code`. */
export function probeMessage(code) {
  return `${PROBE_PREFIX} ${code}`;
}

/**
 * Read the current thread's bubbles with their roles, in DOM order.
 *
 * Shipped into the page as source. Roles come from the class markers the shell
 * uses (`hatch-agent-bubble-bg` for the assistant, `chat-user-bubble` for the
 * user); an unmarked bubble is reported as `other` and never counts as either,
 * because guessing a role is how a probe passes on its own echo.
 *
 * The Stop check is visibility-aware for the same reason the media poll's is:
 * the composer keeps the node mounted and only toggles its display, so a
 * presence check would report "still generating" for the rest of the session
 * and no probe could ever complete.
 */
function pageBubbles() {
  const scope =
    document.querySelector('main,[class*="chat-scroll"],[class*="hatch-chat-scroll"]') || document.body;
  const nodes = scope ? [...scope.querySelectorAll('div[class*="hatch-chat-groupable-bubble"]')] : [];
  const rows = [];
  for (const node of nodes) {
    const className = node.className || "";
    const role = /hatch-agent-bubble-bg/.test(className)
      ? "agent"
      : /chat-user-bubble/.test(className)
        ? "user"
        : "other";
    rows.push({ role, text: (node.innerText || "").trim() });
  }
  const candidates = [
    document.querySelector('[data-testid="hatch-composer-stop-button"]'),
    ...document.querySelectorAll('button[aria-label*="Stop" i],button[aria-label*="停止"]'),
  ].filter(Boolean);
  let stop = false;
  for (const node of candidates) {
    if (node.getClientRects().length === 0) continue;
    const style = getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none") continue;
    if (Number(style.opacity) === 0) continue;
    stop = true;
    break;
  }
  return { rows, stop, path: location.pathname || "", href: location.href || "" };
}

/**
 * Normalise a user bubble's text before comparing it to the sent message.
 *
 * The real shell prefixes a user bubble with a speaker label and a blank line —
 * `你：\n\n[连通测试] 请只回复 MUSE-…` — which an exact `===` comparison never
 * matches. That is not a cosmetic difference: it made every live probe report
 * `stage: locating-round` and time out, with the reply sitting right there in the
 * DOM (found by dumping the thread: the agent bubble contained the exact code).
 *
 * Only decorations are removed: the label, surrounding whitespace, and the
 * newlines a `<div>`-per-paragraph render introduces. The message text itself is
 * compared verbatim, so a reply that merely contains the words still cannot pass
 * for the round.
 */
export function normalizeUserText(text) {
  if (typeof text !== "string") return "";
  return text
    // Leading speaker label, in the languages the shell ships.
    .replace(/^(?:你|您|我|You|you)\s*[:：]\s*/, "")
    // Collapse the newlines a block render inserts, so `a\n\nb` equals `a b`.
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Locate this round inside one snapshot.
 *
 * Returns `undefined` for every ambiguity the goal names: no matching user
 * bubble, more than one match, or a thread that changed under us. `undefined`
 * means "not attributable", which never green-lights a probe.
 *
 * The match is on normalised text (see `normalizeUserText`), and it must be
 * unique: two bubbles carrying the same message make the round ambiguous, and an
 * ambiguous round is not evidence.
 *
 * `expectedPath` is the path observed when the probe started, not a constant.
 * Muse rewrites `/thread/new` to `/thread/<id>` as soon as the first message
 * lands, so a hardcoded `/thread/new` would fail every real probe; comparing
 * against the *starting* path catches a genuine session switch while tolerating
 * that rename, because both spellings belong to the same new-thread flow.
 */
export function anchorRound(snapshot, message, expectedPath) {
  if (snapshot === undefined || !Array.isArray(snapshot.rows)) return undefined;
  if (expectedPath !== undefined && expectedPath !== "" && snapshot.path !== "") {
    if (!sameThreadPath(expectedPath, snapshot.path)) return undefined;
  }
  const wanted = normalizeUserText(message);
  if (wanted === "") return undefined;
  const matches = [];
  for (let index = 0; index < snapshot.rows.length; index += 1) {
    const row = snapshot.rows[index];
    if (row.role !== "user") continue;
    if (normalizeUserText(row.text) === wanted) matches.push(index);
  }
  if (matches.length !== 1) return undefined;
  const anchorIndex = matches[0];
  let nextUserIndex = snapshot.rows.length;
  for (let index = anchorIndex + 1; index < snapshot.rows.length; index += 1) {
    if (snapshot.rows[index].role === "user") {
      nextUserIndex = index;
      break;
    }
  }
  const replies = snapshot.rows
    .slice(anchorIndex + 1, nextUserIndex)
    .filter((row) => row.role === "agent")
    .map((row) => row.text);
  // Several agent bubbles can belong to one round (a placeholder that fills in,
  // a progress bubble plus the answer). The round's text is their concatenation
  // in DOM order, which is what the page shows once the placeholder settles.
  const text = replies.filter((entry) => entry !== "").join("\n").trim();
  return { anchorIndex, nextUserIndex, replies, text, stop: snapshot.stop === true };
}

/**
 * Whether two thread paths belong to the same conversation.
 *
 * Equal paths do. So does the `/thread/new` → `/thread/<id>` rename, because
 * that is Muse assigning the id to the very thread the probe sent into. Two
 * different `/thread/<id>` values are different conversations and are refused.
 */
export function sameThreadPath(left, right) {
  if (left === right) return true;
  const idOf = (path) => {
    if (typeof path !== "string") return undefined;
    const match = /^\/thread\/(.+)$/.exec(path);
    return match === null ? undefined : match[1];
  };
  const leftId = idOf(left);
  const rightId = idOf(right);
  if (leftId === undefined || rightId === undefined) return false;
  return leftId === "new" || rightId === "new";
}

/**
 * Classify one round's text against the code.
 *
 * `exact` beats everything: the assistant replied with the code and nothing
 * else. `partial` is the yellow case — exactly one full occurrence of the code
 * plus other words. `invalid` covers no code and a repeated code, both of which
 * the goal says must never pass.
 */
export function judgeText(text, code) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed === "") return { verdict: "empty", occurrences: 0 };
  if (trimmed === code) return { verdict: "exact", occurrences: 1 };
  // Case-sensitive on purpose: `muse-7k4p9d` did not follow the instruction, and
  // the goal calls that out by name.
  const occurrences = trimmed.split(code).length - 1;
  if (occurrences === 1) return { verdict: "partial", occurrences };
  if (occurrences >= 2) return { verdict: "repeated", occurrences };
  return { verdict: "missing", occurrences: 0 };
}

/**
 * Run one probe.
 *
 * `page` is a `MusePage`. The caller owns the account check and the page, so
 * this module has no dependency on the send-boundary bookkeeping in `index.js`.
 *
 * **The clock.** G6 says "从测试开始用单调时钟计时". So:
 *
 *   - the default clock is monotonic (`performance.now()`, which is a
 *     time-origin-relative counter and cannot jump when the wall clock is
 *     corrected mid-test);
 *   - `startedAt` lets the caller pass the moment *it* began the test, so
 *     account verification and page preparation are charged to the same 60 s
 *     budget rather than being free;
 *   - the deadline comparison is `>=`, so a sample landing exactly on the
 *     deadline reports a timeout. A12's table says "到达截止时优先记超时",
 *     and `<`/`>` at the boundary was an off-by-one against that sentence.
 */
/**
 * Run one probe.
 *
 * `page` is a `MusePage`. The caller owns the account check and the page, so
 * this module has no dependency on the send-boundary bookkeeping in `index.js`.
 *
 * **The clock.** G6 says "从测试开始用单调时钟计时". Two parameters carry that,
 * and mixing them up was a real bug:
 *
 *   - `startedAt` is the moment the **caller began the test**. It is only used to
 *     report the total duration, which must cover the account check and the page
 *     preparation the caller did before calling in.
 *   - `deadlineAt` is the **absolute instant** the test must stop, on the same
 *     clock. It is what actually bounds the wait.
 *
 * The first version accepted `timeoutMs` *plus* `startedAt` and computed
 * `startedAt + timeoutMs`. A caller that passed the original start and the
 * *remaining* budget therefore got a deadline in the past: preparation of 20 s
 * left 40 s, and `startedAt + 40 s` expired at t=40 instead of t=60, so a good
 * reply at t=45 was reported as a timeout. `deadlineAt` removes the ambiguity —
 * there is exactly one way to express the stop moment, and it cannot be
 * double-counted.
 *
 * The default clock is monotonic (`performance.now()`): a wall-clock correction
 * mid-test would otherwise move a 60-second deadline by seconds. The comparison
 * against it is `>=`, so a sample landing exactly on the deadline is a timeout —
 * G6's table says "到达截止时优先记超时".
 */
export async function runProbe({
  page,
  code,
  message = probeMessage(code),
  timeoutMs = 60_000,
  deadlineAt,
  path,
  startedAt,
  now = monotonicNow,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const beganAt = typeof startedAt === "number" ? startedAt : now();
  const deadline =
    typeof deadlineAt === "number" ? deadlineAt : typeof startedAt === "number" ? startedAt + timeoutMs : beganAt + timeoutMs;

  // Capture the starting path before the send: Muse renames `/thread/new` to
  // `/thread/<id>` on the first message, and only the *starting* path can tell
  // a rename apart from a switch into somebody else's conversation.
  let expectedPath = path;
  if (expectedPath === undefined) {
    try {
      const before = await page.call(pageBubbles);
      expectedPath = before?.path;
    } catch {
      expectedPath = undefined;
    }
  }

  // 1. Fill the composer and prove the shell took it.
  await page.setPrompt(message);

  /**
   * 2. Re-check the deadline **after** filling the composer.
   *
   * `setPrompt` is not instant: it focuses the field, writes through the React
   * setter, then waits for the send button to render, which the caller may have
   * spent half a second on. Measured: a composer started at t=59.8 s and took
   * 0.5 s, so the send fired at t=60.3 s — past the 60-second hard cap, after
   * which the probe correctly reported a timeout for a message it had already
   * sent. G6's rule is that the deadline outranks the send, so the check has to
   * sit immediately before the action, not before the preparation.
   */
  if (now() >= deadline) {
    return {
      ok: false,
      note: "填写输入框时已到 60 秒截止，未发送",
      code: "PROBE_INCOMPLETE",
      elapsedMs: Math.round(now() - beganAt),
      detail: { stage: "composer-expired" },
    };
  }

  /**
   * 3. One send action, bounded by the same deadline.
   *
   * `sendOnce` may have to wait for React to enable the button before it can click. That wait
   * lived on its own two-second budget, so a probe arriving at t=59.95s could click at
   * t=60.10s and then report a timeout for a message it had already sent. Passing the deadline
   * through closes the window: the wait stops at the caller's instant.
   *
   * The two clocks differ — this module counts monotonic milliseconds from `beganAt`, while the
   * send layer uses wall-clock — so the remaining budget is translated here rather than
   * comparing numbers from different origins.
   */
  const remainingMs = deadline - now();
  const sent = await page.sendOnce({
    deadlineAt: Date.now() + Math.max(0, remainingMs),
  });
  if (!sent.fired) {
    throw new MuseFailure(`测试消息没有发出去（${sent.reason ?? "unknown"}）。`, {
      code: "PROBE_NOT_SENT",
      kind: FAILURE.SHARED,
      stage: "probe-send",
    });
  }
  const sentAt = now();

  let baseline;
  let lastText = "";
  let lastJudge = { verdict: "empty", occurrences: 0 };
  let sawStop = false;
  let anchored = false;
  let lastFailure;

  for (;;) {
    const finished = now();
    if (finished >= deadline) {
      // The deadline outranks a late sighting: the goal is explicit that a code
      // appearing at second 58 with Stop still up is a timeout, not a pass.
      const note =
        lastJudge.verdict === "missing"
          ? "助手没有回显本次短码"
          : lastJudge.verdict === "repeated"
            ? "助手重复回显本次短码"
            : lastJudge.verdict === "partial" || lastJudge.verdict === "exact"
              ? "助手回复未在截止前完成"
              : "截止前没有取得本轮助手回复";
      return {
        ok: false,
        note,
        code: lastJudge.verdict === "missing" ? "PROBE_NO_ECHO" : lastJudge.verdict === "repeated" ? "PROBE_REPEATED_ECHO" : "PROBE_INCOMPLETE",
        elapsedMs: finished - beganAt,
        sendAction: sent.action,
        detail: {
          stage: anchored ? "waiting-completion" : "locating-round",
          verdict: lastJudge.verdict,
          occurrences: lastJudge.occurrences,
          stopVisible: sawStop,
          baselineTaken: baseline !== undefined,
          lastText: lastText.slice(0, 400),
          lastFailure,
        },
      };
    }

    let snapshot;
    try {
      snapshot = await page.call(pageBubbles);
    } catch (error) {
      // A read failure clears the baseline: the goal lists it as a reset cause.
      baseline = undefined;
      lastFailure = error instanceof Error ? error.message : String(error);
      await sleep(SAMPLE_MS);
      continue;
    }

    const round = anchorRound(snapshot, message, expectedPath);
    if (round === undefined) {
      baseline = undefined;
      anchored = false;
      await sleep(SAMPLE_MS);
      continue;
    }
    anchored = true;
    if (round.stop) sawStop = true;

    const judge = judgeText(round.text, code);
    const changed = round.text !== lastText;
    lastText = round.text;
    lastJudge = judge;

    if (round.stop) {
      // Stop up means generation is still running, even if the text has been
      // frozen for seconds. No baseline can be taken here.
      baseline = undefined;
      await sleep(SAMPLE_MS);
      continue;
    }

    if (round.text === "") {
      baseline = undefined;
      await sleep(SAMPLE_MS);
      continue;
    }

    if (changed || baseline === undefined) {
      // A non-empty body with Stop hidden establishes (or re-establishes) the
      // baseline; the count starts at zero and this sample is not one of the
      // three confirmations.
      baseline = { text: round.text, count: 0 };
      await sleep(SAMPLE_MS);
      continue;
    }

    baseline.count += 1;
    if (baseline.count >= STABLE_SAMPLES) {
      // Completion rule satisfied: judge the baseline text, never `round.text`
      // from a later sample, so a change arriving during the 180 ms cannot slip
      // into the verdict.
      const stableJudge = judgeText(baseline.text, code);
      const elapsedMs = now() - beganAt;
      if (now() >= deadline) {
        // Completion arrived past the deadline; the deadline still wins.
        return {
          ok: false,
          note: "助手回复未在截止前完成",
          code: "PROBE_INCOMPLETE",
          elapsedMs,
          sendAction: sent.action,
          detail: { stage: "completed-after-deadline", verdict: stableJudge.verdict, stopVisible: sawStop },
        };
      }
      if (stableJudge.verdict === "exact") {
        return {
          ok: true,
          note: undefined,
          code: "PROBE_OK",
          elapsedMs,
          sendAction: sent.action,
          formatMismatch: false,
          text: baseline.text,
          detail: { stage: "done", verdict: "exact", stopVisible: sawStop, sendAt: sentAt },
        };
      }
      if (stableJudge.verdict === "partial") {
        return {
          ok: true,
          note: "助手未按约定格式回显",
          code: "PROBE_OK_FORMAT",
          elapsedMs,
          sendAction: sent.action,
          formatMismatch: true,
          text: baseline.text,
          detail: { stage: "done", verdict: "partial", stopVisible: sawStop, sendAt: sentAt },
        };
      }
      // A completed reply with no code (or a doubled code) is not a pass and not
      // yet a timeout: keep waiting, because the round may be re-rendered with
      // more text. The counter is cleared so a new completion is required.
      baseline = undefined;
      await sleep(SAMPLE_MS);
      continue;
    }

    await sleep(SAMPLE_MS);
  }
}

export { pageBubbles };
