import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileTicketStore } from "../../src/storage/file";
import type { AuditEntry, Ticket } from "../../src/core/types";

const T0 = "2026-01-01T00:00:00.000Z";
const at = (offsetMs: number): string => new Date(Date.parse(T0) + offsetMs).toISOString();

const tempDirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "readyroom-file-"));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function baseTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    stream: "alpha",
    question: "Ship it?",
    urgency: "normal",
    status: "pending",
    created_at: T0,
    expires_at: at(1_800_000),
    ...overrides,
  };
}

function auditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ticket_id: "11111111-1111-4111-8111-111111111111",
    action: "created",
    at: T0,
    ...overrides,
  };
}

test("load() on a missing file starts empty", async () => {
  const dir = await makeDir();
  const store = new FileTicketStore(dir);

  await store.load();

  assert.deepEqual(await store.list({}), []);
  assert.equal(await store.get("nope"), undefined);
});

test("put() then a fresh load() sees the ticket (durability)", async () => {
  const dir = await makeDir();
  const ticket = baseTicket();

  const first = new FileTicketStore(dir);
  await first.load();
  await first.put(ticket);

  // A brand-new instance over the same directory must recover the ticket from disk.
  const second = new FileTicketStore(dir);
  await second.load();

  assert.deepEqual(await second.get(ticket.id), ticket);
  assert.deepEqual(await second.list({}), [ticket]);
});

test("audit.jsonl is append-only and survives a re-load", async () => {
  const dir = await makeDir();
  const auditPath = join(dir, "audit.jsonl");

  const first = new FileTicketStore(dir);
  await first.load();
  await first.appendAudit(auditEntry({ action: "created" }));
  await first.appendAudit(auditEntry({ action: "answered", answer: "yes" }));

  const afterTwo = (await readFile(auditPath, "utf8")).trimEnd().split("\n");
  assert.equal(afterTwo.length, 2);
  assert.equal(JSON.parse(afterTwo[0]).action, "created");
  assert.equal(JSON.parse(afterTwo[1]).action, "answered");

  // A re-load must not truncate the log; a further append extends it.
  const second = new FileTicketStore(dir);
  await second.load();
  await second.appendAudit(auditEntry({ action: "undone" }));

  const afterThree = (await readFile(auditPath, "utf8")).trimEnd().split("\n");
  assert.equal(afterThree.length, 3);
  assert.equal(JSON.parse(afterThree[2]).action, "undone");
});

test("list() filters by status and by since", async () => {
  const dir = await makeDir();
  const store = new FileTicketStore(dir);
  await store.load();

  const pendingOld = baseTicket({ id: "p-old", status: "pending", created_at: at(0) });
  const pendingNew = baseTicket({ id: "p-new", status: "pending", created_at: at(60_000) });
  const answered = baseTicket({ id: "a-new", status: "answered", created_at: at(60_000) });

  await store.put(pendingOld);
  await store.put(pendingNew);
  await store.put(answered);

  const pending = await store.list({ status: "pending" });
  assert.deepEqual(
    pending.map((t) => t.id).sort(),
    ["p-new", "p-old"],
  );

  const since = await store.list({ since: at(30_000) });
  assert.deepEqual(
    since.map((t) => t.id).sort(),
    ["a-new", "p-new"],
  );

  const both = await store.list({ status: "pending", since: at(30_000) });
  assert.deepEqual(
    both.map((t) => t.id),
    ["p-new"],
  );
});

test("no tickets.json.tmp is left behind after a successful put()", async () => {
  const dir = await makeDir();
  const store = new FileTicketStore(dir);
  await store.load();
  await store.put(baseTicket());

  await assert.rejects(() => stat(join(dir, "tickets.json.tmp")), { code: "ENOENT" });
  // The real file is present and parseable.
  const raw = await readFile(join(dir, "tickets.json"), "utf8");
  assert.equal(JSON.parse(raw).length, 1);
});
