// Exercise the production predicate, not a copy of it.
//
// The previous version defined its own gate and then used assert.match on the source to confirm wiring. That passes when the
// real condition is broken: nothing executes the production branch. `isSizeSettled` is now exported from lib/muse.js, so these
// tests call the code that ships.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSizeSettled } from "../lib/muse.js";

/* ---- the behaviour that matters, measured on a real page ---- */

test("the first sighting of a node is never settled", () => {
  // The bug this exists for: 498×498 looked like a result and was fetched straight away.
  assert.equal(isSizeSettled("498×498", undefined), false);
});

test("an unchanged size is settled", () => {
  assert.equal(isSizeSettled("498×498", "498×498"), true);
});

test("a size that grew is not settled yet", () => {
  // The real sequence: placeholder first, original after.
  assert.equal(isSizeSettled("1600×1600", "498×498"), false);
  assert.equal(isSizeSettled("1600×1600", "1600×1600"), true);
});

test("a legitimately small result is still delivered", () => {
  // The reason the rule cannot be "wait until it is large".
  assert.equal(isSizeSettled("320×320", undefined), false);
  assert.equal(isSizeSettled("320×320", "320×320"), true);
});

/* ---- the edge cases the review raised ---- */

test("a zero size is never settled, even twice in a row", () => {
  // A node whose image has not decoded reports 0×0. Two agreeing zeroes are not a measurement.
  assert.equal(isSizeSettled("0×0", "0×0"), false, "0×0 must never pass");
  assert.equal(isSizeSettled("0×498", "0×498"), false, "a zero width must not pass");
  assert.equal(isSizeSettled("498×0", "498×0"), false, "a zero height must not pass");
});

test("an unparseable size is never settled", () => {
  assert.equal(isSizeSettled(undefined, undefined), false);
  assert.equal(isSizeSettled(null, null), false);
  assert.equal(isSizeSettled("", ""), false);
  assert.equal(isSizeSettled("1600", "1600"), false, "missing the separator");
  assert.equal(isSizeSettled("1600x1600", "1600x1600"), false, "ascii x is not the format");
  assert.equal(isSizeSettled(1600, 1600), false, "a number is not a size string");
});
