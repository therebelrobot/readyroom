# Readyroom page screenshots — manifest

Every visually distinct state of the readyroom page ([`public/index.html`](../../public/index.html)),
captured by [`scripts/capture-screenshots.sh`](../../scripts/capture-screenshots.sh).

Regenerate from the repo root:

```sh
npm run screenshots
```

The script starts its own isolated readyroom instance on `:8972` with a fresh temporary
state dir, drives each state with `playwright-cli`, writes the PNGs here, and tears the
instance down. To capture against an already-running server instead:

```sh
READYROOM_EXTERNAL=1 BASE_URL=http://127.0.0.1:8971 READYROOM_TOKEN=... npm run screenshots
```

There is a single flow (the human draining the queue) and a single authenticated role,
so files are flat under this directory. Viewports: `1280x800` for desktop, `390x844` for
the two `mobile-*` shots.

| File | State shown |
|---|---|
| `token-gate.png` | Unauthenticated first paint: token bar visible, status "waiting for token", both sections empty. |
| `mobile-token-gate.png` | The token gate at phone width. |
| `empty.png` | Authenticated with an empty queue: status "live (server-sent events)", no pending tickets, nothing recently answered. |
| `pending-single.png` | One pending ticket with free-text context (line breaks preserved), a normal-urgency badge, and the free-text answer form. |
| `pending-options.png` | A ticket with mutually-exclusive option buttons (`1. Save` / `2. Apply` / `3. Confirm`) and a blocking-urgency badge, above a second free-text ticket. |
| `pending-multi-stream.png` | Tickets from three streams (`docs-pipeline`, `web-client`, `api-server`), grouped under stream headings, newest stream first; shows the dotted (low), double (blocking) and solid (normal) urgency badges. |
| `pending-media.png` | A ticket with an attached screenshot, expanded for inspection: the attachment's name/MIME/size, its caption, the image on a drawing canvas with `Box`/`Draw`/`Clear markup` tools, and the optional annotations editor. Element-scoped to the card. |
| `mobile-pending.png` | The populated multi-stream queue at phone width. |
| `option-selected.png` | An option picked: the card gains a thick left border and a `SELECTED` text marker, and the chosen option button is pressed. |
| `media-annotated.png` | The same attachment marked up with a drawn box, plus a queued note ("nudge the title left by 8px") in the annotations editor. Element-scoped to the card. |
| `card-error.png` | Submitting an empty answer shows the inline, per-card validation error "Type an answer, pick an option, or add an annotation first." |
| `recent-answered.png` | An answered ticket in the "Recent (undoable for 5 minutes)" section: dashed border, `STATUS: ANSWERED` badge, `by human`, the recorded answer, and the Undo button. |
| `token-rejected.png` | A wrong token was saved: the 401 error banner "Token rejected (401). Enter it again." with the token bar shown again. |
| `status-polling.png` | The `/api/events` SSE endpoint is unavailable, so the page fell back to "polling every 5s" (the Worker target's live-update path). |
| `load-error.png` | `GET /api/tickets` failed: the global error banner "Could not load tickets: tickets 500". |

## States that cannot be captured

Two ticket statuses never render on the page, so there is no screenshot for them:

- **`expired`** — `GET /api/tickets` returns pending tickets plus answered tickets from
  the last 5 minutes only. An expired ticket resolves out of the pending set and is not
  answered, so it simply disappears from the page.
- **`cancelled`** — same reason: a cancelled ticket is neither pending nor recently
  answered, so it disappears.

The page has no conditional render branch for either status; this is inherent to the
`listForPage` contract, not a missing screen.
