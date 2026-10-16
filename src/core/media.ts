/**
 * Media helpers shared by every target.
 *
 * Target-agnostic by design: base64 is done with the `atob`/`btoa` globals that both
 * Node 22 and the Workers runtime expose, never `Buffer`, so this module runs
 * unchanged on both. No target-specific imports.
 *
 * The media *bytes* are moved as base64 across every boundary (the MCP tool call, the
 * Durable Object RPC, `POST /api/media`), because base64 is the one binary encoding
 * that survives JSON, stdio, and the SQLite text columns alike. Decoding happens only
 * at the edges that need raw bytes: `FileTicketStore` writing a file.
 */

import { MEDIA_CHUNK_BYTES } from "./constants";
import type { MediaInput, MediaKind, MediaRef } from "./types";

/** `image/*`, `audio/*`, and `video/*` are the supported families. Anything else is rejected. */
export function mediaKind(mimeType: string): MediaKind | undefined {
  const base = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (base.startsWith("image/")) {
    return "image";
  }
  if (base.startsWith("audio/")) {
    return "audio";
  }
  if (base.startsWith("video/")) {
    return "video";
  }
  return undefined;
}

/** The MIME type inside an optional `data:<mime>;base64,` prefix, lowercased. */
export function dataUriMime(input: string): string | undefined {
  const match = /^data:([^;,]+);base64,/i.exec(input.trim());
  return match === null ? undefined : match[1]!.toLowerCase();
}

/** Drop an optional `data:<mime>;base64,` prefix if present. */
export function stripDataUri(input: string): string {
  return input.trim().replace(/^data:[^;,]+;base64,/i, "");
}

/** Remove whitespace, which is legal inside base64 and common when it has been wrapped. */
export function normalizeBase64(input: string): string {
  return input.replace(/\s+/g, "");
}

/**
 * Decode standard base64 to bytes. Throws `InvalidCharacterError` (from `atob`) on
 * malformed input; callers turn that into an agent-readable validation error.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Encode bytes as standard base64. Chunked so a large blob cannot blow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/**
 * The exact byte length a base64 string decodes to, without decoding it.
 *
 * Used to enforce size caps before spending the memory to decode a hostile payload.
 */
export function base64ByteLength(base64: string): number {
  const length = base64.length;
  if (length === 0) {
    return 0;
  }
  let padding = 0;
  if (base64.endsWith("==")) {
    padding = 2;
  } else if (base64.endsWith("=")) {
    padding = 1;
  }
  return Math.floor((length * 3) / 4) - padding;
}

/**
 * Split a base64 blob into chunk encodings for row-based storage.
 *
 * `MEDIA_CHUNK_BYTES` is a multiple of 3, so every non-final chunk encodes without
 * padding and `chunkBase64(x).join("") === x` holds exactly. That invariant is what
 * lets the Durable Object store read a blob back by concatenating rows.
 */
export function chunkBase64(base64: string): string[] {
  const bytes = base64ToBytes(base64);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += MEDIA_CHUNK_BYTES) {
    chunks.push(bytesToBase64(bytes.subarray(offset, offset + MEDIA_CHUNK_BYTES)));
  }
  return chunks;
}

/** Build the stored metadata ref for a validated media upload. */
export function buildMediaRef(id: string, input: MediaInput, now: string): MediaRef {
  const ref: MediaRef = {
    id,
    kind: mediaKind(input.mime_type) ?? "image",
    mime_type: input.mime_type,
    size_bytes: base64ByteLength(input.data_base64),
    created_at: now,
  };
  if (input.filename !== undefined) {
    ref.filename = input.filename;
  }
  if (input.caption !== undefined) {
    ref.caption = input.caption;
  }
  return ref;
}

/**
 * True when an id is safe to use as a filename and as a URL path segment.
 *
 * Ids are minted by the server as UUIDs, but `GET /api/media/{id}` takes an id straight
 * from the URL, so every read is guarded against traversal (`../`, `/`, `\`, NUL).
 */
export function isSafeMediaId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}
