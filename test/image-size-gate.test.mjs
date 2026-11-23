// The rule that matters: an image smaller than any finished Muse render is a preview, and must not be delivered.
//
// Measured behind these cases:
//   - finished Muse images observed: 1600×1600 (643 KB), 1080×1080
//   - preview renders observed: 220 (CSS box) and 498×498 (7–39 KB)
//   - the page's own "generating" signal clears about a second before the finished image appears, which is why neither a stop gate
//     nor a size-stability gate could catch this
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { imagePixelSize, isIntermediateImage } from "../lib/muse.js";

/** Build a minimal WebP header carrying a given size. */
const webp = (width, height = width) => {
  const buffer = Buffer.alloc(40);
  buffer.write("RIFF", 0, "ascii");
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8 ", 12, "ascii");
  buffer.writeUInt16LE(width, 26);
  buffer.writeUInt16LE(height, 28);
  return buffer;
};

/* ---- the decoder ---- */

test("decodes the sizes Muse actually returns", () => {
  assert.deepEqual(imagePixelSize(webp(498)), { width: 498, height: 498 });
  assert.deepEqual(imagePixelSize(webp(1600)), { width: 1600, height: 1600 });
});

test("returns undefined for bytes it cannot read", () => {
  assert.equal(imagePixelSize(Buffer.alloc(0)), undefined);
  assert.equal(imagePixelSize(Buffer.from("not an image at all, definitely not")), undefined);
  assert.equal(imagePixelSize(undefined), undefined);
});

/* ---- the rule ---- */

test("a 498 render is treated as a preview", () => {
  // The case that produced three bad images.
  assert.equal(isIntermediateImage(webp(498), 498), true);
});

test("a finished image is delivered", () => {
  assert.equal(isIntermediateImage(webp(1600), 1600), false);
  assert.equal(isIntermediateImage(webp(1080), 1080), false);
});

test("a small result is rejected at first, and the caller's attempt cap saves it", () => {
  // The floor cannot tell these apart, which is why the loop bounds the rejection instead of relying on the rule alone.
  assert.equal(isIntermediateImage(webp(320), 320), true);
});

test("a page claiming far more than the bytes hold is a preview", () => {
  // Covers a future Muse whose previews exceed the floor: the disagreement itself is the signal.
  assert.equal(isIntermediateImage(webp(700), 1600), true);
});

test("undecodable bytes are not treated as a preview", () => {
  // Otherwise an unrecognised format would retry until the deadline.
  assert.equal(isIntermediateImage(Buffer.from("xxxx"), 1600), false);
});

/* ---- the wiring ---- */

test("the check runs after the fetch, before delivery", () => {
  const muse = readFileSync("lib/muse.js", "utf8");

  assert.match(muse, /isIntermediateImage\(media\.bytes, candidate\.width\)/, "called with the fetched bytes");
  assert.match(muse, /const PREVIEW_GRACE_MS = 20_000/, "the fallback is bounded by time, not by a count");
  assert.match(muse, /Date\.now\(\) < deadline - PREVIEW_GRACE_MS/, "waits while budget remains");
  assert.match(muse, /width: decodedSize\?\.width/, "reports what was stored, not what the page claimed");
});

test("the stop gate stays, because it still avoids most wasted fetches", () => {
  const muse = readFileSync("lib/muse.js", "utf8");
  assert.match(muse, /if \(snapshot\.stop === true\)/);
});
