import { test } from "node:test";
import assert from "node:assert/strict";
import { MAIN_CHAT, readRuleReply, ruleOutcome, ruleMessage } from "../lib/memory-rule.js";

test("an intention, a denial containing a success word, and another operation's reply remain unconfirmed", () => {
  for (const text of ["我将删除", "还未移除", "好的，我将删除这条规则。", "已设置"]) {
    assert.equal(ruleOutcome("remove", text), "unconfirmed");
  }
  assert.equal(ruleOutcome("remove", "已移除。"), "removed");
  assert.equal(ruleOutcome("set", "无法保存"), "refused");
});

test("a history repaint that adds an old user and a newer unrelated user cannot hide the named request", async () => {
  const prompt = "save this rule / request 123";
  const snapshot = { href: MAIN_CHAT, stop: false,
    users: [{ index: 0, text: "old" }, { index: 2, id: "mine", text: prompt }, { index: 4, text: "next" }],
    agents: [{ index: 1, text: "旧回复" }, { index: 3, text: "已设置" }, { index: 5, text: "其他回复" }] };
  const result = await readRuleReply({ snapshot: async () => snapshot }, prompt, "set", Date.now() + 2000);
  assert.equal(result.outcome, "set");
  assert.equal(result.reply, "已设置");
  assert.equal(result.messageId, "mine");
});

test("a newer removal prevents a legacy set confirmation from being presented as current", async () => {
  const prompt = ruleMessage("set");
  const snapshot = { href: MAIN_CHAT, stop: false, users: [
    { index: 0, text: prompt }, { index: 2, text: ruleMessage("remove", "later") }
  ], agents: [{ index: 1, text: "已设置" }] };
  const result = await readRuleReply({ snapshot: async () => snapshot }, prompt, "set", Date.now() + 1000, { legacy: true });
  assert.equal(result.outcome, "unconfirmed");
  assert.equal(result.reply, "");
});

test("a matching old assistant bubble is never used, and an interrupted new reply remains available", async () => {
  const baseline = { users: [{ index: 0 }] };
  const anchored = { href: MAIN_CHAT, users: [...baseline.users, { index: 2, text: "prompt" }], stop: true,
    agents: [{ index: 1, text: "已移除" }, { index: 3, text: "仍在检查" }] };
  let polls = 0;
  const partial = await readRuleReply({
    async snapshot() { if (polls++ === 0) return anchored; throw new Error("断开"); },
  }, "prompt", "remove", Date.now() + 2000);
  assert.deepEqual(partial, { outcome: "unconfirmed", reply: "仍在检查", delivered: true, messageId: undefined, detail: "断开" });
  polls = 0;
  const other = await readRuleReply({
    async snapshot() { return polls++ === 0 ? { ...anchored, users: baseline.users } : { ...anchored, href: MAIN_CHAT + "thread/elsewhere" }; },
  }, "prompt", "remove", Date.now() + 2000);
  assert.equal(other.outcome, "unconfirmed");
  assert.equal(other.reply, "");
  assert.equal(other.delivered, false);
});
