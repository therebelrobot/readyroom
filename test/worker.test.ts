/**
 * Tests for the Cloudflare Worker route table, guards, stream resolution, and the
 * `wait_for_answer` clamp.
 *
 * The router is exercised through `handleRequest(request, env, deps)` with a fake
 * `TicketStore`, so nothing here needs a live Cloudflare account or a Durable Object.
 * The `/mcp` mount is injected as a fake handler that delegates to the real
 * `callWorkerTool`, so the stream-resolution and clamp logic under test is the real one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { callWorkerTool, handleRequest } from "../src/worker";
import type { WorkerDeps, WorkerEnv } from "../src/worker";
import { WORKER_WAIT_CLAMP_SECONDS } from "../src/core/constants";
import { enqueue } from "../src/core/queue";
import { bytesToBase64 } from "../src/core/media";
import type { Ticket, ToolResult } from "../src/core/types";
import { FakeTicketStore } from "./core/fakeStore";

const IMAGE_BYTES = bytesToBase64(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));

const TOKEN = "test-token";
const ORIGIN = "https://readyroom.example.workers.dev";

function env(): WorkerEnv {
  return { READYROOM_TOKEN: TOKEN };
}

function deps(store: FakeTicketStore, mcpHandler?: WorkerDeps["mcpHandler"]): WorkerDeps {
  return { store, now: () => new Date().toISOString(), mcpHandler };
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

/** The first text content block. Content may also carry image/audio; these tests read text. */
function textOf(result: ToolResult): string {
  const first = result.content[0];
  return first !== undefined && first.type === "text" ? first.text : "";
}

function authed(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TOKEN}`);
  return req(path, { ...init, headers });
}

function postJson(path: string, body: unknown): Request {
  return authed(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A fake `/mcp` handler that runs the real tool dispatch and serializes the result. */
function toolHandler(store: FakeTicketStore): WorkerDeps["mcpHandler"] {
  return async (request, stream) => {
    const body = (await request.json()) as { name: string; args?: unknown };
    const result = await callWorkerTool(body.name, body.args, {
      store,
      now: () => new Date().toISOString(),
      stream,
    });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

test("GET /healthz returns 200 with body exactly `ok`", async () => {
  const store = new FakeTicketStore();
  const response = await handleRequest(req("/healthz"), env(), deps(store));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
});

test("GET /api/tickets: 401 without a token, 401 with a wrong token, 200 with the token", async () => {
  const store = new FakeTicketStore();

  const anon = await handleRequest(req("/api/tickets"), env(), deps(store));
  assert.equal(anon.status, 401, "no Authorization header must be rejected");

  const wrong = await handleRequest(
    req("/api/tickets", { headers: { authorization: "Bearer wrong-token" } }),
    env(),
    deps(store),
  );
  assert.equal(wrong.status, 401, "a mismatched token must be rejected");

  const ok = await handleRequest(authed("/api/tickets"), env(), deps(store));
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { tickets: Ticket[] };
  assert.deepEqual(body.tickets, []);
});

test("GET /api/tickets rejects a token-less Worker even when no token is configured", async () => {
  const store = new FakeTicketStore();
  // No READYROOM_TOKEN in env: the Worker has no loopback fallback, so this is a 401.
  const response = await handleRequest(req("/api/tickets"), {}, deps(store));
  assert.equal(response.status, 401);
});

test("GET /api/events returns 501 with a plain-text body", async () => {
  const store = new FakeTicketStore();
  const response = await handleRequest(authed("/api/events"), env(), deps(store));
  assert.equal(response.status, 501);
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
  assert.match(await response.text(), /not available/i);
});

test("POST /api/answer maps 404 (unknown), 409 (already answered), 200 (ok)", async () => {
  const store = new FakeTicketStore();

  const missing = await handleRequest(postJson("/api/answer", { id: "does-not-exist", answer: "yes" }), env(), deps(store));
  assert.equal(missing.status, 404);

  const ticket = await enqueue(
    store,
    { question: "Proceed?" },
    { defaultStream: "alpha", now: new Date().toISOString() },
  );

  const ok = await handleRequest(postJson("/api/answer", { id: ticket.id, answer: "yes" }), env(), deps(store));
  assert.equal(ok.status, 200);
  const okBody = (await ok.json()) as { ticket: Ticket };
  assert.equal(okBody.ticket.status, "answered");
  assert.equal(okBody.ticket.answer, "yes");

  const again = await handleRequest(postJson("/api/answer", { id: ticket.id, answer: "no" }), env(), deps(store));
  assert.equal(again.status, 409);
});

test("POST /api/undo: 200 inside the window, 409 outside it", async () => {
  const store = new FakeTicketStore();

  const ticket = await enqueue(
    store,
    { question: "Proceed?" },
    { defaultStream: "alpha", now: new Date().toISOString() },
  );
  assert.equal((await handleRequest(postJson("/api/answer", { id: ticket.id, answer: "yes" }), env(), deps(store))).status, 200);
  assert.equal((await handleRequest(postJson("/api/undo", { id: ticket.id }), env(), deps(store))).status, 200);

  const staleStamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const stale: Ticket = {
    id: "stale-ticket",
    stream: "alpha",
    question: "Proceed?",
    urgency: "normal",
    status: "answered",
    created_at: staleStamp,
    expires_at: staleStamp,
    answer: "yes",
    answered_by: "human",
    answered_at: staleStamp,
  };
  await store.put(stale);

  const closed = await handleRequest(postJson("/api/undo", { id: "stale-ticket" }), env(), deps(store));
  assert.equal(closed.status, 409);
});

test("POST /mcp/foo with a missing Origin is rejected with 403 before the handler runs", async () => {
  const store = new FakeTicketStore();
  let handlerRan = false;
  const handler: WorkerDeps["mcpHandler"] = async () => {
    handlerRan = true;
    return new Response("should not run");
  };

  const response = await handleRequest(req("/mcp/foo", { method: "POST", body: "{}" }), env(), deps(store, handler));
  assert.equal(response.status, 403);
  assert.equal(handlerRan, false, "the Origin guard must run before the MCP handler");
});

test("POST /mcp/foo with a mismatched Origin is rejected with 403", async () => {
  const store = new FakeTicketStore();
  const response = await handleRequest(
    req("/mcp/foo", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }),
    env(),
    deps(store, toolHandler(store)),
  );
  assert.equal(response.status, 403);
});

test("POST /mcp/{stream} with a matching Origin reaches the handler and labels the ticket", async () => {
  const store = new FakeTicketStore();
  const response = await handleRequest(
    req("/mcp/beta-agent", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "ask_human", args: { question: "Ship it?" } }),
    }),
    env(),
    deps(store, toolHandler(store)),
  );
  assert.equal(response.status, 200);
  const result = (await response.json()) as ToolResult;
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent["status"], "pending");
  assert.equal(result.structuredContent["stream"], "beta-agent");
});

test("POST /mcp/ with no stream and no explicit stream arg returns a clear error naming both supply paths", async () => {
  const store = new FakeTicketStore();
  const response = await handleRequest(
    req("/mcp/", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "ask_human", args: { question: "Ship it?" } }),
    }),
    env(),
    deps(store, toolHandler(store)),
  );
  assert.equal(response.status, 200);
  const result = (await response.json()) as ToolResult;
  assert.equal(result.isError, true);

  const message = textOf(result);
  assert.match(message, /POST \/mcp\/\{stream\}/, "must name the path-segment way to supply the stream");
  assert.match(message, /`stream` argument/, "must name the explicit-argument way to supply the stream");
});

test("POST /mcp/ with an explicit stream argument succeeds", async () => {
  const store = new FakeTicketStore();
  const response = await handleRequest(
    req("/mcp/", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "ask_human", args: { question: "Ship it?", stream: "gamma" } }),
    }),
    env(),
    deps(store, toolHandler(store)),
  );
  assert.equal(response.status, 200);
  const result = (await response.json()) as ToolResult;
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent["stream"], "gamma");
});

test("wait_for_answer with the Worker clamp returns pending promptly", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(
    store,
    { question: "Proceed?" },
    { defaultStream: "alpha", now: new Date().toISOString() },
  );

  // The seam keeps the test fast; the production default is asserted separately below.
  const started = Date.now();
  const result = await callWorkerTool(
    "wait_for_answer",
    { id: ticket.id, timeout_seconds: 600 },
    { store, now: () => new Date().toISOString(), stream: "alpha", waitClampSeconds: 0 },
  );
  const elapsed = Date.now() - started;

  assert.equal(result.structuredContent["status"], "pending");
  assert.ok(elapsed < 1000, `expected a prompt return, took ${elapsed}ms`);
});

test("wait_for_answer uses WORKER_WAIT_CLAMP_SECONDS by default and does not hang", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(
    store,
    { question: "Proceed?" },
    { defaultStream: "alpha", now: new Date().toISOString() },
  );

  const started = Date.now();
  const result = await callWorkerTool(
    "wait_for_answer",
    { id: ticket.id, timeout_seconds: 600 },
    { store, now: () => new Date().toISOString(), stream: "alpha" },
  );
  const elapsed = Date.now() - started;

  assert.equal(result.structuredContent["status"], "pending");
  assert.ok(
    elapsed < WORKER_WAIT_CLAMP_SECONDS * 1000 + 3000,
    `expected the clamp (${WORKER_WAIT_CLAMP_SECONDS}s) to bound the wait, took ${elapsed}ms`,
  );
});

test("unknown route is 404 and a known route with the wrong method is 405", async () => {
  const store = new FakeTicketStore();

  const notFound = await handleRequest(req("/nope"), env(), deps(store));
  assert.equal(notFound.status, 404);

  const wrongMethod = await handleRequest(req("/api/answer"), env(), deps(store));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
});

/* ------------------------------------------------------------------ *
 * Media and annotations
 * ------------------------------------------------------------------ */

test("POST /api/media and GET /api/media/{id} round-trip through the Worker router", async () => {
  const store = new FakeTicketStore();

  const anon = await handleRequest(req("/api/media", { method: "POST" }), env(), deps(store));
  assert.equal(anon.status, 401, "media upload must require the token");

  const upload = await handleRequest(
    postJson("/api/media", { mime_type: "image/png", data_base64: IMAGE_BYTES }),
    env(),
    deps(store),
  );
  assert.equal(upload.status, 201);
  const body = (await upload.json()) as { media: { id: string; kind: string } };
  assert.equal(body.media.kind, "image");

  const served = await handleRequest(authed(`/api/media/${body.media.id}`), env(), deps(store));
  assert.equal(served.status, 200);
  assert.match(served.headers.get("content-type") ?? "", /image\/png/);
  assert.deepEqual([...new Uint8Array(await served.arrayBuffer())], [137, 80, 78, 71, 13, 10, 26, 10]);

  const missing = await handleRequest(authed("/api/media/does-not-exist"), env(), deps(store));
  assert.equal(missing.status, 404);

  const wrongMethod = await handleRequest(authed("/api/media"), env(), deps(store));
  assert.equal(wrongMethod.status, 405);
});

test("POST /api/answer accepts annotations and records them on the ticket", async () => {
  const store = new FakeTicketStore();

  const ticket = await enqueue(
    store,
    { question: "Look?", media: [{ mime_type: "image/png", data_base64: IMAGE_BYTES }] },
    { defaultStream: "alpha", now: new Date().toISOString() },
  );
  const upload = await handleRequest(
    postJson("/api/media", { mime_type: "image/png", data_base64: IMAGE_BYTES }),
    env(),
    deps(store),
  );
  const rendered = (await upload.json()) as { media: { id: string } };

  const answered = await handleRequest(
    postJson("/api/answer", {
      id: ticket.id,
      answer: "ship it",
      annotations: [{ annotated_media_id: rendered.media.id, media_id: ticket.media![0].id }],
    }),
    env(),
    deps(store),
  );
  assert.equal(answered.status, 200);
  const body = (await answered.json()) as { ticket: Ticket };
  assert.equal(body.ticket.annotations?.length, 1);
  assert.equal(body.ticket.annotations?.[0].annotated_media?.id, rendered.media.id);
});

test("POST /api/answer with neither text nor annotations is 400 on the Worker", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(
    store,
    { question: "Look?" },
    { defaultStream: "alpha", now: new Date().toISOString() },
  );
  const response = await handleRequest(postJson("/api/answer", { id: ticket.id, answer: "" }), env(), deps(store));
  assert.equal(response.status, 400);
});
