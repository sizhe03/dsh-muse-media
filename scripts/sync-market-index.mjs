// Add the current package version to the plugin market index, then validate the result.
//
// Run this AFTER `npm publish`: a version's publish timestamp only exists once npm has it, and the
// index must never point at a version that cannot be installed.
//
//   node scripts/sync-market-index.mjs
//
// It is idempotent — running it twice adds nothing the second time.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const INDEX = "market-index.json";
const PACKAGE_NAME = "dsh-muse-media";
const INDEX_URL = "https://raw.githubusercontent.com/sizhe03/dsh-muse-media/main/market-index.json";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

if (pkg.name !== PACKAGE_NAME) {
  console.error(`package.json names ${pkg.name}, but this script manages ${PACKAGE_NAME}`);
  process.exit(1);
}

const index = JSON.parse(readFileSync(INDEX, "utf8"));
const plugin = index.plugins.find((entry) => entry.name === PACKAGE_NAME);
if (plugin === undefined) {
  console.error(`${INDEX} has no entry for ${PACKAGE_NAME}`);
  process.exit(1);
}

const listed = plugin.versions.map((entry) => entry.version);
console.log("package version:", pkg.version);
console.log("listed versions:", listed.join(", "));

if (listed.includes(pkg.version)) {
  console.log(`\n${pkg.version} is already listed; nothing to add`);
} else {
  /* ---- wait for npm to have the version ---- */
  const deadline = Date.now() + 3 * 60_000;
  let registry;

  while (Date.now() < deadline) {
    const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}`, {
      headers: { Accept: "application/json" },
    });
    if (response.ok) {
      const data = await response.json();
      if (Object.keys(data.versions).includes(pkg.version)) {
        registry = data;
        break;
      }
    }
    console.log("  npm does not have it yet, waiting 15s…");
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }

  if (registry === undefined) {
    console.error(`\n${pkg.version} never appeared on npm.`);
    console.error("Publish first:  npm publish");
    console.error("The index is unchanged, so Discover keeps serving the previous version.");
    process.exit(1);
  }

  /* ---- append, with the timestamp npm recorded ---- */
  const publishedAt = registry.time[pkg.version];
  plugin.versions.push({
    version: pkg.version,
    // Unix seconds as an integer: the validator rejects ISO strings and millisecond values.
    publishTimestamp: Math.floor(new Date(publishedAt).getTime() / 1000),
    source: { type: "npm" },
  });

  writeFileSync(INDEX, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  console.log(`\nadded ${pkg.version} (published ${publishedAt})`);
}

/* ---- validate with the Host's own parser, when it is available ---- */
const validator = "E:/deepseek/resources/app/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js";
if (existsSync(validator)) {
  const { parseMarketIndex, marketInstallTarget } = await import(`file:///${validator}`);
  try {
    const parsed = parseMarketIndex(index, INDEX_URL);
    const entry = parsed.plugins[0];
    console.log("\nvalidator: PASS");
    console.log("  versions (newest first):", entry.versions.map((v) => v.version).join(", "));
    console.log("  install target:", marketInstallTarget(entry.name, entry.versions[0]).spec);
  } catch (error) {
    console.error("\nvalidator: FAIL");
    console.error("  path:", error.path);
    console.error("  reason:", error.reason);
    process.exit(1);
  }
} else {
  console.log("\nvalidator not available (no Host checkout); skipped");
}

/* ---- remind about the commit ---- */
let dirty = "";
try {
  dirty = execFileSync("git", ["status", "--porcelain", INDEX], { encoding: "utf8" }).trim();
} catch {
  /* not a git checkout */
}

if (dirty !== "") {
  console.log("\nNext:");
  /**
   * One commit, not two.
   *
   * This used to suggest a separate `chore: index …` commit. Following that produced a version bump commit
   * whose index was still behind, which the index test correctly failed — a red commit in every release,
   * visible to anyone reading the history. The manifest, the changelog and the index describe one release and
   * belong in one commit.
   */
  console.log("  git add package.json CHANGELOG.md market-index.json");
  console.log(`  git commit -m "${pkg.version}: <what changed>"`);
  console.log("  git push");
  console.log(`  git tag -a v${pkg.version} -m "${pkg.version} — <summary>"`);
  console.log(`  git push origin v${pkg.version}`);
  console.log("");
  console.log("  Version, changelog and index in a single commit: a bump commit without the index");
  console.log("  fails the index test, and splitting them puts a red commit in the release history.");
}
