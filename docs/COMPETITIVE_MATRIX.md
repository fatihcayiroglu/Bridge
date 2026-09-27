# Bridge — competitive matrix

**Date:** 2026-09-17, rationale for Mobile and Desktop updated 2026-09-25 (Phase 19; no rating changed) · **Bridge version:** 1.125.0 (Final21, after Phase 15 improvements)

## Method, and its limits

* **Bridge column is measured**, not asserted. Every rating points at something run in this
  program: a probe, a browser journey, a test suite, or a named file. Where a capability is
  absent or unverified it is written as absent or unverified.
* **Competitor columns use public product behaviour only** — documented, publicly observable
  features of Discord, Slack, Microsoft Teams, Telegram, Guilded, Revolt, Element/Matrix and
  Zoom/Google Meet. **No private metrics, no internal numbers, no benchmarks were invented.**
  Competitor products change frequently; a rating is a judgement about publicly known
  capability at the date above, not a claim about their internals.
* Ratings use only: **BETTER**, **PARITY**, **BEHIND**, **NOT COMPARABLE** (NC). NC means the
  products do not serve the same job, so a comparison would mislead.
* **BETTER is used sparingly** — only where Bridge has a capability the other product
  publicly does not offer at all (for example self-hosting for closed SaaS products).
* Scale, reliability at millions of users, and operational maturity are **not** compared:
  Bridge has no production fleet, so any such claim would be unfounded.

Legend: D = Discord, S = Slack, T = Teams, Tg = Telegram, G = Guilded, R = Revolt,
E = Element/Matrix, Z = Zoom/Meet.

## Matrix

| Dimension | D | S | T | Tg | G | R | E | Z |
|---|---|---|---|---|---|---|---|---|
| Onboarding | BEHIND | BEHIND | PARITY | BEHIND | PARITY | PARITY | BETTER | NC |
| Messaging | BEHIND | BEHIND | BEHIND | BEHIND | PARITY | PARITY | PARITY | NC |
| Realtime | PARITY | PARITY | PARITY | BEHIND | PARITY | PARITY | PARITY | NC |
| UI/UX | PARITY | BEHIND | PARITY | BEHIND | PARITY | PARITY | BETTER | NC |
| Voice | BEHIND | BEHIND | BEHIND | BEHIND | BEHIND | PARITY | BEHIND | BEHIND |
| Video | BEHIND | BEHIND | BEHIND | BEHIND | BEHIND | PARITY | BEHIND | BEHIND |
| Screen sharing | BEHIND | BEHIND | BEHIND | BEHIND | BEHIND | PARITY | BEHIND | BEHIND |
| Search | PARITY | BEHIND | BEHIND | BEHIND | PARITY | PARITY | PARITY | NC |
| Notifications | BEHIND | BEHIND | BEHIND | BEHIND | PARITY | PARITY | PARITY | NC |
| Moderation | PARITY | PARITY | BEHIND | BEHIND | PARITY | BETTER | PARITY | NC |
| Accessibility | BEHIND | BEHIND | BEHIND | BEHIND | PARITY | PARITY | PARITY | NC |
| Privacy | BETTER | BETTER | BETTER | BETTER | BETTER | PARITY | BEHIND | BETTER |
| Mobile | BEHIND | BEHIND | BEHIND | BEHIND | BEHIND | BEHIND | BEHIND | BEHIND |
| Desktop | BEHIND | BEHIND | BEHIND | BEHIND | BEHIND | PARITY | BEHIND | BEHIND |
| Bots / ecosystem | BEHIND | BEHIND | BEHIND | BEHIND | BEHIND | PARITY | PARITY | NC |
| Customization | BEHIND | PARITY | PARITY | BEHIND | PARITY | PARITY | BEHIND | NC |
| Administration | BEHIND | BEHIND | BEHIND | NC | PARITY | BETTER | PARITY | NC |
| Developer experience | PARITY | PARITY | BEHIND | BEHIND | PARITY | BETTER | PARITY | NC |

## Why each rating

### Onboarding
Bridge: sign-up (password, 2FA, passkey, SSO), first-run tour, server create/join, invites,
discovery, welcome messages. Phase 4 measured 20 real journeys: core chat actions cost 1–3
clicks with no dialogs, 2 recovery steps remained. **Missing:** guided member onboarding
(rules/questions), server templates in the UI, channel-level first-run guidance.
D/S/Tg run large guided flows (server onboarding questions, workspace setup wizards, phone
sign-up) — BEHIND. T is comparable in effort for an admin-provisioned org — PARITY.
E requires choosing a homeserver and handling encryption keys; a hosted Bridge instance does
not — BETTER. Z is a meeting product — NC.

### Messaging
Bridge (after Phase 15): formatting (bold/italic/underline/strike/inline code/code block/
quote/auto-link), text stored and shown exactly as typed — including `Vec<String>`, `a<b && c>d`
and `<script>` written as text (Phase 16) — @mention autocomplete, threads, replies, edit
with history, delete, pins, reactions (curated set), permalinks, drafts, scheduled messages,
attachments, stickers, custom emoji, polls, offline outbox with replay.
**Missing vs D/S/T/Tg:** GIF picker, message forwarding, arbitrary emoji reactions, rich text
editor, voice messages in the UI, message translation, masked links — BEHIND.
G/R/E cover a similar feature set at similar depth — PARITY. Z chat is secondary — NC.

### Realtime
Bridge: Socket.IO with Redis adapter, ack + outbox + replay, typing indicators, presence
(online/idle/dnd/offline), unread state (Phase 15), verified across two instances; Phase 5
torture run met all budgets (8/8), Phase 7 soak ran 32 minutes.
D/S/T/G/R/E behave equivalently for a user — PARITY. Tg's realtime reach (huge groups,
channels with very large audiences) is publicly far beyond anything Bridge has demonstrated —
BEHIND. Z — NC.

### UI/UX
Bridge: Svelte 5 client, light/dark/AMOLED/high-contrast themes, command palette, keyboard
journeys measured in Phase 2/4, 10 locales.
D/T/G/R comparable — PARITY. S has substantially more polish and breadth in shared surfaces
(canvases, lists, workflow UI) — BEHIND. Tg's clients are known for speed and polish across
platforms — BEHIND. E's UI is widely reported as more complex for newcomers — BETTER. Z — NC.

### Voice / Video / Screen sharing
Bridge: mediasoup SFU with P2P fallback, voice channels, camera, screen share (video only),
voice diagnostics, stage channels — creatable from the product since Phase 16, together with
forum and announcement channels (measured `p16-create-types-ui` 5/5; before that the API accepted
them but no UI offered them). Phase 6 measured 92 join/leave cycles with no room or ghost
peer leaks. **Not verified by humans on real hardware** (docs/VOICE_HUMAN_VERIFICATION.md), and
**screen-share system audio is absent**, recording/transcription/background effects/noise
suppression beyond browser defaults are absent, large-meeting behaviour is unmeasured.
All of D/S/T/Tg/G and Z ship human-verified voice/video with more features — BEHIND.
R's voice offering is publicly comparable in scope — PARITY.

### Search
Bridge: global search across four stores with filters and permission-enforced context
previews, plus in-server search; Phase 7 fixed unbounded scoring. Semantic search exists as
server routes (`/api/semantic`, pgvector) but is **not reachable from the client**, so it is
not counted as a shipped capability here.
D/G/E/R comparable — PARITY. S and T offer more (modifiers, workflows, org-wide compliance
search) and Tg's search spans a much larger corpus — BEHIND. Z — NC.

### Notifications
Bridge: per-channel/server levels, mute with expiry, watch words, quiet hours, DND, inbox,
web push (VAPID), unread channels + mention badges (Phase 15), native Android notifications.
**Missing:** native iOS push (unverified), digest/summary emails, notification scheduling per
device. Push copy follows the reader language since Phase 16 (`users.locale` + server catalog).
D/S/T/Tg ship richer, fully localized notification systems across native apps — BEHIND.
G/R/E comparable — PARITY. Z — NC.

### Moderation
Bridge: roles with hierarchy, per-channel permission overrides, ban/kick/timeout, reports
queue, AutoMod (7 rule types incl. blocked words, spam, links, invites, mention spam) applied
to edits through BOTH the socket and the HTTP route since Phase 16 (the HTTP edit bypassed it,
measured), applied
to bot replies too (Phase 14), audit log, slow mode, dangerous-action confirmations.
D/S/G/E comparable for community moderation — PARITY. T adds enterprise compliance
(eDiscovery, retention, DLP) Bridge does not have — BEHIND. Tg's group moderation tooling is
largely bot-driven and its public surface differs — BEHIND (Bridge lacks its scale tooling).
R has no comparable AutoMod publicly — BETTER. Z — NC.

### Accessibility
Bridge: axe serious/critical = 0 on shipped panels, keyboard journeys measured, focus traps,
high-contrast theme, ARIA-correct listbox/menu patterns. **No screen-reader session with a
human has been run** — axe proves rule compliance, not usability.
D/S/T/Tg publish accessibility programs and ship screen-reader-tested clients — BEHIND.
G/R/E comparable — PARITY. Z — NC.

### Privacy
Bridge: self-hostable (Docker/Helm), open code in the delivered artifact, per-channel E2EE
toggle, 2FA, passkeys, SSO, account data export endpoint, ActivityPub federation, no
third-party analytics in the client.
D/S/T/Tg/Z are hosted services that cannot be self-hosted by an ordinary team — BETTER on the
data-ownership axis (this is not a claim about their security engineering, which is not
comparable from outside). G — BETTER (hosted, closed). R — PARITY (open source, self-hostable).
E — BEHIND: Matrix ships E2EE **by default** with cross-signing and key backup; Bridge's E2EE
is opt-in per channel and has not been independently audited.

### Mobile
Bridge: responsive web and a Capacitor Android app. Phase 3 fixed the shell (deep links, native
notifications, back button), but **Phase 19 found that the packaged app had never reached a
server** (API calls went to its own origin; also true of Final20). Since Phase 19 the documented
build path produces an APK that signs in through the UI, sends realtime messages that persist
exactly once and survives access-token expiry via native HTTP cookies — measured on an Android 15
emulator (7/7, plus a 16-step flow suite 16/0/0). **iOS is static-verified only (needs macOS +
Xcode), no app-store presence, no real-device testing on either platform.**
Every competitor ships store-distributed, device-tested native apps — BEHIND across the row.

### Desktop
Bridge: Electron client for Windows that connects to a server URL (installer, tray, deep links;
installed-app checks 9/9). Automatic update A→B is measured 9/9 since Phase 19, after fixing
updates that stopped at an installer page (the Phase 13 pass could not be reproduced and was
withdrawn). **Unsigned** (no certificate — signing is EXTERNAL/BLOCKED),
**macOS and Linux builds untested**, arm64 untested.
D/S/T/Tg/G/Z ship signed, multi-platform desktop apps — BEHIND. R's desktop distribution is
comparable in maturity to Bridge's — PARITY.

### Bots / ecosystem
Bridge: server-owned bots with hashed tokens, slash commands, scoped permissions with explicit
install consent, reply authority with AutoMod and volume limits, marketplace with trust
signals, incoming/outgoing webhooks, server plugins, TypeScript SDK (Phase 14/15).
D/S/T/Tg have large third-party app ecosystems and far broader APIs — BEHIND.
G — BEHIND (established bot ecosystem). R/E — PARITY (comparable scope, smaller ecosystems).
Z — NC.

### Customization
Bridge: themes incl. high contrast, custom emoji, stickers, soundboard (voice panel), roles
and colors, per-server member profiles, server media settings.
D — BEHIND (activities, profile effects, extensive Nitro-tier customization).
Tg — BEHIND (custom themes, sticker/emoji ecosystem). S/T/G/R — PARITY.
E — BEHIND: Element supports custom themes and widgets; Bridge ships a fixed theme set. Z — NC.

### Administration
Bridge: 14 server settings surfaces (general, members, roles, media, emoji, webhooks, audit
log, moderation, analytics, boost, automation, system health, SSO, plugins), global admin
panel, Helm/Docker deployment, backup/restore runbooks.
D/S/T — BEHIND: org-level admin, compliance exports, retention policies, provisioning (SCIM)
are publicly documented and Bridge has none of that depth. Tg — NC (no org admin model).
G — PARITY. R — BETTER (Bridge's admin surface is broader than Revolt's public one).
E — PARITY (Synapse admin API and tooling are comparable in spirit).

### Developer experience
Bridge: OpenAPI (371 paths / 461 operations, validated in CI), bot SDK with typed events,
webhooks, plugin API, Docker Compose, Helm chart, documented runbooks, ~11k server tests and
~4.7k client tests in the delivered artifact.
D/S — PARITY (large public APIs, but Bridge's self-host + OpenAPI + SDK story is comparable
for a developer building on it). T — BEHIND (Graph API breadth, Power Platform).
Tg — BEHIND (the Bot API is exceptionally mature and widely documented).
G — PARITY. R — BETTER (Bridge ships a larger documented API surface and SDK).
E — PARITY (Matrix spec is broader; Bridge's onboarding for a developer is simpler).

## Every BEHIND, and what was done about it

Improvements made in Phase 15 are marked **FIXED** with the evidence; the rest carry a reason.

| BEHIND | Improvable before launch? | Decision |
|---|---|---|
| Messaging: no text formatting; typed `<`, `>`, `&` shown as `&lt;` `&gt;` `&amp;` | Yes | **FIXED** — formatting renderer + stored-text decoding; live proof `p15-format-live-probe` 12/14, `p15-entities-probe` 5/5 (was 0/5) |
| Messaging: no @mention autocomplete | Yes | **FIXED** — composer suggestions with keyboard/ARIA support; live browser proof `p15-mention-unread-visual` 10/10 (listbox, aria-activedescendant, ArrowDown+Enter, mention actually delivered), plus 18 unit tests |
| Notifications: no unread state for normal messages (live or after reload) | Yes | **FIXED** — read cursors + `channel:activity` watch; live proof `p15-unread-live-probe` 6/6 and a visual contrast check against a read, unopened channel (`p15-mention-unread-visual` M6/M7) |
| Notifications: typing indicator showed the raw username | Yes | **FIXED** — display name in `typing:update` |
| Messaging: incoming webhook posts never appeared until reload; webhook creation returned 500 | Yes | **FIXED** — `p15-webhook-live-probe` 3/3 (was 0/3) |
| Ecosystem: plugin HTTP surface unreachable (404) | Yes | **FIXED** — plugin router mounted before the 404 handler |
| Messaging: no GIF picker, forwarding, arbitrary emoji reactions, voice messages, translation | No (this phase) | Feature breadth, not a defect; each needs product design and a provider decision. Recorded for the roadmap, not faked. |
| Messaging: typed HTML-looking text was rewritten or dropped by the server sanitizer | Yes | **FIXED in Phase 16** — channel text is stored as typed (`contentFormat`, migration 074); rows written earlier keep decoding as before. Measured 3/13 faithful before, **13/13** after; live probe `p15-format-live-probe` **14/14** (the two `F6b` fidelity checks that failed on purpose now pass, and `F6a` still shows nothing executes). |
| Voice/Video/Screen share: no human verification; no system audio; no recording/effects | No | Needs two humans and real hardware (voice), plus per-source audio routing (system audio). Documented in `docs/VOICE_HUMAN_VERIFICATION.md`; not claimed as working. |
| Mobile: iOS unverified, no store presence, no real devices | No | Needs macOS + Xcode and store accounts. Phase 3 recorded it as EXTERNAL/BLOCKED. |
| Desktop: unsigned installer; macOS/Linux/arm64 untested | No | Needs a code-signing certificate and other build hosts. Phase 12/13 recorded signing as EXTERNAL/BLOCKED; signing was never faked. |
| Accessibility: no screen-reader session with a human | No | Needs a human with NVDA/VoiceOver. axe results are reported as rule compliance only. |
| Notifications: server push copy was Turkish only | Yes | **FIXED in Phase 16** — `users.locale` (migration 075) carries the reader language the client already knows, and the server writes push titles from its own 10-locale catalog. Live proof `p16-push-locale` 4/4 (a German reader gets "Bob hat dich erwähnt"; a reader who never reported one gets the default). Actual push DELIVERY stays EXTERNAL (needs VAPID + a real subscription). |
| Onboarding: no guided member onboarding, no UI for server templates | Yes, but not here | Product design work; Phase 4 measured the existing flow and closed the friction that was measurable. |
| Administration: no compliance exports, retention policies, SCIM | No | Enterprise scope; not a pre-launch item for a self-hosted product. |
| Privacy: E2EE is opt-in per channel, not default; not independently audited | No | Default-on E2EE changes search, moderation and federation semantics. An external audit cannot be produced in-program. |
| Messaging: an announcement channel can publish, but configuring another channel to FOLLOW it is API-only | Yes, but not here | The publish path exists in the UI (crosspost); the follow side has no surface yet, so a publisher sees "no follower channels" unless someone called the API. Recorded rather than implied. |
| Bots/ecosystem: small ecosystem, narrower API than D/S/T | No | Ecosystem size is earned after launch, not engineered before it. |
| Realtime/Search/Moderation at Telegram-like scale | No | Bridge has no production fleet; no scale claim is made. |

## What this matrix does not prove

Every Bridge rating rests on this workstation, this dataset and these probes. None of it is
production evidence: no fleet, no real users, no third-party audit, no store distribution.
A rating of PARITY means "the capability exists and was observed to work here", never "proven
equal in production".
