# Task: build `readyroom`

An MCP server that lets coding agents request a human decision without hijacking whichever window is focused. Agents enqueue a **ticket**; the human **drains** the queue from one page when they choose to.

Design invariant: **N agents, one interrupt channel.** Every decision below serves it.

Three audiences, and each gets a different entry point:

- **`npx readyroom`** — one developer, one machine, working in thirty seconds. No config, no container, no account.
- **Self-hosted Docker on a Raspberry Pi** — the homelab owner. Always-on, arm64, LAN-reachable, survives reboots.
- **Cloudflare Worker** — a team with no infrastructure to run. Always-on, reachable from anywhere, no box to patch.

Work in a git worktree of its own. Repo `readyroom`; image `ghcr.io/therebelrobot/readyroom`; npm package `readyroom`.

## Vocabulary

Use these exact words in code, comments, tool descriptions, and docs. Do not invent synonyms.

- **ticket** — one pending request: `{ id, stream, question, options, context, urgency, status, created_at, expires_at }`
- **stream** — which agent asked. Defaults to `$READYROOM_STREAM`, else `basename(cwd)`.
- **drain** — the human answering tickets from the page.
- **readyroom page** — the single HTML page served at `GET /`.

The tool names (`ask_human`, `wait_for_answer`, `list_pending`, `cancel_ticket`) are the agent-facing contract and do not change with the product name. The product name is a separate layer, the way `ripgrep` ships `rg`.

## The one rule that matters

`ask_human` enqueues and returns. It never waits.

Reason: a blocking tool holds the MCP session open and wedges the client when the human is heads-down for twenty minutes. Enqueue-then-poll keeps the transport healthy.

It must return `{ id, status: "pending" }` in under 200 ms.

This rule is also what makes the Worker target possible at all. A Workers invocation cannot hold a session open for twenty minutes; a request that enqueues and returns is stateless enough to run per-request on the edge. Do not let the three targets tempt you into a blocking variant for any of them.

The MCP tool description for `ask_human` must instruct the agent: *on `pending`, continue with independent work and call `wait_for_answer` again later; do not poll in a tight loop.* The tool description is where the agent learns the protocol.

## MCP tools

All four tools are identical across all three targets. Only the transport differs.

```ts
ask_human({
  question: string,           // required. One sentence. What must be decided.
  options?: string[],         // optional. 2-5 mutually exclusive choices.
  context?: string,           // optional. Minimal text needed to decide. Plain text.
  default_answer?: string,    // optional. Used only if the ticket expires. Set it only
                              // when it is safe for the agent to proceed without a human.
  timeout_seconds?: number,   // optional. Default 1800. Max 86400.
  urgency?: "low" | "normal" | "blocking",  // optional. Default "normal".
  stream?: string,            // optional. Overrides the env/basename default.
  media?: MediaInput[]        // optional. Screenshots, audio, video. Never required. See below.
}) => { id: string, status: "pending", expires_at: string, media?: MediaRef[] }

wait_for_answer({
  id: string,
  timeout_seconds?: number    // default 60, max 600
}) => {
  id: string,
  status: "pending" | "answered" | "expired" | "cancelled",
  answer?: string,
  answered_by?: string,       // "human" | "default"
  answered_at?: string,
  media?: MediaRef[],         // the agent's attachments, echoed back
  annotations?: Annotation[]  // the human's notes and any rendered markup copy
}

list_pending({}) => { tickets: Ticket[] }

cancel_ticket({ id: string }) => { id: string, status: "cancelled" }
```

Tool result text must be unambiguous when it reaches the agent. Prefix a delivered answer with `HUMAN ANSWER:` so a model can never confuse it with its own earlier guess.

### Media and annotations

An agent may attach media to a ticket for the human to inspect. Media is **optional at every layer**: a ticket without media behaves exactly as before, and an answer is still valid with no annotations.

- **Input.** `ask_human` takes `media?: MediaInput[]`, where `MediaInput` is `{ mime_type, data_base64, filename?, caption? }`. The MIME type must be an `image/*`, `audio/*`, or `video/*` family; the kind is derived from it, never sent separately. `data_base64` is standard base64 (an optional `data:<mime>;base64,` prefix is accepted). Limits: 8 items, 8 MiB per item, 24 MiB per ticket.
- **Storage.** The bytes are stored out of band, keyed by a server-minted id; the ticket carries only a `MediaRef` (`{ id, kind, mime_type, filename?, caption?, size_bytes, created_at }`). This keeps `tickets.json` and `GET /api/tickets` small and lets the page fetch a blob lazily. `FileTicketStore` writes `${READYROOM_STATE_DIR}/media/<id>` plus a MIME sidecar; `DurableObjectTicketStore` chunks each blob across rows because a Cloudflare SQLite row is capped at 2 MB.
- **Annotation.** The human may mark up an image (rectangle/freehand) and add notes; a note on audio/video captures the playhead position. On answer, a marked-up image is rendered to a PNG, uploaded with `POST /api/media`, and referenced from the annotation by `annotated_media_id`. An `Annotation` is `{ id, text?, media_id?, at_seconds?, annotated_media? }`.
- **Return.** `wait_for_answer` returns the annotations as structured fields and any rendered markup as MCP `image` content, so an agent that only speaks MCP sees what the human marked without fetching a URL.
- **Answer shape.** `POST /api/answer` accepts `{ id, answer?, answered_by?, annotations?: AnnotationInput[] }`. An answer must carry text, an option, or at least one annotation; none is a `400`.

Transport per target:

- **npx / Docker** — stdio, wired through the existing mcp-proxy. Streamable HTTP is also served on the same process for clients that want it.
- **Worker** — Streamable HTTP only. No stdio exists on Workers.

The TypeScript SDK's HTTP serving docs describe a web-standard shape on Workers/Deno/Bun where `export default handler` is the entire mount. Verify the exact export and transport class names against the installed SDK version — the SDK has both a v1 and a v2 documentation line and the serving surface differs between them.

**Stream resolution on the Worker.** There is no `cwd` on Workers, so `basename(cwd)` cannot be the fallback. On the Worker target the stream is required and is taken from the request path: `POST /mcp/{stream}`. Each agent gets its own URL, configured once in the client. If neither the path segment nor an explicit `stream` argument is present, fail the tool call with a clear error naming both ways to supply it. Do not invent a default.

## HTTP

```
GET  /healthz          -> 200, body "ok"
GET  /                 -> the readyroom page (index.html)
GET  /api/tickets      -> { tickets: Ticket[] }   pending + last 5 min of answered
GET  /api/events       -> text/event-stream of ticket changes
POST /api/answer       -> { id, answer?, answered_by?, annotations? } -> 200 | 400 | 404 | 409
POST /api/undo         -> { id } -> 200 | 409 outside the undo window
POST /api/media        -> { mime_type, data_base64 } -> 201 { media: MediaRef }
GET  /api/media/{id}   -> the blob bytes, with Content-Type from the stored MIME
```

Per-target notes on the same route table:

- `GET /api/events` — real SSE on npx and Docker. On the **Worker target, return `501` with a short plain-text body.** The readyroom page already mandates a polling fallback, so the fallback is what carries the Worker target. Do not add WebSockets and do not build a Durable-Object-held stream fleet for v1; a Workers response can stay open as a stream, but the fan-out complexity is not worth it when the page already handles the fallback.
- `GET /healthz` — return `"ok"` verbatim on all targets. The npx singleton probe (below) needs more than that, so it reads `daemon.json` from the state dir rather than parsing this response.

## Security

Three rules, all required.

**1. Bind and refusal, restated per target.**

- **npx** — bind `127.0.0.1` by default. `READYROOM_BIND` may override, but when it is anything other than a loopback address the server **must refuse to start** unless `READYROOM_TOKEN` is set.
- **Docker** — the container binds `0.0.0.0` internally and the port is mapped to `127.0.0.1` on the host. The process therefore *always* sees a non-loopback bind, so the token is mandatory and the refusal rule always applies. Document that the loopback guarantee comes from the port mapping, not from the process.
- **Worker** — there is no loopback and no safe fallback configuration. The token is mandatory, the refusal rule has no analogue, and the service is public by construction. Do not pretend otherwise in the README.

Reason for the rule: an approval endpoint is a privilege-escalation surface — whoever can answer a ticket can grant an agent permission to act.

**2. Every `/api/*` route requires `Authorization: Bearer $READYROOM_TOKEN`,** compared in constant time.

Implement the comparison as a shared `constantTimeEqual(a: string, b: string): boolean` that compares digests byte by byte with no early return. Reason: `node:crypto.timingSafeEqual` is a Node builtin and is not reliably present on Workers. One shared implementation is the only way all three targets get the same guarantee. Verify whether the installed Workers compatibility flags expose it; do not depend on that.

**3. Never expose this to a public network directly.** Document in the README that LAN access goes through the existing reverse proxy with its own auth in front, and that Worker deployments should sit behind Cloudflare Access.

Additionally: reject requests with a missing or mismatched `Origin` on the Streamable HTTP MCP endpoint with `403`. The MCP specification requires this of HTTP transports, and it is the reason the SDK ships host and origin validation guards.

The page collects the token once, stores it in `localStorage`, and attaches it to every request.

## Storage

One interface, two implementations. The ticket lifecycle — enqueue, expire, answer, undo — is written once against the interface and must not branch on target.

```ts
interface TicketStore {
  load(): Promise<void>;
  list(filter: { status?: Status; since?: string }): Promise<Ticket[]>;
  get(id: string): Promise<Ticket | undefined>;
  put(ticket: Ticket): Promise<void>;
  appendAudit(entry: AuditEntry): Promise<void>;   // append-only, never updated
}
```

**`FileTicketStore`** — `${READYROOM_STATE_DIR}/tickets.json`, default `./.state`.

Write atomically: write `tickets.json.tmp`, `fsync`, `rename`. Single process, single writer. Load on boot.

Reason: the queue must survive a container restart. A restart that forgets pending tickets means an agent waits forever.

Also append every state change to `${READYROOM_STATE_DIR}/audit.jsonl` — one JSON object per line, append-only, never rotated. Reason: an approval log is the only record that a human authorised something.

**`DurableObjectTicketStore`** — one Durable Object instance, SQLite-backed via `ctx.storage.sql`, tables `tickets` and `audit`.

Reason for Durable Objects over D1: a single DO instance is a single writer with a transaction boundary, which is exactly the `FileTicketStore` invariant expressed on the edge. Address it deterministically (`idFromName("queue")`) so every request lands on the same instance. SQLite-backed Durable Objects are generally available and recommended for all new classes; the migration entry must use `new_sqlite_classes` or the SQL API is unavailable.

Invariants that hold on both implementations:

- The audit table is append-only and never pruned. State this in the README, including that this is a deliberate difference from a retention policy.
- **Expiry is evaluated lazily on read.** A ticket is expired if `expires_at` has passed and it is still pending; the read path resolves it to `expired` and applies `default_answer` if one was set. Reason: Workers have no long-lived process, so a timer-based expiry would silently not happen there, and divergence between targets on when a ticket expires is worse than a few wasted reads. A Cron Trigger on Workers is an optional optimization, never the contract.
- The undo window is five minutes, measured against the audit entry's timestamp.

## The npx singleton

The original single-process design breaks under npx. Three MCP clients spawning `npx readyroom` produce three processes, three attempts to bind port 8971, and three writers to one `tickets.json` — which contradicts the single-writer invariant and can corrupt the queue.

First process to start becomes the **daemon**: it binds the port, owns the store, and writes `${READYROOM_STATE_DIR}/daemon.json` containing `{ pid, port, started_at }`.

Every subsequent process becomes a **client**: it reads `daemon.json`, confirms the pid is alive and `/healthz` answers, and then proxies its MCP tool calls to the daemon over `http://127.0.0.1:<port>`. It serves stdio on its own file descriptors and nothing else. It must not write `tickets.json`.

If `daemon.json` is stale (pid dead, or the port refuses), the starting process acquires the daemon role itself and overwrites the file. If the daemon is unreachable but a foreign service holds the port, refuse to start with a message naming the port — do not silently fall back to a second writer.

Reason: this is what makes `npx readyroom` work for a developer who has three agents running, which is the majority of the audience for that target.

## The readyroom page

`public/index.html`. One file, shared by all three targets. All CSS and JS inline. No CDN, no external origin, no build step. It must render correctly when opened from the server with the network otherwise cut.

Inline it at build time into each target's bundle (`--loader:.html=text` for the Node bundle; the equivalent rule for the Worker build) with a `*.html` module declaration in TypeScript. Reason: a single page source across three deploys is the only way the three targets stay visually identical, and inlining keeps the "no runtime file resolution" property the repo conventions already require.

Required:

1. **Live.** Subscribe to `/api/events` with `EventSource`. If the connection fails, fall back to polling `/api/tickets` every 5 s. This fallback is the Worker target's live-update path, so it is load-bearing, not a nicety.
2. **Grouped by stream.** Tickets grouped under a stream heading, newest stream first. This is the whole point: you need to know which agent is asking.
3. **Card contents.** Stream name, ticket age (`4m`), urgency badge, the question, the context, option buttons, a free-text field, and an Answer button.
4. **Keyboard-first.** `j`/`k` move between tickets, `1`-`5` pick an option, `Enter` submits, `u` undoes the last answer. Reason: draining a queue with a mouse is the slow path, and the queue exists to be drained quickly.
5. **Tab title carries the count.** `(3) readyroom`.
6. **No colour-only signalling.** Urgency and status are carried by text and borders as well as hue. Reason: this page has to be legible on an e-ink display and in grayscale print.
7. **No animation on the critical path.** Respect `prefers-reduced-motion`. No hover-only affordances — every action reachable by keyboard and by tap.
8. **Undo.** Answered tickets stay in a "recent" section for 5 minutes with an Undo button that calls `/api/undo`.
9. **First paint is synchronous.** Render at the end of the script, not inside `requestAnimationFrame`. Re-render on `window` `load`. Reason: this page may be embedded in a hidden or zero-sized frame, where rAF never fires.

Render `context` as text with line breaks preserved. Do not add a markdown parser.

## Repo conventions (required)

- TypeScript, Node >= 22. `module` and `moduleResolution` = `ESNext` / `bundler`.
- **Never** put `.js` extensions in import paths. Import `./queue`, not `./queue.js`.
- `tsx` for dev, `esbuild` for build. Bundle to a single file, so there is no runtime import resolution.
- npm.
- Zero runtime dependencies except `@modelcontextprotocol/sdk`. `wrangler` and `@cloudflare/workers-types` are devDependencies; Durable Objects are a platform primitive and need no package.
- Unlicense.
- Image name `ghcr.io/therebelrobot/readyroom`. npm package `readyroom`.
- **All logging goes to stderr.** Nothing may be written to stdout except the MCP protocol. This is the single most common way a stdio MCP server breaks, and a stray `console.log` in a shared module breaks the npx target only — the hardest one to notice.

Three entry points, one shared core:

- `src/index.ts` — Node entry: daemon-or-client, stdio MCP, HTTP, `FileTicketStore`
- `src/worker.ts` — Worker entry: `export default { fetch }`, the Durable Object class, `DurableObjectTicketStore`
- `src/core/*` — ticket lifecycle, validation, the four tool definitions, the page. No target-specific imports anywhere under `src/core/`.

`package.json` — these exact names. The first seven are unchanged from the original spec; the rest are new:

```json
{
  "dev": "tsx watch src/index.ts",
  "start": "node dist/server.mjs",
  "build": "esbuild src/index.ts --bundle --platform=node --format=esm --target=node22 --banner:js='#!/usr/bin/env node' --loader:.html=text --outfile=dist/server.mjs",
  "build:worker": "wrangler deploy --dry-run --outdir dist/worker",
  "dev:worker": "wrangler dev",
  "deploy:worker": "wrangler deploy",
  "typecheck": "tsc --noEmit -p tsconfig.json",
  "docker:build": "docker build -t ghcr.io/therebelrobot/readyroom:local .",
  "docker:run": "docker run --rm -d -p 127.0.0.1:8971:8971 -v $(pwd)/.state:/app/.state --env-file .env ghcr.io/therebelrobot/readyroom:local",
  "docker:push": "docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/therebelrobot/readyroom:latest --push .",
  "release:patch": "npm version patch -m \"chore: release v%s\" && git push && git push --tags",
  "release:minor": "npm version minor -m \"chore: release v%s\" && git push && git push --tags",
  "release:major": "npm version major -m \"chore: release v%s\" && git push && git push --tags",
  "release:tags": "git tag --sort=-v:refname | grep '^v'"
}
```

Also required for the npm target: `bin: { "readyroom": "dist/server.mjs" }`, `engines: { "node": ">=22" }`, `publishConfig: { "access": "public" }`, `files: ["dist", "README.md", "LICENSE"]`, and `prepublishOnly: "npm run build"`.

Port **8971**. It must not collide with 3000-3899, which a worktree helper already allocates to per-branch dev servers.

### Environment variables

`READYROOM_STREAM`, `READYROOM_TOKEN`, `READYROOM_BIND`, `READYROOM_STATE_DIR`, `READYROOM_PORT`.

This is a deliberate rename from the original `ASK_HUMAN_*` prefix. Reason: the product now ships to npm and a Worker, where a `READYROOM_*` prefix and a `READYROOM_TOKEN` secret are what a user will look for. The tool name stays `ask_human`; only the product's own configuration moved.

On the Worker these are `vars` and `secrets` in the Wrangler config rather than process environment. Map them explicitly in the README.

## CI/CD

GitHub Actions, all required:

- `.github/workflows/release.yml` — on push to the default branch: run `semantic-release` over the conventional-commit messages since the last tag (fix → patch, feat → minor, `BREAKING CHANGE:` → major once at 1.0). While the version is still `0.x`, a breaking change is downgraded to a minor bump by `release.config.js`, so the jump to 1.0 is deliberate (`npm run release:major`), never a surprise. The run writes `CHANGELOG.md` and the `package.json` version, commits `chore(release): vX.Y.Z [skip ci]`, tags `vX.Y.Z`, and opens the GitHub Release. It then dispatches the publishers below on the new tag, because a tag pushed with `GITHUB_TOKEN` cannot trigger them and `workflow_dispatch` is the event that rule exempts. Keep `id-token: write` off this job — publishing stays in `npm-publish.yml` so no dependency code runs beside the OIDC token.
- `.github/workflows/ci.yml` — on push and PR: `npm ci`, typecheck, build, `wrangler deploy --dry-run`, `docker build`.
- `.github/workflows/publish.yml` — on the default branch and `v*` tags: buildx for `linux/amd64,linux/arm64` (arm64 is required; the deploy target is a Pi), push to GHCR, auth via the built-in `GITHUB_TOKEN` with `packages: write` (no PAT, no repo secrets), `docker/metadata-action` tags (`latest` on the default branch and on `v*`, semver on `v*`, `sha-<short>`), GHA build cache scoped per image, one matrix entry per image.
- `.github/workflows/npm-publish.yml` — on `v*` tags: `npm publish` with provenance. Use npm Trusted Publishing (OIDC) rather than a stored token; it needs `id-token: write` and the trusted-publisher entry configured on the package. Note in the README that the very first publish must be interactive because trusted publishing is configured against an existing package. Keep the two-job split: an unprivileged build that packs a tarball, then a privileged job that only publishes it.
- `.github/workflows/deploy-worker.yml` — on `v*` tags: `wrangler deploy` with `CLOUDFLARE_API_TOKEN`. Mark this one as optional and off by default; a Worker deploy needs the operator's own account, so it should be a documented manual step unless the deploy token is supplied.
- Supply chain: `provenance: mode=max`, `sbom: true`, and `actions/attest-build-provenance` pushed to the registry.
- `.github/dependabot.yml` for `github-actions`, `npm`, and `docker`.

## Docker

Multi-stage, non-root user, handles `SIGTERM`. Multi-arch, arm64 required.

The container runs the same Node entry as npx, in stdio-plus-HTTP mode.

README must note: GHCR packages start private and must be flipped public after the first run.

## Cloudflare

`wrangler.toml` (or `.jsonc`) with:

- a Durable Object binding and a migration using `new_sqlite_classes`
- a pinned `compatibility_date`
- `READYROOM_TOKEN` supplied via `wrangler secret put`, never committed
- the MCP endpoint and the page served from the same Worker

The Worker has no state dir, no bind address, and no daemon role. Document the three consequences in the README: the token is mandatory, `/api/events` returns 501 and the page polls, and `wait_for_answer` clamps its timeout to a window short enough to return well inside a Workers invocation.

**That clamp is the one place the three targets differ in observable behavior.** Have `wait_for_answer` return `status: "pending"` promptly on the Worker rather than erroring, so the agent's documented protocol — call again later — is already the correct handling and no agent needs to know which target it is talking to.

## compose service

Add this to the README as a mergeable snippet. It binds to loopback; LAN exposure goes through the reverse proxy.

```yaml
services:
  readyroom:
    image: ghcr.io/therebelrobot/readyroom:latest
    container_name: readyroom
    restart: unless-stopped
    stdin_open: true
    ports:
      - "127.0.0.1:8971:8971"
    environment:
      READYROOM_TOKEN: ${READYROOM_TOKEN:?set READYROOM_TOKEN}
      READYROOM_STATE_DIR: /app/.state
      READYROOM_BIND: 0.0.0.0
    volumes:
      - ./readyroom-state:/app/.state
```

## Out of scope

No multi-user accounts, no roles, no permissions, no rich markdown rendering, no database, no mobile app, no push notifications, no WebSockets, no cloud sync, no LLM in the decision path. The human decides.

Also not in scope: any compliance posture. `readyroom` is a convenience gate, not an authorization-of-record system for regulated data. It is not covered by a BAA on any target, its audit log has no retention policy, and nothing in it should be treated as evidence a human authorized a regulated action. Say so in one line in the README so users who need that look elsewhere.

## Acceptance

Do not report a step as passing without pasting its actual output.

**npx / local:**

1. `npm ci && npm run typecheck && npm run build && npm run build:worker` — all four exit 0.
2. Start the server. `curl -sS -o /dev/null -w '%{http_code}\n' localhost:8971/healthz` prints `200`.
3. Write a throwaway stdio client script. Call `ask_human` through it and time the call. Show it returning `status: "pending"` in under 200 ms.
4. `curl -sS -H "Authorization: Bearer $READYROOM_TOKEN" localhost:8971/api/tickets` shows the ticket with the correct stream.
5. `curl -sS -X POST -H "Authorization: Bearer $READYROOM_TOKEN" -H 'content-type: application/json' -d '{"id":"<id>","answer":"yes"}' localhost:8971/api/answer` returns 200. Then `wait_for_answer` returns `status: "answered"` with `answer: "yes"`.
6. Kill the process, restart it, and `GET /api/tickets` still shows the ticket. Durability is the claim being tested.
7. Open two tickets from two different streams. Confirm the page renders two grouped cards.
8. Screenshot the page with a headless browser at 1200x900 and at 600x800. Paste both. Confirm the layout survives the narrow viewport and that nothing depends on colour or hover.
9. Start a second `readyroom` process against the same state dir. Show it becoming a client rather than a second daemon: `daemon.json` still names the first pid, and `ask_human` through the second process lands in the same queue.

**Docker:**

10. `npm run docker:build` succeeds, and `docker image inspect` shows the container runs as a non-root user.
11. `npm run docker:run`, then `curl localhost:8971/healthz` prints `200`.
12. `docker restart` the container and confirm `GET /api/tickets` still shows an open ticket — the volume is the durability path. Report the amd64 result; note that arm64 is verified by the publish workflow's buildx run.

**Worker:**

13. `npm run build:worker` succeeds.
14. `npm run dev:worker`, then confirm `GET /healthz` returns `ok`, `GET /api/events` returns `501`, and a `wait_for_answer` on a fresh ticket returns `pending` promptly rather than hanging.
15. Against the running worker: `ask_human` on `/mcp/<stream>`, answer it over `/api/answer`, and confirm `wait_for_answer` returns `answered`. Then restart the worker and confirm the ticket is still there — that is the Durable Object being exercised, not an in-memory store.

Steps 10-15 cannot run without Docker and a Cloudflare account. Where an environment cannot run a check, say so explicitly and name the workflow that covers it instead. Do not report a check as passing on the strength of the code looking right.

## Definition of done

All acceptance checks pass with output pasted in. `README.md` documents install for all three targets, the five env vars, the compose snippet, the reverse-proxy topology, the loopback bind rule per target, and the fact that GHCR packages start private. Every acceptance check that could plausibly drift has a test under `test/`.
