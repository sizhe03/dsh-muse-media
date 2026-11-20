// A permanent test suite, replacing the throwaway verification scripts used while building this.
//
// Why these tests and not others: every one of them encodes a defect that actually shipped or nearly
// did. They are cheap to run and catch the failures that are expensive to discover late — a wrong
// version, a broken locale, a phantom theme token, a media route that 404s.
//
// Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

const read = (path) => readFileSync(path, "utf8");
const readStrict = (path) => new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
const pkg = JSON.parse(read("package.json"));

/* ============================================================
 * Version and manifest
 * ========================================================== */

test("version is semver and the changelog records it", () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.ok(read("CHANGELOG.md").includes(`## [${pkg.version}]`), `CHANGELOG is missing an entry for ${pkg.version}`);
});

test("the manifest points at the real repository and npm listing", () => {
  assert.equal(pkg.repository?.url, "git+https://github.com/sizhe03/dsh-muse-media.git");
  assert.equal(pkg.homepage, "https://www.npmjs.com/package/dsh-muse-media");
  assert.equal(pkg.bugs?.url, "https://github.com/sizhe03/dsh-muse-media/issues");
});

test("engines admits the DSH version this build was tested on", () => {
  // A wrong range blocks every future install, and the failure is invisible until someone tries.
  assert.match(pkg.engines.dsh, />=0\.2\.2-rc\.5/);
  assert.match(pkg.engines.dsh, /<0\.3\.0-0/);
});

test("every entry in files exists, so npm pack cannot silently drop it", () => {
  for (const entry of pkg.files) {
    if (entry.includes("*")) continue;
    assert.ok(existsSync(entry), `files entry missing: ${entry}`);
  }
});

/* ============================================================
 * Encoding — a PowerShell redirect once corrupted every Chinese character
 * ========================================================== */

test("every shipped text file is valid UTF-8", () => {
  const files = ["index.js", "client.js", "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "docs/DESIGN.md", "locale/zh.json", "locale/en.json"];
  for (const file of files) {
    assert.doesNotThrow(() => readStrict(file), `${file} is not valid UTF-8`);
  }
});

/* ============================================================
 * Display metadata — the Host refuses to render a malformed detail document
 * ========================================================== */

test("locale files carry the fields the plugin manager reads", () => {
  for (const lang of ["zh", "en"]) {
    const data = JSON.parse(read(`locale/${lang}.json`));
    assert.ok(data.meta?.title, `${lang}: meta.title missing`);
    assert.ok(data.meta?.description?.length > 400, `${lang}: description too short`);
    assert.equal(data.meta.detail, "docs/DETAIL.md");
  }
});

test("the detail document is exactly one image line", () => {
  const lines = read("docs/DETAIL.md").trim().split(/\r?\n/).filter((line) => line.trim() !== "");
  assert.equal(lines.length, 1, "a detail document must contain one image and nothing else");
  assert.match(lines[0], /^!\[.+\]\(.+\)$/);
});

test("the preview image satisfies the documented constraints", () => {
  const svg = read("docs/preview.svg");
  assert.match(svg, /width="640"/);
  assert.match(svg, /height="300"/);
  assert.ok(!/<text/i.test(svg), "a preview must not contain text (it would need translating)");
  assert.ok(!/<script/i.test(svg));
  assert.ok(!/<style/i.test(svg));
  assert.ok(!/foreignObject/i.test(svg));
  assert.ok(!/href\s*=\s*"https?:|url\(\s*https?:/i.test(svg), "no external resources");
  assert.ok(statSync("docs/preview.svg").size < 1024 * 1024);
});

test("the icon is a self-contained SVG within the size limit", () => {
  const icon = read("icon.svg");
  assert.match(icon.trimStart(), /^<svg/);
  assert.ok(statSync("icon.svg").size <= 256 * 1024);
  assert.ok(!/href\s*=\s*"https?:|url\(\s*https?:/i.test(icon));
});

/* ============================================================
 * Theme tokens — four phantom names once made every primary button grey
 * ========================================================== */

test("every theme token used exists in the Host's own stylesheets", () => {
  const hostRoot = "E:/deepseek/resources/app/dsh/node_modules/@deepseek-ai";
  if (!existsSync(hostRoot)) {
    // On a machine without the Host checkout the check cannot run; skip rather than fail falsely.
    return;
  }

  const hostTokens = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs|css)$/.test(entry.name)) {
        try {
          for (const match of read(full).matchAll(/--dsw-[a-z0-9-]+/g)) hostTokens.add(match[0]);
        } catch {
          /* unreadable file */
        }
      }
    }
  };
  walk(hostRoot);

  const client = read("client.js");
  const styleStart = client.indexOf("const STYLE = `");
  const css = client.slice(styleStart, client.indexOf("`;", styleStart));
  const used = [...new Set([...css.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((m) => m[1]))];

  const unknown = used.filter((token) => !hostTokens.has(token));
  assert.deepEqual(unknown, [], `tokens the Host does not define: ${unknown.join(", ")}`);
});

/* ============================================================
 * Client rules — the Host documents these, and violating them blanks the slot
 * ========================================================== */

test("the client does not require Harness packages", () => {
  const client = read("client.js");
  const requires = [...client.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(requires)].sort(), ["react", "react-dom"]);
});

test("the host entry declares the services it reads", () => {
  const index = read("index.js");
  assert.match(index, /export const inject\s*=/);
  assert.match(index, /export function apply\s*\(/);
});

/* ============================================================
 * CI — a tag must never fail because a credential is missing
 * ========================================================== */

test("the publish job is gated and the verify job is not", () => {
  const code = read(".github/workflows/publish.yml")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  const publish = code.slice(code.indexOf("\n  publish:"));
  assert.match(publish, /needs:\s*verify/, "publishing must depend on verification");
  assert.match(publish, /if:\s*vars\.NPM_PUBLISH_ENABLED\s*==\s*'true'/, "publishing must be gated");

  const verify = code.slice(code.indexOf("\n  verify:"), code.indexOf("\n  publish:"));
  assert.ok(!/^\s*if:/m.test(verify), "verification must run on every tag");
  assert.match(verify, /GITHUB_REF_NAME/);
});

test("the workflow references no stored credential", () => {
  const code = read(".github/workflows/publish.yml")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.ok(!/secrets\./.test(code));
  assert.ok(!/NPM_TOKEN/.test(code));
});

/* ============================================================
 * Documentation links — a broken link on the npm page is the first thing a visitor meets
 * ========================================================== */

test("relative links in the README resolve", () => {
  const readme = read("README.md");
  const links = [...readme.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)].map((m) => m[1].split("#")[0]);
  for (const link of links) {
    assert.ok(existsSync(link), `README links a missing file: ${link}`);
  }
});

test("the README does not link the image-only detail document", () => {
  // DETAIL.md is a single image for the plugin page; linking it from the README shows a bare picture.
  assert.ok(!read("README.md").includes("docs/DETAIL.md"));
});

test("the English README mirrors the Chinese one", () => {
  // A visitor who does not read Chinese still needs the install command and the requirements; the
  // plugin description on npm is already bilingual, so the repository should not be the exception.
  const en = read("README.en.md");
  assert.match(en, /npm install dsh-muse-media/);
  assert.match(en, /\| `imageTimeoutSeconds`/, "config table should match the Chinese README");
  assert.match(en, /docs\/preview\.svg/, "the preview belongs in both");
  for (const link of [...en.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)].map((m) => m[1].split("#")[0])) {
    assert.ok(existsSync(link), `English README links a missing file: ${link}`);
  }
});

test("the security policy states what the plugin does not read", () => {
  const security = read("SECURITY.md");
  assert.match(security, /不读取也不存储/, "must say which credentials it never touches");
  assert.match(security, /security\/advisories\/new/, "must give a private reporting route");
  assert.match(security, /127\.0\.0\.1/, "must state the loopback-only boundary");
});

/* ============================================================
 * Working tree hygiene
 * ========================================================== */

test("no scratch files are tracked", () => {
  let tracked;
  try {
    tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
  } catch {
    return; // not a git checkout
  }
  const scratch = tracked.filter((file) => file.split("/").pop().startsWith("_"));
  assert.deepEqual(scratch, [], `scratch files are tracked: ${scratch.join(", ")}`);
});

test("the internal goal document is not tracked", () => {
  let tracked;
  try {
    tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
  } catch {
    return;
  }
  assert.ok(!tracked.includes("GOAL.md"));
});
