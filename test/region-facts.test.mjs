// The region block has facts that took two months of measurement to establish. They belong in tests so a
// later edit cannot quietly soften them back into "try again".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { looksLikeRegionRefusal, looksLikeContentRefusal } from "../lib/pool.js";

const readme = readFileSync("README.md", "utf8");
const readmeEn = readFileSync("README.en.md", "utf8");
const toolText = readFileSync("index.js", "utf8");

test("a 403 naming a region is recognised", () => {
  // Muse answers 403 for an unsupported region, and the reply says so. The plugin sees the text, not the
  // status code, so the number has to be matched as text.
  for (const text of ["Muse 返回 403，当前地区不在支持范围", "403: region not supported", "region 403"]) {
    assert.ok(looksLikeRegionRefusal(text) !== undefined, `should match: ${text}`);
  }
});

test("the four supported regions are named in both READMEs", () => {
  for (const doc of [readme, readmeEn]) {
    for (const region of ["美国", "加拿大", "日本", "新加坡"]) {
      if (doc === readme) assert.ok(doc.includes(region), `missing ${region}`);
    }
  }
  // The English README names them in English.
  for (const region of ["United States", "Canada", "Japan", "Singapore"]) {
    assert.ok(readmeEn.includes(region), `missing ${region}`);
  }
});

test("the documentation states the block is permanent, not temporary", () => {
  // The measured fact: an account flagged at registration was still blocked two months later. A message
  // that implies "try again later" sends the user to repeat something proven not to work.
  assert.match(readme, /两个月/, "the Chinese README must record the two-month observation");
  assert.match(readme, /永久|不会恢复|无法恢复/, "it must say the block does not heal");
  assert.match(readmeEn, /two months|does not recover/, "the English README must say the same");
});

test("the documentation says changing IP will not help", () => {
  assert.match(readme, /换 IP[^。]*不会/, "must state that another IP will not restore video");
  assert.match(readmeEn, /changing IP[^.]*will not/, "same in English");
});

test("the documentation covers WebRTC and DNS leaks", () => {
  // A nominally correct exit is defeated by a leak, which is the failure mode users hit without knowing.
  for (const doc of [readme, readmeEn]) {
    assert.match(doc, /WebRTC/);
    assert.match(doc, /DNS/);
  }
});

test("the documentation says the email does not matter", () => {
  assert.match(readme, /邮箱/);
  assert.match(readmeEn, /email/i);
});

test("the tool description tells the model not to suggest retrying with another IP", () => {
  // Otherwise a model reads "region-restricted" and advises exactly the one thing that cannot work.
  assert.match(toolText, /不要建议用户换 IP/, "the video tool must rule out that advice");
  assert.match(toolText, /图片生成不受影响/, "and must point at the path that still works");
});

test("images remain usable on a region-blocked account", () => {
  // The measured behaviour: the same account that cannot make video still makes images.
  assert.match(readme, /图片生成不受影响|图片不受此限制|同一账号的图片/);
  assert.match(readmeEn, /image generation kept working|Images are not restricted/i);
});

test("a region block and a content refusal stay distinct", () => {
  const region = "视频生成功能在你账号所在的国家／地区不可用";
  const content = "这违反了我们的内容政策";
  assert.ok(looksLikeRegionRefusal(region) !== undefined);
  assert.equal(looksLikeContentRefusal(region), undefined);
  assert.ok(looksLikeContentRefusal(content) !== undefined);
  assert.equal(looksLikeRegionRefusal(content), undefined);
});
