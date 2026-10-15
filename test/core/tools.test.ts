import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeTicketStore } from "./fakeStore";
import { TOOL_DEFINITIONS, handleToolCall } from "../../src/core/tools";
import { answer } from "../../src/core/queue";
import { DEFAULT_TIMEOUT_SECONDS } from "../../src/core/constants";
import type { ToolDeps } from "../../src/core/tools";

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
  assert.match(result.content[0].text, /status pending/);
  assert.match(result.content[0].text, /wait_for_answer/);
  assert.match(result.content[0].text, /do not poll in a tight loop/i);
});

test("ask_human surfaces validation errors as an isError result", async () => {
  const store = new FakeTicketStore();
  const result = await handleToolCall("ask_human", { question: "" }, deps(store));

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Error: \[ask_human\]/);
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
  assert.match(result.content[0].text, /still pending/);
  assert.match(result.content[0].text, /do not poll in a tight loop/i);
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
  assert.match(result.content[0].text, /^HUMAN ANSWER: yes$/);
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
  assert.match(result.content[0].text, /^DEFAULT ANSWER/);
  assert.doesNotMatch(result.content[0].text, /HUMAN ANSWER/);
});

test("wait_for_answer returns 404 as an isError result for an unknown id", async () => {
  const store = new FakeTicketStore();
  const result = await handleToolCall("wait_for_answer", { id: "missing" }, deps(store));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found/);
});

test("wait_for_answer reports a cancelled ticket rather than pretending it is pending", async () => {
  const store = new FakeTicketStore();
  const asked = await handleToolCall("ask_human", { question: "Ship it?" }, deps(store));
  const id = asked.structuredContent.id as string;
  await handleToolCall("cancel_ticket", { id }, deps(store));

  const result = await handleToolCall("wait_for_answer", { id }, deps(store, { waitClampSeconds: 0 }));
  assert.equal(result.structuredContent.status, "cancelled");
  assert.match(result.content[0].text, /cancelled/);
});

test("list_pending returns the pending tickets", async () => {
  const store = new FakeTicketStore();
  await handleToolCall("ask_human", { question: "First?" }, deps(store));
  await handleToolCall("ask_human", { question: "Second?" }, deps(store, { defaultStream: "beta" }));

  const result = await handleToolCall("list_pending", {}, deps(store));
  const tickets = result.structuredContent.tickets as Array<{ question: string }>;
  assert.equal(tickets.length, 2);
  assert.match(result.content[0].text, /2 pending ticket\(s\)/);
  assert.match(result.content[0].text, /beta/);
});

test("list_pending with an empty queue says so", async () => {
  const store = new FakeTicketStore();
  const result = await handleToolCall("list_pending", {}, deps(store));
  assert.equal(result.content[0].text, "No pending tickets.");
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
  assert.match(result.content[0].text, /unknown tool/);
});
