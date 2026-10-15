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
