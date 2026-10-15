import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ValidationError,
  validateAskHuman,
  validateCancelTicket,
  validateListPending,
  validateWaitForAnswer,
} from "../../src/core/validation";

function isValidationError(error: unknown): boolean {
  return error instanceof ValidationError;
}

test("ask_human accepts a one-sentence question", () => {
  const input = validateAskHuman({ question: "Should I ship it?" });
  assert.equal(input.question, "Should I ship it?");
});

test("ask_human accepts a single sentence without a trailing terminator", () => {
  const input = validateAskHuman({ question: "Which port should the server bind" });
  assert.equal(input.question, "Which port should the server bind");
});

test("ask_human rejects a missing or empty question", () => {
  assert.throws(() => validateAskHuman({}), isValidationError);
  assert.throws(() => validateAskHuman({ question: "" }), isValidationError);
  assert.throws(() => validateAskHuman({ question: "   " }), isValidationError);
});

test("ask_human rejects more than one sentence", () => {
  assert.throws(() => validateAskHuman({ question: "Ship it. Then deploy?" }), isValidationError);
  assert.throws(() => validateAskHuman({ question: "Do this! And that?" }), isValidationError);
});

test("ask_human does not over-reject abbreviations or decimals", () => {
  assert.equal(validateAskHuman({ question: "Which port, e.g. 8971 or 3000?" }).question, "Which port, e.g. 8971 or 3000?");
  assert.equal(validateAskHuman({ question: "Should I use 1.5 as the timeout?" }).question, "Should I use 1.5 as the timeout?");
});

test("ask_human enforces the 2-5 option rule", () => {
  assert.throws(() => validateAskHuman({ question: "Pick one?", options: ["only"] }), isValidationError);
  assert.throws(
    () => validateAskHuman({ question: "Pick one?", options: ["a", "b", "c", "d", "e", "f"] }),
    isValidationError,
  );
  assert.equal(validateAskHuman({ question: "Pick one?", options: ["a", "b"] }).options?.length, 2);
  assert.equal(validateAskHuman({ question: "Pick one?", options: ["a", "b", "c", "d", "e"] }).options?.length, 5);
  assert.throws(() => validateAskHuman({ question: "Pick one?", options: ["a", "  "] }), isValidationError);
});

test("ask_human enforces the timeout range and integer-ness", () => {
  assert.equal(validateAskHuman({ question: "Wait?", timeout_seconds: 1 }).timeout_seconds, 1);
  assert.equal(validateAskHuman({ question: "Wait?", timeout_seconds: 86400 }).timeout_seconds, 86400);
  assert.throws(() => validateAskHuman({ question: "Wait?", timeout_seconds: 0 }), isValidationError);
  assert.throws(() => validateAskHuman({ question: "Wait?", timeout_seconds: 86401 }), isValidationError);
  assert.throws(() => validateAskHuman({ question: "Wait?", timeout_seconds: 1.5 }), isValidationError);
  assert.throws(() => validateAskHuman({ question: "Wait?", timeout_seconds: "60" }), isValidationError);
});

test("ask_human enforces the urgency enum", () => {
  assert.equal(validateAskHuman({ question: "Urgent?", urgency: "blocking" }).urgency, "blocking");
  assert.equal(validateAskHuman({ question: "Urgent?", urgency: "low" }).urgency, "low");
  assert.throws(() => validateAskHuman({ question: "Urgent?", urgency: "urgent" }), isValidationError);
});

test("ask_human rejects unknown arguments", () => {
  assert.throws(() => validateAskHuman({ question: "Ship it?", timeout: 60 }), isValidationError);
});

test("wait_for_answer requires an id and clamps the timeout to 600", () => {
  assert.equal(validateWaitForAnswer({ id: "abc" }).id, "abc");
  assert.equal(validateWaitForAnswer({ id: "abc", timeout_seconds: 600 }).timeout_seconds, 600);
  assert.throws(() => validateWaitForAnswer({}), isValidationError);
  assert.throws(() => validateWaitForAnswer({ id: "" }), isValidationError);
  assert.throws(() => validateWaitForAnswer({ id: "abc", timeout_seconds: 601 }), isValidationError);
  assert.throws(() => validateWaitForAnswer({ id: "abc", timeout_seconds: 0 }), isValidationError);
});

test("cancel_ticket requires an id", () => {
  assert.equal(validateCancelTicket({ id: "abc" }).id, "abc");
  assert.throws(() => validateCancelTicket({}), isValidationError);
  assert.throws(() => validateCancelTicket({ id: "   " }), isValidationError);
});

test("list_pending takes no input", () => {
  assert.doesNotThrow(() => validateListPending({}));
  assert.doesNotThrow(() => validateListPending(undefined));
  assert.throws(() => validateListPending({ id: "abc" }), isValidationError);
});
