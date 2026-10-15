/**
 * Tests for the npx singleton: pid liveness, the health probe, and `acquireDaemonRole`.
 *
 * These use real ports and a real stub HTTP server, because the decision under test is
 * "is something else already holding this port and answering as a daemon" — a mock of
 * the probe would not exercise the thing that matters.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireDaemonRole, isPidAlive, readDaemonFile, writeDaemonFile } from "../src/daemon";

/** A pid far above any real process id, so `process.kill` always reports it dead. */
const DEAD_PID = 2_147_483_646;

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "readyroom-daemon-"));
}

/** Bind an ephemeral port, read it, and immediately release it. */
async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

async function startStub(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: (server.address() as AddressInfo).port };
}

async function stopStub(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });
}

test("isPidAlive: the current pid is alive, a nonexistent pid is not", () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(DEAD_PID), false);
});

test("writeDaemonFile / readDaemonFile round-trip", async () => {
  const dir = await tempDir();
  await writeDaemonFile(dir, { pid: 4242, port: 8971, started_at: "2026-01-01T00:00:00.000Z" });
  const read = await readDaemonFile(dir);
  assert.deepEqual(read, { pid: 4242, port: 8971, started_at: "2026-01-01T00:00:00.000Z" });
});

test("readDaemonFile returns undefined when the file is absent", async () => {
  const dir = await tempDir();
  assert.equal(await readDaemonFile(dir), undefined);
});

test("acquireDaemonRole: no daemon.json -> this process becomes the daemon", async () => {
  const dir = await tempDir();
  const port = await getFreePort();
  const role = await acquireDaemonRole(dir, port);
  assert.equal(role.role, "daemon");
});

test("acquireDaemonRole: live daemon file + healthy /healthz -> client", async () => {
  const dir = await tempDir();
  const { server, port: stubPort } = await startStub((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });

  try {
    await writeDaemonFile(dir, { pid: process.pid, port: stubPort, started_at: new Date().toISOString() });
    const unrelatedPort = await getFreePort();
    const role = await acquireDaemonRole(dir, unrelatedPort);
    assert.deepEqual(role, { role: "client", port: stubPort });
  } finally {
    await stopStub(server);
  }
});

test("acquireDaemonRole: stale daemon file (dead pid) -> this process becomes the daemon", async () => {
  const dir = await tempDir();
  const deadPort = await getFreePort();
  await writeDaemonFile(dir, { pid: DEAD_PID, port: deadPort, started_at: new Date().toISOString() });

  const port = await getFreePort();
  const role = await acquireDaemonRole(dir, port);
  assert.equal(role.role, "daemon");
});

test("acquireDaemonRole: a foreign service on the port -> refuse to start", async () => {
  const dir = await tempDir();
  const { server, port } = await startStub((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("not a daemon");
  });

  try {
    await assert.rejects(() => acquireDaemonRole(dir, port), /Refusing to start: port \d+/);
  } finally {
    await stopStub(server);
  }
});
