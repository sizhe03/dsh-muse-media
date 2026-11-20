// Corrected page-side tests.
//
// Two fixture mistakes produced the earlier failures, neither a code defect:
//   1. The data: URL carried no charset, so Chrome decoded the Chinese as Latin-1 and the prompt match
//      could never succeed. Every fixture now sends `<meta charset="utf-8">`.
//   2. A function returning `undefined` arrives as `null` through the CDP bridge, so the assertions must
//      accept that shape rather than treating it as an empty result.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { pageReady, pageSnapshot, pageRoundAttachments, describeReadyState } from "../lib/muse.js";

/* ============================================================
 * describeReadyState — pure
 * ========================================================== */

test("every ready-state value maps to a sentence", () => {
  for (const state of ["ready", "no-composer", "hydrating", "connecting", "input-disabled"]) {
    const text = describeReadyState(state);
    assert.equal(typeof text, "string");
    assert.ok(text.length > 0, `${state} must describe itself`);
  }
});

test("an unknown ready state still produces something readable", () => {
  // The case that matters when Muse adds a state this build has never seen.
  const text = describeReadyState("something-new");
  assert.equal(typeof text, "string");
  assert.ok(text.length > 0);
});

/* ============================================================
 * a real browser through the plugin's own CDP layer
 * ========================================================== */

let browser;
let handle;
let home;

before(async () => {
  const { MuseBrowser, MusePaths } = await import("../lib/browser.js");
  home = mkdtempSync(join(tmpdir(), "muse-page-"));
  browser = new MuseBrowser({
    paths: new MusePaths(home).ensure(),
    getConfig: () => ({ chromePath: "", headlessAfterLogin: true, debugPortBase: 19_970, idleReapSeconds: 0 }),
    log: () => {},
  });
  const opened = await browser.open("page-fns", { visible: false, url: "about:blank" });
  handle = opened.page;
});

after(async () => {
  try {
    await browser?.closeAll("page-fns");
  } catch {
    /* disposable */
  }
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
});

/** Load a fixture with an explicit UTF-8 charset, then run one page-side function. */
async function run(html, fn, ...args) {
  const page = `<!doctype html><html><head><meta charset="utf-8"></head>${html}</html>`;
  await handle.navigate(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  const result = await handle.js(`((${fn.toString()})(...${JSON.stringify(args)}))`);
  // `undefined` crosses the bridge as null.
  return result === null ? undefined : result;
}

/* ---- pageReady ---- */

test("pageReady reports a missing composer", async () => {
  assert.equal(await run("<body><p>nothing</p></body>", pageReady), "no-composer");
});

test("pageReady reports an unhydrated shell", async () => {
  const html = '<body><div data-hatch-shell-hydration-state="pending"></div><textarea></textarea></body>';
  assert.equal(await run(html, pageReady), "hydrating");
});

test("pageReady reports a connecting body", async () => {
  const html =
    '<body><div data-hatch-shell-hydration-state="hydrated"></div><textarea></textarea>Connecting...</body>';
  assert.equal(await run(html, pageReady), "connecting");
});

test("pageReady reports a disabled input", async () => {
  const html =
    '<body><div data-hatch-shell-hydration-state="hydrated"></div><textarea disabled></textarea></body>';
  assert.equal(await run(html, pageReady), "input-disabled");
});

test("pageReady says ready only when everything lines up", async () => {
  const html = '<body><div data-hatch-shell-hydration-state="hydrated"></div><textarea></textarea></body>';
  assert.equal(await run(html, pageReady), "ready");
});

/* ---- pageSnapshot ---- */

test("pageSnapshot separates user bubbles from agent bubbles", async () => {
  const html = [
    "<body><main>",
    '<div class="hatch-chat-groupable-bubble chat-user-bubble">用户说的话</div>',
    '<div class="hatch-chat-groupable-bubble hatch-agent-bubble-bg">助手说的话</div>',
    "</main></body>",
  ].join("");
  const snapshot = await run(html, pageSnapshot);
  assert.equal(snapshot.users.length, 1);
  assert.equal(snapshot.agents.length, 1);
  assert.match(snapshot.users[0].text, /用户/);
  assert.match(snapshot.agents[0].text, /助手/);
});

test("pageSnapshot reports no stop control when idle", async () => {
  const snapshot = await run("<body><main></main></body>", pageSnapshot);
  assert.equal(snapshot.stop, false);
});

test("pageSnapshot sees a visible stop control while generating", async () => {
  const html =
    '<body><main><button data-testid="hatch-composer-stop-button" style="display:block">Stop</button></main></body>';
  const snapshot = await run(html, pageSnapshot);
  assert.equal(snapshot.stop, true);
});

test("pageSnapshot ignores a hidden stop control", async () => {
  // Muse keeps the node mounted and hides it; reading that as "generating" makes the plugin wait for a
  // task that already finished.
  const html =
    '<body><main><button data-testid="hatch-composer-stop-button" style="display:none">Stop</button></main></body>';
  const snapshot = await run(html, pageSnapshot);
  assert.equal(snapshot.stop, false);
});

test("pageSnapshot carries the tail a timeout message quotes", async () => {
  const snapshot = await run("<body><main>生成中</main><div>视频生成在你的地区不可用</div></body>", pageSnapshot);
  assert.match(snapshot.tail, /地区不可用/);
});

/* ---- pageRoundAttachments ---- */

test("an image inside the bubble counts once, not twice", async () => {
  // The container encloses the bubble, so the same node is reachable from both. Counting it twice was a
  // real defect: the attachment check cited evidence that did not exist.
  const html = [
    "<body><main>",
    '<div class="group/msg flex" id="container">',
    '<div class="hatch-chat-groupable-bubble chat-user-bubble">',
    "<span>你：</span><div>生成一张图</div>",
    '<img alt="one.png" width="32" height="32">',
    "</div>",
    '<div class="hatch-chat-groupable-bubble hatch-agent-bubble-bg">好的</div>',
    "</div></main></body>",
  ].join("");

  const evidence = await run(html, pageRoundAttachments, "生成一张图");
  assert.ok(evidence !== undefined, "the round must be found");
  assert.equal(evidence.count, 1, "one nested image must not be counted as two");
});

test("two thumbnails in the container count as two", async () => {
  const html = [
    "<body><main>",
    '<div class="group/msg flex" id="container">',
    '<div class="hatch-chat-groupable-bubble chat-user-bubble"><div>生成一张图</div></div>',
    '<img alt="a.png" width="32" height="32">',
    '<img alt="b.png" width="32" height="32">',
    "</div></main></body>",
  ].join("");

  const evidence = await run(html, pageRoundAttachments, "生成一张图");
  assert.ok(evidence !== undefined);
  assert.equal(evidence.count, 2);
});

test("a message whose text differs from the prompt is not attributed", async () => {
  // Attributing the wrong message would make the plugin claim an upload it never made.
  const html = [
    "<body><main>",
    '<div class="group/msg flex" id="container">',
    '<div class="hatch-chat-groupable-bubble chat-user-bubble">',
    "<div>完全不相关的话</div>",
    '<img alt="x.png" width="32" height="32">',
    "</div></div></main></body>",
  ].join("");

  const evidence = await run(html, pageRoundAttachments, "生成一张图");
  const count = evidence === undefined ? 0 : evidence.count;
  assert.equal(count, 0, "a different message must not be attributed");
});
