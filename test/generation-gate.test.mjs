// The gate that was missing: a page still generating cannot yield a final image.
//
// Measured evidence behind these cases:
//   - a settled thread holds only 1600×1600 and never shows 498
//   - three consecutive generations returned 498×498
//   - therefore the 498 was captured during generation, when a preview is painted
//   - a preview can hold its size across several 700 ms polls, so stability alone accepted it
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The decision the loop makes each poll, extracted to mirror it exactly.
 *
 * Returns "wait" when the page is still generating, "settle" when the size has changed and must be re-observed, and "fetch"
 * when a candidate's size has held across two polls.
 */
const nextAction = ({ stop, candidate, remembered }) => {
  if (stop === true) return "wait";
  if (candidate === undefined) return "wait";
  if (candidate.size !== remembered) return "settle";
  return "fetch";
};

test("a page that is still generating never yields an image", () => {
  // The case that produced 498 three times: the preview was present and stable, the page was still working.
  assert.equal(nextAction({ stop: true, candidate: { size: "498×498" }, remembered: "498×498" }), "wait");
});

test("a finished page with a stable size is fetched", () => {
  assert.equal(nextAction({ stop: false, candidate: { size: "1600×1600" }, remembered: "1600×1600" }), "fetch");
});

test("a preview that then grows is re-observed, not fetched", () => {
  // Even if stop flickers false, a size change restarts the wait.
  assert.equal(nextAction({ stop: false, candidate: { size: "1600×1600" }, remembered: "498×498" }), "settle");
});

test("the first sighting is never fetched", () => {
  assert.equal(nextAction({ stop: false, candidate: { size: "498×498" }, remembered: undefined }), "settle");
});

test("no candidate means keep polling, not give up", () => {
  assert.equal(nextAction({ stop: false, candidate: undefined, remembered: undefined }), "wait");
});

/* ---- the wiring, checked against the real loop ---- */

test("waitMedia consults the stop signal before choosing a candidate", () => {
  const muse = readFileSync("lib/muse.js", "utf8");
  const stopAt = muse.indexOf("if (snapshot.stop === true)");
  const pickAt = muse.indexOf("const candidate = pickCandidate", stopAt === -1 ? 0 : stopAt - 400);

  assert.notEqual(stopAt, -1, "the stop gate must exist");
  assert.ok(stopAt < pickAt, "it must run before a candidate is chosen");
  assert.match(muse, /if \(snapshot\.stop === true\) \{\s*\n\s*await delay\(SAMPLE_MS\);\s*\n\s*continue;/, "and must wait, not fetch");
});

test("the same signal already governs delivery", () => {
  // If this ever diverges, one of the two waits is reading the page differently from the other.
  const muse = readFileSync("lib/muse.js", "utf8");
  assert.match(muse, /!snapshot\.stop/, "waitDelivery still checks it");
});
