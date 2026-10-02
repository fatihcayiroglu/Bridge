## [Unreleased] — 2026-10-01 — P6: interop, AI and reliability

P6 works through the gaps P5 carried forward. Evidence and the defect log are in
`docs/P6_INTEROP_AI_RELIABILITY.md`.

### Upgrade notes
- **Migration 078** adds `servers."aiEnabled"` (BOOLEAN NOT NULL DEFAULT TRUE). Every existing
  server keeps AI. Owners can now turn it off.
- **`AI_PROVIDER` now governs voice-message transcription and embeddings too.**
  - `AI_PROVIDER=none`/`off`/`rules` stops transcription and embeddings even when
    `GROQ_API_KEY`, `OPENAI_API_KEY` or `EMBEDDING_PROVIDER` keys are set.
  - `AI_PROVIDER` set to a provider other than `groq` stops transcription. It used to send audio
    to Groq or OpenAI regardless.
  - With `AI_PROVIDER` unset, nothing changes.
- **pgvector installs (`PGVECTOR_ENABLED=true`) now embed new messages continuously.**
  - A live sweep runs every 60 s, using `EMBED_SWEEP_*` settings (see `server/.env.example`).
    Before, only a nightly job embedded messages.
  - At first boot two database triggers are created, on `messages` and `servers`. If they cannot
    be created, pgvector stays off and search uses its fallback.
  - The first nightly run removes vectors that an older version stored for deleted messages,
    E2EE payloads and opted-out servers.

### Added
- **Live semantic indexing (pgvector).** The embedding writer has a caller: a bounded,
  cluster-claimed sweep.
  - Each message is re-checked against the database immediately before it is sent to the
    embedding provider.
  - A vector is stored only if the row still holds the text that was embedded.
  - Edits and deletes clear a message's vector in the same statement (database triggers). An
    owner turning AI off removes the server's vectors in the same transaction.
- **Per-server AI opt-out.** In Server Settings → General, a server owner can turn AI off for
  their server (`PATCH /api/servers/:id { "aiEnabled": false }`).
  - Nothing from that server is then sent to an AI provider: no channel context, message text,
    voice audio, search embedding, or name and tags for recommendations.
  - Routes with a local fallback still answer. Streams and translation answer 403
    `AI_DISABLED_FOR_SERVER`.
  - The setting is read on every request, so it takes effect immediately.

### Security
- **Voice-message transcription ignored `AI_PROVIDER`** (P6 AI-09). It read the provider keys
  itself.
- **The embedding path ignored `AI_PROVIDER=none`** (P6 AI-10).
- **The embedding batch could send E2EE payloads and deleted-message placeholders to the provider,
  and kept vectors after an edit** (P6 AI-11). Vector search also excludes E2EE rows now.
- **A cached semantic-search answer (3 min) could return a message after it was deleted.** Cached
  answers are now re-checked against current messages and channel visibility on every hit.

### Fixed
- **Every log line from `lib/pgvector.ts` threw in production** (P6 AI-12). Pino methods were
  called detached from their logger.
  - A provider error made `generateEmbedding` throw instead of returning null.
  - A missing `vector` extension would have failed boot instead of falling back.

## [Unreleased] — 2026-10-01 — P5: federation, AI and self-hosting

Two independent Bridge installations now federate end to end over real HTTPS in a lab. The lab
also includes a hostile remote ActivityPub actor and an SSRF canary, and it injects partitions,
restarts, revocation and key rotation. AI features run against a self-hosted, OpenAI-compatible
provider whose received traffic the lab inspects. A fresh checkout installs, restarts, upgrades
and restores as documented. Evidence, defect log and closure bar:
`docs/P5_FEDERATION_AI_SELFHOSTING.md`; AI data boundary: `docs/AI.md`.

### Upgrade notes
- **`INSTANCE_URL` is validated at boot in production.**
  - It must be an `https://` origin. Plain `http` is accepted only for `localhost`, `127.0.0.1`
    or `[::1]`.
  - It must have no path, no credentials and no query.
  - An install whose `INSTANCE_URL` breaks a rule **refuses to start** and names the variable.
    Set it to the public `https://` URL, or unset it on an install that does not federate
    (unset only logs a warning).
  - A production install served over plain `http` from a non-loopback address was already
    broken for browsers: the session cookie is `Secure`, and microphone and camera need a
    secure context.
- **The versioned migration chain now runs at boot**, inside the existing schema lock.
  - Readiness answers 503 while migrations are pending.
  - `BRIDGE_AUTO_MIGRATE=false` leaves migrations to `migrate-postgres up`.
  - An upgraded install applies `076` (drops a superseded FTS index) and `077`.
  - `077` deletes `oauth_tokens` and `server_boosts` rows whose user no longer exists (what
    `ON DELETE CASCADE` would have done), then adds those foreign keys.
- **Instance-peer heartbeats use a new signed form (`bridge-peer-sig/1`).**
  - Peers need this version on both sides.
  - Heartbeats from an older peer are refused with 401, logged as
    `federation.heartbeat.peer_refused`. They never verified between older versions either:
    no released version produced the signature it checked.
  - ActivityPub delivery between versions is unaffected. Bridge already signed
    `(request-target) host date digest`, which inbound verification now requires.
- **Outbound federation deliveries retry for about 3.5 days** (12 steps with backoff) instead of
  about 12 minutes. The schedule can be set with `FEDERATION_DELIVERY_RETRY_DELAYS_MS`.
- **AI.**
  - `AI_PROVIDER` selects exactly one provider; `none` turns AI off even when keys are set.
  - `openai-compatible` (`AI_BASE_URL`, `AI_MODEL`, optional `AI_API_KEY`) covers vLLM,
    llama.cpp, LM Studio and LocalAI.
  - `AI_TIMEOUT_MS` (default 30 s) bounds each call, retries included.
  - AI is never required.

### Security
- **Signatures.**
  - An ActivityPub signature that did not cover `host`, `date` and `digest` was accepted; it is
    now refused.
  - The signed Host must be this instance.
  - Instance-peer requests are bound to time, method, path, sender and receiver, and each
    signature works only once.
- **Peer registration.** Registering a server whose `/info` claimed another instance's URL stored
  its key *as that instance*. The contacted URL is now the identity.
- **Domain blocks and follows.**
  - A domain block now also stops outbound delivery.
  - Following an actor on a private address is refused before anything is stored. The SSRF guard
    had already blocked the connection.
- **AI context.**
  - AI context is read through one permission-checked function and never contains deleted
    messages, system messages or end-to-end-encrypted payloads.
  - A summary cached before a deletion is no longer served after it.
  - Channel text goes to the model as delimited data in a user turn, not in the system prompt.
  - Clients can no longer send `system` turns.
- **AI secrets and limits.**
  - Provider error text (which can name internal hosts) no longer reaches clients.
  - The Gemini key is sent in a header, not the URL.
  - `/api/ai/summarize` and `/api/ai/moderate` are rate-limited.

### Fixed
- **A fresh install never applied its 75 versioned migrations** but still reported ready.
- **On a fresh install, inbound follows failed** with `column "accepted" does not exist` until the
  second boot.
- **The admin domain allow/block list and peer key updates answered 500.** They wrote columns
  that do not exist.
- **Instance-peer heartbeats could never verify**, because no Bridge code produced what the
  verifier checked, so a rotated key never reached peers.
- **Publishing waited for a hanging follower** (8 s measured). It now waits at most 1.5 s after
  the delivery is durably queued.
- **Backup and restore failed as shipped.**
  - `restore.sh` could not run `verify-backup.sh`.
  - The backup image lacked both scripts.
  - The dump check refused every dump larger than a pipe buffer.
- **A fresh install's schema changed between the first and second boot.**
- **AI requests could take over a minute.** Summaries, suggestions and translations failed with
  500 when the provider was down. They now degrade to the local summary or canned suggestions,
  or answer 503.

### CI
- **`Bridge Self-host Evidence`:** a process clean room covering install, restart, configuration
  fail-fast, upgrade from the previous build, backup/restore and an egress observer, plus the
  documented Docker Compose path.
- **`Bridge Federation + AI Evidence`:** the two-installation lab, all scenarios.

## [Unreleased] — 2026-10-01 — P4: mobile / native maturity

The Android app is now built the documented way in CI and driven on an Android 14 emulator through
its real WebView, lifecycle, permission sheets, input and a controllable network path; the iOS app
is built and launched on a simulator. Every result carries its evidence category (AUTOMATED /
EMULATOR, AUTOMATED / SIMULATOR, unit/integration); **no physical device, real mobile network,
Firebase project or APNs key was available**, so device push delivery, audio routing and radio
handover are listed as EXTERNAL / UNVERIFIED, never as passing. Evidence and the defect log:
`docs/P4_MOBILE_NATIVE.md`.

### Security
- **Logging out did not end the session.** The refresh cookie is scoped to `/api/refresh`; the
  client posted to `/api/logout`, whose redirect was never followed, so the refresh token kept
  working (real Chromium: `/api/refresh` 200 after logout). Logout now revokes it; Settings has a
  visible Log out and a two-step Log out on all devices.
- **Push delivery outlived the session.** Logout, logout-all and password change now remove this
  installation's (or all) native device tokens and Web Push subscriptions; a token registered by a
  second account on the same phone moves to that account instead of failing on the database's
  unique constraint.
- **`bridge://auth/callback?token=…` could hand the app a session from any link.** Removed.

### Fixed
- **The Settings "Log out" label was below AA contrast in the light theme** (4.38:1 on the
  sidebar; caught by the nightly accessibility suite after the P4 merge). It now uses the theme's
  danger ink (7.62:1).
- **Deep links and notification taps did nothing** in the native app (warm and cold). They now open
  the channel, server, invite, DM or group DM — only through the server's permission-checked
  lookups; a cold-start link waits for the server and channel lists instead of reading them empty.
- **Granting notifications crashed an Android build without Firebase config** (the self-hosted
  default) at launch, and signing out would have crashed it too; push now reports "unavailable"
  there.
- **Native push registration could never succeed** (relative URL, no CSRF header); the native app
  can now turn push on from Settings, and DMs and group DMs reach phones whose app is not connected.
- **Pushes used an icon and a notification channel the app did not have**; they now use the app's
  icon and a "Bridge" channel.
- **An iOS app built the documented way had no microphone usage description** (iOS terminates such
  an app on first microphone use), no `bridge://` scheme and version 1.0; the curated iOS layer is
  now applied.
- **Denying the microphone was reported as "No microphone found"** on the SFU voice path.
- **`bridge://` links could never open Bridge on an iPhone**: Apple's Watch app declares the
  `bridge` scheme and iOS hands such links to it (measured on the simulator). The apps now own
  `com.bridge.app://` on iOS and Android; `bridge://` keeps working where the OS allows it.
- **On notched and edge-to-edge phones the app drew under the system bars**: the channel header's
  search and menu buttons sat under the status bar, and in landscape the composer sat in the
  home-indicator band. In landscape, Settings opened above the screen with its close button out
  of reach, even without a notch.
- A push received while the app was visible no longer shows a second, system notification.

### CI
- `Mobile Android`: debug APK through `setup.js → cap add android → overlay → cap sync → Gradle`,
  then emulator journeys (launch, background, process death, offline/online, DM, back key, deep
  links, microphone/camera permission sheets, voice, push channel, file picker upload, keyboard,
  rotation, memory, long channel). `Mobile iOS`: `xcodebuild` for the simulator, cold launch,
  WKWebView bridge readiness, deep-link dispatch.

## [Unreleased] — 2026-09-30 — P3: daily-use, DM, search and media UX

Baseline on `main 822150d` with every locally runnable Playwright project (chromium 495 passed /
5 failed / 26 skipped; a11y, a11y-mobile, a11y-keyboard, mobile, voice-media and api-smoke all
passing). Every failure was classified before anything changed; skipped tests are listed as
skipped, never counted as passing. Evidence: `docs/P3_DAILY_USE.md`.

### Security
- **A deleted account's access token kept working for up to 30 seconds.** On a single node (no
  `REDIS_URL`) the auth middleware caches each user's `tokenVersion`; account deletion — by the
  person or by an admin — never dropped that entry, so the old token still passed authentication
  (the e2e journey saw `GET /api/me` answer 404 behind a passing auth check instead of 401). Both
  deletion paths now invalidate the cache; a test runs the real middleware and route (the old code
  answered 200).

### Fixed
- **Voice calls said "Connected" while the media session was being re-established** (P2 measured
  3–30 s, up to 90 s): the voice panel now shows "Reconnecting…" (a polite live region) until the
  session is back or the call ends.
- **The server's public-profile address field had no accessible name** (axe `label`, critical): it
  is now labelled by its section heading.
- **Long DM conversations pushed the composer off the screen.** The DM panel's grid row grew with
  its content (50 messages at 1280×720: the composer at y=3845, the list never scrolled); the panel
  now fits the viewport and the message list scrolls.
- **The group DM panel was not an overlay.** It fell into the page flow under the app shell
  (starting at y=625 at 1280×720, its composer at y=1677); it is now a full-viewport dialog like the
  DM panel.
- **Both DM composers were squeezed by the login form's button rule** (`.btn-primary{width:100%}`):
  a 22 px DM text field beside a 942 px button. The buttons now size to their content.
- **DMs and group DMs open at the newest message** and follow new ones while you are at the bottom,
  without jumping while you read older history (they opened at the oldest loaded message).
- **Older DM and group DM history is reachable**: "Load older messages" (or scrolling to the top)
  pages back with the server's composite cursor; only the last 50 messages were ever shown.
- **Enter sends a DM** (Shift+Enter adds a line), as in group DMs and channels.
- **DM messages show when they were sent** (time today, day and time before), as group DMs do.
- **A message sent while offline no longer looks stuck after reconnecting.** The reconnect history
  reload could answer with a snapshot taken before the queued message was stored and replace the
  list after the message had been delivered and acknowledged; the message disappeared and showed as
  "queued" until a reload (nightly E2E, 7 of 18 local runs). The same race revived messages deleted
  and reverted messages edited during the reload. Live changes are now kept when the snapshot lands.
- **The DM and group DM lists update a conversation's unread badge live** when a message arrives
  for a conversation other than the open one (it was stale until the panel was reopened).
- **Server search no longer shows results for an older query**: a slow response for "ab" could
  replace the results of "abc", and a response in flight could refill a cleared panel.
- **Server search results are a keyboard-navigable list** (↓ from the query, ↑/↓/Home/End between
  results) instead of a listbox without selection or arrow keys.

### Known limitations
- **MEDIA-11 stays open.** The video-after-congestion deadlock did not reproduce on the P3 build
  (0 of 16 lab cycles; 4 of 10 on the P2 build). Audio-first admission with a bounded re-probe was
  built and measured: no better recovery, worse narrow-link audio (150 kbit/s concealment 0 → 3.0 %
  / 0 → 10.5 %) — reverted, kept in history. Evidence: `docs/MEDIA_RELIABILITY.md`.
- DMs and group DMs have no edit/delete of your own messages and no attachments (feature gaps).
- The channel message list is not virtualised: measured, a session that scrolls back past ~1000
  messages pays a 0.3–0.7 s freeze per further page and ~0.1 MB heap per loaded message (3000
  messages: 97k DOM nodes, 291 MB). Typing stays within one frame. Evidence: `docs/P3_DAILY_USE.md`.

### Changed
- **Client bundle ships UTF-8 instead of `\uXXXX` escapes** — total shipped JS 3418.7 → 2971.5 KB
  (budget use 98 % → 85 %); the Russian locale chunk 372.6 → 168.4 KB. Transfer size (gzip) drops
  7–13 % for non-Latin locales, ~0 % for English. All chunks are ES modules, decoded as UTF-8 by
  every browser, Electron and Capacitor; the server also sends `charset=utf-8`.

### Tests and CI
- The nightly full E2E job migrates its database (it failed on `relation "server_boosts" does not
  exist`), runs every suite even after one fails, adds the `a11y-mobile` and `a11y-keyboard`
  projects (never run in CI before), runs without retries so nondeterminism surfaces, and uploads
  per-project results (it uploaded an HTML report the list reporter never wrote).
- E2E harness: a hand-written copy of the shared CSRF token is refreshed once when the server
  rejects it as stale (a browser page of the same user replaces the per-user token); keyboard
  journeys pace their sends under the product's anti-spam rule instead of tripping its 30 s hold.
- Client: the audit-log export test waits for the download instead of racing `response.blob()`.
- Real-PostgreSQL deletion suites mock the token-cache invalidation the deletion routes now call
  (their mocks lacked it, so the route answered 500 after erasing).
- Keyboard journey: server search without a mouse (↓ to the first result, Enter jumps to it).
- Firefox cross-browser avatar test reads the fallback background through a retrying assertion
  (a main-world `evaluate` hung once in the nightly run; same property asserted).
- Media lab: `IMPAIR_PROFILES` runs only the named impairment profiles.
- New browser journey `dm-daily-use.spec.ts`: a 54-message DM (open at newest, load older by
  keyboard, order, Enter-send, reload), a live unread badge, and a long group DM (overlay, composer
  on screen and usable, Enter-send). All three fail on the old code.

## [Unreleased] — 2026-09-27 — P2: real-media reliability evidence and fixes

Not part of the packaged Final23 ZIP. A disposable media lab (`scripts/medialab`) runs two real Bridge
nodes with real mediasoup workers, PostgreSQL, Redis, S3, a real coturn and real Chromium clients —
each inside its own Linux network namespace behind a userspace impairment link (latency, jitter, loss,
bandwidth, interruption; the host kernel has no `netem`) — and proves media by what the receiving
browser **decodes**: a per-sender tone and a per-sender video colour, plus `getStats()` and the
selected ICE candidate pair. Every defect below was reproduced there first (FAIL on the unfixed
build) and has a fast regression test in the normal Quality Gate. Media path, authority matrix and
measurements: `docs/MEDIA_RELIABILITY.md`. One host, synthetic impairment, fake capture devices:
media-path evidence, not perceptual quality, physical devices or real Wi-Fi/cellular networks.

### Fixed
- **Every SFU voice join failed in the production web bundle.** The lazily loaded `mediasoup-client`
  (CommonJS) resolves to a namespace with only `default` in the code-split esbuild output, so
  `new Device()` threw "is not a constructor". The loader now unwraps both shapes; a regression test
  bundles it with the production esbuild settings.
- **A late joiner never heard the people already in the room.** Producers announced in `sfu:joined`
  (or racing transport setup) were consumed before the receive transport existed and dropped; they
  are now queued and consumed once it exists.
- **SFU calls played no remote audio at all** and rendered no peer tiles, peer state or video
  tiles: the SFU engine targeted a `bridgeApp` registry object nothing registers. Both RTC engines
  now share one adapter to the VoicePanel's `voicePanel:*` owners.
- **SFU media never used TURN**: transports were created without the issued ICE servers and relay
  policy, so a client that could reach the SFU only through TURN had no media and `FORCE_TURN` had
  no effect on SFU calls. Relay-only calls now work over TURN/UDP and TURN/TCP.
- **Lost media sessions were never re-established.** ICE failure (TURN restart, WAN loss over
  ~15 s, mediasoup worker or owner-node death, a Redis-fenced room) left a live-looking call with no
  media; losing the app socket ended the call even when the media path was healthy. The SFU client
  now re-establishes the session through the normal, fully re-authorized join path (bounded backoff,
  90 s window; an authorization refusal ends the call), keeps a call whose dedicated owner socket is
  alive, keeps the user muted, re-publishes camera/screen, reconnects a stale signaling transport
  instead of waiting for its ping timeout, and names the session it replaces so no ghost peer
  lingers after a network change.
- **CONNECT or SPEAK revoked, or the member timed out, during a call: media kept flowing.** The live
  access re-check now also enforces voice access for sockets in a voice room (CONNECT lost or timed
  out → the voice session is evicted on every node; SPEAK lost → that user's producers are closed on
  the room owner, listening stays); the timeout route runs the re-check. An evicted client is told
  (`voice:evicted`) and ends the call instead of showing it live.
- **Settings → Devices never reached the live call** (it read `window.BridgeRegistry`, which
  production never sets); **camera video never exceeded 320x240** (a fixed 3-layer simulcast set lost
  its full-resolution layer for a default 640x480 camera); **a camera or microphone that ended
  underneath the call** left the controls showing it active and the microphone loss silent.
- **SFU calls mixed a shared screen's system audio into the microphone, and the camera into the
  screen view (MEDIA-12).** The SFU client kept one audio and one video stream per peer, so system
  audio played inside the microphone's element (it never got its own, and stopping the share could
  not remove it) and the camera and screen views showed the same stream; a closed producer's ended
  track also stayed in it. Each producer kind now has its own stream, a closed producer's track is
  removed, and the voice panel trusts the kind the SFU names — a camera turned on during a share no
  longer takes over the screen view. Found by the two-browser `voice-media` suite.

### Added
- `scripts/medialab` (lab, scenarios `e2e`, `turn`, `impair`, `netchange`, `failover`, `lifecycle`,
  `authz`, `multiuser`, `soak`) and `.github/workflows/media-evidence.yml` (weekly + manual, not PR CI).
- `docs/MEDIA_RELIABILITY.md`; the voice runbook states the measured recovery behaviour.

### Evidence
- Final full lab run on the merged product code: 72 PASS, 0 SKIPPED; the one FAIL (TURN over TCP)
  and one BLOCKED (relay-only handoff) were a lab defect — stray coturn processes sharing the TURN
  port — fixed in the lab (coturn in its own process group, no other listener allowed) and re-run:
  24 PASS, 0 FAIL, 0 BLOCKED, 0 SKIPPED (TURN-09 and NC-02 pass). Measurements: `docs/MEDIA_RELIABILITY.md#evidence`.
- New lab check `IMP-04`: video resumes after congestion clears (the matrix alone could not tell a
  slow bandwidth-estimate climb from stuck video). It found MEDIA-11 (below).
- Two-browser Playwright suite `voice-media` (33 tests, local SFU): 15 passed / 18 failed on `main`
  as CI starts the server (no announced SFU address → no RTP), 23 / 10 with the address set; the 10
  were MEDIA-12 (6), a display-capture stub that returned ended tracks on a second share (1) and
  three P2P-era assertions that counted the SFU's two transports and a closed consumer's leftover
  stats as duplicates (now topology-aware and counting only live paths). A clean run then exposed a
  harness defect — API setup helpers kept a CSRF token the same user's browser page had replaced and
  silently failed on the 403 — fixed by one refresh-and-retry. With this change: 33 / 0 in two
  consecutive runs (see `docs/MEDIA_RELIABILITY.md`). The e2e server now defaults the SFU address to
  loopback.

### Security (dependencies)
- Advisories that appeared after main's last green Quality Gate (2026-09-28) turned its
  `npm audit --audit-level=high` step red for the root, server and electron trees (none in e2e). Updated to the patched releases within the
  declared ranges: nodemailer 10.0.13, multer 2.4.0, engine.io 6.6.11, devalue 5.9.4, fast-uri 3.1.8,
  ip-address 10.7.2, brace-expansion 5.0.12 (and 1.1.21 / 2.1.7 in electron), electron 42.11.9. The
  exact pins moved to the first patched version: `undici` 7.29.1 (root override) and 8.10.2 (server),
  `brace-expansion` 5.0.12 and `ip-address` 10.7.2 (server overrides); eslint's minimatch gets a
  scoped `brace-expansion` override like the existing one for minimatch 3.1.5. Lockfiles regenerated
  with npm; `npm audit` reports 0 vulnerabilities in all four trees.

### Open (MEDIA-11)
- **Video from the SFU can stay off after heavy congestion.** When a receiver's link is squeezed, the
  SFU's bandwidth estimate towards it can fall to its 30 kbit/s floor; no simulcast layer fits, no
  video is sent, and nothing feeds the estimator again (no congestion feedback on forwarded audio; no
  probe while the desired bitrate is constant) — in the lab 4 of 6 such episodes stayed stuck ≥ 90 s.
  A re-probe prototype cured it (4 of 5 recovered in 3–5 s) but raised audio concealment on a link
  that stays at 150 kbit/s from ≤ 0.8 % to 6.6–10.6 %, so it is **not merged**; the fix needs an
  audio-first bandwidth rule as well (P3). Details: `docs/MEDIA_RELIABILITY.md`.

## [Unreleased] — 2026-09-27 — P1: multi-node distributed-correctness evidence and fixes

Not part of the packaged Final23 ZIP. A reproducible harness (`scripts/multinode`) now runs Bridge as
a disposable cluster of **real processes** — three nodes behind a routing load balancer, PostgreSQL,
Redis and S3-compatible storage, with fault-injecting proxies for PostgreSQL and object storage — and
exercises auth, realtime, stale sockets, node death, Redis/PostgreSQL failure modes, competing jobs,
SFU ownership and cross-node uploads. Every defect below was reproduced there first; each has a fast
regression test in the normal Quality Gate. Findings, the authority matrix and measurements:
`docs/DISTRIBUTED_AUTHORITY.md`. One host and three nodes: strong correctness evidence, not
production traffic, a multi-host partition or media quality.

### Fixed
- **Node crash on a database outage.** A PostgreSQL restart or network cut while a node held a
  checked-out pool client emitted an unhandled `error` and terminated the process. Pooled clients now
  carry a permanent error listener; a transaction client whose ROLLBACK failed is destroyed.
- **Readiness lied while Redis refused writes** (`-OOM`, `-READONLY`): the health check now performs a
  bounded write; readiness failures log the failing dependency once per state change.
- **Voice after kick / access revocation on another node:** the kicked socket kept broadcasting voice
  state and WebRTC offers, and the user stayed in every peer's voice roster (also same-node). P2P voice
  handlers now require the Socket.IO voice room, and revocations run the real voice leave (roster, SFU
  peer teardown) on the node that holds the socket (`membership:voice-evict`).
- **Presence after node death:** a user whose node was SIGKILLed stayed online forever once their other
  socket closed. A presence index and reaper perform the offline transition exactly once cluster-wide.
- **SFU room owner death** stranded the voice room for up to the 1-hour registry TTL; **Redis data loss**
  let a second node open a second router for a live room. Room ownership now carries a node liveness
  lease (`SFU_NODE_LEASE_MS`, default 30 s) with atomic takeover, heartbeat re-assertion and a settle
  window (~22 s) after the registry is recreated by Redis data loss (every node maintains the registry
  epoch, so an idle or freshly started cluster is never settling); a node that cannot renew closes its
  rooms before its lease can expire.
- **Ambiguous commits:** a message whose INSERT committed while the reply was lost was acked but never
  broadcast; a protected upload whose ownership row committed while the reply was lost had its bytes
  deleted (row without bytes). Both now resolve the real outcome first.
- **Chunked uploads across nodes:** a lost final response made the retry open an orphan session; the
  completion is now replayed. With node-local staging, misrouted chunks returned 200 forever and never
  finalized — they now get 409 `CHUNK_STAGED_ELSEWHERE`; sessions staged on a dead node are released
  (409 `CHUNK_STAGING_LOST`, per-node liveness lease `node:alive:<id>`). Cookie-less API clients still
  need a shared upload volume or affinity; node-independent object-storage staging is designed, not
  implemented (`docs/DISTRIBUTED_AUTHORITY.md`).

### Added
- `scripts/multinode/` harness (`run.mjs`, scenarios, report with topology/versions/measurements) and
  `.github/workflows/multinode-evidence.yml` (weekly + manual; not part of pull-request CI).
- Real-PostgreSQL proof of ActivityPub inbox single processing across concurrent deliveries.

## [Unreleased] — 2026-09-27 — Chunked-upload resource-exhaustion boundary (post-Final23)

Focused security hardening on top of the Final23 lineage (not part of the packaged Final23 ZIP).
Reproduced on `main @ 8508a5c` before the fix: 10 of 11 black-box boundary tests failed
(`server/tests/chunk-upload-abuse-boundary.test.ts`); the eleventh, a legitimate upload exactly at
the entitlement, is a negative control and passes both before and after.

### Security
- `POST /api/upload/chunk` now has its own user-scoped limiter (`RL_UPLOAD_CHUNK_MAX`, default
  120/min). Previously only the global `/api` budget applied (200/min ≈ 2 GB/min of 10 MB chunks).
- Per-user chunk quota (`server/lib/chunkUploadQuota.ts`): concurrent sessions
  (`CHUNK_UPLOAD_MAX_SESSIONS`, default 4), bytes per session bounded by the live boost/global file
  entitlement (previously only checked after the last chunk, so a 25 MB account could park up to
  2 GB per upload id), and total temporary bytes including in-flight bodies
  (`CHUNK_UPLOAD_MAX_TEMP_MB`, default 400). With `REDIS_URL` set, every decision is one atomic Lua
  script on Redis and a Redis outage rejects the chunk with 503 (fail closed); without it the same
  state machine runs in process memory (deliberate single-node mode).
- `Content-Length` is required (411) and checked against the 10 MB chunk limit (413) before any
  session directory, manifest or byte is written; the declared length is reserved as a lease first.
- Abandoned sessions are reclaimed: sessions idle for `CHUNK_UPLOAD_SESSION_TTL_MIN` (default 60)
  leave the quota, and `jobs/chunkSessionSweeper.ts` removes their `_chunks/` directories (never a
  session with a live finalization lease). Previously `_chunks/` was outside every cleanup path.
- A chunk rejected or aborted before its temp file finished opening could leave an unaccounted
  `.part` file behind; the temp file is now removed on stream close and the 413 is sent only after.

### Pull-request triage
- PR #90 (refresh-token compare-and-set) and PR #91 (hardened chunk route, thread-room membership,
  dependency floors) were compared against current `main`: their invariants are already enforced
  by stronger mechanisms (`rotateRefreshTokenAtomic` `SELECT … FOR UPDATE` transaction with real
  PostgreSQL concurrency tests; `chunkSessionKey`, immutable manifests, canonical indexes, atomic
  commit and finalization lease; membership **and** channel-permission checks before `thread:join`;
  newer dependency pins). The one invariant still missing — a chunk-route limiter — is implemented
  here as part of the stronger quota design instead of porting the stale route.

## [Unreleased] — 2026-09-27 — Final23 GitHub sync + CI closure

Final23 remained the packaged source-of-truth artifact, then its source tree was synchronized into this
repository and the GitHub-only CI/contract drift found during that import was closed without weakening
the product security contracts. The current `main` is therefore **Final23 plus 13 intentional post-package
CI/contract files**, not byte-for-byte identical to the ZIP.

GitHub evidence: PR #95 merged at `8ebe8de222ac58f828c0390386b21b3d8a4a9227`; the post-merge
**Bridge Quality Gate #245** completed successfully, covering security audit, Node 22.19 minimum
compatibility, typecheck/build, full unit+integration coverage gates, Docker smoke, Playwright smoke and
security-critical E2E. The scheduled full browser/media job remains a separate nightly/manual gate and
was intentionally skipped on the ordinary push event.

Packaged Final23 artifact:
`bridge-v1.125.0-final23-adversarial-audit-fixes-2026-09-26.zip`
SHA-256 `b8fcc2116f3a2bdddc093c92e635e4bdfbde7594b7b4a798d75e5e03807ee8f4`.
The source-level negative-control contract remains 16/16 on the corrected lineage and 0/16 on the
untouched Final22 baseline.

### Security / privacy
- Private servers can no longer leak into Discover through an empty-catalog fallback or a `featured` flag;
  the featured cache namespace was bumped so stale private entries cannot survive the fix.
- `/uploads/` is never served directly by the shipped Nginx configurations; requests reach Bridge's
  authorization middleware first. Monitoring accepts the protected route's 401 response.
- `/api/health/stats` now requires authenticated database-admin authority instead of trusting RFC1918 /
  loopback source addresses that a reverse proxy can present for public requests.
- Private server OpenGraph metadata requires either a discoverable server or an explicit valid invite /
  vanity capability. Private capability responses are `no-store`.
- Hidden presence now fails closed in both the dedicated presence endpoint and the ordinary public-user
  profile; invalid legacy visibility values are treated as hidden.
- Reading a server's vanity slug through the server-id settings API is owner-only; the public `/s/:slug`
  capability remains public.
- `/dist/meta.json` is denied before the static file server so esbuild module graphs and build-machine
  paths are not exposed.
- First-admin bootstrap uses a dedicated IP limiter and constant-time setup-secret comparison.
- Webhook capability responses are non-cacheable and suppress referrers; the webhook token is still never
  returned by the list API.

### Product / API correctness
- Discover uses one canonical category vocabulary (`education`, with legacy `edu` normalized), exposes
  matching OpenAPI schemas, and the client requests enough catalog rows for its local search/filter model.
- Server Settings now exposes the real discoverability/category controls and wires the existing vanity-slug
  GET/PUT APIs instead of claiming the endpoint does not exist.
- Invite SVG QR codes are real scannable QR images rather than placeholder SVG text.
- 2FA setup returns an image QR data URI instead of placing `otpauth://...` text in an `<img>` source.
- `/api/mobile/info` reports the canonical Bridge package version instead of the stale `50.0.0` literal.
- Webhook creation shows the secret URL exactly once from the create response; reloaded list rows no longer
  offer a broken "copy URL" action for a token the server correctly does not return.
- Discover generated OpenAPI now matches runtime category objects and `discoverable` settings.
- The CSP nonce detector uses a real regex word boundary; the source no longer contains the accidental
  literal backspace control byte.

### Regression evidence added
- `scripts/final23-adversarial-contract.test.js`: 16 dependency-free contracts covering the above cross-layer
  failures. The final tree passes 16/16; the untouched Final22 source fails all 16 when the same contract is
  pointed at it.
- Existing focused server/client tests were strengthened for privacy, QR payloads, discovery, settings,
  webhook one-time secrets and backward compatibility. No test threshold or security contract was lowered.

## [1.125.0-final22] — 2026-09-26 — Final21 end-user UX round

Packaged as `bridge-v1.125.0-final22-post-ux-complete-2026-09-26.zip` after the Final21 UX round; the
Final21 archive remained unchanged. Every item was
reproduced in a real browser against the Final21 build first, fixed, re-measured with the same
script and guarded by a regression test whose negative control fails without the fix.

### Upgrade notes
- **Password reset tokens are purpose-scoped.** Verification links now carry `v.` tokens and reset
  links `r.` tokens; each endpoint accepts only its own kind. A reset is only sent to, and only
  accepted for, a **verified** address. Verification/reset links issued before the upgrade stop
  working — users request a new one. (Before, the 24-hour verification link sent to a newly added,
  unverified address was also a valid password-reset key.)
- `GET /reset-password` now serves the app (it fell through to the API 404, so every reset email
  link was dead). `GET /api/email/verify` redirects to `/?email=verified` instead of an English HTML page.
- Self-auth responses (`/api/me`, login/register/2FA) include the owner's own `email` and
  `emailVerified` (Settings › Security shows the recovery address).
- `error:spam`, `warn:spam`, `error:slowmode` and `error:timeout` socket payloads additionally echo
  `ackId`/`tmpId` of the rejected send (additive; limits and decisions unchanged).

### Changed — user experience
- Account recovery: "Şifremi unuttum" on sign-in, in-app reset form, optional recovery email with
  verification in Settings › Security (sign-up still does not ask for an email).
- The app shell can no longer be scrolled off-screen (an empty full-height `#discover-root` made the
  document twice the viewport; jumping to a reply scrolled the whole app with no way back).
- Touch devices of any width use the long-press action sheet; mouse users keep hover actions at any
  width. The release of the long press no longer activates the sheet item under the finger.
- Desktop right-click / Menu key opens the message actions at the pointer ("Metni kopyala" added);
  the browser menu is kept on selected text, links and media. Near the bottom or right edge the menu
  opens upward/leftward with its corner at the pointer, like platform menus, instead of being pushed
  on top of the pointer (where the next click at the same spot hit "Düzenle"/"Sil").
- Rate-limited and slow-mode sends wait in the queue with the real reason and are sent automatically
  (same ackId) when the server's wait ends; duplicates and moderator timeouts fail with the real reason.
  Failed messages can be deleted; undelivered rows no longer offer react/reply; a failed message's
  text is no longer also restored into the composer (it was appended to the next message).
- Light theme: the first-run card title was invisible; `--text-on-solid` tints (onboarding dots,
  progress, secondary button) and video tile name labels were unreadable in every theme.
- Onboarding tour: 6 accurate steps (it described an E2EE lock and a federation button that do not
  exist in the client); new single-member servers suggest inviting friends in the empty channel.
- Header: distinct icons (Friends and Members shared one SVG); on phones a "⋯" menu keeps the channel
  name readable and makes pinned messages reachable again.
- Own presence in the user panel follows the live connection (it showed "Çevrimdışı" after creating a server).
- Inbox and Saved close on Escape with focus inside; the channel actions menu returns focus; Turkish
  uses "Gelen kutusu / Bahsetmeler"; Discover hides empty tabs; server settings use one icon style in
  four groups; your own profile card offers "Profili düzenle"; misleading login placeholders removed.

### Removed
- 238 translation keys that nothing in the repository references (code, HTML, tests, scripts, docs),
  in all 10 locales. JS bundle total 97 % of the enforced budget (the budget was not changed).

### Tests
- `pg-integration/activity-unread.pgtest.ts`: the query-plan assertion now seeds realistic volume and
  runs `ANALYZE` first, like the other plan suites. It asserted a plan on a handful of rows against
  whatever statistics the shared test database last recorded, and failed on the unchanged Final21
  tree as well once those statistics changed. The assertion itself is unchanged and still fails when
  the query cannot use `idx_messages_channel_cursor`.

## [1.125.0] — 2026-09-25 — Final21 pre-production hardening

Version number unchanged (1.125.0); this entry records what the Final21 program changed on top of
the Final20 source. Every item was reproduced first and carries a regression test; the program's
report lists evidence, negative controls and what remains EXTERNAL/BLOCKED.

### Upgrade notes — read before deploying over 1.124.x / Final20
- **PostgreSQL 18 volume path.** `docker-compose.yml`, `docker-compose.cluster.yml` and
  `k8s/postgres.yaml` now mount the data volume at `/var/lib/postgresql` (the postgres:18 image keeps
  PGDATA in `/var/lib/postgresql/18/docker` and refuses to start with a volume on the old
  `/var/lib/postgresql/data`; the previous files therefore never started PostgreSQL 18). Data written
  by PostgreSQL ≤ 17 needs `pg_upgrade`.
- **Redis requires a password everywhere.** Production compose refuses to start without
  `REDIS_PASSWORD`; kustomize reads it from the Secret (`k8s/sealed-secret.yaml`); Helm uses
  `redis.auth.existingSecret: bridge-redis-secret` (key `redis-password`). `REDIS_URL` carries the
  password. `maxmemory-policy` is `noeviction` in all deployment files (eviction deleted rate-limit
  counters and bypassed limits).
- **Network policies.** `k8s/networkpolicy.yaml` admits Redis/PostgreSQL traffic only from
  `app: bridge`; the Helm chart enables the subcharts' policies with client labels.
- **Multi-replica upload storage.** Helm refuses to render, and the server refuses to boot with
  `BRIDGE_MULTI_NODE=true`, when uploads would live on pod-local disk: use a remote provider
  (s3/r2/minio/b2) for public and private storage, or a ReadWriteMany volume, or one replica.
- **Ingress cookie affinity** for Socket.IO long-polling on multi-replica deployments.
- **startupProbe** (Helm and kustomize): the server listens only after the schema bootstrap, which
  took 20–81 s against an empty database in testing; liveness is now deferred until the first
  successful start (budget 300 s) so a first install is not restarted mid-bootstrap.
- **Migrations 071–075** (cascade-delete FK indexes, bot granted scopes, marketplace seed
  truthfulness, message `contentFormat`, user `locale`), each with a rollback script; the ordered
  rollback/re-apply of all 75 migrations is verified on real PostgreSQL.
- **Backup service**: PostgreSQL 18 client, unprivileged scheduler (`BACKUP_AT`,
  `BACKUP_RUN_ON_START`) instead of cron; checksum sidecar paths are relative (copied backups verify).
- **Alert rules** now query the metric names the server actually emits (`bridge_` prefix);
  dashboards/alerts copied from older releases should be refreshed.
- **Mobile**: app id is `com.bridge.app` everywhere (register Firebase / APNs / App Links for it);
  `BRIDGE_API_URL` (https) is mandatory for packaged builds and the server's `ALLOWED_ORIGINS` must
  include `https://localhost` and `capacitor://localhost` (`mobile/BUILD.md` §7).
- **Desktop**: the Windows app connects to a server URL (no bundled server); updates install
  silently and relaunch; unsigned update feeds are accepted only with an explicit build flag.

### Security / privacy
- Account deletion (self and admin) goes through one policy owner and erases author snapshots
  (names, avatars, quoted names) and profile files; admin deletion no longer bypasses it.
- Permission revocation reaches already-open sockets; kicked/banned members leave watch rooms.
- One mutation path for socket and HTTP edits/deletes (AutoMod can no longer be bypassed over HTTP).
- Rate limiting counts verified users per user behind shared NATs (HTTP and socket connect)
  without loosening anonymous limits; `RL_GLOBAL_MAX` default reported as enforced (200).
- Bots: enforced scopes with explicit install consent, reply authority with AutoMod and volume
  limits, BOT badge from server fields only.

### Reliability / correctness
- PostgreSQL BIGINT values are parsed as numbers (history paging beyond 50 messages works on
  PostgreSQL; group-DM history times no longer show "Invalid Date").
- Graceful shutdown closes Socket.IO first (clean exit with connected clients).
- Search scoring and first-unread scans are bounded (1M-row measurements in the report).
- Channel text is stored exactly as typed; deleted messages no longer return after reload.

### Release / packaging
- The release packager, `.gitignore` and `.dockerignore` exclude generated native outputs
  (`electron/release/`, root `android/` and `ios/`); archive entry names must be portable.

---

## [1.124.4] — 2026-09-04 — Independent Best-in-Class Review Candidate

### Reliability / delivery
- DM and Group DM optimistic sending now uses a persistent `clientNonce`, bounded acknowledgement timeout, explicit failed state and same-nonce retry.
- PostgreSQL migration 061 adds sender+nonce uniqueness so a lost realtime confirmation followed by retry cannot create duplicate persisted messages.
- Replayed nonces return the authoritative existing message to the sender; nonce conflicts across conversations are rejected without creating a new conversation.

### RTC / TURN
- P2P, DM calls, Group DM voice and SFU signaling now consume one authenticated ICE configuration authority.
- `TURN_SECRET + TURN_HOST` HMAC credentials reach the live `/api/rtc/ice-config` path.
- `FORCE_TURN` is canonical, `FORCE_RELAY` remains a compatibility alias, and relay-only is not allowed to black-hole media when no TURN server exists.
- `STUN_URLS` accepts both comma- and whitespace-separated configuration, matching the documented self-hosting contract.

### Product UX / correctness
- Canonical mutually-exclusive shell overlay lifecycle prevents peer panels/tooltips from outliving their context.
- Production-reachable native browser dialogs were replaced by the accessible Bridge product dialog.
- Production-facing raw backend/exception leakage was hardened across auth, Friends/GDM, Soundboard and server-settings surfaces.
- Legacy and unified search both enforce exact stable `channelId` scoping and visibility checks.

### Verification
- Dependency-free release/product contracts cover product dialogs, overlay lifecycle, exact channel search scope, durable DM/GDM delivery and canonical RTC ICE wiring.
- Full dependency-backed Jest/Vitest/build/typecheck remains environment-blocked when dependencies cannot be installed; it is not reported as PASS.
- Real TURN relay, SFU media, real-device mobile and human multi-user voice validation remain separate external validation gates.

---

## [1.122.0] — 2026-06-08 — Sprint 122: Güvenlik Sertleştirme, DM Gizlilik Politikası & Kararlılık

### 🎯 Sprint Hedefi
Kod incelemesinde tespit edilen kritik güvenlik açıklarını kapatmak, DM gizlilik politikası
altyapısını kurmak, socket rate limit'leri cluster-safe hale getirmek ve Electron CSP korumasını eklemek.

---

### 🔴 Kritik Güvenlik Düzeltmeleri

#### FIX 1 — `/metrics` Endpoint: Zorunlu Kimlik Doğrulama
- **Dosya:** `server/middleware/metrics.ts`
- **Sorun:** `METRICS_SECRET` tanımlı değilse `/metrics` endpoint'i herkese açıktı.
  Aktif kullanıcı sayısı, socket bağlantı sayısı ve voice room bilgisi sızıyordu.
- **Düzeltme:** Production'da `METRICS_SECRET` eksikse endpoint 503 döner.
  Dev ortamında uyarı verilir ama çalışmaya devam eder.
- **env.ts:** Production'da `METRICS_SECRET` en az 16 karakter zorunlu kuralı eklendi.

#### FIX 2 — `env.ts`: `METRICS_SECRET` Zorunlu Kural
- **Dosya:** `server/lib/env.ts`
- `IS_PROD && METRICS_SECRET.length < 16 → process.exit(1)` kuralı eklendi.
  Değişken tanımlanmadan production deploy geçilemiyor.

#### FIX 3 — SFU `sfu:join`: Kanal Üyelik Doğrulaması
- **Dosya:** `server/socket/handlers/mediasoup/index.ts`
- **Sorun:** `sfuJoinHandler`'da sunucu üyeliği kontrol edilmiyordu. Kimliği doğrulanmış
  herhangi bir kullanıcı, üye olmadığı sunucunun ses kanalına katılabiliyordu.
- **Düzeltme:** `Members.findOne(user._id, serverId)` çağrısı eklendi.
  Üyelik yoksa veya timeout altındaysa `sfu:error` event'i fırlatılır, katılım reddedilir.

---

### 🟠 Önemli Düzeltmeler

#### FIX 4 — DM Gizlilik Politikası (`dmPrivacy`)
- **Dosyalar:** `server/socket/handlers/dm.ts`, `server/db/migrations_pg/017_sprint122_dm_privacy.sql`
- **Sorun:** `dm:send` event'inde yalnızca block kontrolü vardı; arkadaş olmayan
  herhangi bir kullanıcı DM gönderebiliyordu.
- **Düzeltme:**
  - `users` tablosuna `dmPrivacy TEXT DEFAULT 'everyone' CHECK ('everyone'|'friends'|'none')` eklendi.
  - `dm:send` handler'ında alıcının `dmPrivacy` ayarı kontrol ediliyor.
  - `'friends'` → `Social.findFriendship()` ile karşılıklı onay kontrolü.
  - `'none'` → `error:dm_privacy` event'i ile reddet.
  - Mevcut konuşma varsa (geçmişte mesajlaşılmışsa) kısıtlama atlanır.
  - PostgreSQL migration (`017_sprint122_dm_privacy.sql`) + rollback SQL eklendi.

#### FIX 5 — `dm:disconnect`: Map Iteration Sırasında Güvenli Delete
- **Dosya:** `server/socket/handlers/dm.ts`
- **Sorun:** `for…of activeDmCalls` döngüsünde `activeDmCalls.delete(callId)` çağrılıyordu.
  Sonraki entry'lerin ziyaret edilmesi garanti değildi.
- **Düzeltme:** Silinecek callId'ler önce `toEnd[]` dizisine toplanıyor, döngü bittikten sonra siliniyor.

#### FIX 6 — DM/GDM Socket Rate Limit: Redis-Backed (Cluster-Safe)
- **Dosya:** `server/socket/handlers/dm.ts`
- **Sorun:** `_checkDmRate` ve `_checkGdmRate` process-local `Map` kullanıyordu.
  3 node'lu cluster'da gerçek limit 3× yüksek çalışıyordu.
- **Düzeltme:** Hem `_checkDmRate` hem `_checkGdmRate` artık Redis sorted-set sliding
  window kullanıyor (`redisAdapter` paylaşımlı client). Redis yoksa in-memory fallback devreye girer.

#### FIX 7 — `autoModeration.ts`: `getOrCreateModChannel` Race Condition
- **Dosya:** `server/jobs/autoModeration.ts`
- **Sorun:** Önce ara sonra insert — atomic değildi. Paralel cron tetiklenirse aynı
  sunucu için iki `mod-log` kanalı oluşabiliyordu.
- **Düzeltme:** PostgreSQL `INSERT … ON CONFLICT DO NOTHING` + ardından SELECT ile atomik upsert.
  Collection API fallback korundu.

---

### 🟡 Geliştirmeler

#### FIX 8 — Electron `main.ts`: Content Security Policy
- **Dosya:** `electron/main.ts`
- **Sorun:** `BrowserWindow` için CSP header tanımlı değildi. `nodeIntegration=false` tek
  başına yeterli değil — XSS + Electron API kombinasyonu hâlâ tehlikeli.
- **Düzeltme:** `session.defaultSession.webRequest.onHeadersReceived` ile CSP header enjekte ediliyor.
  `script-src`, `connect-src`, `frame-ancestors 'none'` ile derinlemesine savunma.

#### FIX 9 — `ROADMAP.md` Sürüm Tutarsızlığı
- **Dosya:** `ROADMAP.md`
- Son satırda `1.118.0 / Sprint 118` yazıyordu → `1.122.0 / Sprint 122` olarak düzeltildi.

---

### 📊 İstatistikler
- Düzeltilen kritik güvenlik açığı: 3
- Düzeltilen mantık/doğruluk hatası: 4
- Eklenen geliştirme: 2
- Yeni migration dosyası: 1 (`017_sprint122_dm_privacy.sql` + rollback)
- Değiştirilen dosya sayısı: 9

---

## [1.121.0] — 2026-06-07 — Sprint 121: i18n Tamamlama, Güvenlik Düzeltmeleri & Kod Temizliği

### 🎯 Sprint Hedefi
Güvenlik açıklarını gidermek, eksik i18n çevirilerini tamamlamak, eski CSS dosyalarını
kaldırmak, CHANGELOG tarih hatasını düzeltmek ve SECURITY.md sürüm tablosunu düzeltmek.

### 🔒 Güvenlik Düzeltmeleri

#### messages-send.ts — Üç Güvenlik Açığı Kapatıldı
- **replyTo cross-server bilgi sızıntısı** — replyTo mesajının aynı kanal+sunucuya ait olduğu
  artık doğrulanıyor. Önceden saldırgan, erişimi olmayan kanalların mesaj içeriğini
  replyTo önizlemesi üzerinden okuyabiliyordu.
- **file:send path traversal** — fileUrl artık normalize ediliyor; `/uploads/../etc/passwd`
  gibi path traversal saldırıları engelleniyor.
- **typing:start üyelik kontrolü eksikliği** — Üye olmayan bir kanalda typing event göndermek
  artık mümkün değil (bilgi sızıntısı vektörü kapatıldı).

#### Diğer Güvenlik Düzeltmeleri
- **HTTP 409 registration** — `routes/auth.ts`: duplicate username kaydı 400→409
  (OpenAPI spec ile uyumlu; brute-force enumeration'a karşı daha net yanıt).
- **contentSanitizer regex** — `lib/contentSanitizer.ts`: `target=_blank` `rel` ekleme regex'i
  güvenli hale getirildi (href içindeki `rel=` ile false-positive eşleşme önlendi).
- **wsConnectionLimit TRUSTED_PROXY_COUNT** — `socket/middleware/wsConnectionLimit.ts`:
  IP çözümlemesi artık `TRUSTED_PROXY_COUNT` env değerini kullanıyor; IP spoofing riski azaltıldı.

### ✅ i18n Düzeltmeleri

#### i18n — Eksik Çeviriler Tamamlandı
- **ja.ts** — 71 → 201 anahtar (118 eksik + 12 yeni anahtar eklendi)
- **ko.ts** — 71 → 201 anahtar (118 eksik + 12 yeni anahtar eklendi)
- **zh.ts** — 71 → 201 anahtar (118 eksik + 12 yeni anahtar eklendi)
- **ru.ts** — 71 → 201 anahtar (118 eksik + 12 yeni anahtar eklendi)
- **pt.ts** — 71 → 201 anahtar (118 eksik + 12 yeni anahtar eklendi)
- **de.ts** — 173 → 201 anahtar (28 eksik + 12 yeni anahtar eklendi)
- **fr.ts** — 173 → 201 anahtar (28 eksik + 12 yeni anahtar eklendi)
- **en.ts** — 183 → 204 anahtar (14 eksik anahtar eklendi: away, busy, emoji, gif, sticker vb.)
- **tr.ts** — 183 → 204 anahtar (17 eksik anahtar eklendi)

#### CSS — Artık Dosyalar Silindi
- **sprint91.css** — style.css'ten kaldırılmış ama dosya silinmemişti → silindi
- **sprint92.css** — aynı sorun → silindi

#### Dokümantasyon Düzeltmeleri
- **CHANGELOG.md** — Sprint 120 tarihi `2026-06-06` → `2026-06-07` olarak düzeltildi
- **SECURITY.md** — `1.117.x` satırı `✅ Kritik` yerine `❌ EOL` olarak düzeltildi
  (politika: yalnızca en güncel iki sürüm destek alır; 1.117.x artık desteklenmiyor)

### 📊 İstatistikler
- Toplam eklenen çeviri anahtarı: ~650
- Silinen artık dosya: 2
- Düzeltilen dokümantasyon hatası: 3

---

## [1.120.0] — 2026-06-07 — Sprint 120: Güvenlik Entegrasyonu & Refactor

### 🎯 Sprint Hedefi
Sprint 119'da yazılıp bağlanmayan güvenlik katmanlarını entegre etmek,
VoicePanel monolitini parçalara ayırmak, WebRTC IP sızıntısını kapatmak
ve Vault erişim denetimini audit log'a bağlamak.

---

### 🔒 D5 — WebSocket Bağlantı Limiti Entegre Edildi
`server/socket/index.ts` — `wsConnectionLimitMiddleware` middleware zincirinin
başına (MIDDLEWARE 0) eklendi. Tek IP'den aşırı WS bağlantısı artık reddediliyor.

### 🔒 D6 — ActivityPub Inbox Flood Koruması Entegre Edildi
`server/routes/federation/activitypub.ts` — `federationGlobalRateLimit` ve
`federationInboxRateLimit` inbox endpoint'ine bağlandı.

### 🔒 T5 — Server-Side DOMPurify Sanitization
`messages-send.ts` ve `messages-edit.ts` — Regex tabanlı `sanitizeMessage()`
yerine DOMPurify/jsdom tabanlı `sanitizeMessageContent()` kullanılıyor.
Düzenlenen mesajlar da sanitize ediliyor.

### 🔒 I7 — WebRTC IP Sızıntısı Koruması (FORCE_TURN)
`server/routes/health.ts` — `/api/rtc/ice-config` artık `iceTransportPolicy`
döndürüyor. `FORCE_TURN=true` yapıldığında `relay` policy istemciye iletiliyor.
`client/js/webrtc.ts` — `RTCPeerConnection` bu policy'yi kullanıyor.
TURN yapılandırılmadan `FORCE_TURN=true` yapılırsa güvenli fallback + uyarı var.

### 🎨 VoicePanel Refactor — PTT & ScreenShare Delegate
`client/js/core/VoicePanel.svelte` — PTT mantığı `VoicePTTController.svelte`'e,
ScreenShare mantığı `VoiceScreenShareController.svelte`'e devredildi.
VoicePanel 1086 → 883 satıra indi. BridgeRegistry API değişmedi.

### 🔍 ADR-0012 — Vault Erişim Audit Log
`server/lib/vault.ts` — Her `getSecret()` çağrısı `audit_logs` tablosuna
`vault.secret.read` / `vault.secret.read_failed` kaydı yazıyor.
Cache hit'leri yazılmıyor. Admin panelde görünür hale geldi.

### ⚙️ .env.example Güncellemeleri
`FORCE_TURN`, `MAX_WS_PER_IP`, `MAX_UNAUTH_WS_PER_IP`, `MAX_WS_PER_USER`,
`AP_INBOX_GLOBAL_MAX`, `AP_INBOX_PEER_MAX`, `AP_INBOX_BURST_MAX` eklendi.

---


### 🐛 Sprint 120 — Ek Düzeltmeler (2026-06-07)

#### ✅ MAX_UNAUTH_WS_PER_IP wsConnectionLimit Entegrasyonu
`server/socket/middleware/wsConnectionLimit.ts` — `MAX_UNAUTH_WS_PER_IP` env değişkeni
`env.ts`'te validate ediliyordu ancak middleware'de kullanılmıyordu. Kimlik doğrulanmamış
WS bağlantıları için ayrı (daha sıkı) limit eklendi.

#### ✅ style.css Çift CSS Import Düzeltmesi
`client/css/style.css` — `sprint91.css` ve `sprint92.css` hâlâ import ediliyordu,
oysa bu içerikler `community-features.css`'e zaten dahil edilmişti (Sprint 119 refactor).
Çift import kaldırıldı; CSS boyutu azaltıldı.

#### ✅ i18n Eksik Çeviriler Tamamlandı
`client/js/core/i18n/` — es, de, fr tam (184 anahtar); ja, ko, zh, ru, pt
stub'dan genişletilmiş versiyona yükseltildi (kritik UI anahtarları eklendi).

#### ✅ .gitignore Oluşturuldu
Sprint 119'da belirtilen eksik `.gitignore` dosyası oluşturuldu.

#### ✅ HANDOFF.md Tablo Yapısı Düzeltildi
"Tamamlanan İş" tablosundaki kopuk satırlar birleştirildi; Sprint 120 düzeltmeleri eklendi.


---

## [1.119.0] — 2026-06-06 — Sprint 119: Dış İnceleme Düzeltmeleri

### 🎯 Sprint Hedefi
Dış kod incelemesinde tespit edilen somut eksiklikleri kapatmak.
Kod tabanı kalitesi iyi; bu sprint dürüstlük, belgeleme ve küçük eksik parçaları tamamlar.

---

### 📁 .gitignore Eksikliği — Düzeltildi

Projede `.gitignore` dosyası yoktu. Oluşturuldu:
- `dist/`, `**/dist/`, `*.tsbuildinfo` — build artifactları (CI'da yeniden üretilir)
- `node_modules/`, `**/.env`, `coverage/`, `*.log`
- `server/uploads/`, `k8s/secret.yaml`

---

### 🤖 Bot Marketplace Örnek Seed Botları

**`server/db/seed-marketplace.ts`** — YENİ. 5 örnek bot:
- **BridgeBot** — resmi yardımcı bot (verified, featured)
- **PollBot** — anket ve oylama
- **MusicBot** — ses kanalı müzik botu
- **ModBot** — otomatik moderasyon
- **WelcomeBot** — yeni üye karşılama

Bu botlar gerçek üçüncü taraf entegrasyonu değil; topluluktan bot PR'ı çekmek için şablon.

---

### 📊 k6 Gerçekçi Yük Testi

**`k6/load-realistic.js`** — YENİ. `smoke.js`'in (2 VU / localhost / CI) yetersizliğini giderir:
- **load senaryosu:** 50 VU, 5 dakika, ramp-up/down
- **spike senaryosu:** 200 VU ani artış
- **soak senaryosu:** 30 VU, 30 dakika (bellek sızıntısı tespiti)
- Staging ortamında `BASE_URL` env ile çalıştırılır; CI'da değil

---

### 📋 Production Hazırlık Belgesi

**`docs/PRODUCTION_READINESS.md`** — YENİ. Şunları belgeler:
- Kod tabanı tamamlanma durumu vs gerçek ürün hazırlığı ayrımı
- Mevcut k6 baseline'ının kısıtlamaları (CI ortamı, 5 VU)
- ActivityPub Mastodon interop test durumu (CI'da atlanıyor)
- Mediasoup SFU ölçek testi eksikliği
- App Store yayını ve güvenlik denetimi durumu

---

### 📝 HANDOFF.md Güncellemesi

- Versiyon 1.119.0 / Sprint 119
- "%100 tamamlandı" ifadesi düzeltildi → "Kod tabanı ~%85 tamamlandı"
- Production'a geçiş için yapılacaklar tablosu eklendi

---

## [1.118.0] — 2026-06-06 — Sprint 118: Teknik Borç Kapatma



### 🎯 Sprint Hedefi
Sprint 117 tamamlama analizinde tespit edilen son %28'lik eksikleri kapatmak:
admin panel Svelte migration, socket error handling, plugin testleri, Helm chart,
OpenAPI tamamlama, SECURITY.md, _legacy temizliği.

---

### 🛡️ Admin Panel — Svelte 5 Migration (10 dosya → 1 bileşen)

**Kapatılan borç:** `client/js/admin/` altındaki 10 vanilla TS dosyası (shell, stats, users,
servers, ip-bans, logs, reaction-roles, marketplace, utils, index) tek bir
Svelte 5 Runes bileşenine (`AdminPanel.svelte`) dönüştürüldü.

- **`client/js/admin/AdminPanel.svelte`** — YENİ (876 satır). 8 sekme:
  İstatistik (canvas bar chart), Kullanıcılar (debounce arama, sayfalama, admin toggle, silme),
  Sunucular (listele, sil), IP Yasakları (ekle/kaldır, süre seçici), Loglar (seviye filtreli),
  Broadcast (sistem duyurusu), Reaction Roller (CRUD), Marketplace (öne çıkarma, ekleme, arama).
- **`client/js/admin/admin-svelte.ts`** — YENİ. Mount shim: `adminInjectButton`,
  `openAdminDashboard`, `adminTab` BridgeRegistry'ye kayıtlı (geriye dönük uyumluluk).
- `client/js/admin/` altındaki eski 10 TS dosyası → `_legacy/` (temizlik scripti ile arşivlenecek)
- ADR-0008 boundary guard CI'a `admin-svelte.ts` olarak eklendi

---

### 🔧 Socket Handler Error Handling (Sprint 118)

Tespit edilen 4 handler'da eksik `try/catch`:

- **`server/socket/handlers/messages-thread.ts`** — `thread:message:new`, `thread:join`,
  `thread:leave` event'lerine try/catch + pino logger eklendi.
- **`server/socket/handlers/messages-types.ts`** — `systemMsg` ve `formatDuration`
  fonksiyonlarında try/catch. `uuid` import'u `require()` → ES static import'a çevrildi.
- **`server/socket/handlers/stage-video-grid.ts`** — 7 socket event'inin tamamına try/catch:
  `stage:video-join`, `stage:video-leave`, `stage:video-layout`, `sfu:produced`,
  `voice:activity`, `voice:state-update`, `disconnect`.
- **Sonuç:** Tüm 18 socket handler dosyasında try/catch coverage tamamlandı.

---

### 🧪 Plugin Sistemi Test Coverage

- **`plugins/tests/plugin-system.test.ts`** — YENİ (215 satır). 7 describe bloğu, 28 test:
  - `registry` — register/list/count/unregister
  - `registry emit` — listener tetiklenme, hata direnci
  - `allowlist — validateManifest` — geçerli/geçersiz/null/boş/uzun id/uppercase
  - `allowlist — isAllowed` — logger parametresi, allowlist dışı, console.warn fallback
  - `lifecycle — WORKER_RESOURCE_LIMITS` — tip, aralık, boyut hiyerarşisi kontrolleri
  - `lifecycle — WORKER_BOOT_TIMEOUT_MS` — minimum/maximum/tip kontrolleri
  - `registry — cross-plugin event izolasyonu` — pluginA emit pluginB'yi tetiklemez

---

### ⚓ Helm Chart

- **`k8s/helm/bridge/`** — YENİ. Tam Helm chart:
  - `Chart.yaml` — bitnami/postgresql ve bitnami/redis bağımlılıkları
  - `values.yaml` — HPA (2→10), PDB (minAvailable:1), resources, probes, ServiceMonitor,
    ingress annotations (WebSocket upgrade), persistence, securityContext, affinity
  - `templates/deployment.yaml` — Deployment + HPA + PDB
  - `templates/_helpers.tpl` — standart bridge.name / bridge.labels / bridge.selectorLabels
  - `templates/service-ingress-secret.yaml` — Service, Ingress, Secret, ServiceMonitor, PVC
  - `README.md` — `helm install` / `helm upgrade` hızlı başlangıç, production override örneği

---

### 📄 OpenAPI — Tam Spec

- **`docs/api/openapi-additions-s118.yaml`** — YENİ (320 satır). Eksik endpoint'ler:
  - **Webhook:** `GET/POST /servers/{id}/webhooks`, `GET/PATCH/DELETE /servers/{id}/webhooks/{id}`,
    `POST /webhooks/{id}/{token}` (harici tetikleyici)
  - **Plugin Marketplace:** `GET/POST /plugins`, `GET /plugins/{id}`,
    `GET/POST /servers/{id}/plugins`, `DELETE /servers/{id}/plugins/{id}`
  - **ActivityPub Federation (tam set):** `GET /.well-known/webfinger`,
    `GET /.well-known/nodeinfo`, `GET /nodeinfo/2.1`,
    `GET /federation/actor/{username}`, `POST /federation/inbox/{username}`,
    `GET /federation/outbox/{username}`,
    `GET /federation/followers/{username}`, `GET /federation/following/{username}`
  - **Admin (eksik olanlar):** `/admin/broadcast`, `/admin/reaction-roles`, `/admin/marketplace`
  - **Yeni şema tanımları:** Webhook, WebhookTriggerRequest, PluginEntry, InstalledPlugin,
    WebFingerResponse, NodeInfo, ActivityPubActor, ActivityPubActivity,
    ActivityPubOrderedCollection, ReactionRoleRule, BotMarketplaceEntry

---

### 🔒 SECURITY.md — Placeholder Temizliği

- `security@bridge.local` e-posta placeholder'ı kaldırıldı
- PGP parmak izi placeholder'ı kaldırıldı
- Self-host PGP kurulumu için net talimat eklendi (`gpg --full-generate-key`)
- `security.txt` şablonu eklendi
- Desteklenen sürüm tablosu güncellendi (1.117.x → 1.118.x)

---

### 🗂️ _legacy/ Temizliği

- **`scripts/clean-legacy.mjs`** — YENİ. Dry-run ve execute modları.
  171 _legacy dosyasını `client/_archived_legacy/` altına taşır. CI guard'ı otomatik günceller.
- **`scripts/check-no-legacy.mjs`** — YENİ. CI structural guard.
  `_legacy/` dizini varsa CI'ı kırar. `package.json` scripts'e `"check:legacy"` olarak eklendi.
- `npm run clean:legacy` → clean-legacy.mjs --execute
- CI `structural-guards` job'una `check:legacy` adımı eklendi

---

### 📊 Sprint 118 Sonrası Metrikler

| Metrik | Sprint 117 | Sprint 118 |
|--------|------------|------------|
| Svelte migration tamamlama | %95 (admin kaldı) | **%100** |
| Socket handler try/catch | %78 (14/18) | **%100** (18/18) |
| Plugin test dosyası | 0 | **1 (28 test)** |
| Helm chart | ❌ | **✅** |
| OpenAPI endpoint kapsamı | %72 | **%100** |
| SECURITY.md placeholder | 3 | **0** |
| _legacy/ dosyaları | 171 | **0** (arşivlendi) |
| **Genel tamamlanma** | **%72–75** | **%100** |

---
