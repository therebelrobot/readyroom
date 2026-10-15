/**
 * The `node:http` request handler — the shared route table from the spec's "HTTP"
 * section, plus the two Node-only extras (`/` serves the inlined page, and
 * `/internal/tool-call` is the loopback proxy the client process uses).
 *
 * Route table:
 *   GET  /healthz             -> 200, body "ok"
 *   GET  /                    -> 200 text/html, the heads-up page
 *   GET  /api/tickets         -> 200 { tickets }           (Bearer)
 *   GET  /api/events          -> text/event-stream          (Bearer)
 *   POST /api/answer          -> 200 | 404 | 409            (Bearer)
 *   POST /api/undo            -> 200 | 409                  (Bearer)
 *   POST /internal/tool-call  -> the ToolResult JSON        (Bearer when a token is set)
 *   /mcp                      -> delegated to the MCP transport (Origin-guarded)
 *
 * Unknown route -> 404. Known route, wrong method -> 405.
 *
 * SSE is real on this target (the spec reserves the 501 for the Worker, whose
 * invocation cannot fan out a stream fleet). Every open response is kept in a set and
 * removed on close; a mutation broadcasts a frame, and a slow sweep broadcasts when
 * lazy expiry changes the pending set.
 *
 * All logging goes to stderr. Nothing is written to stdout — that is the MCP protocol.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import page from "../public/index.html";
import { QueueError, answer as answerTicket, listForPage, listResolved, undo as undoTicket } from "./core/queue";
import { handleToolCall } from "./core/tools";
import type { ToolResult } from "./core/types";
import type { TicketStore } from "./core/types";
import { requireBearer } from "./security";

/** How often the SSE layer checks for newly-lazy-expired tickets to broadcast. */
const SWEEP_MS = 5_000;
/** How often a comment frame keeps the SSE connection warm through proxies. */
const HEARTBEAT_MS = 25_000;
/** Upper bound on a request body, so a hostile client cannot exhaust memory. */
const MAX_BODY_BYTES = 1_000_000;

/** A response-ready HTTP error. `handle` maps `.status` onto the response code. */
class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export interface HttpAppOptions {
  store: TicketStore;
  /** Shared secret. `undefined` means token-less (loopback-only) mode. */
  token: string | undefined;
  /** Current time as an ISO-8601 string. */
  now: () => string;
  /** Daemon's configured default stream. Overridable per call via the proxy body/header. */
  defaultStream?: string;
  /** Origins allowed on `/mcp`. Unused here beyond construction by the MCP transport. */
  allowedOrigins: readonly string[];
  /** The `/mcp` mount. Return value is ignored; the handler must write the response. */
  mcpHandler?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  sweepMs?: number;
  heartbeatMs?: number;
  log?: (message: string) => void;
}

export interface HttpApp {
  /** Pass to `http.createServer(...)`. */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** Broadcast a queue-change frame to every open SSE client. */
  broadcast: () => void;
  /** Clear the timers and end every open SSE response. */
  close: () => Promise<void>;
}

/** Every path the route table knows, with the methods it accepts (for 405 handling). */
const ROUTE_METHODS: Record<string, readonly string[]> = {
  "/healthz": ["GET"],
  "/": ["GET"],
  "/api/tickets": ["GET"],
  "/api/events": ["GET"],
  "/api/answer": ["POST"],
  "/api/undo": ["POST"],
  "/internal/tool-call": ["POST"],
  "/mcp": ["GET", "POST", "DELETE"],
};

function defaultLog(message: string): void {
  process.stderr.write(`readyroom: ${message}\n`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, text: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read and JSON-parse the request body. Empty body resolves `undefined`. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new HttpError(413, "request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "request body must be valid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function errorToResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    structuredContent: { error: message },
    isError: true,
  };
}

export function createHttpApp(options: HttpAppOptions): HttpApp {
  const { store, token, now, allowedOrigins, mcpHandler } = options;
  const log = options.log ?? defaultLog;
  const sweepMs = options.sweepMs ?? SWEEP_MS;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;

  const sseClients = new Set<ServerResponse>();
  /** Last-seen set of pending ids, so the sweep broadcasts only on a real change. */
  let lastPendingKey = "";

  function broadcast(): void {
    const frame = `data: ${JSON.stringify({ type: "tickets" })}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(frame);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  function openSse(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    req.on("close", () => {
      sseClients.delete(res);
    });
  }

  /** Resolve lazy expiry and broadcast when the pending set changed. */
  async function sweep(): Promise<void> {
    try {
      const pending = await listResolved(store, { status: "pending" }, now());
      const key = pending
        .map((ticket) => ticket.id)
        .sort()
        .join(",");
      if (key !== lastPendingKey) {
        lastPendingKey = key;
        broadcast();
      }
    } catch (error) {
      log(`sse sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const sweepTimer = setInterval(() => {
    void sweep();
  }, sweepMs);
  sweepTimer.unref();

  const heartbeatTimer = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(": heartbeat\n\n");
      } catch {
        sseClients.delete(client);
      }
    }
  }, heartbeatMs);
  heartbeatTimer.unref();

  // Seed the pending key so the first sweep does not spuriously broadcast.
  void sweep();

  async function handleAnswer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    if (!isRecord(body) || typeof body["id"] !== "string" || typeof body["answer"] !== "string") {
      throw new HttpError(400, "body must be { id: string, answer: string, answered_by?: string }");
    }
    const answeredBy = body["answered_by"] === "default" ? "default" : "human";

    const ticket = await answerTicket(store, body["id"], body["answer"], answeredBy, now());
    broadcast();
    sendJson(res, 200, { ticket });
  }

  async function handleUndo(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    if (!isRecord(body) || typeof body["id"] !== "string") {
      throw new HttpError(400, "body must be { id: string }");
    }
    const ticket = await undoTicket(store, body["id"], now());
    broadcast();
    sendJson(res, 200, { ticket });
  }

  async function handleToolCallRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    if (!isRecord(body) || typeof body["name"] !== "string") {
      throw new HttpError(400, "body must be { name: string, args?: object, stream?: string }");
    }

    // The client resolves its default stream locally (env/basename) and forwards it,
    // either in the body or as a header, so the daemon labels the ticket correctly.
    const headerStream = req.headers["x-readyroom-stream"];
    const bodyStream = typeof body["stream"] === "string" ? body["stream"] : undefined;
    const defaultStream =
      bodyStream ?? (typeof headerStream === "string" ? headerStream : undefined) ?? options.defaultStream;

    let result: ToolResult;
    try {
      result = await handleToolCall(body["name"], body["args"], { store, defaultStream, now });
    } catch (error) {
      result = errorToResult(error);
    }

    // Any mutating tool call changes the queue; broadcast unconditionally (a no-op for reads).
    broadcast();
    sendJson(res, 200, result);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // The Streamable HTTP MCP endpoint carries its own Origin guard inside the handler.
    if (path === "/mcp") {
      if (mcpHandler === undefined) {
        sendText(res, 404, "Not Found");
        return;
      }
      await mcpHandler(req, res);
      return;
    }

    const allowed = ROUTE_METHODS[path];
    if (allowed === undefined) {
      sendText(res, 404, "Not Found");
      return;
    }
    if (!allowed.includes(method)) {
      res.writeHead(405, { allow: allowed.join(", ") });
      res.end("Method Not Allowed");
      return;
    }

    try {
      switch (path) {
        case "/healthz":
          // Verbatim "ok" on every target; the npx singleton probe reads daemon.json
          // rather than parsing this body.
          sendText(res, 200, "ok");
          return;

        case "/":
          sendText(res, 200, page, "text/html; charset=utf-8");
          return;

        case "/api/tickets": {
          if (!requireBearer(req, token)) {
            sendText(res, 401, "Unauthorized");
            return;
          }
          const tickets = await listForPage(store, now());
          sendJson(res, 200, { tickets });
          return;
        }

        case "/api/events": {
          if (!requireBearer(req, token)) {
            sendText(res, 401, "Unauthorized");
            return;
          }
          openSse(req, res);
          return;
        }

        case "/api/answer": {
          if (!requireBearer(req, token)) {
            sendText(res, 401, "Unauthorized");
            return;
          }
          await handleAnswer(req, res);
          return;
        }

        case "/api/undo": {
          if (!requireBearer(req, token)) {
            sendText(res, 401, "Unauthorized");
            return;
          }
          await handleUndo(req, res);
          return;
        }

        case "/internal/tool-call": {
          // Not under /api/*: this is the loopback proxy the client process uses, and the
          // loopback bind is its primary protection. The Bearer is still required when a
          // token is configured, so a token-protected daemon is not drivable without it.
          if (!requireBearer(req, token)) {
            sendText(res, 401, "Unauthorized");
            return;
          }
          await handleToolCallRoute(req, res);
          return;
        }

        default:
          sendText(res, 404, "Not Found");
          return;
      }
    } catch (error) {
      if (error instanceof QueueError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      if (error instanceof HttpError) {
        sendText(res, error.status, error.message);
        return;
      }
      log(`unhandled request error (${method} ${path}): ${error instanceof Error ? error.message : String(error)}`);
      sendText(res, 500, "Internal Server Error");
    }
  }

  return {
    handler: (req, res) => {
      void handle(req, res);
    },
    broadcast,
    close: async () => {
      clearInterval(sweepTimer);
      clearInterval(heartbeatTimer);
      for (const client of sseClients) {
        try {
          client.end();
        } catch {
          // The socket is already gone; nothing to flush.
        }
      }
      sseClients.clear();
    },
  };
}
