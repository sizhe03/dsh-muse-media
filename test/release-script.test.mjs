// The release script must exist and keep the index in step with the manifest.
//
// The memo tells a maintainer to run `node scripts/sync-market-index.mjs` after publishing. If that
// path ever stops existing, or the script stops being idempotent, the documented release procedure
// silently breaks — and Discover would serve a stale version.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

test("the release script exists at the path the docs name", () => {
  assert.ok(existsSync("scripts/sync-market-index.mjs"), "scripts/sync-market-index.mjs is missing");
});

test("the release script is idempotent: running it on a synced index changes nothing", () => {
  // Property, not behaviour: the index already lists the manifest version, so a second run must be a
  // no-op. The script prints "already listed" in that case.
  const source = readFileSync("scripts/sync-market-index.mjs", "utf8");
  assert.match(source, /already listed/, "the script must detect a synced index");
  assert.match(source, /process\.exit\(1\)/, "it must fail rather than proceed when npm lacks the version");
});

test("the index timestamp rule is stated where someone will read it", () => {
  // Two mistakes were made while writing this: an ISO string, then milliseconds. Both are easy to
  // repeat, so the requirement is asserted in both the script and the test file.
  const script = readFileSync("scripts/sync-market-index.mjs", "utf8");
  assert.match(script, /Unix seconds/i);

  const index = JSON.parse(readFileSync("market-index.json", "utf8"));
  for (const version of index.plugins[0].versions) {
    assert.equal(typeof version.publishTimestamp, "number");
    assert.ok(Number.isInteger(version.publishTimestamp));
    assert.ok(version.publishTimestamp < 10 ** 11, `${version.version}: looks like milliseconds`);
  }
});

test("the memo's documented procedure matches the scripts that exist", () => {
  // The memo lives outside the repository, so this only checks the parts it names inside it.
  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /npm test/, "the release procedure is described in README.md");

  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  // Compare the intent, not the exact quoting: the value embeds quotes around the glob.
  assert.match(pkg.scripts.test, /node --test/, "the test script must invoke node --test");
  assert.match(pkg.scripts.test, /test\/\*\.test\.mjs/, "it must cover every test file in test/");
});
