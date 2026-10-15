/**
 * `DurableObjectTicketStore` — the Cloudflare Worker `TicketStore`.
 *
 * Durability contract (docs/SPEC.md, "Storage"):
 *   - One Durable Object instance, SQLite-backed via `ctx.storage.sql`, tables
 *     `tickets` and `audit`.
 *   - A single DO instance is a single writer with a transaction boundary, which is
 *     exactly the `FileTicketStore` invariant expressed on the edge. The Worker
 *     addresses it deterministically with `idFromName("queue")` so every request lands
 *     on the same instance.
 *   - The `audit` table is append-only and never pruned. State this in the README,
 *     including that this is a deliberate difference from a retention policy.
 *
 * Schema:
 *   tickets(id TEXT PRIMARY KEY, status TEXT, created_at TEXT, data TEXT)
 *     - `id`, `status`, `created_at` are indexed columns so `list` can filter in SQL.
 *     - `data` is the full ticket as JSON, so the row round-trips without a column per
 *       optional field.
 *   audit(id TEXT PRIMARY KEY, ticket_id TEXT, action TEXT, at TEXT, data TEXT)
 *     - `data` is the full `AuditEntry` as JSON; the other columns exist for querying.
 *
 * Tables are created lazily on first use (`CREATE TABLE IF NOT EXISTS`), because a
 * Worker has no boot phase. `load()` is the interface's "ensure tables exist" hook and
 * is a no-op after the first call.
 *
 * All logging goes to stderr. Nothing is written to stdout.
 */

import type { AuditEntry, Status, Ticket, TicketStore } from "../core/types";
import type { DurableObjectState, SqlStorage } from "../worker-types";

const CREATE_TICKETS = `CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
)`;

const CREATE_AUDIT = `CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  action TEXT NOT NULL,
  at TEXT NOT NULL,
  data TEXT NOT NULL
)`;

export class DurableObjectTicketStore implements TicketStore {
  private readonly sql: SqlStorage;
  /** Set once the tables are known to exist. The DO instance persists, so this sticks. */
  private ready = false;

  constructor(state: DurableObjectState) {
    this.sql = state.storage.sql;
  }

  /** Create the tables if they do not exist. Idempotent; safe to call on every op. */
  private ensure(): void {
    if (this.ready) {
      return;
    }
    this.sql.exec(CREATE_TICKETS);
    this.sql.exec(CREATE_AUDIT);
    this.ready = true;
  }

  async load(): Promise<void> {
    this.ensure();
  }

  /**
   * Tickets matching `status` (if given) and `created_at >= since` (if given).
   *
   * `created_at` is an ISO-8601 UTC string, so lexicographic comparison in SQL is
   * chronological comparison. Ordering is oldest-first, matching `FileTicketStore`.
   */
  async list(filter: { status?: Status; since?: string }): Promise<Ticket[]> {
    this.ensure();

    const clauses: string[] = [];
    const bindings: unknown[] = [];
    if (filter.status !== undefined) {
      clauses.push("status = ?");
      bindings.push(filter.status);
    }
    if (filter.since !== undefined) {
      clauses.push("created_at >= ?");
      bindings.push(filter.since);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";

    const rows = this.sql
      .exec<{ data: string }>(`SELECT data FROM tickets${where} ORDER BY created_at ASC`, ...bindings)
      .toArray();

    return rows.map((row) => JSON.parse(row.data) as Ticket);
  }

  async get(id: string): Promise<Ticket | undefined> {
    this.ensure();
    const rows = this.sql.exec<{ data: string }>("SELECT data FROM tickets WHERE id = ?", id).toArray();
    const row = rows[0];
    return row === undefined ? undefined : (JSON.parse(row.data) as Ticket);
  }

  /** Upsert. A ticket is written once on enqueue and again on every state change. */
  async put(ticket: Ticket): Promise<void> {
    this.ensure();
    this.sql.exec(
      `INSERT INTO tickets (id, status, created_at, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         created_at = excluded.created_at,
         data = excluded.data`,
      ticket.id,
      ticket.status,
      ticket.created_at,
      JSON.stringify(ticket),
    );
  }

  /** Append-only. Never updated, never pruned. */
  async appendAudit(entry: AuditEntry): Promise<void> {
    this.ensure();
    this.sql.exec(
      "INSERT INTO audit (id, ticket_id, action, at, data) VALUES (?, ?, ?, ?, ?)",
      entry.id,
      entry.ticket_id,
      entry.action,
      entry.at,
      JSON.stringify(entry),
    );
  }
}
