import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { looksLikeRegionRefusal, looksLikeContentRefusal } from "../lib/pool.js";

const guide = readFileSync("docs/TROUBLESHOOTING.md", "utf8");
const [zh, en] = guide.split(/^## English$/m);
const toolText = readFileSync("index.js", "utf8");

test("a 403 naming a region is recognised", () => {
  // Muse answers 403 for an unsupported region, and the reply says so. The plugin sees the text, not the
  // status code, so the number has to be matched as text.
  for (const text of ["Muse 返回 403，当前地区不在支持范围", "403: region not supported", "region 403"]) {
    assert.ok(looksLikeRegionRefusal(text) !== undefined, `should match: ${text}`);
  }
});

test("both troubleshooting sections name the regions with recorded successes", () => {
  for (const name of ["美国", "加拿大", "日本", "新加坡"]) assert.ok(zh.includes(name));
  for (const name of ["United States", "Canada", "Japan", "Singapore"]) assert.ok(en.includes(name));
});

test("the account restriction is documented within the observation period", () => {
  assert.match(zh, /七个账号、两个月/);
  assert.match(en, /seven accounts observed for two months/);
  assert.doesNotMatch(zh, /永久/);
  assert.doesNotMatch(en, /permanent/i);
});

test("the IP change result is attributed to the observed account", () => {
  assert.match(zh, /该账号换 IP 后仍受限/);
  assert.match(en, /Changing IP did not restore video for that account/);
});

test("the documentation records the network diagnostics considered", () => {
  for (const section of [zh, en]) {
    assert.match(section, /WebRTC/);
    assert.match(section, /DNS/);
  }
});

test("the documentation records registration email among the factors considered", () => {
  assert.match(zh, /注册邮箱/);
  assert.match(en, /registration email/i);
});

test("the tool description tells the model not to suggest retrying with another IP", () => {
  // Otherwise a model reads "region-restricted" and advises exactly the one thing that cannot work.
  assert.match(toolText, /不要建议用户换 IP/, "the video tool must rule out that advice");
  assert.match(toolText, /图片生成不受影响/, "and must point at the path that still works");
});

test("images remain usable on a region-blocked account", () => {
  // The measured behaviour: the same account that cannot make video still makes images.
  assert.match(zh, /图片生成不受影响|图片不受此限制|同一账号的图片/);
  assert.match(en, /image generation kept working|Images are not restricted/i);
});

test("a region block and a content refusal stay distinct", () => {
  const region = "视频生成功能在你账号所在的国家／地区不可用";
  const content = "这违反了我们的内容政策";
  assert.ok(looksLikeRegionRefusal(region) !== undefined);
  assert.equal(looksLikeContentRefusal(region), undefined);
  assert.ok(looksLikeContentRefusal(content) !== undefined);
  assert.equal(looksLikeRegionRefusal(content), undefined);
});
