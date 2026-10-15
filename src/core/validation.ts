/**
 * Tool input validation.
 *
 * Every rejection throws a `ValidationError` whose message is written for an agent
 * to read and act on: it names the field, the constraint, and what to send instead.
 * Target-agnostic: no SDK import, no target-specific import.
 */

import type { AskHumanInput, Urgency, WaitForAnswerInput, CancelTicketInput } from "./types";
import { MAX_TIMEOUT_SECONDS, WAIT_MAX_SECONDS } from "./constants";

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
] as const;

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
