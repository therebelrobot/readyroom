/**
 * Target-agnostic core types for readyroom.
 *
 * This module contains no target-specific imports. It runs unchanged on Node 22
 * and on Cloudflare Workers.
 */

/** Lifecycle state of a ticket. */
export type Status = "pending" | "answered" | "expired" | "cancelled";

/** How loudly a ticket should present itself to the human draining the queue. */
export type Urgency = "low" | "normal" | "blocking";

/** Who supplied an answer. `default` means the agent's own `default_answer`, applied on expiry. */
export type AnsweredBy = "human" | "default";

/**
 * The kind of media an attachment is. Derived from its MIME type, never sent by the
 * agent: `image/*`, `audio/*`, and `video/*` are the only supported families, and an
 * explicit `kind` field would only be one more thing to contradict the MIME type.
 */
export type MediaKind = "image" | "audio" | "video";

/**
 * One media attachment an agent supplies in `ask_human`. Optional: most tickets have
 * no media, and a ticket with media is answered exactly like one without.
 */
export interface MediaInput {
  /** e.g. `image/png`, `audio/mpeg`, `video/mp4`. Determines the `kind`. */
  mime_type: string;
  /**
   * Standard base64. Surrounding whitespace and an optional `data:<mime>;base64,`
   * prefix are tolerated and stripped during validation.
   */
  data_base64: string;
  /** Optional display name, e.g. `before.png`. */
  filename?: string;
  /** Optional caption rendered with the attachment. */
  caption?: string;
}

/**
 * Stored metadata for one media blob. The bytes live in the media store, keyed by
 * `id`, and are served from `GET /api/media/{id}` — never inlined into the ticket, so
 * `GET /api/tickets` and `tickets.json` stay small.
 */
export interface MediaRef {
  id: string;
  kind: MediaKind;
  mime_type: string;
  filename?: string;
  caption?: string;
  size_bytes: number;
  created_at: string;
}

/** A media blob: bytes plus the MIME type needed to serve them. */
export interface MediaBlob {
  id: string;
  mime_type: string;
  /** Standard base64 of the raw bytes. */
  data_base64: string;
}

/**
 * One annotation the human attached when answering. Annotations are optional and
 * never required: an answer may be text, a chosen option, one or more annotations, or
 * any combination.
 */
export interface Annotation {
  id: string;
  /** Note text. Absent when the annotation is markup only. */
  text?: string;
  /** The source media this annotation targets, when it targets one. */
  media_id?: string;
  /** For audio/video: the playback position, in seconds, the note refers to. */
  at_seconds?: number;
  /** For image markup: the rendered annotated copy, stored as a media blob. */
  annotated_media?: MediaRef;
}

/**
 * One annotation as sent by the readyroom page in `POST /api/answer`, before the
 * server assigns ids and resolves any rendered markup copy.
 */
export interface AnnotationInput {
  text?: string;
  media_id?: string;
  at_seconds?: number;
  /** An id returned by `POST /api/media` for a rendered markup copy. */
  annotated_media_id?: string;
}

/**
 * One pending request.
 *
 * The spec's canonical shape is `{ id, stream, question, options, context, urgency,
 * status, created_at, expires_at }`. The remaining fields carry the answer lifecycle
 * (set on answer, applied on expiry, or cleared on undo).
 */
export interface Ticket {
  id: string;
  /** Which agent asked. Defaults to `$READYROOM_STREAM`, else `basename(cwd)` on Node. */
  stream: string;
  question: string;
  /** 2-5 mutually exclusive choices, when the decision is a pick-one. */
  options?: string[];
  /** Minimal plain text needed to decide. Rendered with line breaks preserved. */
  context?: string;
  urgency: Urgency;
  status: Status;
  created_at: string;
  expires_at: string;
  /** Used only if the ticket expires. Set only when proceeding without a human is safe. */
  default_answer?: string;
  /**
   * Media the agent attached for the human to inspect. Optional. The bytes live in the
   * media store; these refs carry only metadata.
   */
  media?: MediaRef[];
  /** The human's annotations, set on answer. Cleared on undo. */
  annotations?: Annotation[];
  answer?: string;
  answered_by?: AnsweredBy;
  answered_at?: string;
}

/** Every state change is appended to the audit log. Append-only, never updated. */
export type AuditAction = "created" | "answered" | "undone" | "cancelled" | "expired";

/** One line in `${READYROOM_STATE_DIR}/audit.jsonl` (or the DO `audit` table). */
export interface AuditEntry {
  id: string;
  ticket_id: string;
  action: AuditAction;
  at: string;
  by?: string;
  answer?: string;
  /** Media attached on `created`. A count, not the bytes: the log stays append-only and small. */
  media_count?: number;
  /** Annotations attached on `answered`. A count, not the content, for the same reason. */
  annotation_count?: number;
}

/**
 * The one storage interface. Two implementations (`FileTicketStore`,
 * `DurableObjectTicketStore`) satisfy it, and the ticket lifecycle in `./queue`
 * is written once against it with no branching on target.
 */
export interface TicketStore {
  load(): Promise<void>;
  list(filter: { status?: Status; since?: string }): Promise<Ticket[]>;
  get(id: string): Promise<Ticket | undefined>;
  put(ticket: Ticket): Promise<void>;
  appendAudit(entry: AuditEntry): Promise<void>;
  /**
   * Store a media blob, keyed by `blob.id`. Idempotent: re-storing an id replaces the
   * bytes. Media is immutable in practice (a new id is minted per upload), so no
   * update path is exposed beyond a plain put.
   */
  putMedia(blob: MediaBlob): Promise<void>;
  /** The blob, or `undefined`. An unsafe or unknown id resolves to `undefined`, never throws. */
  getMedia(id: string): Promise<MediaBlob | undefined>;
}

/* ------------------------------------------------------------------ *
 * Tool input types
 * ------------------------------------------------------------------ */

/** Input for `ask_human`. Validated by `./validation`. */
export interface AskHumanInput {
  question: string;
  options?: string[];
  context?: string;
  default_answer?: string;
  timeout_seconds?: number;
  urgency?: Urgency;
  /** Overrides the env/basename (Node) or URL-path (Worker) default. */
  stream?: string;
  /** Optional media for the human to inspect. Never required. */
  media?: MediaInput[];
}

/** `ask_human` returns immediately. It never waits. */
export interface AskHumanOutput {
  id: string;
  status: "pending";
  expires_at: string;
}

/** Input for `wait_for_answer`. */
export interface WaitForAnswerInput {
  id: string;
  timeout_seconds?: number;
}

/**
 * `wait_for_answer` output.
 *
 * The spec's union is `"pending" | "answered" | "expired"`. `"cancelled"` is added
 * so the tool reports the truth when the ticket it is waiting on was cancelled:
 * reporting `"pending"` forever would be a lie the agent cannot act on.
 */
export interface WaitForAnswerOutput {
  id: string;
  status: "pending" | "answered" | "expired" | "cancelled";
  answer?: string;
  answered_by?: AnsweredBy;
  answered_at?: string;
  /** The media the agent attached, echoed back so the agent can map annotations to it. */
  media?: MediaRef[];
  /** The human's annotations. Also returned as MCP image content when markup was drawn. */
  annotations?: Annotation[];
}

/** `list_pending` takes no input. */
export type ListPendingInput = Record<string, never>;

/** `list_pending` output. */
export interface ListPendingOutput {
  tickets: Ticket[];
}

/** Input for `cancel_ticket`. */
export interface CancelTicketInput {
  id: string;
}

/** `cancel_ticket` output. */
export interface CancelTicketOutput {
  id: string;
  status: "cancelled";
}

/* ------------------------------------------------------------------ *
 * Tool result types (transport-agnostic shape of an MCP call result)
 * ------------------------------------------------------------------ */

export interface ToolTextContent {
  type: "text";
  text: string;
}

/** MCP image content: base64 bytes plus the MIME type. Used to hand annotated images back. */
export interface ToolImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

/** MCP audio content: base64 bytes plus the MIME type. */
export interface ToolAudioContent {
  type: "audio";
  data: string;
  mimeType: string;
}

export type ToolContent = ToolTextContent | ToolImageContent | ToolAudioContent;

export interface ToolResult {
  content: ToolContent[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}
