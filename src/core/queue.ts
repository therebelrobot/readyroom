/**
 * The ticket lifecycle, written ONCE against `TicketStore`.
 *
 * There is no branching on target in this file, by design: the spec requires the
 * lifecycle to be identical on Node and Workers, and the only observable difference
 * between targets is the `wait_for_answer` clamp, which lives in `./tools`.
 *
 * Time is injected as an ISO-8601 string (`now`) so every function is deterministic
 * under test and so the store never needs its own clock.
 */

import type {
  Annotation,
  AnnotationInput,
  AskHumanInput,
  AuditEntry,
  MediaInput,
  MediaRef,
  Status,
  Ticket,
  TicketStore,
} from "./types";
import { DEFAULT_TIMEOUT_SECONDS, RECENT_WINDOW_MS, UNDO_WINDOW_MS } from "./constants";
import { base64ByteLength, buildMediaRef, mediaKind } from "./media";
import { resolveStream } from "./stream";

/**
 * A lifecycle rejection that carries an HTTP status.
 *
 * The future HTTP layer maps `.status` directly onto a response code, and
 * `handleToolCall` turns it into an agent-readable error result.
 */
export class QueueError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "QueueError";
    this.status = status;
  }
}

export function notFound(id: string): QueueError {
  return new QueueError(404, `ticket ${id} not found`);
}

export function conflict(message: string): QueueError {
  return new QueueError(409, message);
}

export interface EnqueueOptions {
  /** The target-supplied default stream (env/basename on Node, URL path on Worker). */
  defaultStream?: string;
  /** Current time as an ISO-8601 string. */
  now: string;
}

function newId(): string {
  // `crypto.randomUUID` exists on both Node 22 (global webcrypto) and Workers.
  return crypto.randomUUID();
}

function makeAudit(
  ticketId: string,
  action: AuditEntry["action"],
  at: string,
  by?: string,
  answer?: string,
): AuditEntry {
  const entry: AuditEntry = { id: newId(), ticket_id: ticketId, action, at };
  if (by !== undefined) {
    entry.by = by;
  }
  if (answer !== undefined) {
    entry.answer = answer;
  }
  return entry;
}

/**
 * Store one validated media upload and return its metadata ref.
 *
 * Used both by `enqueue` (agent-supplied attachments) and by the HTTP layer's
 * `POST /api/media` (a rendered annotation copy), so the two paths cannot diverge.
 */
export async function uploadMedia(store: TicketStore, input: MediaInput, now: string): Promise<MediaRef> {
  const id = newId();
  await store.putMedia({ id, mime_type: input.mime_type, data_base64: input.data_base64 });
  return buildMediaRef(id, input, now);
}

/** Create a pending ticket, persist it, and append a `created` audit entry. */
export async function enqueue(
  store: TicketStore,
  input: AskHumanInput,
  options: EnqueueOptions,
): Promise<Ticket> {
  const stream = resolveStream(input.stream, options.defaultStream);
  const timeoutSeconds = input.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
  const created_at = options.now;
  const expires_at = new Date(Date.parse(created_at) + timeoutSeconds * 1000).toISOString();

  const ticket: Ticket = {
    id: newId(),
    stream,
    question: input.question,
    urgency: input.urgency ?? "normal",
    status: "pending",
    created_at,
    expires_at,
  };
  if (input.options !== undefined) {
    ticket.options = input.options;
  }
  if (input.context !== undefined) {
    ticket.context = input.context;
  }
  if (input.default_answer !== undefined) {
    ticket.default_answer = input.default_answer;
  }

  // Media bytes are stored BEFORE the ticket, so a persisted ticket never references a
  // blob that does not exist yet. Validation guarantees every entry has a known kind.
  const media: MediaRef[] = [];
  if (input.media !== undefined && input.media.length > 0) {
    for (const item of input.media) {
      media.push(await uploadMedia(store, item, created_at));
    }
    ticket.media = media;
  }

  await store.put(ticket);
  const createdAudit = makeAudit(ticket.id, "created", created_at, stream);
  if (media.length > 0) {
    createdAudit.media_count = media.length;
  }
  await store.appendAudit(createdAudit);
  return ticket;
}

/**
 * Lazy expiry-on-read: a pending ticket whose `expires_at` has passed becomes
 * `expired`, applying `default_answer` if one was set.
 *
 * Returns the SAME object reference when nothing changed, so callers can cheaply
 * detect "did this resolve" with `resolved !== ticket` and avoid a redundant write.
 *
 * A timer-based expiry is deliberately not used: Workers have no long-lived process,
 * so a timer would silently never fire there, and divergence between targets on when
 * a ticket expires is worse than a few wasted reads.
 */
export function resolveExpiry(ticket: Ticket, now: string): Ticket {
  if (ticket.status !== "pending") {
    return ticket;
  }
  if (Date.parse(ticket.expires_at) > Date.parse(now)) {
    return ticket;
  }

  const resolved: Ticket = {
    ...ticket,
    status: "expired",
    answered_by: "default",
    answered_at: now,
  };
  if (ticket.default_answer !== undefined) {
    resolved.answer = ticket.default_answer;
  }
  return resolved;
}

/**
 * `get`, then resolve expiry. If resolution changed the ticket, persist the resolved
 * copy and append the `expired` audit entry. Because the persisted copy is no longer
 * `pending`, the audit entry is written exactly once.
 */
export async function getResolved(
  store: TicketStore,
  id: string,
  now: string,
): Promise<Ticket | undefined> {
  const ticket = await store.get(id);
  if (ticket === undefined) {
    return undefined;
  }
  const resolved = resolveExpiry(ticket, now);
  if (resolved !== ticket) {
    await store.put(resolved);
    await store.appendAudit(makeAudit(resolved.id, "expired", now, "default", resolved.answer));
  }
  return resolved;
}

/** `list`, then resolve expiry for each, persisting any newly-expired tickets. */
export async function listResolved(
  store: TicketStore,
  filter: { status?: Status; since?: string },
  now: string,
): Promise<Ticket[]> {
  const tickets = await store.list(filter);
  const out: Ticket[] = [];

  for (const ticket of tickets) {
    const resolved = resolveExpiry(ticket, now);
    if (resolved !== ticket) {
      await store.put(resolved);
      await store.appendAudit(makeAudit(resolved.id, "expired", now, "default", resolved.answer));
    }
    out.push(resolved);
  }

  return out;
}

/**
 * Record an answer.
 *
 * Expiry is resolved first, so answering a ticket that has quietly expired returns
 * 409 rather than resurrecting a stale pending row.
 *
 * `annotations` are optional and accompany the answer. An answer may be text, a chosen
 * option, one or more annotations, or any combination — but never nothing: an empty
 * answer with no annotations is a 400 rather than a ticket that says "answered" with no
 * content. A rendered markup copy referenced by `annotated_media_id` must already exist
 * in the media store (the page uploads it with `POST /api/media` first); a missing or
 * non-image blob is a 400.
 */
export async function answer(
  store: TicketStore,
  id: string,
  value: string,
  answeredBy: "human" | "default",
  now: string,
  annotations: AnnotationInput[] = [],
): Promise<Ticket> {
  const existing = await getResolved(store, id, now);
  if (existing === undefined) {
    throw notFound(id);
  }
  if (existing.status !== "pending") {
    throw conflict(`ticket ${id} is ${existing.status}; only a pending ticket can be answered`);
  }

  const resolved: Annotation[] = [];
  for (const input of annotations) {
    const annotation: Annotation = { id: newId() };
    if (input.text !== undefined) {
      annotation.text = input.text;
    }
    if (input.media_id !== undefined) {
      annotation.media_id = input.media_id;
    }
    if (input.at_seconds !== undefined) {
      annotation.at_seconds = input.at_seconds;
    }
    if (input.annotated_media_id !== undefined) {
      const blob = await store.getMedia(input.annotated_media_id);
      if (blob === undefined) {
        throw new QueueError(
          400,
          `annotation media ${input.annotated_media_id} not found; upload it with POST /api/media first`,
        );
      }
      const kind = mediaKind(blob.mime_type);
      if (kind !== "image") {
        throw new QueueError(400, `annotation media ${input.annotated_media_id} must be an image`);
      }
      annotation.annotated_media = {
        id: blob.id,
        kind,
        mime_type: blob.mime_type,
        size_bytes: base64ByteLength(blob.data_base64),
        created_at: now,
      };
    }
    resolved.push(annotation);
  }

  const trimmed = value.trim();
  if (trimmed === "" && resolved.length === 0) {
    throw new QueueError(400, "an answer must include text, a chosen option, or at least one annotation");
  }

  const ticket: Ticket = {
    ...existing,
    status: "answered",
    answered_by: answeredBy,
    answered_at: now,
  };
  if (trimmed !== "") {
    ticket.answer = value;
  }
  if (resolved.length > 0) {
    ticket.annotations = resolved;
  }

  await store.put(ticket);
  const answeredAudit = makeAudit(id, "answered", now, answeredBy, trimmed !== "" ? value : undefined);
  if (resolved.length > 0) {
    answeredAudit.annotation_count = resolved.length;
  }
  await store.appendAudit(answeredAudit);
  return ticket;
}

/**
 * Undo an answer within the five-minute window.
 *
 * Spec reconciliation: the spec measures the undo window against the `answered`
 * audit entry's timestamp. That entry and `ticket.answered_at` are written in the
 * same call with the same `now`, so they are the same instant; measuring against
 * `ticket.answered_at` is exactly equivalent and avoids a second store read to find
 * the audit entry. `expires_at` is intentionally NOT extended on undo: a ticket that
 * has already lapsed resolves straight back to `expired` (with its `default_answer`),
 * which is the honest outcome.
 */
export async function undo(store: TicketStore, id: string, now: string): Promise<Ticket> {
  const ticket = await store.get(id);
  if (ticket === undefined) {
    throw notFound(id);
  }
  if (ticket.status !== "answered") {
    throw conflict(`ticket ${id} is ${ticket.status}; only an answered ticket can be undone`);
  }
  if (ticket.answered_at === undefined) {
    throw conflict(`ticket ${id} has no answer timestamp; the undo window cannot be evaluated`);
  }

  const elapsedMs = Date.parse(now) - Date.parse(ticket.answered_at);
  if (elapsedMs > UNDO_WINDOW_MS) {
    throw conflict(
      `ticket ${id} was answered more than ${UNDO_WINDOW_MS / 60000} minutes ago; the undo window has closed`,
    );
  }

  const reverted: Ticket = { ...ticket, status: "pending" };
  delete reverted.answer;
  delete reverted.annotations;
  delete reverted.answered_by;
  delete reverted.answered_at;

  await store.put(reverted);
  await store.appendAudit(makeAudit(id, "undone", now, "human"));
  return reverted;
}

/** Cancel a ticket. Idempotent: cancelling an already-cancelled ticket is a no-op. */
export async function cancel(store: TicketStore, id: string, now: string): Promise<Ticket> {
  const ticket = await store.get(id);
  if (ticket === undefined) {
    throw notFound(id);
  }
  if (ticket.status === "cancelled") {
    return ticket;
  }

  const cancelled: Ticket = { ...ticket, status: "cancelled" };
  await store.put(cancelled);
  await store.appendAudit(makeAudit(id, "cancelled", now, "human"));
  return cancelled;
}

/**
 * Tickets for the readyroom page (`GET /api/tickets`): all pending tickets, plus
 * answered tickets answered within `RECENT_WINDOW_MS` (the undo-eligible "recent"
 * section). Pending first, oldest first; recent answered after, newest first.
 */
export async function listForPage(store: TicketStore, now: string): Promise<Ticket[]> {
  const pending = await listResolved(store, { status: "pending" }, now);
  const answered = await listResolved(store, { status: "answered" }, now);

  const cutoff = Date.parse(now) - RECENT_WINDOW_MS;
  const recent = answered
    .filter((ticket) => ticket.answered_at !== undefined && Date.parse(ticket.answered_at) >= cutoff)
    .sort((a, b) => Date.parse(b.answered_at ?? "") - Date.parse(a.answered_at ?? ""));

  pending.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  return [...pending, ...recent];
}
