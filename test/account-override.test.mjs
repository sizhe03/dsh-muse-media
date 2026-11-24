// Forcing an account has to work, and a bad request has to fail rather than quietly run elsewhere.
//
// The failure this is written against: a user asked for acc-01 and the plugin ran acc-02, because ranking had no override and the result
// looked normal. Charging an account nobody asked for is worse than refusing, because nothing in the outcome reveals it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* ---- the resolver, mirroring accountForRequest ---- */

const resolve = (accounts, requested) => {
  const wanted = typeof requested === "string" ? requested.trim() : "";
  if (wanted === "") return { kind: "default" };

  const match =
    accounts.find((account) => account.id === wanted) ??
    accounts.find((account) => account.label === wanted) ??
    accounts.find((account) => account.label.toLowerCase() === wanted.toLowerCase());

  if (match === undefined) return { kind: "unknown" };
  if (match.usable !== true) return { kind: "unusable", account: match };
  return { kind: "forced", account: match };
};

const accounts = [
  { id: "acc-01", label: "acc-01", usable: true },
  { id: "acc-2", label: "acc-2", usable: true },
  { id: "acc-3", label: "备用", usable: false },
];

test("omitting the argument leaves the default alone", () => {
  assert.equal(resolve(accounts, undefined).kind, "default");
  assert.equal(resolve(accounts, "").kind, "default");
  assert.equal(resolve(accounts, "   ").kind, "default");
});

test("an id forces that account", () => {
  const result = resolve(accounts, "acc-01");
  assert.equal(result.kind, "forced");
  assert.equal(result.account.id, "acc-01");
});

test("a label forces that account, case-insensitively", () => {
  assert.equal(resolve(accounts, "acc-2").account.id, "acc-2");
  assert.equal(resolve(accounts, "ACC-2").account.id, "acc-2");
  assert.equal(resolve(accounts, "备用").account.id, "acc-3");
});

test("an unknown name is refused rather than falling back", () => {
  // The whole point: no silent substitution.
  assert.equal(resolve(accounts, "acc-99").kind, "unknown");
});

test("a known but unusable account is refused", () => {
  const result = resolve(accounts, "acc-3");
  assert.equal(result.kind, "unusable");
});

/* ---- the wiring ---- */

test("all three tools declare the parameter", () => {
  const index = readFileSync("index.js", "utf8");
  for (const tool of ["muse_draw_image", "muse_draw_video", "muse_quota"]) {
    const at = index.indexOf(`name: "${tool}"`);
    const block = index.slice(at, at + 1400);
    assert.match(block, /account: ACCOUNT_FIELD/, `${tool} must declare it`);
  }
});

test("the forced account is used instead of the ranked one", () => {
  const index = readFileSync("index.js", "utf8");
  assert.match(index, /const requested = this\.accountForRequest\(account\);/, "resolved");
  assert.match(index, /if \(requested !== undefined\) \{\s*\n\s*chosen = requested;/, "and preferred over ranking");
  assert.match(index, /\.ordered\[0\] \?\? preferred/, "ranking remains the default path");
});

test("a refusal is an error, not a fallback", () => {
  const index = readFileSync("index.js", "utf8");
  assert.match(index, /code: "UNKNOWN_ACCOUNT"/);
  assert.match(index, /code: "ACCOUNT_UNAVAILABLE"/);
  assert.ok(
    !/accountForRequest[\s\S]{0,600}?return undefined;[\s\S]{0,100}?usable/.test(index),
    "must not return undefined for an unusable account",
  );
});

test("every generation call site passes the argument through", () => {
  const index = readFileSync("index.js", "utf8");
  assert.match(index, /kind: "image"[^;\n]*account: record\.account/, "image");
  assert.match(index, /kind: "video",[\s\S]{0,200}?account: record\.account/, "video");
});
