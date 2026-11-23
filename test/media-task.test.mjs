import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { apply } from "../index.js";
import { MuseBrowser } from "../lib/browser.js";
import { MusePage } from "../lib/muse.js";
import { TaskStore } from "../lib/store.js";

// Exercise the registered tools and the on-disk journal, replacing just the host
// services and browser I/O. Each test owns its data directory and page state.
function fixture(t, config = {}, accounts = [{ id: "acc-01", label: "Studio", status: "ready" }]) {
  const home = mkdtempSync(join(tmpdir(), "muse-task-"));
  const root = join(home, "muse-media");
  mkdirSync(root);
  writeFileSync(join(root, "state.json"), JSON.stringify({
    selectedId: "acc-01", accounts,
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
  const routes = new Map();
  const settingsEntry = { options: { name: "dsh-muse-media" } };
  const configValues = { homeDir: home, autoRefreshQuotaSeconds: 0, ...config };
  const services = {
    configEditor: { entries: () => [settingsEntry], edit(_entry, cb) { Object.assign(configValues, cb(configValues)); } },
    connection: { requestRejection: () => undefined },
    webServer: { register(def) { routes.set(def.path, def.handler); } },
    tools: { register(def) { registry.set(def.name, def); } },
    attachments: { imageLimits: { mediaTypes: ["image/png"] }, saveImage: async () => ({ attachmentId: "fixture" }) },
  };
  const ctx = {
    get: (name) => services[name], inject(names, bind) { if (names.every(name => services[name])) bind(ctx); },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === "function") cleanups.push(cleanup); },
  };
  apply(ctx, configValues);
  t.after(async () => {
    await nextTurn();
    for (const cleanup of cleanups.reverse()) await cleanup();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    state, root, page, registry,
    async picker(sessionId, action, more = {}) {
      const req = Readable.from([Buffer.from(JSON.stringify({ action, sessionId, ...more }))]);
      Object.assign(req, { method: "POST", headers: { host: "localhost" },
        socket: { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" } });
      let response;
      await routes.get("/plugins/dsh-muse-media/accounts/action")(req, { setHeader() {}, end(data) { response = JSON.parse(data); } });
      return response;
    },
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
    assert.equal(written, brief);
    assert.equal(expected, written);
  });
}

for (const kind of ["image", "video"]) {
  test(kind + " revisions follow the selected work through two edits and leave new work independent", async (t) => {
    const f = fixture(t);
    const tool = f.registry.get("muse_draw_" + kind);
    const opens = [], resets = [], sends = [];
    let thread = 0, turn = 0;
    f.page("openRevision", async (revision, prompts) => {
      opens.push(revision);
      assert.ok(prompts.includes(sends[turn - 1]));
    });
    f.page("clearComposer", async ({ fresh }) => {
      resets.push(fresh);
      if (fresh) { thread++; turn = 0; }
    });
    f.page("sendOnce", async ({ expectedPrompt }) => {
      sends.push(expectedPrompt);
      return { fired: true };
    });
    f.page("waitMedia", async () => ({
      ...image, mime: kind === "video" ? "video/mp4" : image.mime, kind,
      threadUrl: "https://muse.ai/thread/work-" + thread, turn: ++turn,
    }));
    const first = await tool.execute({ prompt: "画一枚卡带" });
    const edit = await tool.execute({ prompt: "背景改蓝", continueFromTaskId: first.taskId });
    const final = await tool.execute({ prompt: "再暗一点", continueFromTaskId: edit.taskId });
    await tool.execute({ prompt: "全新的项目" });
    assert.deepEqual(resets, [true, false, false, true]);
    assert.deepEqual(opens, [1, 2].map(turn => ({ threadUrl: "https://muse.ai/thread/work-1", turn })));
    assert.equal(sends[0], "画一枚卡带");
    assert.deepEqual(sends.slice(1, 3), ["背景改蓝", "再暗一点"]);
    assert.equal(sends[3], "全新的项目");
    const saved = f.tasks().find(row => row.id === final.taskId);
    assert.equal(saved.parentTaskId, edit.taskId);
    assert.equal(saved.threadUrl, opens[0].threadUrl);
    assert.equal(saved.turn, 3);
  });
}

test("a different intervening work does not become the target of an edit", async (t) => {
  const f = fixture(t);
  let threadUrl, serial = 0;
  f.page("clearComposer", async ({ fresh }) => {
    if (fresh) threadUrl = "https://muse.ai/thread/work-" + ++serial;
  });
  f.page("waitMedia", async (_baseline, { revision }) =>
    ({ ...image, threadUrl, turn: (revision?.turn ?? 0) + 1 }));
  const original = await f.draw("卡带");
  await f.draw("海边");
  assert.equal(threadUrl, "https://muse.ai/thread/work-2");
  f.page("openRevision", async revision => { threadUrl = revision.threadUrl; });
  const edit = await f.registry.get("muse_draw_image").execute({ prompt: "卡带改蓝", continueFromTaskId: original.taskId });
  assert.equal(f.tasks().find(row => row.id === edit.taskId).threadUrl, "https://muse.ai/thread/work-1");
});

test("an unknown or legacy task cannot accidentally start a new chat", async (t) => {
  const f = fixture(t);
  f.page("waitMedia", async () => image);
  const legacy = await f.draw();
  for (const id of ["missing", "", legacy.taskId]) {
    await assert.rejects(f.registry.get("muse_draw_image").execute({ prompt: "改蓝", continueFromTaskId: id }),
      { code: "REVISION_UNAVAILABLE" });
  }
  assert.equal(f.tasks().length, 1);
  assert.equal(f.state.sends, 1);
});

test("a revision on a signed-out account never tries the second account", async (t) => {
  const f = fixture(t, {}, ["acc-01", "acc-02"].map(id => ({ id, label: id, status: "ready" })));
  f.page("waitMedia", async () => ({ ...image, threadUrl: "https://muse.ai/thread/test", turn: 1 }));
  const first = await f.draw();
  const accounts = [];
  t.mock.method(MuseBrowser.prototype, "withPage", async (id, _options, fn) => {
    accounts.push(id);
    return fn({ closed: false });
  });
  f.page("waitReady", async () => "signed-out");
  await assert.rejects(f.registry.get("muse_draw_image").execute({ prompt: "改蓝", continueFromTaskId: first.taskId }));
  assert.ok(accounts.length > 0 && accounts.every(id => id === first.account));
  assert.equal(f.state.sends, 1);
});

test("pinned web threads apply to both media tools in just their DSH session", async (t) => {
  const f = fixture(t);
  const url = "https://muse.ai/thread/manual-history";
  const ctx = id => ({ agent: { session: { id } } });
  const opens = [], sends = [];
  f.page("openSelectedThread", async url => { opens.push(url); return 7; });
  f.page("sendOnce", async opts => { sends.push(opts); return { fired: true }; });
  f.page("waitMedia", async (_baseline, { kind, revision }) => ({
    ...image, kind, mime: kind === "video" ? "video/mp4" : image.mime,
    threadUrl: revision?.threadUrl ?? "https://muse.ai/thread/fresh", turn: revision ? 8 : 1,
  }));
  const bad = await f.picker("A", "import-thread", { accountId: "acc-01", url: "https://example.org/thread/id" });
  assert.equal(bad.ok, false);
  const pin = await f.picker("A", "import-thread", { accountId: "acc-01", title: "卡带", url });
  assert.equal(pin.threads[0].title, "卡带");
  assert.equal((await f.picker("B", "list-threads")).selected, null);
  for (const kind of ["image", "video"]) await f.registry.get("muse_draw_" + kind).execute({ prompt: "续改" }, ctx("A"));
  await f.registry.get("muse_draw_image").execute({ prompt: "新任务" }, ctx("B"));
  assert.equal((await f.picker("A", "select-thread", { key: null })).selected, null);
  await f.registry.get("muse_draw_image").execute({ prompt: "新任务" }, ctx("A"));
  assert.deepEqual(opens, [url, url]);
  assert.deepEqual(sends.map(s => s.revision?.turn), [7, 7, undefined, undefined]);
  assert.equal(sends.length, 4);
});

test("preview status survives the tool renderer and task journal", async (t) => {
  const f = fixture(t);
  const url = "https://muse.ai/thread/preview-only";
  f.page("waitMedia", async () => ({ ...image, previewOnly: true, threadUrl: url, turn: 1, width: 498, height: 498 }));
  const tool = f.registry.get("muse_draw_image");
  const result = await tool.execute({ prompt: "茶杯" });
  assert.equal(result.previewOnly, true);
  assert.equal(result.threadUrl, url);
  assert.equal(f.tasks()[0].previewOnly, true);
  assert.equal(result.path, f.tasks()[0].media);
  assert.ok(tool.output.render({}, result)[0].text.includes(result.path));
  assert.match(tool.output.render({}, result)[0].text, /仅取到预览.*\/thread\/preview-only/);
});

test("locating a removed file reports the missing task output without accepting a caller-supplied path", async (t) => {
  const f = fixture(t);
  f.page("waitMedia", async () => image);
  const first = await f.draw();
  rmSync(first.path);
  const missing = await f.picker("A", "reveal-task-file", { taskId: first.taskId, file: f.root });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /移动或清理/);
  assert.equal(missing.snapshot.history[0].filePath, first.path);
  const unknown = await f.picker("A", "reveal-task-file", { taskId: "missing", path: f.root });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /没有已保存/);
});

function simulateMainChat(f) {
  const state = { users: [], agents: [], writes: [], prompt: "", response: "已设置", href: "https://muse.ai/" };
  f.page("openThread", async ({ url }) => { assert.equal(url, "https://muse.ai/"); state.href = url; });
  f.page("snapshot", async () => ({ href: state.href, stop: false,
    users: [...state.users], agents: [...state.agents], composer: { text: "", attachments: 0 } }));
  f.page("setPrompt", async text => { state.prompt = text; return { length: text.length }; });
  f.page("sendOnce", async ({ expectedPrompt, revision }) => {
    assert.equal(expectedPrompt, state.prompt);
    assert.deepEqual(revision, { threadUrl: "https://muse.ai", turn: state.users.length });
    state.writes.push(state.prompt);
    const index = state.users.length * 2;
    state.users.push({ index, text: state.prompt });
    state.agents.push({ index: index + 1, text: state.response });
    if (state.loseReceipt) state.href = "https://muse.ai/thread/unrelated";
    return { fired: true, unconfirmed: state.loseReceipt };
  });
  f.page("roundUserAttachments", async (prompt, latestOnly) =>
    latestOnly && state.users.at(-1)?.text === prompt ? { count: 0 } : undefined);
  return state;
}

test("new login writes one named rule; manual removal retains its own receipt and never re-enrolls", async t => {
  const f = fixture(t);
  const chat = simulateMainChat(f);
  const added = await f.picker("", "add", { label: "fresh" });
  const accountId = added.account.id;
  const action = name => f.picker("", name, { accountId });
  const row = result => result.snapshot.accounts.find(a => a.id === accountId).memoryRule;
  const first = row(await action("verify"));
  assert.equal(first.latest.outcome, "set");
  assert.equal(first.latest.automatic, true);
  assert.equal(first.latest.reply, "已设置");
  assert.ok(chat.writes[0].includes(added.snapshot.memoryRule.text));
  await action("verify");
  assert.equal(chat.writes.length, 1);
  chat.loseReceipt = true;
  const uncertain = row(await action("remove-memory-rule"));
  assert.equal(uncertain.latest.outcome, "unconfirmed");
  assert.equal(uncertain.latest.reply, "");
  assert.deepEqual(uncertain.lastConfirmed, first.latest);
  assert.equal(uncertain.possiblyPresent, true);
  assert.ok(chat.writes[1].includes("DSH-Muse-旁聊独立-v1"));
  assert.ok(chat.writes[1].includes("不要引用、复述或概括规则内容"));
  assert.ok(!chat.writes[1].includes(added.snapshot.memoryRule.text));
  chat.loseReceipt = false;
  chat.agents.at(-1).text = "已移除";
  const reread = row(await action("recheck-memory-rule"));
  assert.equal(reread.latest.outcome, "removed");
  assert.equal(reread.latest.requestId, uncertain.latest.requestId);
  assert.equal(chat.writes.length, 2);
  chat.response = "已移除";
  const removed = row(await action("remove-memory-rule"));
  assert.equal(removed.latest.outcome, "removed");
  assert.equal(removed.possiblyPresent, false);
  await action("verify");
  assert.equal(chat.writes.length, 3);
  chat.response = "已设置";
  assert.equal(row(await action("set-memory-rule")).latest.outcome, "set");
});

test("existing accounts stay manual and old opt-out survives unless the new setting overrides it", async t => {
  const f = fixture(t, { independentGeneration: false });
  const chat = simulateMainChat(f);
  const existing = await f.picker("", "verify", { accountId: "acc-01" });
  assert.equal(existing.snapshot.settings.autoSetMemoryRule, false);
  assert.equal(existing.snapshot.accounts[0].memoryRule, undefined);
  await f.picker("", "add", { label: "fresh" });
  await f.picker("", "verify", { accountId: "fresh" });
  assert.equal(chat.writes.length, 0);
  const saved = await f.picker("", "save-settings", { settings: { autoSetMemoryRule: true } });
  assert.deepEqual(saved.changed, ["autoSetMemoryRule"]);
  assert.equal(saved.snapshot.settings.autoSetMemoryRule, true);
  await f.picker("", "verify", { accountId: "fresh" });
  assert.equal(chat.writes.length, 0);
  chat.response = "无法保存";
  const manual = await f.picker("", "set-memory-rule", { accountId: "acc-01" });
  assert.equal(manual.receipt.outcome, "refused");
  assert.equal(manual.receipt.reply, "无法保存");
});

test("enabling the new switch never applies retroactively to existing accounts", async t => {
  const f = fixture(t, { independentGeneration: false, autoSetMemoryRule: true });
  const chat = simulateMainChat(f);
  const verified = await f.picker("", "verify", { accountId: "acc-01" });
  assert.equal(verified.snapshot.settings.autoSetMemoryRule, true);
  assert.equal(chat.writes.length, 0);
  chat.response = "未找到";
  const removed = await f.picker("", "remove-memory-rule", { accountId: "acc-01" });
  assert.equal(removed.receipt.outcome, "absent");
  f.page("checkSession", async () => ({ verdict: "signed-out" }));
  const blocked = await f.picker("", "set-memory-rule", { accountId: "acc-01" });
  assert.equal(blocked.receipt.outcome, "not-sent");
  assert.equal(blocked.snapshot.accounts[0].memoryRule.lastConfirmed.reply, "未找到");
  assert.equal(chat.writes.length, 1);
});

const sourceBrief = "为频道 @audio88 生成头像。4096 × 4096，PNG，sRGB。\n\n烟紫卡带。保留完整方图。";
const promptSource = { start: "为频道 @audio88", end: "保留完整方图。" };
const human = (text) => ({ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] });
const callContext = (...messages) => ({ agent: { session: { deriveMessages: () => messages } } });

for (const kind of ["image", "video"]) {
  test(`${kind} resolves a user-selected range before entering the composer`, async (t) => {
    const f = fixture(t, { independentGeneration: false });
    const context = callContext(
      human("其他说明。\n" + sourceBrief + "\n不要转发这行。"),
      { ...human(sourceBrief), source: { kind: "plugin" } },
      { ...human(sourceBrief), role: "assistant" },
      human("另外两个模型呢？这次用蓝色。"),
    );
    let outgoing;
    f.page("setPrompt", async (text) => {
      outgoing = text;
      throw new Error("offline stop before submission");
    });
    await assert.rejects(f.registry.get("muse_draw_" + kind).execute({ promptSource, promptAmendment: "这次用蓝色。" }, context));
    assert.equal(outgoing, sourceBrief + "\n\n这次用蓝色。");
    assert.equal(f.state.sends, 0);
  });
}

test("a fragment of the cartridge brief is rejected before image or video submission", async (t) => {
  const f = fixture(t);
  const original = "为 Telegram 频道生成一张动态头像的静态首帧。输出 4096 × 4096，PNG，sRGB。" +
    "完整方图，中央圆形裁切。烟紫色半透明游戏卡带，清楚拍到宽肩、顶端薄边和底部短触点。";
  const args = { promptSource: { start: "生成一张", end: "静态首帧" }, promptAmendment: "保留铜箔纹理。".repeat(12) };
  f.page("setPrompt", async () => assert.fail("fragment reached the composer"));
  for (const kind of ["image", "video"]) {
    await assert.rejects(f.registry.get("muse_draw_" + kind).execute(args, callContext(human(original))),
      { code: "INVALID_ARGS", message: /句子或行/ });
  }
  assert.equal(f.tasks().length, 0);
  assert.equal(f.state.sends, 0);
});

test("the same complete brief survives leading and trailing chat of any length", async (t) => {
  const f = fixture(t, { independentGeneration: false });
  const brief = "为频道 @audio88 生成一张动态头像的静态首帧。输出单张 4096 × 4096 像素、PNG、sRGB。" +
    "烟紫色半透明游戏卡带略微斜放，占画面宽度约三分之二。透过外壳能看到电路板、一颗芯片和铜箔线路。" +
    "冷白光从侧面穿过卡带，在底部触点留下一小片淡紫色反光。背景接近黑色，保留接触阴影。" +
    "无文字、品牌或大面积霓虹光效。请务必保留完整方图。";
  const chat = "另外，这支持批量吗？".repeat(20);
  assert.equal(brief.length, 169);
  assert.equal(chat.length, 200);
  let written;
  f.page("setPrompt", async (text) => {
    written = text;
    throw new Error("offline stop before submission");
  });
  for (const [message, expected, start, end] of [
    [brief + chat, brief, "为频道 @audio88", "完整方图。"],
    [chat + brief, brief, "为频道 @audio88", "完整方图。"],
    [chat + "\r\n" + brief + "\n" + chat, brief, "为频道 @audio88", "完整方图。"],
    [chat + "\n画猫\n" + chat, "画猫", "画", "猫"],
    ["提示词：画\n   🎮。另外一个问题。", "画\n   🎮。", "画", "🎮。"],
  ]) {
    written = undefined;
    await assert.rejects(f.registry.get("muse_draw_image").execute({ promptSource: { start, end } },
      callContext(human(message))));
    assert.equal(written, expected);
  }
  assert.equal(f.state.sends, 0);
});

test("clipping the middle or the end of a sentence fails regardless of coverage", async (t) => {
  const f = fixture(t);
  f.page("setPrompt", async () => assert.fail("clipped source reached composer"));
  for (const [text, start, end] of [
    ["请生成一张很精细的游戏卡带封面。", "生成一张", "卡带封面。"],
    ["请画游戏卡带并保留铜箔纹理。", "请画", "铜箔"],
    ["生成一张动态头像的静态首帧。输出 4096 × 4096，PNG。", "生成一张", "静态首帧"],
    ["Use a 3.5 mm lens. Output PNG.", "5 mm", "PNG."],
  ]) {
    await assert.rejects(f.registry.get("muse_draw_video").execute({ promptSource: { start, end } },
      callContext(human(text))), { code: "INVALID_ARGS" });
  }
  assert.equal(f.tasks().length, 0);
});

test("an invalid or ambiguous source never creates a task", async (t) => {
  const f = fixture(t);
  f.page("setPrompt", async () => assert.fail("invalid source reached the composer"));
  const exec = (args, ...messages) => f.registry.get("muse_draw_image").execute(args, callContext(...messages));
  for (const [args, messages] of [
    [{ promptSource }, [human(sourceBrief), human(sourceBrief)]],
    [{ promptSource }, [human("缺少原文")]],
    [{ promptSource }, [human(sourceBrief + "保留完整方图。")]],
    [{ promptSource }, [human("为频道 @audio88"), human("保留完整方图。")]],
    [{ promptSource }, [{ ...human(sourceBrief), source: { kind: "plugin" } }]],
    [{ promptSource, prompt: "改写版" }, [human(sourceBrief)]],
    [{ prompt: "正文", promptAmendment: "补充" }, [human(sourceBrief)]],
    [{}, [human(sourceBrief)]],
  ]) await assert.rejects(exec(args, ...messages), { code: "INVALID_ARGS" });
  assert.equal(f.tasks().length, 0);
});

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

test("a retrieval timeout after acceptance keeps the account and sends only once", async (t) => {
  const f = fixture(t);
  f.page("waitMedia", async () => {
    throw Object.assign(new Error("等待生成结果超时"), { code: "MEDIA_TIMEOUT" });
  });
  await assert.rejects(f.draw(), { code: "OUTCOME_UNKNOWN" });
  const [task] = f.tasks();
  assert.equal(task.state, "unknown");
  assert.equal(task.accountId, "acc-01");
  assert.match(task.note, /Studio.*请先看该账号的 Muse 会话/);
  assert.equal(f.state.sends, 1);
});

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
