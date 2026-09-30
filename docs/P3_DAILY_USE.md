# Daily-use, DM, search and media UX (P3)

P3 makes the everyday journeys — messaging, DMs, search, voice — correct, keyboard-usable and
honestly evidenced. It does not redesign the product. Every failure below was reproduced and
classified as exactly one of: **product defect**, **test/harness defect**, **environment/infra
defect**, **known documented limitation**, **external/unverified**. Skipped tests are listed as
skipped and are never counted as passing.

## Baseline (main `822150d`)

Environment: disposable PostgreSQL 16 (schema via `server/db/postgres/index.ts`, then the full
migration chain, 75/75), `scripts/e2e-server.js` (single node, no Redis, SFU on loopback), the
production client and server builds of `822150d`, Chromium (build 1194). Firefox and WebKit are not
installed in this environment and cannot be installed here: those two projects are
**environment — not run locally**; the nightly CI job installs and runs them.

| Project | Passed | Failed | Skipped |
|---|---|---|---|
| api-smoke | 3 | 0 | 0 |
| chromium (full suite) | 495 | 5 | 26 |
| a11y | 10 | 0 | 0 |
| a11y-mobile | 10 | 0 | 0 |
| a11y-keyboard | 8 | 0 | 0 |
| mobile | 6 | 0 | 0 |
| voice-media | 33 | 0 | 0 |

### Failures

| Test | Class | Root cause | Fix |
|---|---|---|---|
| `a11y.flows` › server settings modal | product defect (a11y) | the public-profile address field sits in a fieldset; a legend names the group, not the field — axe `label` (critical), screen readers read an unlabelled field | `aria-labelledby` → the legend; unit test (old markup: empty name) |
| `account-deletion-journey` | product defect (security) | on a single node the auth middleware caches `tokenVersion` for 30 s; neither self- nor admin deletion dropped the entry, so the deleted account's token still authenticated (`GET /api/me` → 404 behind a passing auth check) | both deletion routes invalidate the cache; test with the real middleware and route (old code: 200) |
| `file-security` › avatar visible to everyone | test/harness defect | a hand-written `'X-CSRF-Token': await getCsrf(...)` bypasses the fixture's refresh; the server keeps one CSRF token per user and alice's browser pages had replaced it → 403 | the `apiTest` fixture refreshes once when the token sent is the shared cached one **and** the server answers a CSRF rejection; deliberately wrong tokens are untouched |
| `keyboard-journeys` › focus survives optimistic reconciliation | test/harness defect | six UI sends in a row as alice tripped the product's anti-spam rule (> 5 messages / 4 s → 30 s hold); the message was correctly shown "Sırada — hız sınırı" (screenshot) and the test waited 20 s | sends paced with the shared cross-process `paceSends('alice')`. The product side is covered: `ux-final21-send-hold.test.ts` (automatic send with the same ackId when the hold ends) and `send-error-semantics.spec.ts` (server contract) |
| `keyboard-journeys` › message actions by keyboard | test/harness defect | same hold: a queued message has no action bar | same fix |

### Skipped (26) — none counted as passing
- **Known documented, obsolete by design (5):** `messaging` ×3, `offline-queue` ×2 — they target a
  REST send endpoint that does not exist; the canonical coverage is `message-actions.spec.ts`
  (Socket.IO send + REST read, 8/8 passing).
- **Known documented, feature not shipped (19):** Canvas REST ×2, Clips ×2, Go-Live REST ×2, admin
  plugin API ×6 (404), activities REST ×2, Swagger JSON ×1, message-list virtualisation ×4 (the
  product does not virtualise the message list).
- **Environment, configuration variant not enabled (2):** WebP conversion (`WEBP_CONVERT`), R2 CDN.

### Other findings from the baseline
- **Nightly `E2E full + media` never ran a suite** (run 36393580675): the job does not run the
  migration chain, so the first suite failed on `relation "server_boosts" does not exist`, and a
  failed step skipped every later suite. **Environment/infra defect** — fixed (see CI below).
- `client/tests/audit-log.test.ts` › CSV export failed locally under Node 22 (passes on CI's Node
  24): it asserted the download click before `await response.blob()` had resolved. **Test
  defect** — it now waits for the click; the assertion is unchanged.

## Fixes

### Media UX — recovery is visible
P2's session recovery (ICE failure, lost socket, owner/worker death) takes 3–30 s in the lab and up
to 90 s. During it the voice panel kept saying "Connected" while no media flowed. The panel now
listens to the engine's `bridge:voice-reconnecting` / `bridge:voice-reconnected` events and shows
"Reconnecting…" in its polite live status region; the call ending clears it. Unit test (old code:
the status stayed "connected").

### Bundle — UTF-8 output
esbuild's default ASCII output wrote every non-ASCII character as a 6-byte `\uXXXX` escape.

| | before | after |
|---|---|---|
| total shipped JS (budget 3500 KB) | 3418.7 KB (98 %) | 2971.5 KB (85 %) |
| initial download (budget 1200 KB) | 953.7 KB | 940.5 KB |
| `ru` locale chunk raw / gzip / brotli | 372.7 / 52.6 / 40.9 KB | 168.4 / 45.5 / 37.0 KB |
| `ja` locale chunk raw / gzip / brotli | 223.5 / 44.8 / 36.5 KB | 141.4 / 41.6 / 34.1 KB |
| `en` locale chunk raw / gzip / brotli | 111.9 / 37.1 / 31.6 KB | 111.1 / 37.2 / 31.6 KB |

Every chunk is an ES module, which browsers, Electron and Capacitor decode as UTF-8; the server
also sends `text/javascript; charset=utf-8`. The locale journey (non-ASCII UI end to end) passes
on the new build.

### Direct messages (1:1 and group)
Found by driving long conversations in a real browser (1280×720 and 390×844), not by the existing
DM specs, which exercise the server contract only. All are **product defects**; each fix has a unit
test and a browser journey (`e2e/tests/dm-daily-use.spec.ts`) that fail on the old code.

| Defect | Old behaviour (measured) | Fix |
|---|---|---|
| DM panel grows past the viewport | `.dm-panel` is a fixed grid with no row template; its implicit `auto` row grew with the content. 50 messages at 1280×720: chat 3917 px tall, composer at y=3845, list never scrolls — the composer is unreachable by mouse | one bounded row (`minmax(0,1fr)`), the chat may shrink; the list is the scroll container |
| Group DM panel is not an overlay | `.gdm-panel` (a `role=dialog aria-modal`) had no positioning; `height:100%` of the auto-height `#gdm-root` resolved to content height and the panel fell into document flow under the shell (y=625, 1109 px; composer at y=1677) | fixed full-viewport overlay, the same contract as the DM panel |
| Composer squeezed by a global rule | `auth.css` `.btn-primary{width:100%}` (login form) leaked into both composers: DM textarea 22 px beside a 942 px button; group DM input 205 px beside 815 px | the composer buttons size to their content |
| Conversation opens at the top | DM opened at the oldest loaded message; incoming and own messages were not scrolled into view | opens at the newest; own sends and incoming messages while at the bottom follow; reading older history is not interrupted (DM and group DM) |
| History beyond 50 unreachable | the client asked for the last 50 only; the server's `before` + `beforeId` cursor was never used (DM and group DM) | "Load older messages" (button, keyboard, or scrolling to the top) with the composite cursor; the reading position is kept |
| Enter did not send a DM | Enter added a newline in 1:1 DMs (group DMs and channels send) | Enter sends; Shift+Enter and IME composition do not |
| No send time on DMs | 1:1 DM rows had no timestamp (group DMs had one) | a `<time datetime>` in the app locale: time for today, day + time otherwise; none on unconfirmed rows |
| Stale sidebar unread badge | a message to a conversation other than the open one left its badge unchanged until the panel was reopened (DM and group DM) | the server-derived list is re-read (debounced); no local counter, so duplicate delivery cannot inflate it |

### Server search panel
| Defect | Old behaviour | Fix |
|---|---|---|
| Stale results | requests carried no sequence number: a late response for "ab" replaced the results of "abc"; a response in flight when the query was cleared refilled the panel (tab switch and "load more" had the same race) | only the newest request writes results — the contract the global search already had |
| Wrong structure | results were `<button role="option" aria-selected="false">` inside a `role="listbox"` that also held the skeleton, error, count and "load more"; no selection, no arrow keys | a list of buttons (Tab reaches every result); ↓ from the query moves to the first result, ↑/↓/Home/End move between results, ↑ on the first returns to the query; visible focus |

Unit tests fail on the old code (5/5). Edited messages: the full-text match is an expression over
the current `content` (`server/db/postgres/fts.ts`), so an edit is searchable by its new text by
construction; deleted messages are covered by `search-security-extended.spec.ts`.

Test/harness finding while writing the journey: seeding 54 DMs from two users at ~1 msg/s tripped
the product's DM limit (20 per minute per user, `RL_DM_SOCKET_MAX`), which answers with the legacy
event `error:dm_rate` even when the send carries a `clientNonce`. The client listens for it; the
helper now does too, so a rejection fails with its code instead of a silent 15 s timeout, and
seeding is paced under the limit.

### Reconnect resync overwrote live messages
Found by the nightly job's first real run (chromium re-run: `offline-queue` › a message sent
offline stayed "queued" 60 s after the connection returned); reproduced locally in 7 of 18 runs.
**Product defect.** WebSocket frames showed the queued message *was* re-sent on reconnect, stored,
broadcast (`message:new`) and acknowledged (`message:ack`), and the outbox emptied — but the
reconnect history reload had been requested before the message was stored, and its response (0
messages) arrived 3 ms after the ack and replaced the list. The delivered message vanished and the
user saw it as still queued until the next reload. The same race brought back a message deleted
while the request was in flight and reverted an edit made in that window.

Fix: while a history request is in flight the loader records what arrives live (new and
acknowledged message ids, deletions, edits); the snapshot keeps those, drops the live-deleted rows
and re-applies the live edits. A message that was present before the request and is absent from
the response is still dropped (deleted while disconnected). Integration test with the real store and
loader (3 of 4 fail on the old code; the fourth is that control); the e2e test passes 30/30 after
the fix.

### MEDIA-11 — bounded investigation, not shipped, still open
Acceptance for a fix: (A) narrow-link audio not regressed, (B) video recovers without the 90 s
deadlock, (C) no uncontrolled probing, (D) regression tests. Media lab on main `a76a9b2`:

| | without the change | with audio-first admission + bounded re-probe |
|---|---|---|
| congestion 64 kbit/s × 20 s, 6 cycles | 6/6 resumed, A→B 2.0–10.1 s | 6/6 resumed, A→B 6.0–10.2 s |
| congestion 32 kbit/s × 30 s, 10 cycles | 10/10 resumed, A→B 2.0–12.1 s | — |
| 150 kbit/s audio concealment A→B / B→A | 0 % / 0 % (video yields) | 3.0 % / 10.5 % |
| 500 kbit/s audio concealment A→B | 0 % | 3.9 % |

The deadlock did not reproduce on the current build (0 of 16 cycles; P2 build: 4 of 10), so (B)
had nothing to cure, and (A) regressed. Reverted; kept in history (`f561254`, reverted by
`611c7ad`) with 14 model tests. Details and what would reopen it: `docs/MEDIA_RELIABILITY.md`.

### Long channels — measured, known limitation
The message list is not virtualised (the 4 virtual-scroll E2E tests are skipped as *feature not
shipped*). Measured with 3000 real message rows (seeded into the disposable database only),
Chromium 1280×720 in this container, scrolling back 50 messages per page:

| Loaded | DOM nodes | JS heap | Older-page load | Longest main-thread task |
|---|---|---|---|---|
| 50 (open) | 2,263 | 11 MB | 209 ms | 86 ms |
| 500 | 16,666 | 41 MB | 522 ms | 155 ms |
| 1,000 | 32,666 | 82 MB | 669 ms | 282 ms |
| 2,000 | 64,666 | 148 MB | 918 ms | 486 ms |
| 3,000 | 96,665 | 291 MB | 1,184 ms | 717 ms |

Growth is linear (~32 DOM nodes per message). Typing stays within one frame (p50 16.4 ms, p95
17.1 ms) with 3000 messages loaded. Opening a channel and normal use (the last few hundred
messages) are unaffected; a session that scrolls back past ~1000 messages pays a 0.3–0.7 s freeze
per further page and ~0.1 MB of heap per loaded message. Windowing/virtualisation is a P4 candidate;
absolute numbers depend on the machine — the trend is the finding.

### Bundle — considered and not changed
Initial download is 944 KB of the 1200 KB budget (79 %), total shipped JS 85 % (after the UTF-8
fix). Two initial-entry modules are voice-only: `webrtc-sfu.ts` (~37 KB) and `soundboard.ts`
(~33 KB). Neither is lazy-loaded: the SFU engine factory must be registered before `webrtc.ts`
boots, and the soundboard binds its socket listeners at startup so other participants' sounds
play. Deferring either restructures the voice path P2 hardened, for ~70 KB raw (~7 % of the
initial download). Not justified inside the budget; revisit if the initial budget tightens. The
sub-budget warnings (mediasoup-client chunk 228 KB, lazy; app entry 814 KB) are unchanged and remain
warnings, as the budget script defines them.

### Known limitations (DMs)
- **No edit or delete of your own DM / group DM messages.** The server has no DM edit/delete
  events or routes; this is a feature gap, not a defect in an existing path. Candidate for P4.
- **DMs are text-only** (no attachments). Same classification.

## CI — nightly full E2E
The scheduled job now: runs the migration chain; runs every suite even when an earlier one fails
(`!cancelled()`), so one red suite no longer hides the others; adds `a11y-mobile` and
`a11y-keyboard` (never run in CI before); runs with `--retries=0` so nondeterminism surfaces as a
failure to classify; uploads each project's results.

First real runs (dispatched on `2a8ad05`, run 36709923407, attempts 1 and 2):

| Project | Attempt 1 | Attempt 2 |
|---|---|---|
| chromium (full) | 500 passed / 0 failed / 26 skipped | 499 / **1** / 26 |
| firefox | 26 / **1** | 27 / 0 |
| webkit | 27 / 0 | 27 / 0 |
| voice-media | 33 / 0 | 33 / 0 |
| mobile | 6 / 0 | 6 / 0 |
| a11y / a11y-mobile / a11y-keyboard | 10 / 10 / 8 | 10 / 10 / 8 |

| Failure | Class | Evidence and action |
|---|---|---|
| chromium `offline-queue` › queued message never "sent" | **product defect** | the reconnect resync race above; reproduced 7/18 locally, fixed, 30/30 |
| firefox `cross-browser-product` › fallback avatar background | **test/harness defect** | 1 of 2 runs, Firefox only: a main-world `locator.evaluate` hung 10 s right after a passing utility-world assertion on the same element; the same property is now asserted with a retrying `toHaveAttribute`. Firefox is not runnable in this environment and the artifact host is blocked by the egress policy, so the next nightly is the confirmation |
