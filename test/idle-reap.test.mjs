// The defect this guards against: an operation longer than idleReapSeconds had its browser closed mid-flight.
//
// Timeline from two real failures: tasks died at 628 s and 629 s with "the browser closed while waiting for the result". idleReapSeconds is
// 600 and the reaper ticks every 30 s, so both fall inside the one window that produces. lastUsedAt was only refreshed in `finally`, meaning
// a ten-minute generation never refreshed it at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* ---- the rule, mirroring withPage ---- */

/**
 * Decide whether a browser would be reaped, given when it was last touched and how long the operation has run.
 *
 * The fix keeps touching during the operation, so the answer must stay "not reaped" for as long as it runs.
 */
const wouldReap = ({ startedAt, now, idleReapSeconds, touchedDuring }) => {
  const lastTouch = touchedDuring.length === 0 ? startedAt : Math.max(startedAt, ...touchedDuring);
  return now - lastTouch >= idleReapSeconds * 1000;
};

test("without periodic touches, a long operation loses its browser", () => {
  // The bug: 628 seconds into a 780-second video budget, with idleReapSeconds at 600.
  assert.equal(wouldReap({ startedAt: 0, now: 628_000, idleReapSeconds: 600, touchedDuring: [] }), true);
});

test("with periodic touches, it does not", () => {
  // Touches every 10 s, so at 628 s the last one is at 620 s.
  const touches = [];
  for (let t = 10_000; t <= 620_000; t += 10_000) touches.push(t);
  assert.equal(wouldReap({ startedAt: 0, now: 628_000, idleReapSeconds: 600, touchedDuring: touches }), false);
});

test("the touch interval is comfortably inside the reaper's tick", () => {
  // A 10 s interval against a 30 s tick means a busy browser is never sampled as idle, even if one touch is late.
  const browser = readFileSync("lib/browser.js", "utf8");
  const interval = Number(/IDLE_TOUCH_INTERVAL_MS = ([\d_]+)/.exec(browser)?.[1].replace(/_/g, ""));
  const tick = Number(/setInterval\(tick, ([\d_]+)\)/.exec(browser)?.[1].replace(/_/g, ""));
  assert.ok(Number.isFinite(interval) && Number.isFinite(tick), "both intervals must be readable");
  assert.ok(interval * 3 <= tick, `touch interval ${interval} must be well under the tick ${tick}`);
});

test("an operation that has finished stops refreshing", () => {
  // The reaper must still close browsers nobody uses: no touches after the operation returns.
  assert.equal(wouldReap({ startedAt: 0, now: 900_000, idleReapSeconds: 600, touchedDuring: [10_000, 20_000] }), true);
});

/* ---- the wiring ---- */

test("withPage refreshes during the operation and clears the timer afterwards", () => {
  const browser = readFileSync("lib/browser.js", "utf8");

  assert.match(browser, /setInterval\(\(\) => \{\s*\n\s*instance\.browser\.touch\(\);/, "starts a keep-alive");
  assert.match(browser, /finally \{\s*\n\s*if \(keepAlive !== undefined\) clearInterval\(keepAlive\);/, "and clears it");
  assert.match(browser, /keepAlive\?\.unref\?\.\(\)/, "does not hold the process open");
});

test("background work stays exempt", () => {
  // A periodic quota read must not keep a browser alive forever; that was the bug the current design fixed.
  const browser = readFileSync("lib/browser.js", "utf8");
  assert.match(browser, /background === true\s*\n\s*\? undefined/, "no keep-alive for background work");
});

test("the media wait really does run inside withPage", () => {
  // If it ever moved out, this fix would silently stop protecting video generation.
  const index = readFileSync("index.js", "utf8");
  const withPageAt = index.indexOf("return this.#browser.withPage(");
  const waitMediaAt = index.indexOf("await page.waitMedia(");
  assert.ok(withPageAt !== -1 && waitMediaAt !== -1, "both must exist");
  assert.ok(withPageAt < waitMediaAt, "waitMedia must be inside the withPage callback");
});
