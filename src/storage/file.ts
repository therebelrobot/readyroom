/**
 * `FileTicketStore` — the Node/Docker `TicketStore`.
 *
 * Durability contract (docs/SPEC.md, "Storage"):
 *   - `${READYROOM_STATE_DIR}/tickets.json` holds the queue.
 *   - Every `put` writes `tickets.json.tmp`, `fsync`s it, then `rename`s it over
 *     `tickets.json`. The fsync+rename is the durability guarantee: a crash mid-write
 *     leaves the previous good file in place, never a half-written one.
 *   - `${READYROOM_STATE_DIR}/audit.jsonl` is append-only, one JSON object per line,
 *     never rotated, never updated.
 *
 * Single process, single writer. All writes are serialized through one promise chain
 * so two `put` calls cannot race the tmp file. This is the single-writer invariant
 * expressed in code.
 *
 * All logging goes to stderr. Nothing is written to stdout.
 */

import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_STATE_DIR, ENV_STATE_DIR } from "../core/constants";
import type { AuditEntry, Status, Ticket, TicketStore } from "../core/types";

const TICKETS_FILE = "tickets.json";
const TICKETS_TMP_FILE = "tickets.json.tmp";
const AUDIT_FILE = "audit.jsonl";

/** Write a diagnostic line to stderr. Never stdout — stdout is the MCP protocol. */
function log(message: string): void {
  process.stderr.write(`readyroom: ${message}\n`);
}

export class FileTicketStore implements TicketStore {
  private readonly stateDir: string;
  private readonly ticketsPath: string;
  private readonly ticketsTmpPath: string;
  private readonly auditPath: string;

  /** In-memory mirror of `tickets.json`, keyed by ticket id. */
  private tickets = new Map<string, Ticket>();

  /** Tail of the write chain. Every mutation appends to it; nothing runs concurrently. */
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * @param stateDir Directory holding `tickets.json` and `audit.jsonl`. Defaults to
   *   `$READYROOM_STATE_DIR`, else `DEFAULT_STATE_DIR` (`./.state`). Tests pass a temp dir.
   */
  constructor(stateDir: string = process.env[ENV_STATE_DIR] ?? DEFAULT_STATE_DIR) {
    this.stateDir = stateDir;
    this.ticketsPath = join(stateDir, TICKETS_FILE);
    this.ticketsTmpPath = join(stateDir, TICKETS_TMP_FILE);
    this.auditPath = join(stateDir, AUDIT_FILE);
  }

  /**
   * Serialize a task behind every previously queued write. The returned promise
   * rejects if the task rejects; the chain itself swallows so one failure does not
   * wedge every later write.
   */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Read `tickets.json` into memory. A missing file starts empty (first boot). A
   * corrupt file fails loudly to stderr and throws — silently discarding the queue
   * would make an agent wait forever.
   */
  async load(): Promise<void> {
    return this.serialize(async () => {
      await mkdir(this.stateDir, { recursive: true });

      let raw: string;
      try {
        raw = await readFile(this.ticketsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          this.tickets = new Map();
          return;
        }
        throw error;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        log(`corrupt ${TICKETS_FILE} at ${this.ticketsPath}: ${(error as Error).message}`);
        throw error;
      }

      if (!Array.isArray(parsed)) {
        const error = new Error(`${TICKETS_FILE} at ${this.ticketsPath} is not a JSON array`);
        log(error.message);
        throw error;
      }

      const next = new Map<string, Ticket>();
      for (const entry of parsed as Ticket[]) {
        next.set(entry.id, entry);
      }
      this.tickets = next;
    });
  }

  /** Tickets matching `status` (if given) and `created_at >= since` (if given). Copies, not references. */
  async list(filter: { status?: Status; since?: string }): Promise<Ticket[]> {
    const sinceMs = filter.since === undefined ? undefined : Date.parse(filter.since);
    const out: Ticket[] = [];
    for (const ticket of this.tickets.values()) {
      if (filter.status !== undefined && ticket.status !== filter.status) {
        continue;
      }
      if (sinceMs !== undefined && Date.parse(ticket.created_at) < sinceMs) {
        continue;
      }
      out.push({ ...ticket });
    }
    return out;
  }

  /** The ticket, or `undefined`. Returns a copy, not the internal reference. */
  async get(id: string): Promise<Ticket | undefined> {
    const ticket = this.tickets.get(id);
    return ticket === undefined ? undefined : { ...ticket };
  }

  /** Upsert a ticket and durably persist the whole queue. */
  async put(ticket: Ticket): Promise<void> {
    return this.serialize(async () => {
      this.tickets.set(ticket.id, { ...ticket });
      await this.writeTickets();
    });
  }

  /** Append one JSON object as a line to `audit.jsonl`. Append-only, never rotated. */
  async appendAudit(entry: AuditEntry): Promise<void> {
    return this.serialize(async () => {
      await mkdir(this.stateDir, { recursive: true });
      const line = `${JSON.stringify(entry)}\n`;
      const handle = await open(this.auditPath, "a");
      try {
        await handle.writeFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }

  /**
   * Atomic write: tmp file -> fsync -> rename over the real file. The rename is the
   * atomic step; the fsync guarantees the bytes are on disk before the rename lands.
   */
  private async writeTickets(): Promise<void> {
    const data = JSON.stringify([...this.tickets.values()], null, 2);
    const handle = await open(this.ticketsTmpPath, "w");
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(this.ticketsTmpPath, this.ticketsPath);
  }
}
