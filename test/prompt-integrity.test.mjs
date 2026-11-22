// Exercise the production predicate, not a copy.
//
// The previous version defined isTruncated() locally and used assert.match on index.js to confirm it was wired. A local copy
// cannot fail when the shipped condition changes, and a source-text assertion breaks on a rename while proving nothing about
// behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPromptComplete } from "../lib/muse.js";

/* ---- the failure this exists for ---- */

test("a shortened composer is rejected", () => {
  // Measured: 336 characters sent, 324 held. The tail — the delivery spec — never arrived.
  const sent = "一枚烟紫色半透明游戏卡带，像从一台老掌机里刚拔出来。".repeat(10) + "正方形 1:1 构图，完整方图，sRGB，摄影级材质细节。";
  const held = sent.slice(0, sent.length - 12);
  assert.equal(isPromptComplete(sent, held), false);
});

test("the exact text is accepted", () => {
  const sent = "一只橘猫坐在窗台上，午后光线。\n\n正方形 1:1 构图。";
  assert.equal(isPromptComplete(sent, sent), true);
});

test("whitespace differences are not truncation", () => {
  // The page collapses runs of whitespace; that must not read as a loss.
  assert.equal(isPromptComplete("第一段。\n\n\n第二段。", "第一段。 第二段。"), true);
});

test("equal length with a different tail is rejected", () => {
  // Length alone would pass this. The tail comparison is what catches it.
  const sent = "这是一段用于测试的完整提示词，包含具体的交付规格。";
  const held = "这是一段用于测试的完整提示词，包含具体的格式要求。";
  assert.equal(held.length, sent.length, "fixture: equal length");
  assert.equal(isPromptComplete(sent, held), false);
});

test("a rewrite that keeps the opening is rejected", () => {
  // The failure mode a per-paragraph summary produces: the first sentence survives, the rest changes.
  const sent = "开头说明了用途。中间是画面描述的内容。结尾规定了交付规格。";
  const held = "开头说明了用途。中间被改写成别的句子。结尾规定了交付规格。";
  assert.equal(isPromptComplete(sent, held), false);
});

/* ---- degenerate inputs ---- */

test("an empty composer is not complete for a non-empty prompt", () => {
  assert.equal(isPromptComplete("有内容", ""), false);
});

test("an empty prompt against an empty composer is complete", () => {
  // Nothing was sent and nothing is held: there is no loss to report.
  assert.equal(isPromptComplete("", ""), true);
});

test("null and undefined are handled without throwing", () => {
  assert.equal(isPromptComplete("内容", undefined), false);
  assert.equal(isPromptComplete(undefined, ""), true);
  assert.equal(isPromptComplete(undefined, undefined), true);
});

test("a much longer composer is rejected", () => {
  // Trailing text appears (an autocomplete, a stray paste). Length catches it.
  assert.equal(isPromptComplete("请求的内容", "请求的内容加上一些不是发出去的东西"), false);
});
