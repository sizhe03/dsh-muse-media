import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { apply } from "../index.js";
import { MuseBrowser } from "../lib/browser.js";
import { MusePage } from "../lib/muse.js";
import { TaskStore } from "../lib/store.js";

// Exercise the registered tools and the on-disk journal, replacing just the host
// services and browser I/O. Each test owns its data directory and page state.
function fixture(t, config = {}) {
  const home = mkdtempSync(join(tmpdir(), "muse-task-"));
  const root = join(home, "muse-media");
  mkdirSync(root);
  writeFileSync(join(root, "state.json"), JSON.stringify({
    selectedId: "acc-01", accounts: [{ id: "acc-01", label: "Studio", status: "ready" }],
  }));
  const state = { sends: 0, usedPct: 10, reply: "", readings: [] };
  const snapshot = () => ({
    agents: state.sends && state.reply ? [{ text: state.reply }] : [],
    attachments: [], tail: "", users: [],
  });
  const page = (name, fn) => t.mock.method(MusePage.prototype, name, fn);
  t.mock.method(MuseBrowser.prototype, "withPage", async (_account, _options, fn) => fn({ closed: false }));
  t.mock.method(MuseBrowser.prototype, "isRunning", () => true);
  page("snapshot", snapshot);
  page("waitReady", async () => "ready");
  page("checkSession", async () => ({ verdict: "signed-in" }));
  page("clearComposer", async () => {});
  page("setPrompt", async () => ({ length: 4 }));
  page("sendOnce", async () => { state.sends++; return { fired: true }; });
  page("waitDelivery", async () => ({ evidence: "server-confirmed" }));
  page("roundUserAttachments", async () => ({ count: 0 }));
  page("readQuota", async () => {
    state.readings.push(state.usedPct);
    return { usedPct: state.usedPct };
  });
  const registry = new Map();
  const cleanups = [];
  const services = {
    tools: { register(def) { registry.set(def.name, def); } },
    attachments: { imageLimits: { mediaTypes: ["image/png"] }, saveImage: async () => ({ attachmentId: "fixture" }) },
  };
  apply({
    get: (name) => services[name], inject() {},
    effect(fn) { const cleanup = fn(); if (typeof cleanup === "function") cleanups.push(cleanup); },
  }, { homeDir: home, autoRefreshQuotaSeconds: 0, ...config });
  t.after(async () => {
    await nextTurn();
    for (const cleanup of cleanups.reverse()) await cleanup();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    state, root, page,
    draw: (prompt = "test") => registry.get("muse_draw_image").execute({ prompt }),
    video: () => registry.get("muse_draw_video").execute({ prompt: "test" }),
    quota: () => registry.get("muse_quota").execute({}),
    tasks: () => new TaskStore(join(root, "tasks.json")).load().list(),
  };
}

const image = { bytes: Buffer.from("offline result"), mime: "image/png", kind: "image" };

for (const enabled of [false, true]) {
  test(`the full image brief reaches the send boundary with independent generation ${enabled}`, async (t) => {
    const f = fixture(t, { independentGeneration: enabled });
    const brief = "为频道 @audio88 生成头像。4096 × 4096，PNG，sRGB。\n\n烟紫卡带。保留完整方图。";
    let written, expected;
    f.page("setPrompt", async (text) => { written = text; return { length: text.length }; });
    f.page("sendOnce", async (options) => { expected = options?.expectedPrompt; return { fired: true }; });
    f.page("waitMedia", async () => image);
    await f.draw(brief);
    assert.equal(f.tasks()[0].prompt, brief);
    if (enabled) assert.ok(written.startsWith("请独立") && written.endsWith("\n\n" + brief));
    else assert.equal(written, brief);
    assert.equal(expected, written);
  });
}

test("a failed post-delivery read cannot turn a cached percentage into a measured cost", async (t) => {
  const f = fixture(t);
  await f.quota();
  f.page("waitMedia", async () => image);
  f.page("readQuota", async () => { throw new Error("panel unavailable"); });
  await f.draw();
  await nextTurn();
  const [task] = f.tasks();
  assert.equal(task.state, "delivered");
  assert.equal(task.quotaAfter, undefined);
});

for (const intermediateRead of [true, false]) {
  test(`two generations with ${intermediateRead ? "three" : "only two"} weekly readings`, async (t) => {
    const f = fixture(t);
    await f.quota();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    f.page("waitMedia", async () => {
      if (f.state.sends === 1) {
        entered.resolve();
        await release.promise;
        f.state.usedPct = 12;
      } else {
        f.state.usedPct = 15;
      }
      return image;
    });
    const first = f.draw();
    await entered.promise;
    let second;
    if (!intermediateRead) second = f.draw();
    release.resolve();
    const firstResult = await first;
    if (intermediateRead) {
      await nextTurn(); // let the post-delivery panel read observe 12%
      second = f.draw();
    }
    const secondResult = await second;
    await nextTurn();
    assert.deepEqual([...new Set(f.state.readings)], intermediateRead ? [10, 12, 15] : [10, 15]);
    for (const [id, before, after] of [[firstResult.taskId, 10, 12], [secondResult.taskId, 12, 15]]) {
      const task = f.tasks().find((row) => row.id === id);
      assert.equal(task.state, "delivered");
      if (intermediateRead) {
        assert.deepEqual([task.quotaBefore, task.quotaAfter], [before, after]);
      } else {
        assert.equal(task.quotaAfter, undefined, "a shared interval cannot price either task");
      }
    }
  });
}

for (const [code, reply, tool] of [
  ["CONTENT_REFUSED", "This violates our community policies", "draw"],
  ["REGION_UNAVAILABLE", "Video generation is not available in your country", "video"],
]) {
  test(`the tool preserves ${code} after the request was accepted`, async (t) => {
    const f = fixture(t);
    f.state.reply = reply;
    await assert.rejects(f[tool](), { code });
    assert.equal(f.tasks()[0].state, "failed");
    assert.ok(f.tasks()[0].note.includes(reply));
    assert.equal(f.state.sends, 1);
  });
}

test("lost media retrieval after acceptance remains unknown", async (t) => {
  const f = fixture(t);
  f.page("waitMedia", async () => { throw new Error("lost connection"); });
  await assert.rejects(f.draw(), { code: "OUTCOME_UNKNOWN" });
  assert.equal(f.tasks()[0].state, "unknown");
  assert.equal(f.state.sends, 1);
});

test("generated media that cannot be saved retains recovery instructions on reload", async (t) => {
  const f = fixture(t);
  f.page("waitMedia", async () => {
    writeFileSync(join(f.root, "media"), "block media directory creation");
    return image;
  });
  await assert.rejects(f.draw(), { code: "MEDIA_SAVE_FAILED" });
  const [task] = f.tasks();
  assert.equal(task.state, "generated-unsaved");
  assert.match(task.note, /上游已生成.*本地保存失败/);
  assert.match(task.note, /Studio.*Muse 会话/);
  assert.equal(f.state.sends, 1);
});
