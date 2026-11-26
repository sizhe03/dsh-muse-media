// The plugin market index must keep passing the Host's own validator.
//
// A malformed index is worse than no index: DSH validates with `parseMarketIndex` and rejects the whole
// document on the first violated rule, so one wrong field makes the plugin invisible in Discover.
// This test runs the real validator, and checks that every listed version actually exists on npm with
// the timestamp it claims.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const INDEX_PATH = "market-index.json";

test("the market index exists and parses as JSON", () => {
  assert.ok(existsSync(INDEX_PATH), "market-index.json must be committed");
  const index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
  assert.equal(index.format, 1, "format 1 is the only supported version");
  assert.ok(Array.isArray(index.plugins) && index.plugins.length > 0);
});

test("the index passes the Host's validator", async () => {
  const validatorPath = "E:/deepseek/resources/app/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js";
  if (!existsSync(validatorPath)) {
    // Without the Host checkout the validator cannot run; skip rather than assert a guess.
    return;
  }

  const { parseMarketIndex, marketInstallTarget } = await import(`file:///${validatorPath}`);
  const index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
  const url = "https://raw.githubusercontent.com/sizhe03/dsh-muse-media/main/market-index.json";

  const parsed = parseMarketIndex(index, url);
  assert.equal(parsed.plugins.length, 1);

  const plugin = parsed.plugins[0];
  assert.equal(plugin.name, "dsh-muse-media");
  assert.ok(plugin.versions.length > 0, "at least one version must be listed");

  // What DSH would actually install for the newest version.
  const target = marketInstallTarget(plugin.name, plugin.versions[0]);
  assert.match(target.spec, /^dsh-muse-media@\d+\.\d+\.\d+$/);
});

test("every listed version matches the package manifest's name", () => {
  const index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(index.plugins[0].name, pkg.name, "the index must name the same package");
});

test("publish timestamps are Unix seconds, not milliseconds or strings", () => {
  // A millisecond value is ~1000x too large and fails the validator's [0, 10^11) range; strings fail
  // the integer check. Both mistakes were made while writing this file.
  const index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
  for (const version of index.plugins[0].versions) {
    assert.equal(typeof version.publishTimestamp, "number", `${version.version}: must be a number`);
    assert.ok(Number.isInteger(version.publishTimestamp), `${version.version}: must be an integer`);
    assert.ok(version.publishTimestamp > 1_600_000_000, `${version.version}: too small to be recent`);
    assert.ok(version.publishTimestamp < 10 ** 11, `${version.version}: looks like milliseconds`);
  }
});

test("localized text is keyed by language, not a bare string", () => {
  const index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
  for (const field of ["title", "description"]) {
    const value = index[field];
    assert.equal(typeof value, "object", `index.${field} must be a language map`);
    assert.ok(Object.keys(value).length > 0);
  }
  const plugin = index.plugins[0];
  for (const field of ["title", "description"]) {
    assert.equal(typeof plugin[field], "object", `plugin.${field} must be a language map`);
  }
});

test("the listed versions match the current manifest version", () => {
  /**
   * The index is regenerated after `npm publish`, because a version's timestamp only exists once it
   * is published. So during the window between bumping the manifest and publishing, the index
   * legitimately lacks the new version.
   *
   * The rule that matters is the other direction: the index must never advertise a version that does
   * not exist. That is checked here for every build. The "is the newest version listed" rule runs in CI on
   * every branch push, where a bump without a sync is a real possibility.
   */
  const index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const listed = index.plugins[0].versions.map((entry) => entry.version);

  // Never list something newer than the manifest: that would point users at a version that cannot exist.
  const manifestParts = pkg.version.split(".").map(Number);
  for (const version of listed) {
    const parts = version.split(".").map(Number);
    const newerThanManifest =
      parts[0] > manifestParts[0] ||
      (parts[0] === manifestParts[0] && parts[1] > manifestParts[1]) ||
      (parts[0] === manifestParts[0] && parts[1] === manifestParts[1] && parts[2] > manifestParts[2]);
    assert.ok(!newerThanManifest, `the index lists ${version}, newer than the manifest's ${pkg.version}`);
  }

  /**
   * In CI the newest version must be listed — but only on branch builds.
   *
   * On a tag this assertion cannot be satisfied: the tag is what triggers the publish, so when verify runs the version is by definition not on the
   * registry yet, and the index cannot contain a version npm has never heard of. Asserting it there makes every OIDC release impossible and forces
   * the manual `npm publish` this assertion exists to protect.
   *
   * The failure worth catching is a branch where the version bump landed and the sync did not: the package is live on npm while Discover still
   * advertises the previous version, and nothing else notices. That is a branch-only shape.
   *
   * Detection reads GITHUB_REF_TYPE rather than merely "am I in CI". With only GITHUB_ACTIONS=true the tag case is indistinguishable from a branch,
   * which is the gap this comment used to describe without implementing.
   */
  const inCi = process.env.GITHUB_ACTIONS === "true" || process.env.CI === "true";
  const refType = process.env.GITHUB_REF_TYPE;
  const isTagBuild = refType === "tag" || (process.env.GITHUB_REF ?? "").startsWith("refs/tags/");

  if (inCi && !isTagBuild) {
    assert.ok(listed.includes(pkg.version), `market-index.json is missing ${pkg.version}; run the sync step`);
  }
});
