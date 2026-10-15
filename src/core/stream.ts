/**
 * Stream resolution.
 *
 * A stream is "which agent asked". Precedence, per spec: an explicit `stream`
 * argument wins, then the target-supplied default.
 *
 * Core does NOT compute `cwd`. The Node entry supplies the default from
 * `$READYROOM_STREAM` else `basename(cwd)`; the Worker supplies it from the URL path
 * (`POST /mcp/{stream}`). When neither is available this throws rather than inventing
 * a default, because an invented stream mislabels the ticket and the human cannot
 * tell which agent is asking.
 */
export function resolveStream(explicit: string | undefined, defaultStream: string | undefined): string {
  const chosen = nonEmpty(explicit) ?? nonEmpty(defaultStream);
  if (chosen !== undefined) {
    return chosen;
  }

  throw new Error(
    "No stream resolved for this ticket. Supply an explicit `stream` argument to ask_human, " +
    "or configure a default: set READYROOM_STREAM (or run inside a named directory) on Node, " +
    "or address the Worker target at POST /mcp/{stream}.",
  );
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
