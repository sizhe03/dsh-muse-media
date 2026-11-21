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
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "muse-task-"));
  const root = join(home, "muse-media");
  mkdirSync(root);
  writeFileSync(join(root, "state.json"), JSON.stringify({
    selectedId: "acc-01", accounts: [{ id: "acc-01", label: "Studio", status: "ready" }],
  }));
  const state = { sends: 0, usedPct: 10, reply: "", panelReads: 0 };
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
  page("readQuota", async () => { state.panelReads++; return { usedPct: state.usedPct }; });
  const registry = new Map();
  const cleanups = [];
  const services = {
    tools: { register(def) { registry.set(def.name, def); } },
    attachments: { imageLimits: { mediaTypes: ["image/png"] }, saveImage: async () => ({ attachmentId: "fixture" }) },
  };
  apply({
    get: (name) => services[name], inject() {},
    effect(fn) { const cleanup = fn(); if (typeof cleanup === "function") cleanups.push(cleanup); },
  }, { homeDir: home, autoRefreshQuotaSeconds: 0 });
  t.after(async () => {
    await nextTurn();
    for (const cleanup of cleanups.reverse()) await cleanup();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    state, root, page,
    draw: () => registry.get("muse_draw_image").execute({ prompt: "test" }),
    video: () => registry.get("muse_draw_video").execute({ prompt: "test" }),
    quota: () => registry.get("muse_quota").execute({}),
    tasks: () => new TaskStore(join(root, "tasks.json")).load().list(),
  };
}

const image = { bytes: Buffer.from("offline result"), mime: "image/png", kind: "image" };

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
