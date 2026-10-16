#!/usr/bin/env bash
# capture-screenshots.sh — capture every readyroom page state with playwright-cli.
#
# The readyroom page (public/index.html) is a single-screen "decision ticket" console.
# This script enumerates every visually distinct state it can render, drives to each
# one, and writes a PNG per state into docs/screenshots/.
#
# State inventory (see docs/screenshots/MANIFEST.md for the one-line description of each):
#
#   token-gate            no token yet; token bar visible, status "waiting for token"
#   token-rejected        a wrong token was saved; 401 error banner + token bar
#   empty                 authenticated; no pending, nothing recently answered
#   pending-single        one ticket, context, free-text answer only
#   pending-options       a ticket with option buttons
#   pending-multi-stream  tickets from several streams, grouped headings
#   option-selected       an option picked (aria-pressed, selection marker)
#   card-error            submitting an empty answer shows the inline card error
#   recent-answered       an answered ticket in "Recent" with its Undo button
#   status-polling        SSE unavailable, page fell back to polling every 5s
#   load-error            /api/tickets failed; global error banner
#   mobile-pending        the pending queue at phone width
#   mobile-token-gate     the token gate at phone width
#
# NOT reachable on the page (and therefore not captured): the `expired` and
# `cancelled` ticket statuses. GET /api/tickets returns only pending tickets plus
# answered tickets from the last 5 minutes, so an expired or cancelled ticket simply
# disappears from the page; there is no expired/cancelled render branch.
#
# Instance strategy: by default the script starts its own isolated readyroom instance
# on a dedicated port with a fresh temporary state dir, captures against it, and tears
# it down. This guarantees a clean "empty" baseline and never touches any other running
# instance. Set READYROOM_EXTERNAL=1 to instead capture against an already-running
# server (BASE_URL + READYROOM_TOKEN must then point at it).
#
# Usage:
#   npm run screenshots
#   # or directly:
#   bash scripts/capture-screenshots.sh
#
#   # target an instance you started yourself:
#   READYROOM_EXTERNAL=1 BASE_URL=http://127.0.0.1:8971 READYROOM_TOKEN=... \
#     bash scripts/capture-screenshots.sh
#
# Requires: node (>=22), curl, and playwright-cli on PATH (falls back to npx).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OUT_ROOT="docs/screenshots"
PORT="${READYROOM_PORT:-8972}"
TOKEN="${READYROOM_TOKEN:-shots-dev-token}"
BASE_URL="${BASE_URL:-http://127.0.0.1:${PORT}}"
EXTERNAL="${READYROOM_EXTERNAL:-0}"

DESKTOP_W=1280; DESKTOP_H=800
PHONE_W=390;    PHONE_H=844

# Resolve the playwright-cli binary once; fall back to npx if not on PATH.
PW_BIN="playwright-cli"
if ! command -v playwright-cli >/dev/null 2>&1; then
  PW_BIN="npx playwright-cli"
fi
pw() { $PW_BIN "$@"; }

SERVER_PID=""
STATE_DIR=""

cleanup() {
  # Close every browser session this script opened, even on failure.
  pw close-all >/dev/null 2>&1 || true
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$STATE_DIR" ] && [ -d "$STATE_DIR" ]; then
    rm -rf "$STATE_DIR"
  fi
}
trap cleanup EXIT

wait_for_server() {
  echo "waiting for $BASE_URL ..."
  for _ in $(seq 1 60); do
    if curl -sf -o /dev/null "$BASE_URL/healthz"; then
      echo "server is up"
      return 0
    fi
    sleep 0.5
  done
  echo "server never came up at $BASE_URL" >&2
  return 1
}

start_server() {
  STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/readyroom-shots.XXXXXX")"
  echo "starting isolated readyroom on :$PORT (state dir $STATE_DIR)"
  READYROOM_PORT="$PORT" \
  READYROOM_BIND=127.0.0.1 \
  READYROOM_TOKEN="$TOKEN" \
  READYROOM_STATE_DIR="$STATE_DIR" \
  READYROOM_STREAM=capture \
    node --import ./scripts/html-loader-register.mjs --import tsx src/index.ts \
    </dev/null >"$STATE_DIR/server.log" 2>&1 &
  SERVER_PID="$!"
}

# ── playwright helpers ──────────────────────────────────────────────────────

open_actor() { # session width height
  local s="$1" w="$2" h="$3"
  # `--no-persistent` = in-memory profile, so every session starts clean.
  pw -s="$s" open "$BASE_URL/" --no-persistent >/dev/null
  pw -s="$s" resize "$w" "$h" >/dev/null
  # The page disables all transitions under reduced-motion; set it and rely on it.
  pw -s="$s" run-code "async page => { await page.emulateMedia({ reducedMotion: 'reduce' }); }" >/dev/null
}

shot() { # session name
  local s="$1" name="$2"
  pw -s="$s" screenshot --filename="$OUT_ROOT/$name.png" >/dev/null
  echo "captured $name.png"
}

# Set the access token in this session's localStorage and reload, then wait until the
# page has reached a live or polling status (i.e. it has authenticated successfully).
login() { # session
  local s="$1"
  pw -s="$s" run-code "async page => { await page.evaluate(() => localStorage.setItem('readyroom_token', '$TOKEN')); await page.reload({ waitUntil: 'load' }); await page.waitForFunction(function(){ var t = document.getElementById('status-text').textContent; return t.indexOf('live') !== -1 || t.indexOf('polling') !== -1; }, { timeout: 15000 }); }" >/dev/null
}

wait_status() { # session substring
  local s="$1" needle="$2"
  pw -s="$s" run-code "async page => { await page.waitForFunction(function(n){ return document.getElementById('status-text').textContent.indexOf(n) !== -1; }, '$needle', { timeout: 15000 }); }" >/dev/null
}

wait_for_text() { # session substring (must not contain a single quote)
  local s="$1" needle="$2"
  pw -s="$s" run-code "async page => { await page.waitForFunction(function(n){ return document.body.innerText.indexOf(n) !== -1; }, '$needle', { timeout: 15000 }); }" >/dev/null
}

# A short settle after a pure-layout change (resize). Reduced motion removes every
# transition, so this is about reflow, not animation; kept deliberately tiny.
settle() { # session
  pw -s="$1" run-code "async page => { await page.waitForTimeout(150); }" >/dev/null
}

# ── ticket fixtures via the loopback tool-call proxy ────────────────────────

create_ticket() { # args-json (the ask_human `args` object)
  curl -sS -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    --data "{\"name\":\"ask_human\",\"args\":$1}" \
    "$BASE_URL/internal/tool-call" >/dev/null
}

# ── run ─────────────────────────────────────────────────────────────────────

if [ "$EXTERNAL" = "1" ]; then
  echo "READYROOM_EXTERNAL=1: capturing against $BASE_URL (no instance started)"
else
  if curl -sf -o /dev/null "$BASE_URL/healthz"; then
    echo "something is already serving $BASE_URL; stop it or set READYROOM_EXTERNAL=1" >&2
    exit 1
  fi
  start_server
fi
wait_for_server

# Clear previous captures (but keep MANIFEST.md and anything else in the dir).
mkdir -p "$OUT_ROOT"
rm -f "$OUT_ROOT"/*.png

# ── token gate (unauthenticated) ────────────────────────────────────────────
open_actor gate "$DESKTOP_W" "$DESKTOP_H"
wait_status gate "waiting for token"
shot gate token-gate

pw -s=gate resize "$PHONE_W" "$PHONE_H" >/dev/null
settle gate
shot gate mobile-token-gate

# ── authenticated queue: empty → single → options → multi-stream ────────────
open_actor human "$DESKTOP_W" "$DESKTOP_H"
login human
shot human empty

# One ticket: context, no options (free-text answer only).
create_ticket '{"stream":"api-server","question":"Should the retry budget be 3 attempts or 5?","context":"The upstream flaked twice this week.\nA higher budget hides outages; a lower one fails fast.","urgency":"normal"}'
wait_for_text human "Should the retry budget be 3 attempts or 5?"
shot human pending-single

# Add a ticket with option buttons.
create_ticket '{"stream":"web-client","question":"Which label for the primary button?","options":["Save","Apply","Confirm"],"context":"Design is split between Save and Apply.","urgency":"blocking"}'
wait_for_text human "Which label for the primary button?"
shot human pending-options

# Add a third stream, so the grouped multi-stream layout is visible.
create_ticket '{"stream":"docs-pipeline","question":"Regenerate the API reference now?","urgency":"low"}'
wait_for_text human "Regenerate the API reference now?"
shot human pending-multi-stream

# Phone-width view of the same populated queue.
open_actor mobile "$PHONE_W" "$PHONE_H"
login mobile
wait_for_text mobile "Should the retry budget be 3 attempts or 5?"
shot mobile mobile-pending

# Option selection: pick option 2 on the web-client card.
pw -s=human run-code "async page => { await page.getByRole('button', { name: '2. Apply' }).click(); await page.waitForTimeout(100); }" >/dev/null
shot human option-selected

# Inline validation error: submit an empty answer on the api-server card.
pw -s=human run-code "async page => { await page.locator('article', { hasText: 'Should the retry budget be 3 attempts or 5?' }).getByRole('button', { name: 'Answer' }).click(); await page.waitForSelector('text=Type an answer or pick an option first.'); }" >/dev/null
shot human card-error

# Answered ticket: type a free-text answer and submit it, so it lands in "Recent".
pw -s=human run-code "async page => { var card = page.locator('article', { hasText: 'Should the retry budget be 3 attempts or 5?' }); await card.getByRole('textbox').fill('Use 3 attempts'); await card.getByRole('button', { name: 'Answer' }).click(); await page.waitForSelector('text=Answer: Use 3 attempts'); }" >/dev/null
shot human recent-answered

# ── network-dependent states ────────────────────────────────────────────────

# Token rejected: enter a wrong token through the UI.
open_actor rejected "$DESKTOP_W" "$DESKTOP_H"
pw -s=rejected run-code "async page => { await page.getByRole('textbox', { name: 'Access token (READYROOM_TOKEN)' }).fill('wrong-token'); await page.getByRole('button', { name: 'Save token' }).click(); await page.waitForSelector('text=Token rejected (401). Enter it again.'); }" >/dev/null
shot rejected token-rejected

# Polling fallback: break /api/events so the SSE path fails and the page polls.
open_actor polling "$DESKTOP_W" "$DESKTOP_H"
pw -s=polling route "**/api/events" --status=500 >/dev/null
login polling
wait_status polling "polling"
shot polling status-polling

# Load error: break /api/tickets so the queue fetch fails.
open_actor loaderr "$DESKTOP_W" "$DESKTOP_H"
pw -s=loaderr route "**/api/tickets" --status=500 >/dev/null
login loaderr
wait_for_text loaderr "Could not load tickets"
shot loaderr load-error

echo "all screenshots written to $OUT_ROOT"
