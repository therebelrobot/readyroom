/**
 * Node entry — daemon-or-client.
 *
 * One process resolves into one of two roles (see `./daemon`):
 *
 *   daemon — binds the port, owns `FileTicketStore`, serves the HTTP route table and
 *            the `/mcp` Streamable HTTP transport, writes `daemon.json`, and speaks
 *            stdio MCP. Tool handlers call core directly.
 *
 *   client — serves stdio MCP only. It never binds the port and never touches
 *            `tickets.json`; it POSTs `{ name, args, stream }` to the daemon's
 *            `/internal/tool-call` and returns the result. Its `defaultStream` is
 *            resolved locally (env/basename) and forwarded so the daemon labels the
 *            ticket with the agent that actually asked.
 *
 * All logging goes to stderr. Nothing is written to stdout except the MCP protocol —
 * a stray stdout write is the single most common way a stdio MCP server breaks, and it
 * breaks the npx target only, the hardest one to notice.
 */

import { createServer } from "node:http";
import { basename } from "node:path";

import { ConfigError, enforceBindRule, loadConfig } from "./config";
import type { Config } from "./config";
import { DaemonError, acquireDaemonRole, writeDaemonFile } from "./daemon";
import { createHttpApp } from "./http";
import { attachStdio, attachStreamableHttp, createMcpServer, createProxyMcpServer } from "./mcp";
import { buildAllowedOrigins } from "./security";
import { FileTicketStore } from "./storage/file";

function log(message: string): void {
  process.stderr.write(`readyroom: ${message}\n`);
}

function now(): string {
  return new Date().toISOString();
}

/** Install SIGTERM/SIGINT handlers that run `close` once, then exit. */
function installShutdown(close: () => Promise<void>): void {
  let closing = false;
  const handler = (signal: NodeJS.Signals): void => {
    if (closing) {
      return;
    }
    closing = true;
    log(`received ${signal}; shutting down`);
    close().then(
      () => {
        process.exit(0);
      },
      (error: unknown) => {
        log(`shutdown error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}

async function runDaemon(config: Config, defaultStream: string): Promise<void> {
  const store = new FileTicketStore(config.stateDir);
  await store.load();

  const deps = { store, defaultStream, now };

  const allowedOrigins = buildAllowedOrigins(config.port, config.allowedOrigins);

  // Streamable HTTP MCP, mounted at /mcp on the same HTTP server. Its own Server
  // instance, because a Protocol may only be connected to one transport.
  const mcp = await attachStreamableHttp(createMcpServer(deps), {
    port: config.port,
    allowedOrigins,
    log,
  });

  const app = createHttpApp({
    store,
    token: config.token,
    now,
    defaultStream,
    allowedOrigins,
    mcpHandler: mcp.handle,
    log,
  });

  const server = createServer(app.handler);

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(config.port, config.bind, () => {
      server.off("error", onError);
      resolve();
    });
  });

  await writeDaemonFile(config.stateDir, { pid: process.pid, port: config.port, started_at: now() });
  log(`daemon listening on ${config.bind}:${config.port} (stream "${defaultStream}")`);

  // stdio MCP for the client that spawned this process.
  const stdio = await attachStdio(createMcpServer(deps));

  installShutdown(async () => {
    await app.close();
    await mcp.close();
    await stdio.close();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  });
}

async function runClient(config: Config, defaultStream: string, daemonPort: number): Promise<void> {
  const server = createProxyMcpServer({
    daemonPort,
    token: config.token,
    defaultStream,
  });

  const stdio = await attachStdio(server);
  log(`client proxying tool calls to daemon on 127.0.0.1:${daemonPort} (stream "${defaultStream}")`);

  installShutdown(async () => {
    await stdio.close();
  });
}

async function main(): Promise<void> {
  const config = loadConfig();

  try {
    enforceBindRule(config);
  } catch (error) {
    if (error instanceof ConfigError) {
      log(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const defaultStream = config.stream ?? basename(process.cwd());

  let role: Awaited<ReturnType<typeof acquireDaemonRole>>;
  try {
    role = await acquireDaemonRole(config.stateDir, config.port);
  } catch (error) {
    if (error instanceof DaemonError) {
      log(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (role.role === "daemon") {
    await runDaemon(config, defaultStream);
  } else {
    await runClient(config, defaultStream, role.port);
  }
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
