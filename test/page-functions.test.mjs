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

import { MusePage, museThreadUrl, pageReady, pageSnapshot, pageRoundAttachments, describeReadyState } from "../lib/muse.js";

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

  try {
    browser = new MuseBrowser({
      paths: new MusePaths(home).ensure(),
      getConfig: () => ({
        chromePath: "",
        headlessAfterLogin: true,
        debugPortBase: 19_970,
        idleReapSeconds: 0,
      }),
      log: () => {},
    });
    const opened = await browser.open("page-fns", { visible: false, url: "about:blank" });
    handle = opened.page;
  } catch (error) {
    /**
     * A browser that will not start means two different things depending on where it happens.
     *
     * Locally, it usually means Chrome is not installed, and blocking a contributor over that is wrong —
     * so the tests skip and say why.
     *
     * In CI it means the Chrome install step or the launch flags broke. Skipping there would let
     * `npm test` exit 0 while the entire page layer went untested, which is the failure mode a test suite
     * exists to prevent. So CI rethrows.
     */
    const reason = error instanceof Error ? error.message : String(error);
    if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
      throw new Error(
        `[page-functions] Chrome failed to start in CI (${reason}).` +
          " The page tests cover the code that breaks when Muse changes its markup; skipping them here" +
          " would report success while nothing was verified.",
      );
    }

    console.warn("\n[page-functions] no Chrome available, skipping the browser-backed tests");
    console.warn(`[page-functions] reason: ${reason}\n`);
    browser = undefined;
    handle = undefined;
  }
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

test("waitMedia waits past a sibling upload preview and delivers the assistant's bytes", async (t) => {
  if (handle === undefined) return t.skip("no Chrome on this machine");
  const baseline = await run("<body><main><textarea></textarea></main></body>", pageSnapshot);
  const [reference, preview, original] = await handle.js(`[1, 8, 64].map(size => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    return canvas.toDataURL('image/png');
  })`);
  const append = async (role, src) => {
    const message = `<div class="group/msg"><div class="hatch-chat-groupable-bubble ${role}">sample</div>` +
      `<div data-testid="hatch-chat-attachment-presentation-image"><img src="${src}"></div></div>`;
    await handle.js(`document.querySelector('main').insertAdjacentHTML('beforeend', ${JSON.stringify(message)});
      [...document.images].at(-1).decode()`);
  };
  await append("chat-user-bubble", reference);
  const page = new MusePage(handle);
  const snapshot = page.snapshot.bind(page);
  let samples = 0;
  t.mock.method(page, "snapshot", async (...args) => {
    samples++;
    if (samples === 2) await append("hatch-agent-bubble-bg", preview);
    if (samples === 3) await handle.js(`document.images[1].src=${JSON.stringify(original)};document.images[1].decode()`);
    return snapshot(...args);
  });
  const media = await page.waitMedia(baseline, { kind: "image", deadline: Date.now() + 5000 });
  assert.deepEqual(media.bytes, Buffer.from(original.split(",")[1], "base64"));
  assert.equal(media.width, 64);
  assert.ok(samples >= 4);
});

test("only saved Muse thread URLs can be reopened", () => {
  assert.equal(museThreadUrl("https://muse.ai/thread/work-1/?view=chat"), "https://muse.ai/thread/work-1");
  for (const url of [undefined, "/thread/id", "https://muse.ai/thread/new", "https://muse.ai/thread/new/",
    "https://other.test/thread/id", "https://user@muse.ai/thread/id", "https://muse.ai/thread/id/path"]) {
    assert.equal(museThreadUrl(url), undefined);
  }
});

test("a reopened conversation ignores delayed prior media and returns only this edit", async (t) => {
  if (!handle) return t.skip("no Chrome on this machine");
  const threadUrl = "https://muse.ai/thread/original";
  const revision = { threadUrl, turn: 1 };
  const html = '<body><main><textarea></textarea><button aria-label="Send">Send</button>' +
    '<div class="hatch-chat-groupable-bubble chat-user-bubble">原图</div>' +
    '<div class="group/msg" id="old"><div class="hatch-chat-groupable-bubble hatch-agent-bubble-bg">好了</div>' +
    '<div data-testid="hatch-chat-attachment-presentation-image"><img></div></div></main></body>';
  await run(html, pageSnapshot);
  const page = new MusePage(handle);
  t.mock.method(page, "openThread", async ({ url }) => assert.equal(url, threadUrl));
  const read = page.snapshot.bind(page);
  t.mock.method(page, "snapshot", async deadline => ({ ...await read(deadline), href: threadUrl }));
  await page.openRevision(revision, ["原图"]);
  const baseline = await page.snapshot();
  // The local fixture has a different origin. The actual button must stay untouched.
  assert.equal((await page.sendOnce({ expectedPrompt: "", revision })).reason, "thread-changed");
  const [old, edited] = await handle.js(`[8, 16].map(size => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    return canvas.toDataURL('image/png');
  })`);
  await handle.js(`document.querySelector('main').insertAdjacentHTML('beforeend',
    '<div class="hatch-chat-groupable-bubble chat-user-bubble">改蓝</div>');
    document.querySelector('#old img').src = ${JSON.stringify(old)}; document.images[0].decode()`);
  let samples = 0;
  t.mock.method(page, "snapshot", async deadline => {
    if (++samples === 4) {
      await handle.js(`document.querySelector('main').insertAdjacentHTML('beforeend',
        '<div class="hatch-chat-groupable-bubble hatch-agent-bubble-bg">已修改</div>' +
        '<div data-testid="hatch-chat-attachment-presentation-image"><img></div>');
        document.images[1].src = ${JSON.stringify(edited)}; document.images[1].decode()`);
    }
    return { ...await read(deadline), href: threadUrl };
  });
  const media = await page.waitMedia(baseline, { kind: "image", deadline: Date.now() + 6000, revision, expectedPrompt: "改蓝" });
  assert.deepEqual(media.bytes, Buffer.from(edited.split(",")[1], "base64"));
  assert.equal(media.threadUrl, threadUrl);
  assert.equal(media.turn, 2);
  await assert.rejects(page.openRevision(revision, ["原图"]), { code: "REVISION_UNAVAILABLE" });
});

test("an undecodable 0×0 image stops at the media deadline", async (t) => {
  const page = new MusePage({ closed: false });
  const baseline = { agents: [], attachments: [], tail: "" };
  let polls = 0;
  t.mock.method(page, "snapshot", async () => {
    if (++polls > 1) throw new Error("polled again after the deadline");
    return { ...baseline, tail: "loading preview", attachments: [
      { image: "blob:pending", video: "", testId: "image", width: 0, height: 0 },
    ] };
  });
  const fetch = t.mock.method(page, "fetchMedia", () => assert.fail("fetched an undecoded image"));
  await assert.rejects(page.waitMedia(baseline, { kind: "image", deadline: Date.now() + 65 }),
    { code: "MEDIA_TIMEOUT", diagnosticTail: "loading preview" });
  assert.equal(fetch.mock.callCount(), 0);
});

test("media send checks the whole composer, including edits of equal length", async (t) => {
  if (!handle) return t.skip("no Chrome on this machine");
  const expectedPrompt = "请独立生成。\r\n\r\n@audio88 烟紫卡带 🎮，4096 × 4096，PNG，sRGB。";
  const page = new MusePage(handle);
  await run('<body><textarea></textarea><button aria-label="Send" onclick="window.sent++">Send</button></body>',
    () => { window.sent = 0; });
  await page.setPrompt(expectedPrompt);
  for (const altered of [expectedPrompt.replace("PNG", "JPG"), expectedPrompt.slice(0, -9)]) {
    await handle.js("document.querySelector('textarea').value = " + JSON.stringify(altered));
    assert.equal((await page.sendOnce({ expectedPrompt })).fired, false);
  }
  assert.equal(await handle.js("window.sent"), 0);
  await page.setPrompt(expectedPrompt);
  assert.equal((await page.sendOnce({ expectedPrompt })).fired, true);
  assert.equal(await handle.js("window.sent"), 1);
  await handle.js("document.querySelector('button').remove();document.querySelector('textarea').value='partial'");
  assert.equal((await page.sendOnce({ expectedPrompt })).fired, false, "a mismatch also prevents Enter");
});

test("pageReady reports a missing composer", async (t) => {
  if (handle === undefined) return t.skip("no Chrome on this machine");
  assert.equal(await run("<body><p>nothing</p></body>", pageReady), "no-composer");
});

test("pageReady reports an unhydrated shell", async (t) => {
  if (handle === undefined) return t.skip("no Chrome on this machine");
  const html = '<body><div data-hatch-shell-hydration-state="pending"></div><textarea></textarea></body>';
  assert.equal(await run(html, pageReady), "hydrating");
});

test("pageReady reports a connecting body", async (t) => {
  if (handle === undefined) return t.skip("no Chrome on this machine");
  // The status line lives outside the transcript; the matcher only looks there now.
  const html =
    '<body><div data-hatch-shell-hydration-state="hydrated"></div><textarea></textarea>' +
    '<div role="status">Connecting...</div></body>';
  assert.equal(await run(html, pageReady), "connecting");
});

test("pageReady is not fooled by the phrase appearing in the transcript", async (t) => {
  if (handle === undefined) return t.skip("no Chrome on this machine");
  // A user quoting the status, or an earlier reply mentioning it, must not pin the account at "connecting"
  // for the rest of the session.
  const html = [
    "<body>",
    '<div data-hatch-shell-hydration-state="hydrated"></div>',
    "<textarea></textarea>",
    '<div class="hatch-chat-groupable-bubble hatch-agent-bubble-bg">页面显示 Connecting... 的时候就是在连</div>',
    "</body>",
  ].join("");
  assert.equal(await run(html, pageReady), "ready", "a transcript mention is not a status notice");
});

test("pageReady reports a disabled input", async (t) => {
  if (handle === undefined) return t.skip("no Chrome on this machine");
  const html =
    '<body><div data-hatch-shell-hydration-state="hydrated"></div><textarea disabled></textarea></body>';
  assert.equal(await run(html, pageReady), "input-disabled");
});

test("pageReady says ready only when everything lines up", async (t) => {
  if (handle === undefined) return t.skip("no Chrome on this machine");
  const html = '<body><div data-hatch-shell-hydration-state="hydrated"></div><textarea></textarea></body>';
  assert.equal(await run(html, pageReady), "ready");
});

/* ---- pageSnapshot ---- */

test("pageSnapshot separates user bubbles from agent bubbles", async (t) => {
  if (handle === undefined) return t.skip("no Chrome on this machine");
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

test("pageSnapshot reports no stop control when idle", async (t) => {
  if (handle === undefined) return t.skip("no Chrome on this machine");
  const snapshot = await run("<body><main></main></body>", pageSnapshot);
  assert.equal(snapshot.stop, false);
});

test("pageSnapshot sees a visible stop control while generating", async (t) => {
  if (handle === undefined) return t.skip("no Chrome on this machine");
  const html =
    '<body><main><button data-testid="hatch-composer-stop-button" style="display:block">Stop</button></main></body>';
  const snapshot = await run(html, pageSnapshot);
  assert.equal(snapshot.stop, true);
});

test("pageSnapshot ignores a hidden stop control", async (t) => {
  if (handle === undefined) return t.skip("no Chrome on this machine");
  // Muse keeps the node mounted and hides it; reading that as "generating" makes the plugin wait for a
  // task that already finished.
  const html =
    '<body><main><button data-testid="hatch-composer-stop-button" style="display:none">Stop</button></main></body>';
  const snapshot = await run(html, pageSnapshot);
  assert.equal(snapshot.stop, false);
});

test("pageSnapshot carries the tail a timeout message quotes", async (t) => {
  if (handle === undefined) return t.skip("no Chrome on this machine");
  const snapshot = await run("<body><main>生成中</main><div>视频生成在你的地区不可用</div></body>", pageSnapshot);
  assert.match(snapshot.tail, /地区不可用/);
});

/* ---- pageRoundAttachments ---- */

test("an image inside the bubble counts once, not twice", async (t) => {
  if (handle === undefined) return t.skip("no Chrome on this machine");
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

test("two thumbnails in the container count as two", async (t) => {
  if (handle === undefined) return t.skip("no Chrome on this machine");
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

test("a message whose text differs from the prompt is not attributed", async (t) => {
  if (handle === undefined) return t.skip("no Chrome on this machine");
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

test("the same prompt sent twice resolves to the most recent round", async (t) => {
  if (handle === undefined) return t.skip("no Chrome on this machine");
  /**
   * This is the behaviour that replaced "exactly one match".
   *
   * Before, a second message with the same text made the lookup return null — so a resend or a retry could
   * never confirm its own upload, and the evidence was silently missing rather than wrong. The fixture gives
   * the two rounds different attachment counts so the assertion can tell which one was read: if it still
   * required a unique match it would return nothing, and if it took the first it would report 1.
   */
  const html = [
    "<body><main>",
    // Earlier round: one image.
    '<div class="group/msg flex" id="first">',
    '<div class="hatch-chat-groupable-bubble chat-user-bubble">',
    "<span>你：</span><div>生成一张图</div>",
    '<img alt="old.png" width="32" height="32">',
    "</div>",
    '<div class="hatch-chat-groupable-bubble hatch-agent-bubble-bg">第一轮</div>',
    "</div>",
    // Later round, same prompt: two images.
    '<div class="group/msg flex" id="second">',
    '<div class="hatch-chat-groupable-bubble chat-user-bubble">',
    "<span>你：</span><div>生成一张图</div>",
    "</div>",
    '<img alt="new-a.png" width="32" height="32">',
    '<img alt="new-b.png" width="32" height="32">',
    "</div>",
    "</main></body>",
  ].join("");

  const evidence = await run(html, pageRoundAttachments, "生成一张图");
  assert.ok(evidence !== undefined, "a repeated prompt must still resolve, not return null");
  assert.equal(evidence.count, 2, "it must read the most recent round, which has two attachments");
});

test("a repeated prompt with no attachment in the newest round reports zero, not the older count", async (t) => {
  if (handle === undefined) return t.skip("no Chrome on this machine");
  // The complement of the test above: taking the last round must not fall back to an earlier one, or a task
  // with no upload would inherit the previous round's attachments as evidence.
  const html = [
    "<body><main>",
    '<div class="group/msg flex" id="first">',
    '<div class="hatch-chat-groupable-bubble chat-user-bubble">',
    "<div>生成一张图</div>",
    '<img alt="old.png" width="32" height="32">',
    "</div></div>",
    '<div class="group/msg flex" id="second">',
    '<div class="hatch-chat-groupable-bubble chat-user-bubble">',
    "<div>生成一张图</div>",
    "</div></div>",
    "</main></body>",
  ].join("");

  const evidence = await run(html, pageRoundAttachments, "生成一张图");
  // Either the newest round is found with zero attachments, or there is nothing to report — never 1.
  const count = evidence === undefined ? 0 : evidence.count;
  assert.equal(count, 0, "the newest round has no attachments, so the older count must not leak in");
});
