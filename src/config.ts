/**
 * Node entry configuration.
 *
 * Parses the `READYROOM_*` environment into a typed config object and enforces the
 * bind refusal rule from the spec (Security, rule 1):
 *
 *   "bind `127.0.0.1` by default. `READYROOM_BIND` may override, but when it is
 *   anything other than a loopback address the server must refuse to start unless
 *   `READYROOM_TOKEN` is set."
 *
 * Reason: an approval endpoint is a privilege-escalation surface — whoever can answer
 * a ticket can grant an agent permission to act. A non-loopback bind without a token
 * would put that surface on the LAN for anyone.
 *
 * This module is Node-only and imports nothing target-specific beyond core constants.
 */

import {
  DEFAULT_STATE_DIR,
  ENV_BIND,
  ENV_PORT,
  ENV_STATE_DIR,
  ENV_STREAM,
  ENV_TOKEN,
  PORT,
} from "./core/constants";

/** `READYROOM_ALLOWED_ORIGINS` — extra origins allowed on the `/mcp` endpoint. */
export const ENV_ALLOWED_ORIGINS = "READYROOM_ALLOWED_ORIGINS";

export interface Config {
  /** Default stream for tickets. `undefined` lets the entry fall back to `basename(cwd)`. */
  stream: string | undefined;
  /** Shared secret for `/api/*` and the MCP endpoint. `undefined` means "not configured". */
  token: string | undefined;
  /** Bind address. Defaults to loopback. */
  bind: string;
  /** Directory holding `tickets.json`, `audit.jsonl`, and `daemon.json`. */
  stateDir: string;
  /** TCP port. Defaults to `PORT` (8971). */
  port: number;
  /** Extra origins for the `/mcp` Origin guard (comma-separated env, split and trimmed). */
  allowedOrigins: string[];
}

/** Thrown when the configuration is unsafe to start with. The entry logs it to stderr and exits non-zero. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Strip surrounding `[ ]` from an IPv6 literal, trim, and lowercase. */
function normalize(addr: string): string {
  const trimmed = addr.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Is `addr` a loopback address?
 *
 * Accepts `localhost`, the IPv6 loopback `::1`, and the whole IPv4 loopback block
 * `127.0.0.0/8` (Node's `listen` accepts any `127.x.y.z`). Anything else — notably
 * `0.0.0.0` and `::` — is not loopback and triggers the refusal rule when no token
 * is configured.
 */
export function isLoopback(addr: string): boolean {
  const value = normalize(addr);
  if (value === "" || value === "localhost") {
    return value === "localhost";
  }
  if (value === "::1") {
    return true;
  }
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (match === null) {
    return false;
  }
  return match.slice(1).every((part) => {
    const octet = Number(part);
    return octet >= 0 && octet <= 255;
  });
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parsePort(raw: string | undefined): number {
  const value = nonEmpty(raw);
  if (value === undefined) {
    return PORT;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new ConfigError(`READYROOM_PORT must be an integer between 1 and 65535 (got "${raw}")`);
  }
  return parsed;
}

/** Parse the environment into a `Config`. Does NOT enforce the bind rule; call `enforceBindRule`. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const allowedOrigins = (nonEmpty(env[ENV_ALLOWED_ORIGINS]) ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");

  return {
    stream: nonEmpty(env[ENV_STREAM]),
    token: nonEmpty(env[ENV_TOKEN]),
    bind: nonEmpty(env[ENV_BIND]) ?? "127.0.0.1",
    stateDir: nonEmpty(env[ENV_STATE_DIR]) ?? DEFAULT_STATE_DIR,
    port: parsePort(env[ENV_PORT]),
    allowedOrigins,
  };
}

/**
 * Enforce the bind refusal rule. Throws `ConfigError` when a non-loopback bind is
 * requested without a token. The entry point treats the throw as "refuse to start".
 */
export function enforceBindRule(config: Pick<Config, "bind" | "token">): void {
  if (isLoopback(config.bind)) {
    return;
  }
  if (config.token === undefined) {
    throw new ConfigError(
      `Refusing to start: READYROOM_BIND is "${config.bind}", which is not a loopback address, ` +
      `and READYROOM_TOKEN is not set. A reachable approval endpoint without a token lets anyone ` +
      `who can reach it grant an agent permission to act. Set READYROOM_TOKEN, or bind loopback ` +
      `(127.0.0.1) and reach the server through a reverse proxy that enforces its own auth.`,
    );
  }
}
