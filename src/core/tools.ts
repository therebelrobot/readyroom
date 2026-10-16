/**
 * The four agent-facing tools, as target-agnostic metadata plus a dispatcher.
 *
 * `inputSchema` is a plain JSON Schema object, not zod: core must not import the MCP
 * SDK. Each target's entry point adapts this metadata onto its own SDK surface.
 *
 * The `ask_human` description is load-bearing. The spec says the tool description is
 * where the agent learns the protocol: enqueue, then poll with `wait_for_answer`
 * later, never in a tight loop. It is written accordingly.
 */

import type { Ticket, TicketStore, ToolContent, ToolResult, WaitForAnswerOutput } from "./types";
import {
  ValidationError,
  validateAskHuman,
  validateWaitForAnswer,
  validateCancelTicket,
  validateListPending,
} from "./validation";
import {
  QueueError,
  answer as answerTicket,
  cancel as cancelTicket,
  enqueue,
  getResolved,
  listResolved,
  notFound,
} from "./queue";
import { POLL_INTERVAL_MS, WAIT_DEFAULT_SECONDS, WAIT_MAX_SECONDS } from "./constants";

export type ToolName = "ask_human" | "wait_for_answer" | "list_pending" | "cancel_ticket";

export interface ToolDefinition {
  name: ToolName;
  description: string;
  /** Plain JSON Schema (draft 2020-12 style subset). Not zod. */
  inputSchema: Record<string, unknown>;
}

const ASK_HUMAN_DESCRIPTION = [
  "Ask a human to make a decision, without blocking. Enqueues a ticket and returns immediately with { id, status: \"pending\" } — it never waits.",
  "",
  "Use it when you are blocked on a decision only a human can make. Keep `question` to one sentence; put everything else the human needs into `context`.",
  "",
  "Protocol you must follow: on `pending`, continue with independent work and call `wait_for_answer` again later — do not poll in a tight loop.",
  "",
  "Set `default_answer` only when it is safe for you to proceed without a human; it is used only if the ticket expires. Set `options` for 2-5 mutually exclusive choices. `timeout_seconds` defaults to 1800 and maxes at 86400. `urgency` defaults to \"normal\".",
  "",
  "Optionally attach `media` (screenshots, audio, or video) for the human to inspect — media is never required. Each item is { mime_type, data_base64 } with optional `filename` and `caption`; `data_base64` is standard base64 (a `data:<mime>;base64,` prefix is accepted). The human may answer with a decision, with annotations on your media, or both; `wait_for_answer` returns any annotations, and rendered markup comes back as image content.",
].join("\n");

const WAIT_FOR_ANSWER_DESCRIPTION = [
  "Wait for the human to answer a ticket created by ask_human, then return the result.",
  "",
  "Returns immediately if the ticket is already answered or expired. If it is still pending when the wait ends, it returns { status: \"pending\" } — continue with independent work and call this tool again later. Do not poll in a tight loop.",
  "",
  "`timeout_seconds` defaults to 60 and maxes at 600.",
].join("\n");

const LIST_PENDING_DESCRIPTION =
  "List the tickets that are still pending across every agent stream. Takes no arguments.";

const CANCEL_TICKET_DESCRIPTION =
  "Cancel a ticket you no longer need answered. Takes its `id`.";

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "ask_human",
    description: ASK_HUMAN_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Required. One sentence. What must be decided.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 5,
          description: "Optional. 2-5 mutually exclusive choices.",
        },
        context: {
          type: "string",
          description: "Optional. Minimal text needed to decide. Plain text, line breaks preserved.",
        },
        default_answer: {
          type: "string",
          description:
            "Optional. Used only if the ticket expires. Set it only when it is safe for you to proceed without a human.",
        },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 86400,
          description: "Optional. Seconds until expiry. Default 1800. Max 86400.",
        },
        urgency: {
          type: "string",
          enum: ["low", "normal", "blocking"],
          description: "Optional. Default \"normal\".",
        },
        stream: {
          type: "string",
          description: "Optional. Overrides the configured default stream for this ticket.",
        },
        media: {
          type: "array",
          maxItems: 8,
          description:
            "Optional. Media (screenshots, audio, video) for the human to inspect. Never required.",
          items: {
            type: "object",
            properties: {
              mime_type: {
                type: "string",
                description: "An image/*, audio/*, or video/* type, e.g. \"image/png\".",
              },
              data_base64: {
                type: "string",
                description: "Standard base64 bytes. A `data:<mime>;base64,` prefix is accepted.",
              },
              filename: { type: "string", description: "Optional. A display name, e.g. \"before.png\"." },
              caption: { type: "string", description: "Optional. A caption shown with the attachment." },
            },
            required: ["data_base64"],
            additionalProperties: false,
          },
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_for_answer",
    description: WAIT_FOR_ANSWER_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Required. The id returned by ask_human." },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 600,
          description: "Optional. Seconds to wait. Default 60. Max 600.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_pending",
    description: LIST_PENDING_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "cancel_ticket",
    description: CANCEL_TICKET_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Required. The id returned by ask_human." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

/** Target-supplied dependencies for the dispatcher. */
export interface ToolDeps {
  store: TicketStore;
  /** Target-supplied default stream. Omitted on the Worker when the path has no segment. */
  defaultStream?: string;
  /** Current time as an ISO-8601 string. */
  now: () => string;
  /**
   * Worker target: clamp the effective `wait_for_answer` wait to this many seconds so
   * the call returns well inside a Workers invocation. The tool returns
   * `status: "pending"` promptly rather than erroring, which matches the protocol.
   */
  waitClampSeconds?: number;
  /** Test seam. Defaults to a real `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function textResult(text: string, structuredContent: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

/** The unambiguous prefix a delivered human answer carries. */
const HUMAN_ANSWER_PREFIX = "HUMAN ANSWER:";

/**
 * Answer text for the agent.
 *
 * A human answer gets `HUMAN ANSWER:` so the model can never confuse it with its own
 * earlier guess. An answer that came from `default_answer` gets a clearly different
 * prefix: labelling the agent's own default as a human answer would be worse than no
 * prefix at all.
 */
function answerText(answer: string | undefined, answeredBy: string | undefined): string {
  if (answeredBy === "default") {
    return `DEFAULT ANSWER (applied on expiry; no human responded): ${answer ?? ""}`;
  }
  return `${HUMAN_ANSWER_PREFIX} ${answer ?? ""}`;
}

/**
 * Machine-readable wait result. Typed as a plain record because that is what
 * `structuredContent` requires on the wire; `WaitForAnswerOutput` documents its shape.
 */
function waitOutput(ticket: Ticket): Record<string, unknown> {
  const out: WaitForAnswerOutput = { id: ticket.id, status: ticket.status };
  if (ticket.answer !== undefined) {
    out.answer = ticket.answer;
  }
  if (ticket.answered_by !== undefined) {
    out.answered_by = ticket.answered_by;
  }
  if (ticket.answered_at !== undefined) {
    out.answered_at = ticket.answered_at;
  }
  if (ticket.media !== undefined) {
    out.media = ticket.media;
  }
  if (ticket.annotations !== undefined) {
    out.annotations = ticket.annotations;
  }
  return { ...out };
}

/**
 * A one-line summary of the annotations, so an agent reading only the text content
 * still knows the human left feedback beyond the answer.
 */
function annotationSummary(ticket: Ticket): string | undefined {
  const annotations = ticket.annotations;
  if (annotations === undefined || annotations.length === 0) {
    return undefined;
  }
  const notes = annotations.filter((annotation) => annotation.text !== undefined).length;
  const markup = annotations.filter((annotation) => annotation.annotated_media !== undefined).length;
  const parts: string[] = [];
  if (notes > 0) {
    parts.push(`${notes} note${notes === 1 ? "" : "s"}`);
  }
  if (markup > 0) {
    parts.push(`${markup} annotated image${markup === 1 ? "" : "s"}`);
  }
  return `The human also left ${annotations.length} annotation(s) (${parts.join(", ")}); see the attached content and the structured "annotations" field.`;
}

/**
 * Build the `wait_for_answer` result: the text answer plus, for any annotation that
 * carries a rendered markup copy, the image content itself. Handing the bytes back
 * inline is what makes an annotation useful to an agent that only speaks MCP — it does
 * not have to fetch a URL to see what the human drew.
 */
async function waitResult(ticket: Ticket, waitedSeconds: number, store: TicketStore): Promise<ToolResult> {
  const content: ToolContent[] = [{ type: "text", text: waitText(ticket, waitedSeconds) }];

  if (ticket.status === "answered" && ticket.annotations !== undefined) {
    for (const annotation of ticket.annotations) {
      const ref = annotation.annotated_media;
      if (ref === undefined) {
        continue;
      }
      const blob = await store.getMedia(ref.id);
      if (blob === undefined) {
        continue;
      }
      if (ref.kind === "image") {
        content.push({ type: "image", data: blob.data_base64, mimeType: blob.mime_type });
      } else if (ref.kind === "audio") {
        content.push({ type: "audio", data: blob.data_base64, mimeType: blob.mime_type });
      }
    }
  }

  return { content, structuredContent: waitOutput(ticket) };
}

function waitText(ticket: Ticket, waitedSeconds: number): string {
  switch (ticket.status) {
    case "answered": {
      // A human answer always carries the HUMAN ANSWER prefix, including the case where
      // the human responded with annotations only. The model must never mistake a human
      // response for its own earlier guess, and an annotation-only answer is still a
      // human response.
      const lines: string[] = [
        ticket.answer !== undefined && ticket.answer !== ""
          ? answerText(ticket.answer, ticket.answered_by)
          : "HUMAN ANSWER: (no text; the human responded with annotations only — see the attached content)",
      ];
      const summary = annotationSummary(ticket);
      if (summary !== undefined) {
        lines.push(summary);
      }
      return lines.join("\n\n");
    }
    case "expired":
      return ticket.answer !== undefined
        ? `DEFAULT ANSWER (applied on expiry; no human responded): ${ticket.answer}`
        : `Ticket ${ticket.id} expired with no answer and no default_answer was set. Do not assume an answer: decide for yourself or ask again with ask_human.`;
    case "cancelled":
      return `Ticket ${ticket.id} was cancelled. Stop waiting and do not assume an answer.`;
    case "pending":
    default:
      return `Ticket ${ticket.id} is still pending after ${waitedSeconds}s. Continue with independent work and call wait_for_answer again later; do not poll in a tight loop.`;
  }
}

async function runAskHuman(args: unknown, deps: ToolDeps): Promise<ToolResult> {
  const input = validateAskHuman(args);
  const ticket = await enqueue(deps.store, input, {
    defaultStream: deps.defaultStream,
    now: deps.now(),
  });

  const mediaCount = ticket.media?.length ?? 0;
  const mediaText = mediaCount > 0 ? `, ${mediaCount} media attachment(s)` : "";
  const text =
    `Ticket ${ticket.id} enqueued (stream "${ticket.stream}", urgency ${ticket.urgency}, ` +
    `status pending${mediaText}, expires_at ${ticket.expires_at}). Continue with independent work and call ` +
    `wait_for_answer with id "${ticket.id}" later. Do not poll in a tight loop.`;

  const structured: Record<string, unknown> = {
    id: ticket.id,
    status: "pending",
    stream: ticket.stream,
    urgency: ticket.urgency,
    expires_at: ticket.expires_at,
  };
  if (ticket.media !== undefined) {
    structured.media = ticket.media;
  }

  return textResult(text, structured);
}

async function runWaitForAnswer(args: unknown, deps: ToolDeps): Promise<ToolResult> {
  const input = validateWaitForAnswer(args);
  const sleep = deps.sleep ?? defaultSleep;

  const requested = Math.min(input.timeout_seconds ?? WAIT_DEFAULT_SECONDS, WAIT_MAX_SECONDS);
  const effective = deps.waitClampSeconds !== undefined ? Math.min(requested, deps.waitClampSeconds) : requested;
  const deadline = Date.now() + effective * 1000;

  for (; ;) {
    const ticket = await getResolved(deps.store, input.id, deps.now());
    if (ticket === undefined) {
      throw notFound(input.id);
    }
    if (ticket.status !== "pending") {
      return waitResult(ticket, effective, deps.store);
    }
    if (Date.now() >= deadline) {
      return waitResult(ticket, effective, deps.store);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function runListPending(args: unknown, deps: ToolDeps): Promise<ToolResult> {
  validateListPending(args);
  const tickets = await listResolved(deps.store, { status: "pending" }, deps.now());

  const text =
    tickets.length === 0
      ? "No pending tickets."
      : `${tickets.length} pending ticket(s):\n${tickets
        .map((ticket) => `- ${ticket.id} [${ticket.stream}] ${ticket.question}`)
        .join("\n")}`;

  return textResult(text, { tickets });
}

async function runCancelTicket(args: unknown, deps: ToolDeps): Promise<ToolResult> {
  const input = validateCancelTicket(args);
  const ticket = await cancelTicket(deps.store, input.id, deps.now());
  return textResult(`Ticket ${ticket.id} cancelled.`, { id: ticket.id, status: "cancelled" });
}

async function dispatch(name: string, args: unknown, deps: ToolDeps): Promise<ToolResult> {
  switch (name) {
    case "ask_human":
      return runAskHuman(args, deps);
    case "wait_for_answer":
      return runWaitForAnswer(args, deps);
    case "list_pending":
      return runListPending(args, deps);
    case "cancel_ticket":
      return runCancelTicket(args, deps);
    default:
      throw new ValidationError(name, `unknown tool \`${name}\``);
  }
}

/**
 * Validate, dispatch, and return the tool result.
 *
 * Validation and lifecycle rejections are returned as `isError` results with the
 * message intact, so the agent sees a fixable error rather than a transport failure.
 * Anything else is a bug and is rethrown.
 */
export async function handleToolCall(name: string, args: unknown, deps: ToolDeps): Promise<ToolResult> {
  try {
    return await dispatch(name, args, deps);
  } catch (error) {
    if (error instanceof ValidationError) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        structuredContent: { error: error.message, tool: error.tool },
        isError: true,
      };
    }
    if (error instanceof QueueError) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        structuredContent: { error: error.message, status: error.status },
        isError: true,
      };
    }
    throw error;
  }
}
