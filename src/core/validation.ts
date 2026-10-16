/**
 * Tool input validation.
 *
 * Every rejection throws a `ValidationError` whose message is written for an agent
 * to read and act on: it names the field, the constraint, and what to send instead.
 * Target-agnostic: no SDK import, no target-specific import.
 */

import type {
  AnnotationInput,
  AskHumanInput,
  MediaInput,
  Urgency,
  WaitForAnswerInput,
  CancelTicketInput,
} from "./types";
import {
  MAX_ANNOTATION_BYTES,
  MAX_ANNOTATIONS,
  MAX_MEDIA_BYTES_PER_FILE,
  MAX_MEDIA_BYTES_PER_TICKET,
  MAX_MEDIA_FILES,
  MAX_TIMEOUT_SECONDS,
  WAIT_MAX_SECONDS,
} from "./constants";
import {
  base64ByteLength,
  base64ToBytes,
  dataUriMime,
  isSafeMediaId,
  mediaKind,
  normalizeBase64,
  stripDataUri,
} from "./media";

/** Thrown when a tool's arguments are malformed. `handleToolCall` turns it into an `isError` result. */
export class ValidationError extends Error {
  readonly tool: string;

  constructor(tool: string, message: string) {
    super(`[${tool}] ${message}`);
    this.name = "ValidationError";
    this.tool = tool;
  }
}

const URGENCIES: readonly Urgency[] = ["low", "normal", "blocking"];

/** Keys the caller may send. Anything else is a typo the agent should hear about. */
const ASK_HUMAN_KEYS = [
  "question",
  "options",
  "context",
  "default_answer",
  "timeout_seconds",
  "urgency",
  "stream",
  "media",
] as const;

/** The only keys a `media` attachment may carry. */
const MEDIA_KEYS = ["mime_type", "data_base64", "filename", "caption"] as const;

/** The only keys an annotation may carry. */
const ANNOTATION_KEYS = ["text", "media_id", "at_seconds", "annotated_media_id"] as const;

/** Human-readable byte size for validation messages. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function fail(tool: string, message: string): never {
  throw new ValidationError(tool, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(tool: string, args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) {
    return {};
  }
  if (!isRecord(args)) {
    fail(tool, "arguments must be a JSON object");
  }
  return args;
}

function rejectUnknownKeys(tool: string, args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      fail(tool, `unknown argument \`${key}\`. Allowed arguments: ${allowed.join(", ")}`);
    }
  }
}

function optionalString(tool: string, args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    fail(tool, `\`${key}\` must be a string when present`);
  }
  return value;
}

function requireNonEmptyString(tool: string, args: Record<string, unknown>, key: string): string {
  const value = optionalString(tool, args, key);
  if (value === undefined || value.trim() === "") {
    fail(tool, `\`${key}\` is required and must be a non-empty string`);
  }
  return value;
}

function optionalInteger(
  tool: string,
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(tool, `\`${key}\` must be an integer when present`);
  }
  if (value < min || value > max) {
    fail(tool, `\`${key}\` must be between ${min} and ${max} (got ${value})`);
  }
  return value;
}

/**
 * Validate one base64 media payload, returning the normalized (whitespace- and
 * `data:`-prefix-free) base64 and its exact decoded size.
 *
 * The size cap is checked arithmetically first, so an oversized payload is rejected
 * before the memory to decode it is spent.
 */
function normalizeMediaData(tool: string, label: string, rawData: string, cap: number): { base64: string; size: number } {
  if (rawData.trim() === "") {
    fail(tool, `\`${label}\` must be a non-empty base64 string`);
  }
  const base64 = normalizeBase64(stripDataUri(rawData));
  const size = base64ByteLength(base64);
  if (size > cap) {
    fail(tool, `\`${label}\` is ${formatBytes(size)}; the limit is ${formatBytes(cap)}`);
  }
  try {
    // Decoding is the only reliable validity check across Node and Workers.
    base64ToBytes(base64);
  } catch {
    fail(tool, `\`${label}\` is not valid base64`);
  }
  return { base64, size };
}

/** Validate and normalize the optional `media` array of `ask_human`. */
function validateAskHumanMedia(tool: string, raw: Record<string, unknown>): MediaInput[] | undefined {
  const value = raw["media"];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    fail(tool, "`media` must be an array of attachments when present");
  }
  if (value.length === 0) {
    return undefined;
  }
  if (value.length > MAX_MEDIA_FILES) {
    fail(tool, `\`media\` may contain at most ${MAX_MEDIA_FILES} attachments (got ${value.length})`);
  }

  const out: MediaInput[] = [];
  let totalBytes = 0;

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const label = `media[${index}]`;
    if (!isRecord(item)) {
      fail(tool, `\`${label}\` must be an object`);
    }
    for (const key of Object.keys(item)) {
      if (!(MEDIA_KEYS as readonly string[]).includes(key)) {
        fail(
          tool,
          `unknown argument \`${label}.${key}\`. Allowed arguments: ${MEDIA_KEYS.join(", ")}`,
        );
      }
    }

    const rawMime = item["mime_type"];
    const declaredMime =
      typeof rawMime === "string" && rawMime.trim() !== "" ? rawMime.trim().toLowerCase() : undefined;
    const rawData = item["data_base64"];
    if (typeof rawData !== "string") {
      fail(tool, `\`${label}.data_base64\` is required and must be a base64 string`);
    }
    // A `data:image/png;base64,…` string may stand in for an explicit mime_type.
    const effectiveMime = declaredMime ?? dataUriMime(rawData);
    if (effectiveMime === undefined) {
      fail(tool, `\`${label}.mime_type\` is required (e.g. "image/png", "audio/mpeg", "video/mp4")`);
    }
    if (mediaKind(effectiveMime) === undefined) {
      fail(tool, `\`${label}.mime_type\` must be an image/*, audio/*, or video/* type (got "${effectiveMime}")`);
    }

    const { base64, size } = normalizeMediaData(tool, `${label}.data_base64`, rawData, MAX_MEDIA_BYTES_PER_FILE);
    totalBytes += size;

    const entry: MediaInput = { mime_type: effectiveMime, data_base64: base64 };
    const filename = optionalString(tool, item, "filename");
    if (filename !== undefined && filename.trim() !== "") {
      entry.filename = filename.trim();
    }
    const caption = optionalString(tool, item, "caption");
    if (caption !== undefined && caption.trim() !== "") {
      entry.caption = caption.trim();
    }
    out.push(entry);
  }

  if (totalBytes > MAX_MEDIA_BYTES_PER_TICKET) {
    fail(
      tool,
      `\`media\` totals ${formatBytes(totalBytes)}; the per-ticket limit is ${formatBytes(MAX_MEDIA_BYTES_PER_TICKET)}`,
    );
  }
  return out;
}

/**
 * Validate and normalize one uploaded blob for `POST /api/media`. Returns the same
 * `MediaInput` shape the agent sends, so the store path is identical.
 */
export function validateMediaUpload(args: unknown): MediaInput {
  const tool = "media_upload";
  const raw = requireRecord(tool, args);
  rejectUnknownKeys(tool, raw, MEDIA_KEYS);

  const rawMime = raw["mime_type"];
  const declaredMime =
    typeof rawMime === "string" && rawMime.trim() !== "" ? rawMime.trim().toLowerCase() : undefined;
  const rawData = raw["data_base64"];
  if (typeof rawData !== "string") {
    fail(tool, "`data_base64` is required and must be a base64 string");
  }
  const effectiveMime = declaredMime ?? dataUriMime(rawData);
  if (effectiveMime === undefined) {
    fail(tool, "`mime_type` is required (e.g. \"image/png\")");
  }
  if (mediaKind(effectiveMime) === undefined) {
    fail(tool, `\`mime_type\` must be an image/*, audio/*, or video/* type (got "${effectiveMime}")`);
  }

  const { base64 } = normalizeMediaData(tool, "data_base64", rawData, MAX_ANNOTATION_BYTES);
  const entry: MediaInput = { mime_type: effectiveMime, data_base64: base64 };
  const filename = optionalString(tool, raw, "filename");
  if (filename !== undefined && filename.trim() !== "") {
    entry.filename = filename.trim();
  }
  const caption = optionalString(tool, raw, "caption");
  if (caption !== undefined && caption.trim() !== "") {
    entry.caption = caption.trim();
  }
  return entry;
}

/**
 * Validate and normalize the `annotations` array of `POST /api/answer`.
 *
 * Every annotation must carry something actionable — note text or a rendered markup
 * copy. An empty annotation is rejected rather than silently dropped, so a page bug is
 * visible to the agent instead of quietly losing the human's feedback.
 */
export function validateAnnotationInputs(args: unknown): AnnotationInput[] {
  const tool = "answer";
  if (args === undefined || args === null) {
    return [];
  }
  if (!Array.isArray(args)) {
    fail(tool, "`annotations` must be an array when present");
  }
  if (args.length > MAX_ANNOTATIONS) {
    fail(tool, `\`annotations\` may contain at most ${MAX_ANNOTATIONS} items (got ${args.length})`);
  }

  const out: AnnotationInput[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    const label = `annotations[${index}]`;
    if (!isRecord(item)) {
      fail(tool, `\`${label}\` must be an object`);
    }
    for (const key of Object.keys(item)) {
      if (!(ANNOTATION_KEYS as readonly string[]).includes(key)) {
        fail(
          tool,
          `unknown argument \`${label}.${key}\`. Allowed arguments: ${ANNOTATION_KEYS.join(", ")}`,
        );
      }
    }

    const text = optionalString(tool, item, "text");
    const annotatedMediaId = optionalString(tool, item, "annotated_media_id");
    if ((text === undefined || text.trim() === "") && (annotatedMediaId === undefined || annotatedMediaId.trim() === "")) {
      fail(tool, `\`${label}\` must carry \`text\` or \`annotated_media_id\``);
    }

    const entry: AnnotationInput = {};
    if (text !== undefined && text.trim() !== "") {
      entry.text = text.trim();
    }
    if (annotatedMediaId !== undefined && annotatedMediaId.trim() !== "") {
      if (!isSafeMediaId(annotatedMediaId)) {
        fail(tool, `\`${label}.annotated_media_id\` is not a valid media id`);
      }
      entry.annotated_media_id = annotatedMediaId;
    }

    const mediaId = optionalString(tool, item, "media_id");
    if (mediaId !== undefined && mediaId.trim() !== "") {
      if (!isSafeMediaId(mediaId)) {
        fail(tool, `\`${label}.media_id\` is not a valid media id`);
      }
      entry.media_id = mediaId;
    }

    const atSeconds = item["at_seconds"];
    if (atSeconds !== undefined && atSeconds !== null) {
      if (typeof atSeconds !== "number" || !Number.isFinite(atSeconds) || atSeconds < 0) {
        fail(tool, `\`${label}.at_seconds\` must be a non-negative number of seconds`);
      }
      entry.at_seconds = atSeconds;
    }

    out.push(entry);
  }
  return out;
}

/**
 * Count sentence terminators that are not the final one.
 *
 * Pragmatic by design: the spec says "One sentence", and over-rejecting a legitimate
 * one-sentence question is worse than accepting a sloppy one. So common abbreviations
 * and decimals are scrubbed before counting, and only terminators *before* the last
 * one count as evidence of a second sentence.
 */
function extraSentenceTerminators(question: string): number {
  const scrubbed = question
    .replace(/\b(e\.g|i\.e|etc|vs|cf|approx|Mr|Mrs|Ms|Dr|St)\./gi, (match) => match.replace(/\./g, ""))
    .replace(/\d+\.\d+/g, "");
  const withoutTrailing = scrubbed.replace(/[.!?]+\s*$/, "");
  return (withoutTrailing.match(/[.!?]/g) ?? []).length;
}

/** Validate and normalize `ask_human` arguments. */
export function validateAskHuman(args: unknown): AskHumanInput {
  const tool = "ask_human";
  const raw = requireRecord(tool, args);
  rejectUnknownKeys(tool, raw, ASK_HUMAN_KEYS);

  const question = requireNonEmptyString(tool, raw, "question");
  if (extraSentenceTerminators(question) > 0) {
    fail(
      tool,
      "`question` must be one sentence. Ask one decision per ticket, and use `context` for anything else the human needs.",
    );
  }

  const rawOptions = raw["options"];
  let options: string[] | undefined;
  if (rawOptions !== undefined && rawOptions !== null) {
    if (!Array.isArray(rawOptions)) {
      fail(tool, "`options` must be an array of strings when present");
    }
    if (rawOptions.length < 2 || rawOptions.length > 5) {
      fail(tool, `\`options\` must contain between 2 and 5 items (got ${rawOptions.length})`);
    }
    options = rawOptions.map((item, index) => {
      if (typeof item !== "string" || item.trim() === "") {
        fail(tool, `\`options[${index}]\` must be a non-empty string`);
      }
      return item;
    });
  }

  const timeout_seconds = optionalInteger(tool, raw, "timeout_seconds", 1, MAX_TIMEOUT_SECONDS);

  const rawUrgency = raw["urgency"];
  let urgency: Urgency | undefined;
  if (rawUrgency !== undefined && rawUrgency !== null) {
    if (typeof rawUrgency !== "string" || !URGENCIES.includes(rawUrgency as Urgency)) {
      fail(tool, '`urgency` must be one of "low", "normal", "blocking"');
    }
    urgency = rawUrgency as Urgency;
  }

  const context = optionalString(tool, raw, "context");
  const default_answer = optionalString(tool, raw, "default_answer");
  const stream = optionalString(tool, raw, "stream");
  const media = validateAskHumanMedia(tool, raw);

  const result: AskHumanInput = { question };
  if (options !== undefined) {
    result.options = options;
  }
  if (context !== undefined) {
    result.context = context;
  }
  if (default_answer !== undefined) {
    result.default_answer = default_answer;
  }
  if (timeout_seconds !== undefined) {
    result.timeout_seconds = timeout_seconds;
  }
  if (urgency !== undefined) {
    result.urgency = urgency;
  }
  if (stream !== undefined) {
    result.stream = stream;
  }
  if (media !== undefined) {
    result.media = media;
  }
  return result;
}

/** Validate `wait_for_answer` arguments. */
export function validateWaitForAnswer(args: unknown): WaitForAnswerInput {
  const tool = "wait_for_answer";
  const raw = requireRecord(tool, args);
  rejectUnknownKeys(tool, raw, ["id", "timeout_seconds"]);

  const id = requireNonEmptyString(tool, raw, "id");
  const timeout_seconds = optionalInteger(tool, raw, "timeout_seconds", 1, WAIT_MAX_SECONDS);

  const result: WaitForAnswerInput = { id };
  if (timeout_seconds !== undefined) {
    result.timeout_seconds = timeout_seconds;
  }
  return result;
}

/** Validate `cancel_ticket` arguments. */
export function validateCancelTicket(args: unknown): CancelTicketInput {
  const tool = "cancel_ticket";
  const raw = requireRecord(tool, args);
  rejectUnknownKeys(tool, raw, ["id"]);
  return { id: requireNonEmptyString(tool, raw, "id") };
}

/** Validate `list_pending` arguments. It takes no input. */
export function validateListPending(args: unknown): void {
  const tool = "list_pending";
  const raw = requireRecord(tool, args);
  rejectUnknownKeys(tool, raw, []);
}
