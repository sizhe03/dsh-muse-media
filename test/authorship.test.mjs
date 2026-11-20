// Ownership must stay unambiguous.
//
// MIT requires the copyright notice to travel with every copy, and npm shows an author only when the
// manifest has one. Both had drifted: LICENSE said "dsh-muse-media contributors" — a plural placeholder
// naming nobody — and package.json had no author at all, so the npm page showed none either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const license = readFileSync("LICENSE", "utf8");

test("the licence names a real copyright holder", () => {
  const holder = /Copyright\s+\(c\)\s+\d{4}\s+(.+)/i.exec(license)?.[1]?.trim();
  assert.ok(holder, "LICENSE must carry a copyright line");

  // A plural placeholder names nobody, which is the shape this project had before.
  assert.doesNotMatch(holder, /contributors?$/i, `LICENSE must name a holder, not "${holder}"`);
  assert.match(holder, /sizhe03/);
});

test("the licence is otherwise the standard MIT text", () => {
  // Only the copyright line should differ from stock MIT; a modified body would change the terms.
  assert.match(license, /^MIT License/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
  assert.match(license, /WITHOUT WARRANTY OF ANY KIND/);
  assert.match(license, /substantial portions of the Software/);
});

test("package.json declares the author npm will display", () => {
  assert.ok(pkg.author, "package.json must have an author for npm to show one");
  const name = typeof pkg.author === "string" ? pkg.author : pkg.author.name;
  assert.equal(name, "sizhe03");
});

test("the manifest and the licence agree on the license identifier", () => {
  assert.equal(pkg.license, "MIT");
  assert.match(license, /^MIT License/);
});

test("the repository is not marked private, so the package is genuinely public", () => {
  assert.notEqual(pkg.private, true);
  assert.match(pkg.repository.url, /github\.com\/sizhe03\/dsh-muse-media/);
});
