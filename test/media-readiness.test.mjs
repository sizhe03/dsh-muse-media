// The gate must reject the placeholder and accept the original.
//
// Real measurements from a live thread: the attachment node first reports 498×498 (30 KB), then 1600×1600 (306 KB). The plugin
// fetched at the first moment. This tests the decision, not the browser: given successive sizes, when may it fetch?
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The rule under test, mirroring waitMedia: a candidate may be fetched only when its size equals the one recorded on the
 * previous poll for that same source.
 */
const createGate = () => {
  const remembered = new Map();
  return (source, size) => {
    const previous = remembered.get(source);
    if (previous === size) return true;
    remembered.set(source, size);
    return false;
  };
};

test("the first sighting of a node is never fetched", () => {
  // This is the bug: 498×498 looked like a result.
  const ready = createGate();
  assert.equal(ready("blob:a", "498×498"), false, "the placeholder must not be taken");
});

test("a stable size is accepted on the next poll", () => {
  const ready = createGate();
  ready("blob:a", "498×498");
  assert.equal(ready("blob:a", "498×498"), true, "an unchanged size is the signal");
});

test("a size that grows is not accepted yet", () => {
  // The real sequence: 498 placeholder, then 1600 original.
  const ready = createGate();
  assert.equal(ready("blob:a", "498×498"), false);
  assert.equal(ready("blob:a", "1600×1600"), false, "the change itself means it is still loading");
  assert.equal(ready("blob:a", "1600×1600"), true, "settled at the original size");
});

test("a genuinely small result is still delivered", () => {
  // The reason this cannot be "wait until it is big": small outputs are legitimate.
  const ready = createGate();
  assert.equal(ready("blob:small", "320×320"), false);
  assert.equal(ready("blob:small", "320×320"), true);
});

test("sizes are tracked per source", () => {
  // Two attachments on one page must not share state, or the second would inherit the first's settled flag.
  const ready = createGate();
  ready("blob:a", "498×498");
  assert.equal(ready("blob:b", "498×498"), false, "a different source starts fresh");
  assert.equal(ready("blob:a", "498×498"), true);
});

/* ---- the wiring ---- */
test("waitMedia records the size and loops instead of fetching", () => {
  const muse = readFileSync("lib/muse.js", "utf8");
  assert.match(muse, /const lastSize = new Map\(\)/, "per-source state");
  assert.match(muse, /if \(remembered !== candidate\.size\)/, "compares against the recorded size");
  assert.match(muse, /lastSize\.set\(candidate\.source, candidate\.size\)/, "records before continuing");
  assert.match(muse, /await delay\(SAMPLE_MS\);\s*\n\s*continue;/, "waits and re-polls rather than fetching");
});

test("the candidate carries the size it was measured at", () => {
  const muse = readFileSync("lib/muse.js", "utf8");
  assert.match(muse, /return \{ \.\.\.candidate, size: `\$\{candidate\.width\}×\$\{candidate\.height\}` \}/);
});

test("natural pixels are read, not the CSS box", () => {
  // The page renders the image at 220px wide; naturalWidth is what tells 498 from 1600.
  const muse = readFileSync("lib/muse.js", "utf8");
  assert.match(muse, /naturalWidth/, "the snapshot must read naturalWidth");
  assert.match(muse, /naturalHeight/);
});
