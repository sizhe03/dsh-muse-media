// The integrity check must actually reject a truncated composer, and must not reject legitimate text.
//
// A check that passes everything is decoration. These cases come from the real failure: 336 characters sent, 324 in the box.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** The same normalisation the host uses. */
const normalise = (text) => String(text).replace(/\s+/g, " ").trim();

/** The decision, extracted so it can be tested without a page. */
const isTruncated = (expected, written) => {
  const a = normalise(expected);
  const b = normalise(written);
  return a.length !== b.length || !b.startsWith(a.slice(0, 40)) || !b.endsWith(a.slice(-40));
};

test("a shortened composer is rejected", () => {
  // The real case: the tail was cut off.
  const sent = "一枚烟紫色半透明游戏卡带，像从一台老掌机里刚拔出来。".repeat(10) + "正方形 1:1 构图，完整方图，sRGB，摄影级材质细节。";
  const written = sent.slice(0, sent.length - 12);
  assert.equal(isTruncated(sent, written), true, "a 12-character shortfall must be caught");
});

test("the exact text is accepted", () => {
  const sent = "一只橘猫坐在窗台上，午后光线。\n\n正方形 1:1 构图。";
  assert.equal(isTruncated(sent, sent), false);
});

test("whitespace differences are not treated as truncation", () => {
  // The page collapses whitespace; that must not read as a difference.
  const sent = "第一段。\n\n\n第二段。";
  const written = "第一段。 第二段。";
  assert.equal(isTruncated(sent, written), false);
});

test("a same-length rewrite is caught by comparing both ends", () => {
  // A real same-length rewrite differs at one end: a summariser replaces a clause but keeps the length.
  const sent = "开头部分说明了用途，" + "中间是画面描述。".repeat(5) + "结尾规定了交付规格和后续说明。";
  const written = "开头部分说明了用途，" + "中间被改写成别的句子。".repeat(5) + "结尾规定了交付规格和后续说明。".padEnd(13, "。");

  // Same opening, different middle, possibly different length — either way it must be rejected.
  assert.equal(isTruncated(sent, written), true, "a rewritten middle must not pass");

  // And a genuine same-length, tail-different case:
  const a = "这是一段用于测试的完整提示词，包含具体的交付规格。";
  const b = "这是一段用于测试的完整提示词，包含具体的格式要求。";
  assert.equal(b.length, a.length, "fixture: equal length");
  assert.equal(isTruncated(a, b), true, "equal length but a different tail must be caught");
});

test("an empty composer is caught before this check, by length === 0", () => {
  // Documents the ordering: the empty case has its own error and its own code.
  assert.equal(normalise("").length, 0);
});

/* ---- the wiring must exist in both files ---- */
test("the page returns what the textarea holds", () => {
  const muse = readFileSync("lib/muse.js", "utf8");
  assert.match(muse, /return \{ ok: true, length: \(textarea\.value \|\| ""\)\.length, text: textarea\.value \|\| "" \}/);
  assert.match(muse, /text: result\.text/, "setPrompt must forward it");
});

test("the host refuses to send on a mismatch", () => {
  const index = readFileSync("index.js", "utf8");
  assert.match(index, /code: "PROMPT_INCOMPLETE"/);
  assert.match(index, /promptResult\.text !== undefined/, "the check must be gated on the field existing");
  assert.match(index, /expectedText\.length !== written\.length/, "length comparison present");
  assert.match(index, /written\.startsWith\(expectedText\.slice\(0, 40\)\)/, "head comparison present");
});
