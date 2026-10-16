import { test } from "node:test";
import assert from "node:assert/strict";

import {
  base64ByteLength,
  base64ToBytes,
  buildMediaRef,
  bytesToBase64,
  chunkBase64,
  dataUriMime,
  isSafeMediaId,
  mediaKind,
  normalizeBase64,
  stripDataUri,
} from "../../src/core/media";
import { MEDIA_CHUNK_BYTES } from "../../src/core/constants";

function bytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = (i * 7 + 13) % 251;
  }
  return out;
}

test("mediaKind derives image/audio/video from the MIME family and rejects the rest", () => {
  assert.equal(mediaKind("image/png"), "image");
  assert.equal(mediaKind("image/jpeg; charset=binary"), "image");
  assert.equal(mediaKind("audio/mpeg"), "audio");
  assert.equal(mediaKind("video/mp4"), "video");
  assert.equal(mediaKind("application/pdf"), undefined);
  assert.equal(mediaKind("text/plain"), undefined);
  assert.equal(mediaKind(""), undefined);
});

test("base64 round-trips for empty and non-multiple-of-3 lengths", () => {
  for (const n of [0, 1, 2, 3, 4, 5, 31, 255, 4096]) {
    const original = bytes(n);
    const encoded = bytesToBase64(original);
    const decoded = base64ToBytes(encoded);
    assert.deepEqual(decoded, original, `round trip for ${n} bytes`);
  }
});

test("base64ByteLength matches the decoded length, with and without padding", () => {
  for (const n of [0, 1, 2, 3, 4, 5, 255]) {
    const encoded = bytesToBase64(bytes(n));
    assert.equal(base64ByteLength(encoded), n, `length for ${n} bytes`);
  }
  // Unpadded input still reports the right size.
  assert.equal(base64ByteLength(bytesToBase64(bytes(4)).replace(/=+$/, "")), 4);
});

test("chunkBase64 splits so the chunk encodings concatenate back into the original", () => {
  const sizes = [
    0,
    1,
    3,
    MEDIA_CHUNK_BYTES - 1,
    MEDIA_CHUNK_BYTES,
    MEDIA_CHUNK_BYTES + 1,
    MEDIA_CHUNK_BYTES * 2,
    MEDIA_CHUNK_BYTES * 2 + 5,
  ];
  for (const n of sizes) {
    const encoded = bytesToBase64(bytes(n));
    const chunks = chunkBase64(encoded);
    assert.equal(chunks.join(""), encoded, `chunk join for ${n} bytes`);
    // Every non-final chunk is padding-free (the multiple-of-3 property).
    for (let i = 0; i < chunks.length - 1; i += 1) {
      assert.equal(chunks[i]!.includes("="), false, `chunk ${i} of ${n} bytes must be padding-free`);
    }
  }
});

test("chunkBase64 always produces at least one chunk for a non-empty blob", () => {
  assert.equal(chunkBase64("").length, 0);
  assert.equal(chunkBase64(bytesToBase64(bytes(1))).length, 1);
  assert.equal(chunkBase64(bytesToBase64(bytes(MEDIA_CHUNK_BYTES + 1))).length, 2);
});

test("isSafeMediaId permits UUID-style ids and blocks path traversal", () => {
  assert.equal(isSafeMediaId("11111111-1111-4111-8111-111111111111"), true);
  assert.equal(isSafeMediaId("abc_def-123"), true);
  assert.equal(isSafeMediaId(""), false);
  assert.equal(isSafeMediaId("../etc/passwd"), false);
  assert.equal(isSafeMediaId("a/b"), false);
  assert.equal(isSafeMediaId("a\\b"), false);
  assert.equal(isSafeMediaId("a.b"), false);
});

test("data URI helpers strip an optional base64 prefix", () => {
  assert.equal(dataUriMime("data:image/png;base64,AAAA"), "image/png");
  assert.equal(dataUriMime("AAAA"), undefined);
  assert.equal(stripDataUri("data:image/png;base64,AAAA"), "AAAA");
  assert.equal(stripDataUri("AAAA"), "AAAA");
  assert.equal(normalizeBase64("AA\nBB CC"), "AABBCC");
});

test("buildMediaRef derives the kind and carries the optional fields", () => {
  const ref = buildMediaRef("id-1", { mime_type: "image/png", data_base64: bytesToBase64(bytes(3)), filename: "a.png", caption: "before" }, "2026-01-01T00:00:00.000Z");
  assert.equal(ref.kind, "image");
  assert.equal(ref.mime_type, "image/png");
  assert.equal(ref.size_bytes, 3);
  assert.equal(ref.filename, "a.png");
  assert.equal(ref.caption, "before");
  assert.equal(ref.created_at, "2026-01-01T00:00:00.000Z");

  const bare = buildMediaRef("id-2", { mime_type: "video/mp4", data_base64: bytesToBase64(bytes(4)) }, "2026-01-01T00:00:00.000Z");
  assert.equal(bare.kind, "video");
  assert.equal(bare.filename, undefined);
  assert.equal(bare.caption, undefined);
});
