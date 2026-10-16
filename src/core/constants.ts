/**
 * Shared, target-agnostic constants.
 *
 * No target-specific imports: this module runs on Node 22 and Cloudflare Workers.
 */

/** Fixed port. Must not collide with 3000-3899, which a worktree helper allocates. */
export const PORT = 8971;

/** Environment variable names. On the Worker these are `vars`/`secrets` in Wrangler config. */
export const ENV_STREAM = "READYROOM_STREAM";
export const ENV_TOKEN = "READYROOM_TOKEN";
export const ENV_BIND = "READYROOM_BIND";
export const ENV_STATE_DIR = "READYROOM_STATE_DIR";
export const ENV_PORT = "READYROOM_PORT";

/** Ticket lifetime default, in seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 1800;

/** Ticket lifetime ceiling, in seconds (24h). */
export const MAX_TIMEOUT_SECONDS = 86400;

/** `wait_for_answer` default wait, in seconds. */
export const WAIT_DEFAULT_SECONDS = 60;

/** `wait_for_answer` ceiling, in seconds. */
export const WAIT_MAX_SECONDS = 600;

/**
 * Worker target only: `wait_for_answer` clamps its effective wait to this window so
 * the response returns well inside a Workers invocation. The tool returns
 * `status: "pending"` promptly, which matches the agent's documented protocol
 * (call again later), so no agent needs to know which target it is talking to.
 */
export const WORKER_WAIT_CLAMP_SECONDS = 5;

/** The undo window for an answered ticket. Measured against the answer timestamp. */
export const UNDO_WINDOW_MS = 5 * 60 * 1000;

/** How long an answered ticket stays in the page's "recent" section (`GET /api/tickets`). */
export const RECENT_WINDOW_MS = 5 * 60 * 1000;

/** Poll interval for `wait_for_answer`. Short enough to feel live, long enough to be cheap. */
export const POLL_INTERVAL_MS = 250;

/** Default state directory (Node targets). */
export const DEFAULT_STATE_DIR = "./.state";

/** Subdirectory of the state dir holding media blobs (`FileTicketStore`). */
export const MEDIA_DIR = "media";

/** Maximum number of media attachments on one ticket. */
export const MAX_MEDIA_FILES = 8;

/** Maximum decoded size of one media attachment, in bytes (8 MiB). */
export const MAX_MEDIA_BYTES_PER_FILE = 8 * 1024 * 1024;

/** Maximum decoded size of all media on one ticket, in bytes (24 MiB). */
export const MAX_MEDIA_BYTES_PER_TICKET = 24 * 1024 * 1024;

/** Maximum decoded size of one rendered annotation image, in bytes (8 MiB). */
export const MAX_ANNOTATION_BYTES = 8 * 1024 * 1024;

/** Maximum number of annotations on one answer. */
export const MAX_ANNOTATIONS = 32;

/**
 * Media bytes per Durable Object SQLite row.
 *
 * Cloudflare caps a SQLite string/BLOB/row at 2 MB, so a large attachment is stored as
 * a series of chunks. 524_286 is a multiple of 3, which means the base64 of every
 * non-final chunk is padding-free and the chunk encodings concatenate into the base64
 * of the whole blob without a decode/re-encode on read.
 */
export const MEDIA_CHUNK_BYTES = 524_286;

/**
 * Maximum request body buffered by the Node HTTP layer, in bytes (48 MiB).
 *
 * Base64 inflates by ~33%, and `ask_human` may carry a ticket's full media budget
 * (`MAX_MEDIA_BYTES_PER_TICKET`) through `/internal/tool-call` or `/mcp` in one body.
 */
export const MAX_BODY_BYTES = 48 * 1024 * 1024;
