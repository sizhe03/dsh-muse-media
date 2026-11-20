// The recognisers must fire on real wording and stay quiet on ordinary progress text.
//
// The exact page wording was not available to check, so the test asserts the shape of the answer: a
// recognised case returns the matched sentence (so an error can quote it), an unrecognised one returns
// undefined rather than a guess. A false positive is worse than a miss here — telling a user their
// prompt was refused when it was merely slow would send them rewriting a fine prompt.
import { test } from "node:test";
import assert from "node:assert/strict";

import { looksLikeContentRefusal, looksLikeRegionRefusal } from "../lib/pool.js";

/* ============================================================
 * region
 * ========================================================== */

test("region refusals are recognised in both languages", () => {
  const cases = [
    "视频生成功能在你账号所在的国家／地区不可用",
    "由于你的所在地区限制，视频生成功能已关闭",
    "视频生成在你的国家不可用",
    "Video generation is not available in your country",
    "This feature is not available in your region",
    "Unsupported country for video generation",
  ];
  for (const text of cases) {
    assert.ok(looksLikeRegionRefusal(text) !== undefined, `should match: ${text}`);
  }
});

test("a region recognition returns the sentence, not a boolean", () => {
  // The caller quotes this in the error, so a user in an unmatched locale still sees the real reason.
  const sentence = lookAt("视频生成功能在你账号所在的国家／地区不可用。");
  assert.equal(typeof sentence, "string");
  assert.ok(sentence.length > 0);
});

function lookAt(text) {
  return looksLikeRegionRefusal(text);
}

test("ordinary progress text is not a region refusal", () => {
  for (const text of ["生成中", "正在生成，请稍候", "Generating…", "Your video is ready", "已使用 24%"]) {
    assert.equal(looksLikeRegionRefusal(text), undefined, `must not match: ${text}`);
  }
});

/* ============================================================
 * content policy
 * ========================================================== */

test("content refusals are recognised in both languages", () => {
  const cases = [
    "这违反了我们的内容政策",
    "该请求涉及不当内容，无法生成",
    "提示词包含色情内容，不符合规定",
    "I can't help with that request",
    "This violates our community policies",
    "The request contains sexual content",
  ];
  for (const text of cases) {
    assert.ok(looksLikeContentRefusal(text) !== undefined, `should match: ${text}`);
  }
});

test("a content refusal also returns the sentence", () => {
  const sentence = looksLikeContentRefusal("这违反了我们的内容政策。请修改后重试。");
  assert.equal(typeof sentence, "string");
  assert.ok(sentence.includes("政策"));
});

test("ordinary progress text is not a content refusal", () => {
  for (const text of ["生成中", "Generating…", "Your video is ready", "已使用 24%", "任务已完成"]) {
    assert.equal(looksLikeContentRefusal(text), undefined, `must not match: ${text}`);
  }
});

/* ============================================================
 * the two must not be confused
 * ========================================================== */

test("a region notice is not read as a content refusal", () => {
  // The advice differs: rephrasing fixes content, nothing fixes a region block.
  const region = "视频生成功能在你账号所在的国家／地区不可用";
  assert.ok(looksLikeRegionRefusal(region) !== undefined);
  assert.equal(looksLikeContentRefusal(region), undefined, "a region block is not a policy refusal");
});

test("a policy refusal is not read as a region block", () => {
  const policy = "这违反了我们的内容政策";
  assert.ok(looksLikeContentRefusal(policy) !== undefined);
  assert.equal(looksLikeRegionRefusal(policy), undefined, "a policy refusal is not a region block");
});
