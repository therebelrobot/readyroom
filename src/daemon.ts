/**
 * The npx singleton.
 *
 * Three MCP clients spawning `npx readyroom` would otherwise produce three processes,
 * three binds of port 8971, and three writers to one `tickets.json` — which breaks the
 * single-writer invariant and can corrupt the queue. So the first process to start
 * becomes the **daemon** (binds the port, owns the store, writes `daemon.json`), and
 * every later process becomes a **client** (reads `daemon.json`, confirms the pid is
 * alive and `/healthz` answers, then proxies its MCP tool calls over loopback).
 *
 * Acquisition logic, in order:
 *   1. `daemon.json` exists, its pid is alive, and `/healthz` answers `ok`  -> client.
 *   2. `daemon.json` is stale (pid dead, or the port refuses) AND the configured port is
 *      free                                                                  -> daemon.
 *   3. The daemon is unreachable but a FOREIGN service holds the port        -> refuse.
 *
 * Case 3 is the one that must never be softened: falling back to "become the daemon"
 * there would silently create a second writer against a queue another process owns.
 *
 * All logging goes to stderr. Nothing is written to stdout.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DAEMON_FILE = "daemon.json";

export interface DaemonFile {
  pid: number;
  port: number;
  started_at: string;
}

/** Thrown when the process must not start. The entry logs it to stderr and exits non-zero. */
export class DaemonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonError";
  }
}

function log(message: string): void {
  process.stderr.write(`readyroom: ${message}\n`);
}

/** Read `daemon.json`. Returns `undefined` when absent or unparseable. */
export async function readDaemonFile(stateDir: string): Promise<DaemonFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(stateDir, DAEMON_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<DaemonFile>;
    if (typeof parsed.pid !== "number" || typeof parsed.port !== "number") {
      return undefined;
    }
    return {
      pid: parsed.pid,
      port: parsed.port,
      started_at: typeof parsed.started_at === "string" ? parsed.started_at : new Date(0).toISOString(),
    };
  } catch {
    log(`ignoring unparseable ${DAEMON_FILE} at ${join(stateDir, DAEMON_FILE)}`);
    return undefined;
  }
}

/**
 * Write `daemon.json` durably enough for a probe: mkdir -p, write a tmp file, rename it
 * into place. The rename is atomic, so a reader never sees a half-written file.
 */
export async function writeDaemonFile(stateDir: string, data: DaemonFile): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const target = join(stateDir, DAEMON_FILE);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

/**
 * Is `pid` a live process?
 *
 * `process.kill(pid, 0)` sends no signal — it only performs the existence/permission
 * check. `EPERM` means the process exists but belongs to another user, which still
 * counts as alive; `ESRCH` means it does not exist.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The outcome of probing a port for a readyroom health endpoint. */
export type Health = "ok" | "foreign" | "closed";

/**
 * GET `http://127.0.0.1:<port>/healthz` and classify the result:
 *   - `"ok"`      — an HTTP 200 whose body is exactly `ok`. A readyroom daemon.
 *   - `"closed"`  — the connection was refused: nothing is listening. The port is free.
 *   - `"foreign"` — anything else listening (wrong status, wrong body, or a hang). The
 *                   port is held by a service that is not this daemon.
 */
export async function probeHealthz(port: number, timeoutMs = 1500): Promise<Health> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
    if (!response.ok) {
      return "foreign";
    }
    const body = (await response.text()).trim();
    return body === "ok" ? "ok" : "foreign";
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    const code = cause?.code ?? (error as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return "closed";
    }
    // A timeout or any other transport failure means something may be holding the port;
    // treat it as foreign so we refuse rather than race a second writer onto it.
    return "foreign";
  } finally {
    clearTimeout(timer);
  }
}

export type DaemonRole = { role: "daemon" } | { role: "client"; port: number };

/**
 * Decide whether this process becomes the daemon or a client. Throws `DaemonError` when
 * a foreign service holds the port (case 3 above) — never falls back to a second writer.
 */
export async function acquireDaemonRole(stateDir: string, port: number): Promise<DaemonRole> {
  const existing = await readDaemonFile(stateDir);

  if (existing !== undefined && isPidAlive(existing.pid)) {
    const health = await probeHealthz(existing.port);
    if (health === "ok") {
      log(`joining existing daemon pid ${existing.pid} on port ${existing.port}`);
      return { role: "client", port: existing.port };
    }
    log(`daemon.json names pid ${existing.pid} on port ${existing.port}, but /healthz was ${health}`);
  }

  // No live daemon file. Before claiming the role, make sure the port is actually free:
  // if a foreign service holds it, refuse rather than become a second writer.
  const health = await probeHealthz(port);
  if (health === "ok") {
    // Something answers as a readyroom daemon even though the file was stale/missing.
    log(`port ${port} already serves a readyroom daemon; joining as client`);
    return { role: "client", port };
  }
  if (health === "foreign") {
    throw new DaemonError(
      `Refusing to start: port ${port} is held by a service that is not a readyroom daemon ` +
      `(its /healthz did not answer "ok"). Falling back would create a second writer against a ` +
      `queue this process does not own. Free port ${port}, or point READYROOM_PORT at a free port.`,
    );
  }

  log(`acquiring daemon role (no live daemon; port ${port} is free)`);
  return { role: "daemon" };
}
