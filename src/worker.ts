/**
 * The Cloudflare Worker entry — `export default { fetch }`, the Durable Object class,
 * and the fetch-based route table that mirrors `src/http.ts`.
 *
 * Route table (web-standard `Request`/`Response`):
 *   GET  /healthz          -> 200, body exactly "ok"
 *   GET  /                 -> 200 text/html, the inlined readyroom page
 *   GET  /api/tickets      -> 200 { tickets }                 (Bearer)
 *   GET  /api/events       -> 501 plain text                  (Bearer)
 *   POST /api/answer       -> 200 | 404 | 409                 (Bearer)
 *   POST /api/undo         -> 200 | 404 | 409                 (Bearer)
 *   POST /mcp/{stream}     -> the Streamable HTTP MCP endpoint (Origin-guarded)
 *   unknown route -> 404; known route, wrong method -> 405
 *
 * Three Worker-only consequences, all from the spec's "Cloudflare" section:
 *   1. The token is mandatory. There is no loopback and no safe fallback, so a
 *      token-less request to any `/api/*` route is rejected. `requireBearer` here
 *      returns false when no token is configured, unlike the Node target.
 *   2. `/api/events` returns 501. The readyroom page's polling fallback carries the
 *      Worker target; no Durable-Object-held stream fleet is built for v1.
 *   3. `wait_for_answer` clamps its wait to `WORKER_WAIT_CLAMP_SECONDS` and returns
 *      `status: "pending"` promptly rather than hanging. This is the one place the
 *      three targets differ in observable behavior, and it must NOT error.
 *
 * Stream resolution: there is no `cwd` on Workers, so `basename(cwd)` cannot be the
 * fallback. The stream is required and comes from the `POST /mcp/{stream}` path
 * segment, or from an explicit `stream` tool argument. If neither is present the tool
 * call fails with an error naming both ways to supply it. No default is invented.
 *
 * Durable Object addressing: the Worker obtains the stub with
 * `env.QUEUE.get(env.QUEUE.idFromName("queue"))`, so every request lands on the same
 * instance — the single-writer invariant expressed on the edge. The Worker talks to it
 * over `stub.fetch(...)` with a tiny internal JSON protocol (`{ op, args }`), which is
 * the simplest correct pattern for this wrangler version and needs no RPC type
 * plumbing. `DurableObjectTicketStore` lives inside the DO and owns the SQL.
 *
 * All logging goes to stderr (`console.error`). Nothing is written to stdout.
 */

import page from "../public/index.html";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { WORKER_WAIT_CLAMP_SECONDS } from "./core/constants";
import { constantTimeEqual } from "./core/constantTimeEqual";
import { QueueError, answer as answerTicket, listForPage, undo as undoTicket } from "./core/queue";
import { TOOL_DEFINITIONS, handleToolCall } from "./core/tools";
import type { AuditEntry, Status, Ticket, TicketStore, ToolResult } from "./core/types";
import { DurableObjectTicketStore } from "./storage/durableObject";
import type {
  DurableObjectNamespace,
  DurableObjectState,
  DurableObjectStub,
  ExecutionContext,
} from "./worker-types";

const SERVER_NAME = "readyroom";
const SERVER_VERSION = "0.1.0";

const BEARER_PREFIX = "bearer ";

/** Methods the Streamable HTTP MCP endpoint accepts, mirroring the Node route table. */
const MCP_METHODS: readonly string[] = ["GET", "POST", "DELETE"];

/** Every non-MCP path the route table knows, with the methods it accepts (for 405). */
const ROUTE_METHODS: Record<string, readonly string[]> = {
  "/healthz": ["GET"],
  "/": ["GET"],
  "/api/tickets": ["GET"],
  "/api/events": ["GET"],
  "/api/answer": ["POST"],
  "/api/undo": ["POST"],
};

/* ------------------------------------------------------------------ *
 * Environment and dependency shapes
 * ------------------------------------------------------------------ */

/**
 * The non-binding environment. `READYROOM_TOKEN` is supplied via
 * `wrangler secret put READYROOM_TOKEN` and is never committed.
 */
export interface WorkerEnv {
  READYROOM_TOKEN?: string;
  /** Optional comma-separated extra origins for the `/mcp` Origin guard. */
  READYROOM_ALLOWED_ORIGINS?: string;
}

/** The full Worker environment, including the Durable Object binding. */
export interface Env extends WorkerEnv {
  QUEUE: DurableObjectNamespace;
}

/** Injected dependencies, so the router is testable without a live Cloudflare account. */
export interface WorkerDeps {
  store: TicketStore;
  /** Current time as an ISO-8601 string. */
  now: () => string;
  /** The `/mcp` mount. Receives the stream parsed from the path (or `undefined`). */
  mcpHandler?: (request: Request, stream: string | undefined) => Promise<Response>;
}

/* ------------------------------------------------------------------ *
 * Small response helpers
 * ------------------------------------------------------------------ */

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read and JSON-parse the request body. Empty body resolves `undefined`; bad JSON throws. */
async function readJsonBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (raw.trim() === "") {
    return undefined;
  }
  return JSON.parse(raw);
}

/* ------------------------------------------------------------------ *
 * Guards (web-standard reimplementations of `src/security.ts`)
 * ------------------------------------------------------------------ */

/**
 * Security rule 2, Worker edition: every `/api/*` route requires
 * `Authorization: Bearer $READYROOM_TOKEN`, compared in constant time.
 *
 * Unlike the Node target, a missing token is a rejection, not an allow: the Worker is
 * public by construction, so there is no loopback to fall back on.
 */
function requireBearer(request: Request, token: string | undefined): boolean {
  if (token === undefined || token === "") {
    return false;
  }
  const header = request.headers.get("authorization");
  if (header === null) {
    return false;
  }
  if (header.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) {
    return false;
  }
  return constantTimeEqual(header.slice(BEARER_PREFIX.length).trim(), token);
}

/**
 * Origin guard for the Streamable HTTP MCP endpoint. A missing or unlisted `Origin` is
 * rejected with 403, per the spec and the MCP specification's HTTP transport rules.
 */
function checkOrigin(request: Request, allowedOrigins: readonly string[]): boolean {
  const origin = request.headers.get("origin");
  if (origin === null || origin === "") {
    return false;
  }
  return allowedOrigins.includes(origin);
}

/**
 * The `/mcp` Origin allowlist: the Worker's own origin (the page is served from the
 * same origin as the MCP endpoint) plus any `READYROOM_ALLOWED_ORIGINS` entries.
 */
function buildWorkerAllowedOrigins(request: Request, env: WorkerEnv): string[] {
  const origins = [new URL(request.url).origin];
  const extra = env.READYROOM_ALLOWED_ORIGINS;
  if (extra !== undefined) {
    for (const origin of extra.split(",")) {
      const trimmed = origin.trim();
      if (trimmed !== "" && !origins.includes(trimmed)) {
        origins.push(trimmed);
      }
    }
  }
  return origins;
}

/* ------------------------------------------------------------------ *
 * Stream resolution
 * ------------------------------------------------------------------ */

/** The stream from `POST /mcp/{stream}`, or `undefined` when the path has no segment. */
function extractStream(path: string): string | undefined {
  if (!path.startsWith("/mcp/")) {
    return undefined;
  }
  const raw = path.slice("/mcp/".length);
  if (raw === "") {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const trimmed = decoded.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** True when a stream is available from the path segment or an explicit tool argument. */
function hasStream(args: unknown, stream: string | undefined): boolean {
  if (stream !== undefined && stream.trim() !== "") {
    return true;
  }
  if (isRecord(args)) {
    const value = args["stream"];
    if (typeof value === "string" && value.trim() !== "") {
      return true;
    }
  }
  return false;
}

/**
 * The error returned when no stream can be resolved on the Worker. It names BOTH ways
 * to supply one, because an invented default would mislabel the ticket and the human
 * could not tell which agent is asking.
 */
function streamErrorResult(): ToolResult {
  const message =
    "No stream resolved for this ticket. On the Worker target the stream is required. " +
    "Supply it either as the URL path segment — POST /mcp/{stream} — or as an explicit " +
    "`stream` argument to ask_human. There is no default on Workers.";
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    structuredContent: { error: message },
    isError: true,
  };
}

/* ------------------------------------------------------------------ *
 * Tool dispatch
 * ------------------------------------------------------------------ */

/** Dependencies for a Worker tool call. */
export interface WorkerToolDeps {
  store: TicketStore;
  now: () => string;
  /** The stream from the `/mcp/{stream}` path segment, if any. */
  stream?: string;
  /**
   * Test seam. Production always uses `WORKER_WAIT_CLAMP_SECONDS`; tests pass a small
   * value so the clamp can be asserted without a multi-second wait.
   */
  waitClampSeconds?: number;
}

/**
 * Run one tool call with the Worker's dependencies.
 *
 * `ask_human` with no resolvable stream is rejected up front with a clear error, rather
 * than letting `resolveStream` throw a plain `Error` that `handleToolCall` would rethrow
 * as a transport failure. Every other call goes straight to the shared dispatcher with
 * the Worker's `waitClampSeconds`, so `wait_for_answer` returns `pending` promptly.
 */
export async function callWorkerTool(name: string, args: unknown, deps: WorkerToolDeps): Promise<ToolResult> {
  if (name === "ask_human" && !hasStream(args, deps.stream)) {
    return streamErrorResult();
  }
  return handleToolCall(name, args, {
    store: deps.store,
    defaultStream: deps.stream,
    now: deps.now,
    waitClampSeconds: deps.waitClampSeconds ?? WORKER_WAIT_CLAMP_SECONDS,
  });
}

/* ------------------------------------------------------------------ *
 * MCP mount
 * ------------------------------------------------------------------ */

/**
 * Build the `/mcp` handler: a stateless Streamable HTTP transport over the shared core.
 *
 * A fresh `Server` and transport are built per request. The transport is stateless
 * (`sessionIdGenerator: undefined`), and `Protocol.connect` throws if a server is
 * already connected, so per-request construction is the correct pattern here.
 */
function createMcpHandler(
  store: TicketStore,
  now: () => string,
): (request: Request, stream: string | undefined) => Promise<Response> {
  return async (request, stream) => {
    const server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Core's schemas are plain JSON Schema; cast across the SDK's zod-inferred type.
      return { tools: TOOL_DEFINITIONS as unknown as Tool[] };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request_) => {
      const { name, arguments: args } = request_.params;
      const result = await callWorkerTool(name, args, { store, now, stream });
      // Core's `ToolResult` is structurally the SDK's `CallToolResult`.
      return result as unknown as CallToolResult;
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}

/* ------------------------------------------------------------------ *
 * API route handlers
 * ------------------------------------------------------------------ */

async function handleAnswer(request: Request, deps: WorkerDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    return text("request body must be valid JSON", 400);
  }
  if (!isRecord(body) || typeof body["id"] !== "string" || typeof body["answer"] !== "string") {
    return text("body must be { id: string, answer: string, answered_by?: string }", 400);
  }
  const answeredBy = body["answered_by"] === "default" ? "default" : "human";

  try {
    const ticket = await answerTicket(deps.store, body["id"], body["answer"], answeredBy, deps.now());
    return json({ ticket });
  } catch (error) {
    if (error instanceof QueueError) {
      return json({ error: error.message }, error.status);
    }
    throw error;
  }
}

async function handleUndo(request: Request, deps: WorkerDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    return text("request body must be valid JSON", 400);
  }
  if (!isRecord(body) || typeof body["id"] !== "string") {
    return text("body must be { id: string }", 400);
  }

  try {
    const ticket = await undoTicket(deps.store, body["id"], deps.now());
    return json({ ticket });
  } catch (error) {
    if (error instanceof QueueError) {
      return json({ error: error.message }, error.status);
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * The router
 * ------------------------------------------------------------------ */

/**
 * The fetch-based route table. Extracted from the Worker's `fetch` so it can be tested
 * with a fake `TicketStore` and no live Cloudflare account.
 */
export async function handleRequest(request: Request, env: WorkerEnv, deps: WorkerDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // The Streamable HTTP MCP endpoint: /mcp or /mcp/{stream}. Origin-guarded first.
  if (path === "/mcp" || path.startsWith("/mcp/")) {
    if (!MCP_METHODS.includes(method)) {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: MCP_METHODS.join(", ") } });
    }
    if (!checkOrigin(request, buildWorkerAllowedOrigins(request, env))) {
      return text("Forbidden: missing or disallowed Origin", 403);
    }
    if (deps.mcpHandler === undefined) {
      return text("Not Found", 404);
    }
    return deps.mcpHandler(request, extractStream(path));
  }

  const allowed = ROUTE_METHODS[path];
  if (allowed === undefined) {
    return text("Not Found", 404);
  }
  if (!allowed.includes(method)) {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: allowed.join(", ") } });
  }

  switch (path) {
    case "/healthz":
      // Verbatim "ok" on every target.
      return text("ok", 200);

    case "/":
      return new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

    case "/api/tickets": {
      if (!requireBearer(request, env.READYROOM_TOKEN)) {
        return text("Unauthorized", 401);
      }
      return json({ tickets: await listForPage(deps.store, deps.now()) });
    }

    case "/api/events": {
      if (!requireBearer(request, env.READYROOM_TOKEN)) {
        return text("Unauthorized", 401);
      }
      // No SSE fleet on the Worker; the page's polling fallback carries this target.
      return text(
        "Server-Sent Events are not available on the Worker target. The readyroom page polls GET /api/tickets every 5 seconds instead.",
        501,
      );
    }

    case "/api/answer": {
      if (!requireBearer(request, env.READYROOM_TOKEN)) {
        return text("Unauthorized", 401);
      }
      return handleAnswer(request, deps);
    }

    case "/api/undo": {
      if (!requireBearer(request, env.READYROOM_TOKEN)) {
        return text("Unauthorized", 401);
      }
      return handleUndo(request, deps);
    }

    default:
      return text("Not Found", 404);
  }
}

/* ------------------------------------------------------------------ *
 * Durable Object
 * ------------------------------------------------------------------ */

/**
 * The single Durable Object instance that owns the queue.
 *
 * The Worker addresses it with `idFromName("queue")`, so every request lands on the same
 * instance — the single-writer invariant expressed on the edge. The Worker talks to it
 * over `stub.fetch(...)` with a tiny internal JSON protocol (`{ op, args }`), which is
 * the simplest correct pattern for this wrangler version and needs no RPC type plumbing.
 */
export class QueueDurableObject {
  private readonly store: DurableObjectTicketStore;

  constructor(state: DurableObjectState, _env: Env) {
    this.store = new DurableObjectTicketStore(state);
  }

  async fetch(request: Request): Promise<Response> {
    let payload: { op?: unknown; args?: unknown };
    try {
      payload = (await request.json()) as { op?: unknown; args?: unknown };
    } catch {
      return json({ error: "durable object request body must be JSON" }, 400);
    }

    try {
      switch (payload.op) {
        case "load":
          await this.store.load();
          return json({ result: null });
        case "list":
          return json({ result: await this.store.list(payload.args as { status?: Status; since?: string }) });
        case "get":
          return json({ result: await this.store.get(payload.args as string) });
        case "put":
          await this.store.put(payload.args as Ticket);
          return json({ result: null });
        case "appendAudit":
          await this.store.appendAudit(payload.args as AuditEntry);
          return json({ result: null });
        default:
          return json({ error: `unknown durable object op \`${String(payload.op)}\`` }, 400);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`readyroom: durable object op \`${String(payload.op)}\` failed: ${message}`);
      return json({ error: message }, 500);
    }
  }
}

/* ------------------------------------------------------------------ *
 * The Worker-side store client
 * ------------------------------------------------------------------ */

/**
 * A `TicketStore` that forwards every operation to the single Durable Object instance
 * over `stub.fetch`. The Worker holds no state of its own; the DO is the writer.
 */
class DurableObjectStoreClient implements TicketStore {
  constructor(private readonly stub: DurableObjectStub) { }

  private async call<T>(op: string, args?: unknown): Promise<T> {
    const response = await this.stub.fetch("https://readyroom-queue.internal/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, args }),
    });
    if (!response.ok) {
      throw new Error(`durable object op \`${op}\` failed with ${response.status}`);
    }
    const payload = (await response.json()) as { result: T };
    return payload.result;
  }

  load(): Promise<void> {
    return this.call<void>("load");
  }

  list(filter: { status?: Status; since?: string }): Promise<Ticket[]> {
    return this.call<Ticket[]>("list", filter);
  }

  get(id: string): Promise<Ticket | undefined> {
    return this.call<Ticket | undefined>("get", id);
  }

  put(ticket: Ticket): Promise<void> {
    return this.call<void>("put", ticket);
  }

  appendAudit(entry: AuditEntry): Promise<void> {
    return this.call<void>("appendAudit", entry);
  }
}

/* ------------------------------------------------------------------ *
 * The Worker mount
 * ------------------------------------------------------------------ */

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // One deterministic instance: every request lands on the same writer.
    const stub = env.QUEUE.get(env.QUEUE.idFromName("queue"));
    const store = new DurableObjectStoreClient(stub);
    const now = (): string => new Date().toISOString();

    return handleRequest(request, env, {
      store,
      now,
      mcpHandler: createMcpHandler(store, now),
    });
  },
};
