import { test } from "node:test";
import assert from "node:assert/strict";
import { MAIN_CHAT, readRuleReply, ruleOutcome } from "../lib/memory-rule.js";

test("an intention, a denial containing a success word, and another operation's reply remain unconfirmed", () => {
  for (const text of ["我将删除", "还未移除", "好的，我将删除这条规则。", "已设置"]) {
    assert.equal(ruleOutcome("remove", text), "unconfirmed");
  }
  assert.equal(ruleOutcome("remove", "已移除。"), "removed");
  assert.equal(ruleOutcome("set", "无法保存"), "refused");
});

test("a matching old assistant bubble is never used, and an interrupted new reply remains available", async () => {
  const baseline = { users: [{ index: 0 }] };
  const anchored = { href: MAIN_CHAT, users: [...baseline.users, { index: 2 }], stop: true,
    agents: [{ index: 1, text: "已移除" }, { index: 3, text: "仍在检查" }] };
  let polls = 0;
  const partial = await readRuleReply({
    async snapshot() { if (polls++ === 0) return anchored; throw new Error("断开"); },
    async roundUserAttachments() { return { count: 0 }; },
  }, baseline, "prompt", "remove", Date.now() + 2000);
  assert.deepEqual(partial, { outcome: "unconfirmed", reply: "仍在检查", detail: "断开" });
  polls = 0;
  const other = await readRuleReply({
    async snapshot() { return polls++ === 0 ? anchored : { ...anchored, href: MAIN_CHAT + "thread/elsewhere" }; },
    async roundUserAttachments() { return undefined; },
  }, baseline, "prompt", "remove", Date.now() + 2000);
  assert.deepEqual(other, { outcome: "unconfirmed", reply: "" });
});
