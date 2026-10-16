/**
 * MCP wiring — the low-level SDK `Server` on top of the target-agnostic core.
 *
 * The SDK ships two server classes. We use the LOW-LEVEL `Server` (not `McpServer`)
 * because `TOOL_DEFINITIONS` in core carries plain JSON Schema, not zod: the low-level
 * `setRequestHandler(ListToolsRequestSchema, ...)` lets us hand the schemas through
 * verbatim, while the high-level server expects zod schemas for `tool(...)`.
 *
 * Two mounts, one daemon:
 *   - stdio (`StdioServerTransport`) — the transport the MCP client speaks to. This is
 *     the path that must stay clean: nothing may be written to stdout but MCP frames.
 *   - Streamable HTTP (`StreamableHTTPServerTransport`) — served on the same process at
 *     `/mcp` for clients that want it, with the Origin guard applied first.
 *
 * `Protocol.connect` throws if a server is already connected to a transport, so the
 * daemon builds a SEPARATE `Server` per mount over the same `ToolDeps`. Tool handling is
 * stateless, so two server instances sharing one store is correct and expected.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { TOOL_DEFINITIONS, handleToolCall } from "./core/tools";
import type { ToolDeps } from "./core/tools";
import type { ToolResult as CoreToolResult } from "./core/types";
import { checkOrigin } from "./security";

const SERVER_NAME = "readyroom";
const SERVER_VERSION = "0.1.0";

/** A function that resolves a tool call to a result. Both mounts are built from one. */
type ToolCaller = (name: string, args: unknown) => Promise<CoreToolResult>;

function buildServer(callTool: ToolCaller): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Core's schemas are plain JSON Schema; cast across the SDK's zod-inferred type.
    return { tools: TOOL_DEFINITIONS as unknown as Tool[] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Core's `ToolResult` is structurally the SDK's `CallToolResult`; the cast narrows
    // the SDK's wider `ServerResult` union, which also carries task-shaped results.
    return (await callTool(name, args)) as unknown as CallToolResult;
  });

  return server;
}

/**
 * The daemon's MCP server: tool calls run against the core directly, with the daemon's
 * own store and default stream.
 */
export function createMcpServer(deps: ToolDeps): Server {
  return buildServer((name, args) => handleToolCall(name, args, deps));
}

export interface ProxyMcpOptions {
  /** The daemon's port on loopback. */
  daemonPort: number;
  /** Shared secret, forwarded as a Bearer header when set. */
  token: string | undefined;
  /** The client's locally-resolved default stream, forwarded so the daemon labels it. */
  defaultStream?: string;
}

function proxyError(message: string): CoreToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    structuredContent: { error: message },
    isError: true,
  };
}

/**
 * The client's MCP server: tool calls are POSTed to the daemon's `/internal/tool-call`.
 * The client owns no store and never writes `tickets.json` — it only relays.
 */
export function createProxyMcpServer(options: ProxyMcpOptions): Server {
  return buildServer(async (name, args) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.token !== undefined && options.token !== "") {
      headers["authorization"] = `Bearer ${options.token}`;
    }
    if (options.defaultStream !== undefined) {
      headers["x-readyroom-stream"] = options.defaultStream;
    }

    const body = JSON.stringify({ name, args, stream: options.defaultStream });

    try {
      const response = await fetch(`http://127.0.0.1:${options.daemonPort}/internal/tool-call`, {
        method: "POST",
        headers,
        body,
      });
      const text = await response.text();
      if (!response.ok) {
        return proxyError(`readyroom daemon returned ${response.status}: ${text.slice(0, 500)}`);
      }
      return JSON.parse(text) as CoreToolResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return proxyError(`readyroom daemon unreachable on 127.0.0.1:${options.daemonPort}: ${message}`);
    }
  });
}

/** Connect a stdio transport the MCP client speaks to. Resolves once connected. */
export async function attachStdio(server: Server): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return transport;
}

export interface StreamableHttpHandle {
  /** Mount at `/mcp`. Applies the Origin guard, then delegates to a per-request transport. */
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  close: () => Promise<void>;
}

export interface StreamableHttpOptions {
  port: number;
  /** Origins allowed on `/mcp`. Missing or unlisted `Origin` is rejected with 403. */
  allowedOrigins: readonly string[];
  log?: (message: string) => void;
}

/**
 * Mount the MCP server as a stateless Streamable HTTP transport.
 *
 * Stateless (`sessionIdGenerator: undefined`) is deliberate: this daemon serves many
 * short-lived MCP clients over one port, and per-session state would only add
 * reconnect friction for no benefit.
 *
 * The SDK forbids reusing a stateless transport across requests ("Stateless transport
 * cannot be reused across requests. Create a new transport per request."), so each
 * request gets a FRESH `Server` and a FRESH `StreamableHTTPServerTransport`, connected
 * for the life of that one request and closed when it finishes. `serverFactory` builds
 * the per-request `Server` over the same `ToolDeps`; tool handling is stateless, so a
 * new instance per request is correct and expected.
 *
 * The Origin guard runs BEFORE `transport.handleRequest`, per the spec: "reject requests
 * with a missing or mismatched `Origin` on the Streamable HTTP MCP endpoint with 403."
 */
export async function attachStreamableHttp(
  serverFactory: () => Server,
  options: StreamableHttpOptions,
): Promise<StreamableHttpHandle> {
  const log = options.log ?? ((message: string) => process.stderr.write(`readyroom: ${message}\n`));

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!checkOrigin(req, options.allowedOrigins)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden: missing or disallowed Origin");
      return;
    }

    // A stateless transport serves exactly one request, so build a fresh Server and
    // transport per request and tear them down when the request completes.
    const server = serverFactory();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      log(`mcp transport error on port ${options.port}: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("Internal Server Error");
      }
    } finally {
      // `server.close()` closes the transport it is connected to; close both defensively.
      await transport.close().catch(() => { });
      await server.close().catch(() => { });
    }
  };

  return {
    handle,
    close: async () => {
      // Nothing persistent to release: each request owns and closes its own transport.
    },
  };
}
