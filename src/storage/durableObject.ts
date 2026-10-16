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

import { base64ByteLength, base64ToBytes, chunkBase64, isSafeMediaId } from "../core/media";
import type { AuditEntry, MediaBlob, Status, Ticket, TicketStore } from "../core/types";
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

/**
 * Media metadata. The bytes live in `media_chunk`, because Cloudflare caps a SQLite
 * string/BLOB/row at 2 MB and a video attachment can exceed that.
 */
const CREATE_MEDIA_META = `CREATE TABLE IF NOT EXISTS media_meta (
  id TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL
)`;

/**
 * Media bytes, one base64 chunk per row. `MEDIA_CHUNK_BYTES` is a multiple of 3, so
 * each non-final chunk encodes without padding and the stored chunk strings
 * concatenate into the base64 of the whole blob with no decode/re-encode on read.
 */
const CREATE_MEDIA_CHUNK = `CREATE TABLE IF NOT EXISTS media_chunk (
  media_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (media_id, idx)
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
    this.sql.exec(CREATE_MEDIA_META);
    this.sql.exec(CREATE_MEDIA_CHUNK);
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

  /** Store a media blob as metadata plus one or more rows. Idempotent per id. */
  async putMedia(blob: MediaBlob): Promise<void> {
    this.ensure();
    if (!isSafeMediaId(blob.id)) {
      throw new Error(`refusing to store media under an unsafe id: ${blob.id}`);
    }

    const chunks = chunkBase64(blob.data_base64);

    // Replace any prior bytes for this id, then write the new set.
    this.sql.exec("DELETE FROM media_chunk WHERE media_id = ?", blob.id);
    this.sql.exec(
      `INSERT INTO media_meta (id, mime_type, size_bytes, chunk_count) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         mime_type = excluded.mime_type,
         size_bytes = excluded.size_bytes,
         chunk_count = excluded.chunk_count`,
      blob.id,
      blob.mime_type,
      base64ByteLength(blob.data_base64),
      chunks.length,
    );
    for (let index = 0; index < chunks.length; index += 1) {
      this.sql.exec(
        "INSERT INTO media_chunk (media_id, idx, data) VALUES (?, ?, ?)",
        blob.id,
        index,
        chunks[index]!,
      );
    }
  }

  /**
   * Read a blob. A missing meta row, or a chunk set that does not match `chunk_count`
   * (a write interrupted partway), resolves to `undefined` rather than returning a
   * truncated blob.
   */
  async getMedia(id: string): Promise<MediaBlob | undefined> {
    this.ensure();
    if (!isSafeMediaId(id)) {
      return undefined;
    }

    const metaRows = this.sql
      .exec<{ mime_type: string; chunk_count: number }>(
        "SELECT mime_type, chunk_count FROM media_meta WHERE id = ?",
        id,
      )
      .toArray();
    const meta = metaRows[0];
    if (meta === undefined) {
      return undefined;
    }

    const chunkRows = this.sql
      .exec<{ data: string }>("SELECT data FROM media_chunk WHERE media_id = ? ORDER BY idx ASC", id)
      .toArray();
    if (chunkRows.length !== meta.chunk_count) {
      return undefined;
    }

    return { id, mime_type: meta.mime_type, data_base64: chunkRows.map((row) => row.data).join("") };
  }
}
