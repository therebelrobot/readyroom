import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeTicketStore } from "./fakeStore";
import {
  QueueError,
  answer,
  cancel,
  enqueue,
  getResolved,
  listForPage,
  listResolved,
  resolveExpiry,
  undo,
  uploadMedia,
} from "../../src/core/queue";
import { DEFAULT_TIMEOUT_SECONDS, RECENT_WINDOW_MS, UNDO_WINDOW_MS } from "../../src/core/constants";
import { base64ByteLength, bytesToBase64 } from "../../src/core/media";
import type { Ticket } from "../../src/core/types";

const T0 = "2026-01-01T00:00:00.000Z";
const at = (offsetMs: number): string => new Date(Date.parse(T0) + offsetMs).toISOString();

function baseTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    stream: "alpha",
    question: "Ship it?",
    urgency: "normal",
    status: "pending",
    created_at: T0,
    expires_at: at(DEFAULT_TIMEOUT_SECONDS * 1000),
    ...overrides,
  };
}

test("enqueue creates a pending ticket with defaults and one created audit entry", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(store, { question: "Ship it?" }, { defaultStream: "alpha", now: T0 });

  assert.equal(ticket.status, "pending");
  assert.equal(ticket.stream, "alpha");
  assert.equal(ticket.urgency, "normal");
  assert.equal(ticket.created_at, T0);
  assert.equal(ticket.expires_at, at(DEFAULT_TIMEOUT_SECONDS * 1000));
  assert.match(ticket.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  assert.equal(store.audit.length, 1);
  assert.equal(store.audit[0].action, "created");
  assert.equal(store.audit[0].by, "alpha");
  assert.equal(store.audit[0].ticket_id, ticket.id);
  assert.deepEqual(await store.get(ticket.id), ticket);
});

test("enqueue honours an explicit stream, timeout, urgency, and default_answer", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(
    store,
    {
      question: "Ship it?",
      stream: "explicit-stream",
      timeout_seconds: 60,
      urgency: "blocking",
      default_answer: "no",
      options: ["yes", "no"],
      context: "line one\nline two",
    },
    { defaultStream: "from-default", now: T0 },
  );

  assert.equal(ticket.stream, "explicit-stream");
  assert.equal(ticket.expires_at, at(60_000));
  assert.equal(ticket.urgency, "blocking");
  assert.equal(ticket.default_answer, "no");
  assert.deepEqual(ticket.options, ["yes", "no"]);
  assert.equal(ticket.context, "line one\nline two");
});

test("enqueue fails clearly when no stream can be resolved", async () => {
  const store = new FakeTicketStore();
  await assert.rejects(() => enqueue(store, { question: "Ship it?" }, { now: T0 }), /No stream resolved/);
});

test("resolveExpiry applies default_answer once expires_at has passed", () => {
  const ticket = baseTicket({ expires_at: at(1000), default_answer: "proceed" });
  const resolved = resolveExpiry(ticket, at(1001));

  assert.notEqual(resolved, ticket, "a resolved ticket must be a new object");
  assert.equal(resolved.status, "expired");
  assert.equal(resolved.answer, "proceed");
  assert.equal(resolved.answered_by, "default");
  assert.equal(resolved.answered_at, at(1001));
});

test("resolveExpiry marks an expiry with no default_answer as expired without an answer", () => {
  const ticket = baseTicket({ expires_at: at(1000) });
  const resolved = resolveExpiry(ticket, at(2000));

  assert.equal(resolved.status, "expired");
  assert.equal(resolved.answer, undefined);
  assert.equal(resolved.answered_by, "default");
});

test("resolveExpiry returns the same object when nothing changes", () => {
  const beforeExpiry = baseTicket({ expires_at: at(1000) });
  assert.equal(resolveExpiry(beforeExpiry, at(999)), beforeExpiry);

  const answered = baseTicket({ status: "answered", answer: "yes", answered_at: at(10) });
  assert.equal(resolveExpiry(answered, at(999999)), answered);
});

test("getResolved persists lazy expiry and writes the expired audit entry exactly once", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(
    store,
    { question: "Ship it?", default_answer: "yes" },
    { defaultStream: "alpha", now: T0 },
  );
  const expiry = Date.parse(ticket.expires_at);

  const early = await getResolved(store, ticket.id, at(1000));
  assert.equal(early?.status, "pending");
  assert.equal(store.countAudit("expired"), 0);

  const late = await getResolved(store, ticket.id, new Date(expiry + 1).toISOString());
  assert.equal(late?.status, "expired");
  assert.equal(late?.answer, "yes");
  assert.equal(store.countAudit("expired"), 1);
  assert.equal((await store.get(ticket.id))?.status, "expired");

  await getResolved(store, ticket.id, new Date(expiry + 5000).toISOString());
  assert.equal(store.countAudit("expired"), 1, "expiry must be audited only once");
});

test("getResolved returns undefined for an unknown id", async () => {
  const store = new FakeTicketStore();
  assert.equal(await getResolved(store, "missing", T0), undefined);
});

test("listResolved persists newly-expired tickets returned from list", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(store, { question: "Ship it?" }, { defaultStream: "alpha", now: T0 });

  const tickets = await listResolved(store, { status: "pending" }, at(DEFAULT_TIMEOUT_SECONDS * 1000 + 1));
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].status, "expired");
  assert.equal(store.countAudit("expired"), 1);
  assert.equal((await store.get(ticket.id))?.status, "expired");
});

test("answer records the answer, the answered_by, and one audit entry", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(store, { question: "Ship it?" }, { defaultStream: "alpha", now: T0 });

  const answered = await answer(store, ticket.id, "yes", "human", at(5000));
  assert.equal(answered.status, "answered");
  assert.equal(answered.answer, "yes");
  assert.equal(answered.answered_by, "human");
  assert.equal(answered.answered_at, at(5000));

  const audit = store.audit.filter((entry) => entry.action === "answered");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].answer, "yes");
  assert.equal(audit[0].by, "human");
});

test("answer returns 409 for a ticket that is not pending", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(store, { question: "Ship it?" }, { defaultStream: "alpha", now: T0 });
  await answer(store, ticket.id, "yes", "human", at(1000));

  await assert.rejects(
    () => answer(store, ticket.id, "no", "human", at(2000)),
    (error: unknown) => error instanceof QueueError && error.status === 409,
  );
});

test("answer returns 409 for a ticket that lazily expired", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(store, { question: "Ship it?" }, { defaultStream: "alpha", now: T0 });

  await assert.rejects(
    () => answer(store, ticket.id, "yes", "human", at(DEFAULT_TIMEOUT_SECONDS * 1000 + 1)),
    (error: unknown) => error instanceof QueueError && error.status === 409,
  );
});

test("answer returns 404 for an unknown id", async () => {
  const store = new FakeTicketStore();
  await assert.rejects(
    () => answer(store, "missing", "yes", "human", T0),
    (error: unknown) => error instanceof QueueError && error.status === 404,
  );
});

test("undo reverts an answer inside the window and clears the answer fields", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(store, { question: "Ship it?" }, { defaultStream: "alpha", now: T0 });
  await answer(store, ticket.id, "yes", "human", at(1000));

  const reverted = await undo(store, ticket.id, at(1000 + UNDO_WINDOW_MS - 1));
  assert.equal(reverted.status, "pending");
  assert.equal(reverted.answer, undefined);
  assert.equal(reverted.answered_by, undefined);
  assert.equal(reverted.answered_at, undefined);
  assert.equal(store.countAudit("undone"), 1);
});

test("undo is allowed exactly at the window boundary", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(store, { question: "Ship it?" }, { defaultStream: "alpha", now: T0 });
  await answer(store, ticket.id, "yes", "human", T0);

  const reverted = await undo(store, ticket.id, at(UNDO_WINDOW_MS));
  assert.equal(reverted.status, "pending");
});

test("undo returns 409 just past the window", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(store, { question: "Ship it?" }, { defaultStream: "alpha", now: T0 });
  await answer(store, ticket.id, "yes", "human", T0);

  await assert.rejects(
    () => undo(store, ticket.id, at(UNDO_WINDOW_MS + 1)),
    (error: unknown) => error instanceof QueueError && error.status === 409,
  );
});

test("undo returns 409 for a ticket that is not answered", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(store, { question: "Ship it?" }, { defaultStream: "alpha", now: T0 });

  await assert.rejects(
    () => undo(store, ticket.id, at(1000)),
    (error: unknown) => error instanceof QueueError && error.status === 409,
  );
});

test("cancel marks a ticket cancelled and is idempotent", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(store, { question: "Ship it?" }, { defaultStream: "alpha", now: T0 });

  const cancelled = await cancel(store, ticket.id, at(1000));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(store.countAudit("cancelled"), 1);

  await cancel(store, ticket.id, at(2000));
  assert.equal(store.countAudit("cancelled"), 1, "re-cancelling must not append a second audit entry");
});

test("cancel returns 404 for an unknown id", async () => {
  const store = new FakeTicketStore();
  await assert.rejects(
    () => cancel(store, "missing", T0),
    (error: unknown) => error instanceof QueueError && error.status === 404,
  );
});

test("listForPage returns pending tickets plus answered tickets inside the recent window", async () => {
  const store = new FakeTicketStore();
  const pending = await enqueue(store, { question: "Still pending?" }, { defaultStream: "alpha", now: T0 });
  const answered = await enqueue(store, { question: "Answered?" }, { defaultStream: "beta", now: T0 });
  await answer(store, answered.id, "yes", "human", at(1000));

  const inside = await listForPage(store, at(1000 + RECENT_WINDOW_MS - 1));
  assert.deepEqual(
    inside.map((ticket) => ticket.id).sort(),
    [pending.id, answered.id].sort(),
  );

  const outside = await listForPage(store, at(1000 + RECENT_WINDOW_MS + 1));
  assert.deepEqual(
    outside.map((ticket) => ticket.id),
    [pending.id],
    "an answered ticket older than the recent window must drop off the page",
  );
});

/* ------------------------------------------------------------------ *
 * Media and annotations
 * ------------------------------------------------------------------ */

const PNG = bytesToBase64(new Uint8Array([137, 80, 78, 71]));

test("enqueue stores media bytes, records a ref, and counts it in the audit entry", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(
    store,
    {
      question: "Look?",
      media: [
        { mime_type: "image/png", data_base64: PNG, filename: "shot.png", caption: "before" },
        { mime_type: "audio/mpeg", data_base64: PNG },
      ],
    },
    { defaultStream: "alpha", now: T0 },
  );

  assert.equal(ticket.media?.length, 2);
  const image = ticket.media?.[0];
  assert.equal(image?.kind, "image");
  assert.equal(image?.mime_type, "image/png");
  assert.equal(image?.size_bytes, 4);
  assert.equal(image?.filename, "shot.png");
  assert.equal(image?.caption, "before");
  assert.equal(ticket.media?.[1].kind, "audio");

  // The bytes are in the media store, keyed by the ref id.
  assert.ok(image?.id);
  const blob = await store.getMedia(image!.id);
  assert.equal(blob?.mime_type, "image/png");
  assert.equal(blob?.data_base64, PNG);

  assert.equal(store.audit[0].media_count, 2);
});

test("enqueue without media leaves media undefined and no media_count", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(store, { question: "Plain?" }, { defaultStream: "alpha", now: T0 });
  assert.equal(ticket.media, undefined);
  assert.equal(store.audit[0].media_count, undefined);
});

test("uploadMedia stores a blob and returns a ref (the POST /api/media path)", async () => {
  const store = new FakeTicketStore();
  const ref = await uploadMedia(store, { mime_type: "image/png", data_base64: PNG }, T0);
  assert.equal(ref.kind, "image");
  assert.equal(ref.size_bytes, base64ByteLength(PNG));
  assert.deepEqual(await store.getMedia(ref.id), { id: ref.id, mime_type: "image/png", data_base64: PNG });
});

test("answer records annotations alongside the answer", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(
    store,
    { question: "Look?", media: [{ mime_type: "image/png", data_base64: PNG }] },
    { defaultStream: "alpha", now: T0 },
  );
  const sourceId = ticket.media![0].id;
  const rendered = await uploadMedia(store, { mime_type: "image/png", data_base64: PNG }, at(500));

  const answered = await answer(store, ticket.id, "ship it", "human", at(1000), [
    { text: "watch the header", media_id: sourceId, at_seconds: 3.5 },
    { annotated_media_id: rendered.id, media_id: sourceId },
  ]);

  assert.equal(answered.answer, "ship it");
  assert.equal(answered.status, "answered");
  assert.equal(answered.annotations?.length, 2);
  assert.equal(answered.annotations?.[0].text, "watch the header");
  assert.equal(answered.annotations?.[0].media_id, sourceId);
  assert.equal(answered.annotations?.[0].at_seconds, 3.5);
  assert.equal(answered.annotations?.[1].annotated_media?.id, rendered.id);
  assert.equal(answered.annotations?.[1].annotated_media?.kind, "image");

  const auditEntry = store.audit.find((entry) => entry.action === "answered");
  assert.equal(auditEntry?.annotation_count, 2);
});

test("answer accepts annotations with no text answer", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(store, { question: "Look?" }, { defaultStream: "alpha", now: T0 });
  const answered = await answer(store, ticket.id, "", "human", at(1000), [{ text: "here" }]);
  assert.equal(answered.answer, undefined, "an annotation-only answer has no answer text");
  assert.equal(answered.annotations?.[0].text, "here");
});

test("answer with neither text nor annotations is a 400", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(store, { question: "Look?" }, { defaultStream: "alpha", now: T0 });
  await assert.rejects(
    () => answer(store, ticket.id, "   ", "human", at(1000), []),
    (error: unknown) => error instanceof QueueError && error.status === 400,
  );
  assert.equal((await store.get(ticket.id))?.status, "pending", "the failed answer must not change the ticket");
});

test("answer rejects an annotation whose rendered copy is missing or not an image", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(store, { question: "Look?" }, { defaultStream: "alpha", now: T0 });

  await assert.rejects(
    () => answer(store, ticket.id, "yes", "human", at(1000), [{ annotated_media_id: "does-not-exist" }]),
    (error: unknown) => error instanceof QueueError && error.status === 400,
  );

  const audio = await uploadMedia(store, { mime_type: "audio/mpeg", data_base64: PNG }, T0);
  await assert.rejects(
    () => answer(store, ticket.id, "yes", "human", at(1000), [{ annotated_media_id: audio.id }]),
    (error: unknown) => error instanceof QueueError && error.status === 400,
  );
});

test("undo clears annotations along with the answer", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(store, { question: "Look?" }, { defaultStream: "alpha", now: T0 });
  await answer(store, ticket.id, "yes", "human", at(1000), [{ text: "note" }]);

  const reverted = await undo(store, ticket.id, at(2000));
  assert.equal(reverted.status, "pending");
  assert.equal(reverted.answer, undefined);
  assert.equal(reverted.annotations, undefined);
});

test("expiry applies the default answer and never carries annotations", async () => {
  const store = new FakeTicketStore();
  const ticket = await enqueue(
    store,
    { question: "Auto?", default_answer: "proceed", timeout_seconds: 60 },
    { defaultStream: "alpha", now: T0 },
  );
  const resolved = await getResolved(store, ticket.id, at(60_001));
  assert.equal(resolved?.status, "expired");
  assert.equal(resolved?.answer, "proceed");
  assert.equal(resolved?.annotations, undefined);
});
