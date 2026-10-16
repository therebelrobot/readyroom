import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ValidationError,
  validateAnnotationInputs,
  validateAskHuman,
  validateCancelTicket,
  validateListPending,
  validateMediaUpload,
  validateWaitForAnswer,
} from "../../src/core/validation";
import { bytesToBase64 } from "../../src/core/media";

function isValidationError(error: unknown): boolean {
  return error instanceof ValidationError;
}

/** Valid base64 of `n` zero bytes. */
function b64(n: number): string {
  return bytesToBase64(new Uint8Array(n));
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

/* ------------------------------------------------------------------ *
 * Media (optional on ask_human)
 * ------------------------------------------------------------------ */

test("ask_human without media has no media field", () => {
  assert.equal(validateAskHuman({ question: "Ship it?" }).media, undefined);
  assert.equal(validateAskHuman({ question: "Ship it?", media: [] }).media, undefined);
});

test("ask_human accepts media, deriving the kind and normalizing the base64", () => {
  const input = validateAskHuman({
    question: "Which one?",
    media: [{ mime_type: "image/png", data_base64: "AA\nBB CC", filename: "shot.png", caption: "before" }],
  });
  assert.equal(input.media?.length, 1);
  assert.equal(input.media?.[0].mime_type, "image/png");
  assert.equal(input.media?.[0].data_base64, "AABBCC", "whitespace must be stripped");
  assert.equal(input.media?.[0].filename, "shot.png");
  assert.equal(input.media?.[0].caption, "before");
});

test("ask_human accepts a data: URI as the payload and derives the mime from it", () => {
  const input = validateAskHuman({
    question: "Look?",
    media: [{ data_base64: "data:image/png;base64," + b64(4) }],
  });
  assert.equal(input.media?.[0].mime_type, "image/png");
  assert.equal(input.media?.[0].data_base64, b64(4));
});

test("ask_human rejects malformed media", () => {
  assert.throws(() => validateAskHuman({ question: "Q?", media: "nope" }), isValidationError);
  assert.throws(
    () => validateAskHuman({ question: "Q?", media: [{ mime_type: "application/pdf", data_base64: b64(4) }] }),
    isValidationError,
    "an unsupported mime family must be rejected",
  );
  assert.throws(
    () => validateAskHuman({ question: "Q?", media: [{ mime_type: "image/png" }] }),
    isValidationError,
    "data_base64 is required",
  );
  assert.throws(
    () => validateAskHuman({ question: "Q?", media: [{ mime_type: "image/png", data_base64: "not base64!!" }] }),
    isValidationError,
  );
  assert.throws(
    () => validateAskHuman({ question: "Q?", media: [{ data_base64: b64(4) }] }),
    isValidationError,
    "a mime type is required when the payload is not a data: URI",
  );
  assert.throws(
    () => validateAskHuman({ question: "Q?", media: [{ mime_type: "image/png", data_base64: b64(4), bogus: 1 }] }),
    isValidationError,
    "unknown keys inside a media item must be rejected",
  );
});

test("ask_human caps the number of media files", () => {
  const many = Array.from({ length: 9 }, () => ({ mime_type: "image/png", data_base64: b64(4) }));
  assert.throws(() => validateAskHuman({ question: "Q?", media: many }), isValidationError);
});

test("ask_human rejects a media file over the per-file size cap before decoding it", () => {
  const oversized = "A".repeat(12_000_000); // ~9 MB decoded, over the 8 MiB cap
  assert.throws(
    () => validateAskHuman({ question: "Q?", media: [{ mime_type: "image/png", data_base64: oversized }] }),
    isValidationError,
  );
});

/* ------------------------------------------------------------------ *
 * Annotation input (POST /api/answer)
 * ------------------------------------------------------------------ */

test("annotations default to an empty array", () => {
  assert.deepEqual(validateAnnotationInputs(undefined), []);
  assert.deepEqual(validateAnnotationInputs(null), []);
  assert.deepEqual(validateAnnotationInputs([]), []);
});

test("annotations carry notes, targets, timestamps, and rendered copies", () => {
  const out = validateAnnotationInputs([
    { text: "  tighten the header  ", media_id: "abc", at_seconds: 12.5 },
    { annotated_media_id: "def" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, "tighten the header");
  assert.equal(out[0].media_id, "abc");
  assert.equal(out[0].at_seconds, 12.5);
  assert.equal(out[1].annotated_media_id, "def");
  assert.equal(out[1].text, undefined);
});

test("annotations reject empty, unsafe, and unknown-shaped entries", () => {
  assert.throws(() => validateAnnotationInputs([{}]), isValidationError, "an empty annotation is meaningless");
  assert.throws(() => validateAnnotationInputs([{ text: "   " }]), isValidationError);
  assert.throws(() => validateAnnotationInputs([{ text: "x", media_id: "../x" }]), isValidationError);
  assert.throws(() => validateAnnotationInputs([{ text: "x", at_seconds: -1 }]), isValidationError);
  assert.throws(() => validateAnnotationInputs([{ text: "x", extra: 1 }]), isValidationError);
  assert.throws(() => validateAnnotationInputs("nope"), isValidationError);
});

/* ------------------------------------------------------------------ *
 * Media upload (POST /api/media)
 * ------------------------------------------------------------------ */

test("media upload accepts a supported payload and rejects the rest", () => {
  const uploaded = validateMediaUpload({ mime_type: "image/png", data_base64: "data:image/png;base64," + b64(8) });
  assert.equal(uploaded.mime_type, "image/png");
  assert.equal(uploaded.data_base64, b64(8));

  assert.throws(() => validateMediaUpload({ mime_type: "application/pdf", data_base64: b64(4) }), isValidationError);
  assert.throws(() => validateMediaUpload({ data_base64: b64(4) }), isValidationError);
  assert.throws(() => validateMediaUpload({ mime_type: "image/png" }), isValidationError);
  assert.throws(() => validateMediaUpload({ mime_type: "image/png", data_base64: b64(4), bad: true }), isValidationError);
});
