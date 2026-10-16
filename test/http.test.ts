/**
 * Integration tests for the HTTP request handler.
 *
 * A real `node:http` server is started on an ephemeral port against a
 * `FileTicketStore` in a temp dir, then driven with `fetch`. This exercises the actual
 * route table, the Bearer guard, the `QueueError` status mapping, and the `/mcp` Origin
 * guard — not mocks of them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHttpApp } from "../src/http";
import type { HttpApp } from "../src/http";
import { createMcpServer, attachStreamableHttp } from "../src/mcp";
import { FileTicketStore } from "../src/storage/file";
import { enqueue } from "../src/core/queue";
import { bytesToBase64 } from "../src/core/media";
import type { Ticket } from "../src/core/types";

const TOKEN = "test-token";
const AUTHORIZATION: Record<string, string> = { authorization: `Bearer ${TOKEN}` };

interface Harness {
  base: string;
  port: number;
  store: FileTicketStore;
  stop: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "readyroom-http-"));
  const store = new FileTicketStore(dir);
  await store.load();

  const now = (): string => new Date().toISOString();

  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;

  const mcp = await attachStreamableHttp(() => createMcpServer({ store, now }), {
    port,
    allowedOrigins: [`http://127.0.0.1:${port}`],
  });

  const app: HttpApp = createHttpApp({
    store,
    token: TOKEN,
    now,
    allowedOrigins: [`http://127.0.0.1:${port}`],
    mcpHandler: mcp.handle,
    // Long intervals so the timers never fire mid-test; the constructor's one seed
    // sweep still runs.
    sweepMs: 1_000_000,
    heartbeatMs: 1_000_000,
  });
  server.on("request", app.handler);

  return {
    base: `http://127.0.0.1:${port}`,
    port,
    store,
    stop: async () => {
      await app.close();
      await mcp.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}

function postJson(url: string, body: unknown, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { ...AUTHORIZATION, "content-type": "application/json", ...extra },
    body: JSON.stringify(body),
  });
}

test("GET /healthz returns 200 with body exactly `ok`", async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(`${harness.base}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  } finally {
    await harness.stop();
  }
});

test("GET /api/tickets: 401 without a token, 200 with it", async () => {
  const harness = await startHarness();
  try {
    const anon = await fetch(`${harness.base}/api/tickets`);
    assert.equal(anon.status, 401, "no Authorization header must be rejected");

    const wrong = await fetch(`${harness.base}/api/tickets`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.equal(wrong.status, 401, "a mismatched token must be rejected");

    const authed = await fetch(`${harness.base}/api/tickets`, { headers: AUTHORIZATION });
    assert.equal(authed.status, 200);
    const body = (await authed.json()) as { tickets: Ticket[] };
    assert.deepEqual(body.tickets, []);
  } finally {
    await harness.stop();
  }
});

test("POST /api/answer maps 404 (unknown), 409 (already answered), 200 (ok)", async () => {
  const harness = await startHarness();
  try {
    const missing = await postJson(`${harness.base}/api/answer`, { id: "does-not-exist", answer: "yes" });
    assert.equal(missing.status, 404);

    const ticket = await enqueue(
      harness.store,
      { question: "Proceed?" },
      { defaultStream: "alpha", now: new Date().toISOString() },
    );

    const ok = await postJson(`${harness.base}/api/answer`, {
      id: ticket.id,
      answer: "yes",
      answered_by: "human",
    });
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as { ticket: Ticket };
    assert.equal(okBody.ticket.status, "answered");
    assert.equal(okBody.ticket.answer, "yes");

    const again = await postJson(`${harness.base}/api/answer`, { id: ticket.id, answer: "no" });
    assert.equal(again.status, 409);
  } finally {
    await harness.stop();
  }
});

test("POST /api/undo: 200 inside the window, 409 outside it", async () => {
  const harness = await startHarness();
  try {
    const ticket = await enqueue(
      harness.store,
      { question: "Proceed?" },
      { defaultStream: "alpha", now: new Date().toISOString() },
    );
    assert.equal((await postJson(`${harness.base}/api/answer`, { id: ticket.id, answer: "yes" })).status, 200);
    const undone = await postJson(`${harness.base}/api/undo`, { id: ticket.id });
    assert.equal(undone.status, 200);

    // A ticket answered ten minutes ago is past the five-minute undo window.
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
    await harness.store.put(stale);

    const closed = await postJson(`${harness.base}/api/undo`, { id: "stale-ticket" });
    assert.equal(closed.status, 409);
  } finally {
    await harness.stop();
  }
});

test("POST /internal/tool-call runs a tool and honours the forwarded stream", async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(`${harness.base}/internal/tool-call`, {
      method: "POST",
      headers: {
        ...AUTHORIZATION,
        "content-type": "application/json",
        "x-readyroom-stream": "beta-agent",
      },
      body: JSON.stringify({ name: "ask_human", args: { question: "Ship it?" } }),
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as { structuredContent: { status: string; stream: string } };
    assert.equal(result.structuredContent.status, "pending");
    assert.equal(result.structuredContent.stream, "beta-agent", "the forwarded stream must label the ticket");
  } finally {
    await harness.stop();
  }
});

test("POST /mcp serves two sequential requests on one handle (stateless transport is not reused)", async () => {
  const harness = await startHarness();
  try {
    const origin = `http://127.0.0.1:${harness.port}`;
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "readyroom-test", version: "0.0.0" },
      },
    };

    const post = (): Promise<Response> =>
      fetch(`${harness.base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          origin,
        },
        body: JSON.stringify(initialize),
      });

    const first = await post();
    assert.equal(first.status, 200, "the first POST /mcp must succeed");

    // A stateless transport may serve exactly one request. Reusing it makes the SDK
    // throw, which the handler swallows into a 500 with an empty body.
    const second = await post();
    assert.equal(second.status, 200, "the second POST /mcp must not 500 (stateless transport reuse)");
  } finally {
    await harness.stop();
  }
});

test("POST /mcp rejects a missing or mismatched Origin with 403", async () => {
  const harness = await startHarness();
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    const noOrigin = await fetch(`${harness.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(noOrigin.status, 403, "a missing Origin must be rejected");

    const badOrigin = await fetch(`${harness.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body,
    });
    assert.equal(badOrigin.status, 403, "an unlisted Origin must be rejected");
  } finally {
    await harness.stop();
  }
});

test("unknown route is 404; known route with the wrong method is 405", async () => {
  const harness = await startHarness();
  try {
    assert.equal((await fetch(`${harness.base}/nope`)).status, 404);
    assert.equal((await fetch(`${harness.base}/healthz`, { method: "POST" })).status, 405);
  } finally {
    await harness.stop();
  }
});

/* ------------------------------------------------------------------ *
 * Media and annotations
 * ------------------------------------------------------------------ */

const IMAGE_BYTES = bytesToBase64(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));

test("POST /api/media stores a blob and GET /api/media/{id} serves it", async () => {
  const harness = await startHarness();
  try {
    const anon = await fetch(`${harness.base}/api/media`, { method: "POST" });
    assert.equal(anon.status, 401, "media upload must require the token");

    const upload = await postJson(`${harness.base}/api/media`, {
      mime_type: "image/png",
      data_base64: IMAGE_BYTES,
    });
    assert.equal(upload.status, 201);
    const body = (await upload.json()) as { media: { id: string; kind: string } };
    assert.equal(body.media.kind, "image");
    assert.ok(body.media.id);

    const served = await fetch(`${harness.base}/api/media/${body.media.id}`, { headers: AUTHORIZATION });
    assert.equal(served.status, 200);
    assert.match(served.headers.get("content-type") ?? "", /image\/png/);
    assert.deepEqual([...new Uint8Array(await served.arrayBuffer())], [137, 80, 78, 71, 13, 10, 26, 10]);

    const noAuth = await fetch(`${harness.base}/api/media/${body.media.id}`);
    assert.equal(noAuth.status, 401);

    const missing = await fetch(`${harness.base}/api/media/does-not-exist`, { headers: AUTHORIZATION });
    assert.equal(missing.status, 404);

    const wrongMethod = await fetch(`${harness.base}/api/media`, { headers: AUTHORIZATION });
    assert.equal(wrongMethod.status, 405);
  } finally {
    await harness.stop();
  }
});

test("POST /api/answer accepts annotations, including a rendered copy, and they appear on the page payload", async () => {
  const harness = await startHarness();
  try {
    const ticket = await enqueue(
      harness.store,
      { question: "Look?", media: [{ mime_type: "image/png", data_base64: IMAGE_BYTES }] },
      { defaultStream: "alpha", now: new Date().toISOString() },
    );

    const upload = await postJson(`${harness.base}/api/media`, {
      mime_type: "image/png",
      data_base64: IMAGE_BYTES,
    });
    const rendered = (await upload.json()) as { media: { id: string } };

    const answered = await postJson(`${harness.base}/api/answer`, {
      id: ticket.id,
      answer: "ship it",
      annotations: [
        { text: "watch this", media_id: ticket.media![0].id, at_seconds: 2.5 },
        { annotated_media_id: rendered.media.id, media_id: ticket.media![0].id },
      ],
    });
    assert.equal(answered.status, 200);
    const answeredBody = (await answered.json()) as { ticket: Ticket };
    assert.equal(answeredBody.ticket.annotations?.length, 2);

    const page = await fetch(`${harness.base}/api/tickets`, { headers: AUTHORIZATION });
    const pageBody = (await page.json()) as { tickets: Ticket[] };
    const recorded = pageBody.tickets.find((t) => t.id === ticket.id);
    assert.equal(recorded?.annotations?.length, 2);
    assert.equal(recorded?.annotations?.[1].annotated_media?.id, rendered.media.id);
  } finally {
    await harness.stop();
  }
});

test("POST /api/answer with neither text nor annotations is 400", async () => {
  const harness = await startHarness();
  try {
    const ticket = await enqueue(
      harness.store,
      { question: "Look?" },
      { defaultStream: "alpha", now: new Date().toISOString() },
    );
    const response = await postJson(`${harness.base}/api/answer`, { id: ticket.id, answer: "" });
    assert.equal(response.status, 400);
  } finally {
    await harness.stop();
  }
});
