import { test } from "node:test";
import assert from "node:assert/strict";

import { constantTimeEqual } from "../../src/core/constantTimeEqual";

test("equal strings compare equal", () => {
  assert.equal(constantTimeEqual("s3cret-token", "s3cret-token"), true);
});

test("empty strings compare equal to each other", () => {
  assert.equal(constantTimeEqual("", ""), true);
});

test("unequal strings of the same length compare unequal", () => {
  assert.equal(constantTimeEqual("s3cret-token", "s3cret-tokeN"), false);
});

test("strings of different lengths compare unequal", () => {
  assert.equal(constantTimeEqual("short", "a-much-longer-token"), false);
  assert.equal(constantTimeEqual("a-much-longer-token", "short"), false);
});

test("an empty string never matches a non-empty token", () => {
  assert.equal(constantTimeEqual("", "s3cret-token"), false);
  assert.equal(constantTimeEqual("s3cret-token", ""), false);
});

test("comparison is exact: no trimming, no case folding, no unicode normalisation", () => {
  assert.equal(constantTimeEqual("token", "token "), false);
  assert.equal(constantTimeEqual("token", "Token"), false);
  assert.equal(constantTimeEqual("\u00e9", "e\u0301"), false);
});

test("a difference in the final byte is still detected", () => {
  const a = "x".repeat(4096) + "a";
  const b = "x".repeat(4096) + "b";
  assert.equal(constantTimeEqual(a, b), false);
  assert.equal(constantTimeEqual(a, a), true);
});

test("handles strings longer than one SHA-256 block boundary (55/56/64 bytes)", () => {
  for (const length of [54, 55, 56, 63, 64, 65, 119, 120, 128]) {
    const value = "t".repeat(length);
    assert.equal(constantTimeEqual(value, value), true, `length ${length} should self-match`);
    assert.equal(constantTimeEqual(value, value + "!"), false, `length ${length} should differ`);
  }
});
