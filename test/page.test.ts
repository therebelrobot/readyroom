/**
 * Static-analysis guard for `public/index.html`.
 *
 * This is deliberately NOT a DOM test. It reads the page as a string and asserts
 * the invariants that are easy to drift: no external origins, the live-update
 * pair (EventSource + polling fallback), the keyboard handlers, reduced-motion
 * support, pre-wrap context rendering, the tab-title count logic, and the
 * localStorage token store.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "public", "index.html"), "utf8");

test("page: no external origins (self-contained, renders with the network cut)", () => {
  assert.equal(html.includes("http://"), false, "must not reference an http:// origin");
  assert.equal(html.includes("https://"), false, "must not reference an https:// origin");
  assert.equal(html.includes("//cdn"), false, "must not reference a CDN");
});

test("page: live updates use a fetch-based SSE reader", () => {
  assert.equal(html.includes("new EventSource"), false, "must not construct an EventSource (it cannot send a Bearer header)");
  assert.ok(html.includes("/api/events"), "must subscribe to /api/events");
  assert.ok(html.includes("TextDecoder"), "must decode SSE bytes with a TextDecoder");
  assert.ok(html.includes("getReader"), "must read response.body through a ReadableStream reader");
  assert.ok(html.includes("Authorization"), "must send the Bearer header on the SSE request");
});

test("page: polling fallback exists and hits /api/tickets", () => {
  assert.ok(html.includes("setInterval"), "must poll on an interval");
  assert.ok(html.includes("/api/tickets"), "must poll /api/tickets");
  assert.ok(html.includes("startPolling"), "must have a polling fallback path");
});

test("page: keyboard handlers for j/k/1-5/Enter/u", () => {
  assert.ok(html.includes("e.key === \"j\""), "must handle j");
  assert.ok(html.includes("e.key === \"k\""), "must handle k");
  assert.ok(html.includes("e.key >= \"1\" && e.key <= \"5\""), "must handle 1-5");
  assert.ok(html.includes("e.key === \"Enter\""), "must handle Enter");
  assert.ok(html.includes("e.key === \"u\""), "must handle u");
  assert.ok(html.includes("isTypingTarget"), "must not fire shortcuts while typing");
});

test("page: respects prefers-reduced-motion", () => {
  assert.ok(html.includes("prefers-reduced-motion"), "must gate motion on the media query");
});

test("page: context renders with line breaks preserved", () => {
  assert.ok(html.includes("pre-wrap"), "must use white-space: pre-wrap");
});

test("page: tab title carries the pending count", () => {
  assert.ok(html.includes(") readyroom"), "must render the (N) readyroom form");
  assert.ok(html.includes("\"readyroom\""), "must render the bare readyroom form at zero");
});

test("page: token is stored in localStorage and sent as a Bearer header", () => {
  assert.ok(html.includes("localStorage"), "must persist the token in localStorage");
  assert.ok(html.includes("Bearer "), "must send an Authorization: Bearer header");
  assert.ok(html.includes("Authorization"), "must set the Authorization header");
});

test("page: undo posts to /api/undo and answer posts to /api/answer", () => {
  assert.ok(html.includes("/api/undo"), "must call /api/undo");
  assert.ok(html.includes("/api/answer"), "must call /api/answer");
});

test("page: first paint is synchronous, not inside requestAnimationFrame", () => {
  assert.equal(html.includes("requestAnimationFrame"), false, "must not defer first paint to rAF");
  assert.ok(html.includes("window.addEventListener(\"load\""), "must re-render on window load");
});

test("page: media is fetched with the Bearer token and shown via object URLs", () => {
  assert.ok(html.includes("/api/media/"), "must fetch a blob from /api/media/{id}");
  assert.ok(html.includes("createObjectURL"), "must render fetched bytes from an object URL (<img src> cannot send a Bearer header)");
  assert.ok(html.includes("Authorization"), "must attach the Bearer header to the media fetch");
});

test("page: attachments are expandable for inspection", () => {
  assert.ok(html.includes("media-toggle"), "must have an expand/collapse control");
  assert.ok(html.includes("aria-expanded"), "the toggle must expose aria-expanded");
  assert.ok(html.includes("for inspection"), "the toggle must name what it does");
});

test("page: images are drawn on (annotated) on a canvas", () => {
  assert.ok(html.includes("data-media-stage"), "must mark the media stage for keyboard handling");
  assert.ok(html.includes("createElement(\"canvas\")"), "images must be annotatable on a canvas");
  assert.ok(html.includes("pointerdown"), "the canvas must accept pointer drawing");
  assert.ok(html.includes("toBlob"), "markup must be rendered to an image blob");
});

test("page: annotations and the rendered markup are sent with the answer", () => {
  assert.ok(html.includes("annotations"), "the answer body must carry annotations");
  assert.ok(html.includes("annotated_media_id"), "a rendered copy must be referenced by id");
  assert.ok(html.includes("\"/api/media\""), "the rendered copy must be uploaded to POST /api/media");
  assert.ok(html.includes("or add an annotation first"), "the empty-submit guard must allow an annotation-only answer");
});
