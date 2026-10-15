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

export interface ToolResult {
  content: ToolTextContent[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}
