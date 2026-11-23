// The behaviour that ended this: a page mid-generation does not repaint when generation finishes.
//
// Measured, side by side, every 3 s for 90 s on a live generation:
//   plugin snapshot: 498×498, stop=false, same blob throughout
//   raw DOM read:    498×498, same blob
//   the same thread, loaded fresh: 1600×1600 within 5 s
//
// So Muse mounts a preview and leaves it until the page reloads. Waiting on size, on the Stop control, or on elapsed time all watch
// for a change that never comes. The remedy is to reload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MusePage, imagePixelSize, isIntermediateImage } from "../lib/muse.js";

const webp = (width, height = width) => {
  const buffer = Buffer.alloc(40);
  buffer.write("RIFF", 0, "ascii");
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8 ", 12, "ascii");
  buffer.writeUInt16LE(width, 26);
  buffer.writeUInt16LE(height, 28);
  return buffer;
};

test("four reloads that still return 498px deliver an explicitly labelled preview", async (t) => {
  const page = new MusePage({ closed: false });
  const threadUrl = "https://muse.ai/thread/preview-test";
  const bytes = webp(498);
  const snapshot = { href: threadUrl, users: [{ index: 0 }], agents: [], stop: false, tail: "",
    attachments: [{ testId: "image", inUser: false, userIndex: 0, width: 498, height: 498, image: "blob:one", video: "" }] };
  t.mock.method(page, "snapshot", async () => snapshot);
  t.mock.method(page, "fetchMedia", async () => ({ bytes, mime: "image/webp" }));
  const reload = t.mock.method(page, "openThread", async ({ url }) => assert.equal(url, threadUrl));
  const result = await page.waitMedia({ users: [], agents: [], attachments: [] }, { kind: "image", deadline: Date.now() + 90_000 });
  assert.equal(reload.mock.callCount(), 4);
  assert.equal(result.previewOnly, true);
  assert.equal(result.threadUrl, threadUrl);
  assert.equal(result.bytes, bytes);
});

/* ---- the decision to reload ---- */

test("a preview triggers a reload rather than another wait", () => {
  const muse = readFileSync("lib/muse.js", "utf8");

  assert.match(muse, /await this\.openThread\(\{ url: snapshot\.href/, "reloads the same thread");
  assert.match(muse, /reloads \+= 1/, "counts the attempt");
  assert.match(muse, /reloads < MAX_PREVIEW_RELOADS/, "bounded");
});

test("the reload budget is small and explicit", () => {
  const muse = readFileSync("lib/muse.js", "utf8");
  assert.match(muse, /const MAX_PREVIEW_RELOADS = 4/);
  assert.match(muse, /const PREVIEW_RELOAD_DELAY_MS = 2_500/, "lets the page settle before reading");
});

test("a failed reload does not abort the task", () => {
  // The attempt may fail for reasons unrelated to the image; the loop must continue.
  const muse = readFileSync("lib/muse.js", "utf8");
  const at = muse.indexOf("await this.openThread({ url: snapshot.href");
  const after = muse.slice(at, at + 420);
  assert.match(after, /catch \{/, "the reload is wrapped");
  assert.match(after, /continue;/, "and the loop carries on");
});

test("the stop gate is still present, and still saves fetches", () => {
  const muse = readFileSync("lib/muse.js", "utf8");
  assert.match(muse, /if \(snapshot\.stop === true\)/);
});

/* ---- the size rule, unchanged ---- */

test("498 is never accepted as a finished image", () => {
  assert.equal(isIntermediateImage(webp(498), 498), true);
  assert.equal(isIntermediateImage(webp(1600), 1600), false);
});

test("the reported size comes from the bytes, not from the page", () => {
  // The page said 498 while holding 498; the stored dimensions must describe the file that was written.
  const muse = readFileSync("lib/muse.js", "utf8");
  assert.match(muse, /width: decodedSize\?\.width/);
});

test("an undecodable payload is delivered, not reloaded forever", () => {
  assert.equal(isIntermediateImage(Buffer.from("not an image"), 1600), false);
  assert.equal(imagePixelSize(Buffer.from("not an image")), undefined);
});
