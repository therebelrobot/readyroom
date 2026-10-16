import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeTicketStore } from "./fakeStore";
import { TOOL_DEFINITIONS, handleToolCall } from "../../src/core/tools";
import { answer, uploadMedia } from "../../src/core/queue";
import { DEFAULT_TIMEOUT_SECONDS } from "../../src/core/constants";
import { bytesToBase64 } from "../../src/core/media";
import type { ToolDeps } from "../../src/core/tools";
import type { ToolResult } from "../../src/core/types";

/** The first text content block. Content may also carry image/audio; these tests read text. */
function textOf(result: ToolResult): string {
  const first = result.content[0];
  return first !== undefined && first.type === "text" ? first.text : "";
}

const T0 = "2026-01-01T00:00:00.000Z";
const at = (offsetMs: number): string => new Date(Date.parse(T0) + offsetMs).toISOString();

function deps(store: FakeTicketStore, overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    store,
    defaultStream: "alpha",
    now: () => T0,
    // Tests never want a real sleep on the pending path.
    sleep: async () => undefined,
    ...overrides,
  };
}

test("TOOL_DEFINITIONS exposes the four tools with JSON Schema input schemas", () => {
  assert.deepEqual(
    TOOL_DEFINITIONS.map((definition) => definition.name),
    ["ask_human", "wait_for_answer", "list_pending", "cancel_ticket"],
  );
  const askHuman = TOOL_DEFINITIONS.find((definition) => definition.name === "ask_human");
  assert.ok(askHuman);
  assert.deepEqual((askHuman.inputSchema as { required?: string[] }).required, ["question"]);
  assert.equal((askHuman.inputSchema as { type?: string }).type, "object");
});

test("the ask_human description carries the protocol: continue working, call wait_for_answer later, no tight loop", () => {
  const askHuman = TOOL_DEFINITIONS.find((definition) => definition.name === "ask_human");
  assert.ok(askHuman);
  assert.match(askHuman.description, /continue with independent work/i);
  assert.match(askHuman.description, /wait_for_answer/);
  assert.match(askHuman.description, /do not poll in a tight loop/i);
  assert.match(askHuman.description, /never waits/i);
});

test("ask_human returns a pending ticket immediately, with structured content", async () => {
  const store = new FakeTicketStore();
  const result = await handleToolCall("ask_human", { question: "Ship it?" }, deps(store));

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.status, "pending");
  assert.equal(result.structuredContent.stream, "alpha");
  assert.equal(result.structuredContent.expires_at, at(DEFAULT_TIMEOUT_SECONDS * 1000));
  assert.match(textOf(result), /status pending/);
  assert.match(textOf(result), /wait_for_answer/);
  assert.match(textOf(result), /do not poll in a tight loop/i);
});

test("ask_human surfaces validation errors as an isError result", async () => {
  const store = new FakeTicketStore();
  const result = await handleToolCall("ask_human", { question: "" }, deps(store));

  assert.equal(result.isError, true);
  assert.match(textOf(result), /Error: \[ask_human\]/);
  assert.equal(store.tickets.size, 0);
});

test("wait_for_answer returns pending promptly when the wait is clamped (Worker target)", async () => {
  const store = new FakeTicketStore();
  const asked = await handleToolCall("ask_human", { question: "Ship it?" }, deps(store));
  const id = asked.structuredContent.id as string;

  const started = Date.now();
  const result = await handleToolCall("wait_for_answer", { id, timeout_seconds: 600 }, deps(store, { waitClampSeconds: 0 }));
  const elapsed = Date.now() - started;

  assert.equal(result.structuredContent.status, "pending");
  assert.ok(elapsed < 1000, `clamped wait should return promptly, took ${elapsed}ms`);
  assert.match(textOf(result), /still pending/);
  assert.match(textOf(result), /do not poll in a tight loop/i);
});

test("wait_for_answer returns a human answer prefixed with HUMAN ANSWER", async () => {
  const store = new FakeTicketStore();
  const asked = await handleToolCall("ask_human", { question: "Ship it?" }, deps(store));
  const id = asked.structuredContent.id as string;
  await answer(store, id, "yes", "human", at(1000));

  const result = await handleToolCall("wait_for_answer", { id }, deps(store));
  assert.equal(result.structuredContent.status, "answered");
  assert.equal(result.structuredContent.answer, "yes");
  assert.equal(result.structuredContent.answered_by, "human");
  assert.match(textOf(result), /^HUMAN ANSWER: yes$/);
});

test("wait_for_answer reports a default answer distinctly from a human answer", async () => {
  const store = new FakeTicketStore();
  const asked = await handleToolCall(
    "ask_human",
    { question: "Ship it?", default_answer: "proceed", timeout_seconds: 60 },
    deps(store),
  );
  const id = asked.structuredContent.id as string;

  const result = await handleToolCall("wait_for_answer", { id }, deps(store, { now: () => at(60_001) }));
  assert.equal(result.structuredContent.status, "expired");
  assert.equal(result.structuredContent.answer, "proceed");
  assert.match(textOf(result), /^DEFAULT ANSWER/);
  assert.doesNotMatch(textOf(result), /HUMAN ANSWER/);
});

test("wait_for_answer returns 404 as an isError result for an unknown id", async () => {
  const store = new FakeTicketStore();
  const result = await handleToolCall("wait_for_answer", { id: "missing" }, deps(store));
  assert.equal(result.isError, true);
  assert.match(textOf(result), /not found/);
});

test("wait_for_answer reports a cancelled ticket rather than pretending it is pending", async () => {
  const store = new FakeTicketStore();
  const asked = await handleToolCall("ask_human", { question: "Ship it?" }, deps(store));
  const id = asked.structuredContent.id as string;
  await handleToolCall("cancel_ticket", { id }, deps(store));

  const result = await handleToolCall("wait_for_answer", { id }, deps(store, { waitClampSeconds: 0 }));
  assert.equal(result.structuredContent.status, "cancelled");
  assert.match(textOf(result), /cancelled/);
});

test("list_pending returns the pending tickets", async () => {
  const store = new FakeTicketStore();
  await handleToolCall("ask_human", { question: "First?" }, deps(store));
  await handleToolCall("ask_human", { question: "Second?" }, deps(store, { defaultStream: "beta" }));

  const result = await handleToolCall("list_pending", {}, deps(store));
  const tickets = result.structuredContent.tickets as Array<{ question: string }>;
  assert.equal(tickets.length, 2);
  assert.match(textOf(result), /2 pending ticket\(s\)/);
  assert.match(textOf(result), /beta/);
});

test("list_pending with an empty queue says so", async () => {
  const store = new FakeTicketStore();
  const result = await handleToolCall("list_pending", {}, deps(store));
  assert.equal(textOf(result), "No pending tickets.");
  assert.deepEqual(result.structuredContent.tickets, []);
});

test("cancel_ticket marks the ticket cancelled", async () => {
  const store = new FakeTicketStore();
  const asked = await handleToolCall("ask_human", { question: "Ship it?" }, deps(store));
  const id = asked.structuredContent.id as string;

  const result = await handleToolCall("cancel_ticket", { id }, deps(store));
  assert.equal(result.structuredContent.status, "cancelled");
  assert.equal((await store.get(id))?.status, "cancelled");
});

test("an unknown tool name is an isError result", async () => {
  const store = new FakeTicketStore();
  const result = await handleToolCall("nope", {}, deps(store));
  assert.equal(result.isError, true);
  assert.match(textOf(result), /unknown tool/);
});

/* ------------------------------------------------------------------ *
 * Media and annotations
 * ------------------------------------------------------------------ */

const IMAGE = bytesToBase64(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));

test("ask_human validates and echoes media, and mentions the count", async () => {
  const store = new FakeTicketStore();
  const result = await handleToolCall(
    "ask_human",
    { question: "Look at this?", media: [{ mime_type: "image/png", data_base64: IMAGE }] },
    deps(store),
  );

  assert.equal(result.isError, undefined);
  const media = result.structuredContent.media as Array<{ kind: string; size_bytes: number }>;
  assert.equal(media.length, 1);
  assert.equal(media[0].kind, "image");
  assert.match(textOf(result), /media attachment/);
});

test("ask_human rejects malformed media as an isError result", async () => {
  const store = new FakeTicketStore();
  const result = await handleToolCall(
    "ask_human",
    { question: "Look?", media: [{ mime_type: "application/pdf", data_base64: IMAGE }] },
    deps(store),
  );
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Error: \[ask_human\]/);
  assert.equal(store.tickets.size, 0);
});

test("wait_for_answer returns annotations, and the rendered markup as image content", async () => {
  const store = new FakeTicketStore();
  const asked = await handleToolCall(
    "ask_human",
    { question: "Look?", media: [{ mime_type: "image/png", data_base64: IMAGE }] },
    deps(store),
  );
  const id = asked.structuredContent.id as string;
  const ticket = await store.get(id);
  const sourceId = ticket!.media![0].id;

  const rendered = await uploadMedia(store, { mime_type: "image/png", data_base64: IMAGE }, at(500));
  await answer(store, id, "ship it", "human", at(1000), [
    { text: "watch the header", media_id: sourceId, at_seconds: 3.5 },
    { annotated_media_id: rendered.id, media_id: sourceId },
  ]);

  const result = await handleToolCall("wait_for_answer", { id }, deps(store));
  assert.equal(result.structuredContent.status, "answered");

  const annotations = result.structuredContent.annotations as Array<{ text?: string; at_seconds?: number }>;
  assert.equal(annotations.length, 2);
  assert.equal(annotations[0].text, "watch the header");
  assert.equal(annotations[0].at_seconds, 3.5);

  const image = result.content.find((content) => content.type === "image");
  assert.ok(image, "the rendered markup must come back as image content");
  assert.equal((image as { mimeType: string }).mimeType, "image/png");
  assert.equal((image as { data: string }).data, IMAGE);

  assert.match(textOf(result), /HUMAN ANSWER: ship it/);
  assert.match(textOf(result), /annotation/i);
});

test("wait_for_answer reports an annotation-only answer as a human response with no text", async () => {
  const store = new FakeTicketStore();
  const asked = await handleToolCall("ask_human", { question: "Look?" }, deps(store));
  const id = asked.structuredContent.id as string;
  await answer(store, id, "", "human", at(1000), [{ text: "just this note" }]);

  const result = await handleToolCall("wait_for_answer", { id }, deps(store));
  assert.equal(result.structuredContent.status, "answered");
  assert.equal(result.structuredContent.answer, undefined);
  assert.match(textOf(result), /HUMAN ANSWER: \(no text/);
  assert.match(textOf(result), /just this note|annotation/i);
});
