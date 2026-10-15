/**
 * Constant-time string comparison, shared by all three targets.
 *
 * Why this exists (spec, Security rule 2): `node:crypto.timingSafeEqual` is a Node
 * builtin and is not reliably present on Workers. One shared, dependency-free
 * implementation is the only way all three targets get the same guarantee.
 *
 * Design constraints:
 *  - Synchronous. The HTTP guard is written as `if (!constantTimeEqual(a, b))`, and
 *    Workers' `crypto.subtle` API is async-only, so it cannot be used here.
 *  - No `node:crypto` import anywhere.
 *  - Both inputs are reduced to a fixed-length digest (SHA-256, 32 bytes) before
 *    comparison. Equal-length digests are what prevent length leakage: the byte loop
 *    below always runs 32 times regardless of the caller's string lengths.
 *  - No early return: the XOR of every byte is accumulated, and the single equality
 *    test happens once, after the loop.
 *
 * A compact pure-JS SHA-256 is implemented here so the module needs no imports at
 * all and runs on any JS runtime.
 */

/** SHA-256 round constants. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Pure, synchronous SHA-256. Returns a 32-byte digest. */
function sha256(input: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const bitLength = input.length * 8;
  const paddedLength = (input.length + 9 + 63) & ~63;
  const message = new Uint8Array(paddedLength);
  message.set(input);
  message[input.length] = 0x80;

  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  message[paddedLength - 8] = (high >>> 24) & 0xff;
  message[paddedLength - 7] = (high >>> 16) & 0xff;
  message[paddedLength - 6] = (high >>> 8) & 0xff;
  message[paddedLength - 5] = high & 0xff;
  message[paddedLength - 4] = (low >>> 24) & 0xff;
  message[paddedLength - 3] = (low >>> 16) & 0xff;
  message[paddedLength - 2] = (low >>> 8) & 0xff;
  message[paddedLength - 1] = low & 0xff;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = (message[j] << 24) | (message[j + 1] << 16) | (message[j + 2] << 8) | message[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const digest = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    digest[i * 4] = (h[i] >>> 24) & 0xff;
    digest[i * 4 + 1] = (h[i] >>> 16) & 0xff;
    digest[i * 4 + 2] = (h[i] >>> 8) & 0xff;
    digest[i * 4 + 3] = h[i] & 0xff;
  }
  return digest;
}

const encoder = new TextEncoder();

/**
 * Compare two strings in constant time (`a` against `b`, typically a presented
 * bearer token against the configured one). Both inputs are hashed to a fixed-length
 * 32-byte digest first, so the comparison loop's work does not depend on either
 * string's length, and no byte position can short-circuit the loop.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = sha256(encoder.encode(a));
  const digestB = sha256(encoder.encode(b));

  let difference = 0;
  for (let i = 0; i < digestA.length; i++) {
    difference |= digestA[i] ^ digestB[i];
  }

  return difference === 0;
}
