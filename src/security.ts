/**
 * Request guards shared by the HTTP layer.
 *
 * Two guards, both from the spec:
 *
 *  1. `requireBearer` — Security rule 2: "Every `/api/*` route requires
 *     `Authorization: Bearer $READYROOM_TOKEN`, compared in constant time." The
 *     comparison is delegated to the shared `constantTimeEqual` (core), so Node and
 *     Workers get the identical guarantee and `node:crypto.timingSafeEqual` is never
 *     depended on.
 *
 *  2. `checkOrigin` — Security, "Additionally": "reject requests with a missing or
 *     mismatched `Origin` on the Streamable HTTP MCP endpoint with `403`. The MCP
 *     specification requires this of HTTP transports, and it is the reason the SDK
 *     ships host and origin validation guards." This is the browser-side guard against
 *     a malicious page in the same browser POSTing to the local MCP endpoint (DNS
 *     rebinding / cross-origin). It is applied to `/mcp` only.
 */

import type { IncomingMessage } from "node:http";

import { constantTimeEqual } from "./core/constantTimeEqual";

/** `READYROOM_ALLOWED_ORIGINS` — extra origins appended to the `/mcp` allowlist. */
export const ENV_ALLOWED_ORIGINS = "READYROOM_ALLOWED_ORIGINS";

const BEARER_PREFIX = "bearer ";

/**
 * True when the request may proceed.
 *
 * When a token is configured, the request MUST carry `Authorization: Bearer <token>`
 * with an exactly-matching token (constant-time). When NO token is configured the
 * request is allowed: the bind refusal rule (see `./config`) guarantees that a
 * token-less server is only reachable on loopback, where the OS is the access
 * control. This is the only reading under which the npx target keeps its
 * "no config, no account, thirty seconds" promise while the Docker and Worker
 * targets — which always bind non-loopback or are public — remain token-mandatory.
 */
export function requireBearer(req: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined || token === "") {
    return true;
  }

  const header = req.headers["authorization"];
  if (typeof header !== "string") {
    return false;
  }
  if (header.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) {
    return false;
  }

  const presented = header.slice(BEARER_PREFIX.length).trim();
  return constantTimeEqual(presented, token);
}

/**
 * Origin guard for the Streamable HTTP MCP endpoint.
 *
 * Returns false (caller responds 403) when the `Origin` header is missing OR is not
 * in `allowedOrigins`. A missing Origin is rejected deliberately: the MCP spec and its
 * SDK guards exist to stop a cross-origin page from driving the local server, and a
 * non-browser client that means well can send its own Origin.
 */
export function checkOrigin(req: IncomingMessage, allowedOrigins: readonly string[]): boolean {
  const origin = req.headers["origin"];
  if (typeof origin !== "string" || origin === "") {
    return false;
  }
  return allowedOrigins.includes(origin);
}

/**
 * Build the `/mcp` Origin allowlist: the server's own origins plus any
 * `READYROOM_ALLOWED_ORIGINS` entries (comma-separated, already split by `loadConfig`,
 * but accepted here as a raw string too for direct callers).
 */
export function buildAllowedOrigins(port: number, extra: readonly string[] | string | undefined): string[] {
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];

  const extras = typeof extra === "string" ? extra.split(",") : (extra ?? []);
  for (const origin of extras) {
    const trimmed = origin.trim();
    if (trimmed !== "" && !origins.includes(trimmed)) {
      origins.push(trimmed);
    }
  }

  return origins;
}
