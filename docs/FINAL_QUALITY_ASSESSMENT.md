# Bridge — Final Quality Assessment (8.0 → 9.0 pass)

Measured, not estimated. Every number below comes from a command run against a
real PostgreSQL + Redis environment with two Bridge instances; the command is
named so it can be re-run.

---

## 1. Measured boundary

| Gate | Result | Command |
|---|---|---|
| Server unit/integration | **3425 passed**, 16 skipped, 216 suites, 0 failed | `cd server && npx jest` |
| Server typecheck | clean | `npx tsc --noEmit` |
| Server lint | **0 errors**, 18 warnings | `npx eslint .` |
| Client unit | **2068 passed**, 129 files, 0 failed | `cd client && npx vitest run --config vitest.config.mts` |
| Client typecheck | **0 errors, 0 warnings** (324 files) | `npx svelte-check --threshold error` |
| Client lint | **0 errors**, 92 warnings | `npx eslint .` |
| Browser E2E | **271 passed**, 0 failed | `cd e2e && npx playwright test` |
| E2E determinism | **5/5 consecutive clean runs** | repeat the above |
| Accessibility | **10 passed, 0 skipped** — serious = 0, critical = 0 | `npx playwright test --project=a11y` |
| Two-instance distributed | **6/6 PASS** | `node e2e/multi-instance-check.mjs` |
| Search context (live server) | **12/12 PASS** | `node e2e/context-probe.mjs` |

Production build succeeds: 896.3 KB JS, 27 files.
Production dependency audit: **0 vulnerabilities** (`npm audit --audit-level=high --omit=dev`).

---

## 2. What this pass actually fixed

Ordered by how much damage each defect was doing in normal use.

### 2.1 The first event a client sends was silently discarded

`socket.emit('userAuthenticated')` — the signal the client treats as "I can act
now" — was emitted **before the feature handlers were registered**, with two
`await`s (a DB write and membership setup) in between. Socket.IO drops an event
with no listener silently: no error, no log, no client feedback.

Every socket's **first outgoing event was lost**. It presented as a
multi-instance problem (`dm:call:start` produced nothing at all — not even
`dm:call:outgoing` back to the caller) but it is equally true on a single
instance: a reconnecting client's first action — a queued message, rejoining a
voice channel, accepting an incoming call — vanished.

Two ordering defects, one class:

- the personal `user:<id>` room was joined *after* the ready signal → the socket
  could not **receive**;
- handlers were registered *after* the ready signal → the socket could not
  **send**.

Fixed by making the signal truthful: join the room, register every handler,
*then* announce readiness. Locked by `server/tests/socket-ready-ordering.test.ts`.

### 2.2 Cross-instance delivery used a process-local map

`socket/handlers/dm.ts` fanned out DM messages and every call signal by scanning
`socketUsers` — a **per-process** `Map`. A user connected to instance A is simply
not in instance B's map, so B's events never arrived. `inbox:changed` already
used the room and worked, which produced a deceptive half-delivery: the badge
updated, the message never came.

Replaced with `io.to('user:<id>')`, which the Redis adapter carries between
instances. `findSocketsForUser` was **removed**, not just bypassed — leaving the
helper in place is how this returns.

Measured before: R-1 FAIL. After: **6/6 PASS**, five consecutive runs.

### 2.3 Two browser tabs broke each other's CSRF

CSRF tokens were stored one-per-user at `security:csrf:<userId>`; every issuance
**overwrote** the previous one. Tab A gets a token, tab B loads and gets its own,
and tab A's next mutation is rejected. The client refetches on a CSRF 403 — which
invalidates tab B in turn, so the two tabs ping-pong 403s indefinitely, each
mutation costing an extra round trip.

Measured: three `POST /api/servers` calls returned `CSRF token invalid or
expired` in a full Playwright run; the same tests passed in isolation, because
isolation means no concurrent second token request.

Fixed with per-token keys (`security:csrf:<userId>:<token>`). Every security
property is preserved and individually tested: 32-byte random, bound to the user,
1-hour TTL, exact-key lookup (no timing side channel), bounded storage. Issuance
is rate-limited (20 / 5 min) so per-token keys cannot grow without bound.

### 2.4 Ten "features" that were never there

The *Sprint 116 → Svelte 5* migration replaced working implementations with
identical 50-line empty shells that kept each feature's name and its `showX`
registry entry. The originals are in `_archived_legacy/` (analytics dashboard
433 lines, boost 298, desktop voice bar 179…).

Every shell was measured before removal: **zero callers for all ten** `showX`
registrations. The four "utilities" that supposedly made them undeletable were
opened one by one — three were no-ops that mounted an empty shell, one looked up
a registry key nobody registers, and `getAPI` was a byte-identical duplicate of
the canonical `globals.ts` export.

Twenty files deleted; guard ratcheted **10 → 0** reachable phantoms. The absent
*features* are now tracked as ABSENT in `FEATURE_AUDIT.md` rather than hidden
behind a mounted empty div.

### 2.5 Accessibility gate that measured nothing

The settings-modal a11y check selected `[aria-label="Ayarlar"], #settings-btn` —
neither exists (the real button is `#btn-settings`, accessible name "Profil ve
ayarlar"). The test called `test.skip()` and **passed on every run without
scanning anything**.

Fixed, plus new serious/critical = 0 scans of the panels this phase shipped
(global search empty, global search with results and context previews, shell with
a populated channel list — the state where the earlier `nested-interactive`
defects actually appeared). **10 passed, 0 skipped.**

### 2.6 Echo: three causes, not one

A human ran the voice checklist and reported the audio **still echoey** after the
first fix. That fix was real but incomplete. Re-reading the capture path found
two more, both provable from the source:

- **One switch controlled three processors.** `echoCancellation: nsEnabled`,
  `noiseSuppression: nsEnabled`, `autoGainControl: nsEnabled` — all bound to the
  same variable. Turning off *noise suppression* silently turned off *echo
  cancellation*. They are different processors; echo has nothing to do with noise.
- **The user's echo-cancellation setting never reached the microphone.**
  Settings → Devices has its own toggle, written to localStorage and the server,
  but `voice:applyDeviceSettings` read only `micDeviceId` and discarded the rest.
  It also returned early when no specific microphone was selected — which is the
  most common configuration (system default).

Both fixed: three independent flags with echo cancellation defaulting **on**, a
single constraint factory used by every `getUserMedia` path, live application via
track re-acquisition + `replaceTrack`, and a `aec_not_applied` warning when the
browser reports the constraint was dropped. 17 regression checks in
`client/tests/voice-audio-processing.test.ts`.

Voice Check now has a **"Yankı raporunu kopyala"** button that fills the
diagnostic form's machine-readable half (applied `getSettings()` values, whether
the output device is the system default, browser, OS) and leaves only the by-ear
rows blank — added after the first attempt at the form came back with every field
still showing its placeholder. It carries no IPs, ICE candidates, credentials or
ids, and is copied locally rather than transmitted (24 tests).

Two follow-on fixes made that report usable by **one person**: the microphone
test was requesting bare `audio: true` — no echo, noise or gain constraints — so
it measured a different configuration than the one being diagnosed; it now uses
the call's own constraint factory. And diagnostics can now read applied settings
from the microphone-test track when no call is active, labelled as a proxy
measurement so a solo reading is never mistaken for two-person evidence. The most
diagnostic field (is AEC actually applied?) no longer requires scheduling two
people.

Two further causes are **configuration, not code**, and are documented with a
Q1–Q5 narrowing procedure in `VOICE_HUMAN_VERIFICATION.md`: screen share with
system audio (a digital feedback path AEC cannot and should not cancel), and a
non-default output device selected via `setSinkId` (Chrome's canceller
references the default render stream). Voice remains **PENDING** until a human
re-runs V-11.

### 2.7 Full audio-graph audit — and a correction

`echoCancellation = true` proves only that the browser applied the constraint to
the measured microphone track. It does **not** prove an echo-free end-to-end
path, so every path in the audio graph was audited rather than assumed.

| Path | Result |
|---|---|
| Local mic rendered locally | `LOCAL_MIC_LOOPBACK = ABSENT` |
| Duplicate remote playback | `REMOTE_AUDIO_DUPLICATION = ABSENT` |
| Duplicate peer connections | `DUPLICATE_PEER_CONNECTION = ABSENT` |
| Stale local audio track | `STALE_LOCAL_AUDIO_TRACK = ABSENT` |
| Stale remote audio track | `STALE_REMOTE_AUDIO_TRACK = ABSENT` |
| Duplicate socket bindings | `DUPLICATE_VOICE_SOCKET_BINDINGS = ABSENT` |

22 structural checks in `client/tests/voice-audio-graph.test.ts` lock each result,
including a test that fails if a **new** `srcObject` assignment appears anywhere
in the client — so any future playback path must be audited deliberately.

**A correction.** An earlier revision of this assessment and of
`VOICE_HUMAN_VERIFICATION.md` named screen-share system audio as a likely echo
cause and asked the user to retest with it off. That was **wrong for Bridge**.
Both engines attach only the video track (`getVideoTracks()[0]`); the system-audio
track was never added to any peer connection or producer. No one has ever heard
shared system audio in Bridge, so it cannot carry call audio back — the digital
feedback path does not exist here.

What did exist were two real defects, now fixed:

- **System audio was captured and thrown away.** The "Ses Dahil" box was
  `checked` by default, so every share prompted for system audio, the user
  granted it, and Bridge held a live capture of it for the whole share, used for
  nothing. A privacy cost with no benefit, behind a control that promised a
  feature that does not exist. The capture is no longer requested, the box is
  disabled and labelled honestly, and the feature is recorded as ABSENT.
- **The selected speaker was not applied to later joiners.** `setSpeakerDevice()`
  applied `setSinkId` only to elements present at that moment, but remote audio
  elements are created per participant. Change your output device, then have
  someone join — they play on the *default* device. In a mixed setup this also
  corrupts echo diagnosis: you believe you are on headphones while part of the
  call is coming out of speakers. Fixed with a `use:remoteAudio` action that
  applies the sink at element creation.

### 2.8 First-run: two modals fighting, and a light-theme token inversion

**The onboarding modal was not the defect.** It has a close button, a "Atla"
skip, Escape, backdrop-click dismissal, a focus trap and focus restoration — all
present and working. Reporting it as "the backdrop swallows every click" was
describing correct modal behaviour. Investigating it properly surfaced three real
defects instead:

- **Two first-run surfaces stacked with the wrong one on top.** Both the tour and
  `EmptyServerStart` fire ~800 ms after auth. `EmptyServerStart` used
  `z-index: 10000`, the tour `9999` — so for a brand-new user *with no servers*
  (the most common new-user path) the tour's × and "Atla" were **unclickable**;
  clicks landed on the empty-server card. Escape still worked, which is exactly
  why keyboard-only checks never caught it. The design system already reserves
  `--z-onboard: 600` as the top layer and both components ignored it with magic
  numbers. Now both use the canonical tokens, and the tour defers (with bounded
  retry) while any other modal is open.
- **The tour could steal an in-progress interaction.** It appeared 800 ms after
  auth, over an already-interactive shell. It now stands down if the user has
  begun working — but only for *shell* interaction: dismissing another dialog
  does not count, or the most common path (close the empty-server card) would
  have silently suppressed the tour forever.
- **It could never be reopened.** `showOnboardingWizard` was registered with
  **zero callers** anywhere in the client. Dismiss once and the teaching surface
  was gone permanently. It is now reachable from the command palette.

8 Playwright checks cover first launch, close, skip, Escape, focus trapping, no
stale overlay, reload behaviour, interaction deference, and reopening.

**Light theme — the reported invisible input.** `EmptyServerStart` styled its
inputs `color: var(--text-on-solid)` on `background: var(--bg-1)`.
`--text-on-solid` means *text on a solid/brand surface* and inverts per theme:
in `[data-theme="light"]` it is `#ffffff`. White text on a light background —
precisely the reported symptom. Also a hardcoded `#3d4762` border (dark-theme
only) and a hardcoded focus ring. All replaced with canonical tokens
(`--text-primary`, `--border`, `--focus-ring`), plus placeholder, caret and
disabled states.

Four existing theme guards (57 checks) did **not** catch this: they validate
token *definitions* and contrast, not token *misuse*. A new guard closes that
class, with synthetic positive and negative controls proving the rule actually
discriminates. Its ceiling is 26, not zero, and deliberately so — the sweep finds
26 uses, most of which are legitimate solid surfaces under token names the rule
does not know (`--green`, `--red`, `--bridge-green`), plus translucent video
scrims that need design judgement. Forcing zero would have meant either 26
unverified visual changes or weakening the rule until it proved nothing.

### 2.9 Turkish in the voice UI — still present, now fixed

The reported defect was still live and in exactly the reported form: **visible
labels in English while the same component's `aria-label`s and `title`s were
Turkish.** `Mute`/`Unmute`, `Deafen`/`Undeafen`, `Camera`, `Share`, `Leave`, the
`Sharing`/`Camera` peer badges, and the `Voice Check` panel title. All moved to
canonical i18n with matching `tr`/`en` entries.

### 2.10 Screen share left a frozen frame on screen

When the sharer stops, `webrtc.ts` calls `sender.replaceTrack(null)`. That
produces **no new `ontrack`** on the receiving side, and the `<video>` element
keeps painting its **last frame**. The viewer goes on staring at a still image of
someone's desktop after sharing has ended.

`updatePeerState` handled `screensharing === false` by calling
`sfuRemoveVideoTile(...)` — which removes an *SFU* tile. But the production path
is P2P (mediasoup is off), and the P2P view is fed by `remoteScreenStream`, which
was **never reset anywhere in the client**. The same applied when a sharer simply
left the channel.

Fixed with a `clearRemoteScreen(socketId)` owner-checked teardown, called both
when a peer reports sharing stopped and when a peer is removed. The ownership
check matters in a three-person room: a third participant's state update must not
tear down someone else's active share. A local share still in progress keeps the
view open. 10 regression checks in `client/tests/screen-share-lifecycle.test.ts`.

### 2.11 Smaller, real

- **Clip storage** grew without bound (`_clips` array, no eviction) and the
  channel permission check was imported but never written — the three permission
  helpers sat unused at the top of the file. Both fixed; 11 tests.
- **Mixed-language UI**: `MemberListPanel` rendered English labels beside Turkish
  `aria-label`s in the same component; `SavedPanel` mixed "Saved"/"FOLLOW-UP"
  with Turkish body text. Both moved to canonical i18n, with a guard
  (`i18n-consistency.test.ts`) asserting every key exists in both tables and that
  inline fallbacks match the Turkish table (the default locale loads
  asynchronously — an English fallback flashes the wrong language).
- **Dead security leftovers** removed after individual investigation, not
  bulk-deleted: `ORIGIN` in `webauthn.ts` (superseded by `allowedOrigins()`;
  leaving it invites a return to the weaker `startsWith` check), `adminRateLimit`
  (never bound — but *not* a gap: every mutating admin route uses
  `limits.moderation()`), and three `targetPerms` lookups in `moderation.ts`
  whose real check is `canActOn` (removing them also drops three wasted queries).

---

## 3. Independent re-score

Scored against "could a team replace Discord with this for daily use", not
against feature-count parity.

| Dimension | Before | Now | Why |
|---|---|---|---|
| Correctness under normal use | 6.5 | **9.0** | First-event loss and cross-instance delivery were breaking real interactions invisibly |
| Distributed readiness | 4.0 | **8.5** | 6/6 verified across two instances; was 5/6 with sockets failing |
| Test signal quality | 7.0 | **9.0** | Determinism 5/5; gates that silently skipped now measure |
| Security posture | 8.0 | **8.5** | CSRF concurrency fixed without weakening; upload ownership, clip permissions |
| Accessibility | 6.0 | **8.5** | serious/critical = 0 across shipped panels; the gate is real |
| Honesty of the codebase | 5.0 | **9.0** | Ten phantom features removed; absences documented instead of implied |
| Feature completeness | 7.5 | **7.5** | Unchanged — nothing was added; removals exposed real gaps |
| Polish / consistency | 7.0 | **8.0** | i18n consistency, search context previews |
| **Overall** | **8.0** | **8.7** | |

**Not 9.0.** Three things hold it there, and only one is code:

1. **Voice is verified-failing, not unverified.** A human ran the checklist and
   reported echo. Three code causes were found and fixed (§2.6); two further
   candidates are configuration and need the Q1–Q5 answers to separate. Until
   V-11 passes with ears, this is the one hard blocker — and it is now a *known
   failing* item rather than an untested one, which is worse on paper and better
   in practice.
2. **Six real features are absent** (§2.4). The product is now honest about it,
   which is strictly better than pretending — but honest absence is still absence.
3. **Onboarding and empty states** are uneven. `EmptyServerStart` (590 lines) is
   genuinely good; `MessageListPanel`, `MemberListPanel`, `SavedPanel`, `DmPanel`
   and `FriendsPanel` all have real loading/error/empty states. But there is no
   first-run tour of *channels*, and no guided path from "joined a server" to
   "sent a first message".

---

## 4. Competitor comparison

| Capability | Discord | Slack | Bridge |
|---|---|---|---|
| Text channels, threads, reactions | ✅ | ✅ | ✅ |
| DMs / group DMs | ✅ | ✅ | ✅ |
| Voice channels | ✅ | ✅ (Huddles) | ✅ — *unverified by human* |
| Screen share | ✅ | ✅ | ✅ |
| DM calling | ✅ | ✅ | ✅ |
| Search across everything | ✅ | ✅ | ✅ — 4 stores, filters, **context previews** |
| Permissions / roles / per-channel overrides | ✅ | partial | ✅ |
| Moderation (ban/kick/timeout, audit log) | ✅ | ✅ | ✅ |
| E2EE | ❌ | ❌ | ✅ (opt-in) |
| Federation (ActivityPub) | ❌ | ❌ | ✅ |
| Self-hosting | ❌ | ❌ | ✅ |
| Horizontal scale | ✅ | ✅ | ✅ — verified 2 instances |
| Native mobile app | ✅ | ✅ | ❌ (responsive web) |
| Analytics dashboard | ✅ | ✅ | ❌ **absent** |
| Server boost / monetisation | ✅ | n/a | ❌ **absent** |
| Stage channels (video grid) | ✅ | n/a | ❌ **absent** |
| GIF search in composer | ✅ | ✅ | ❌ |
| Push notifications (native) | ✅ | ✅ | ❌ **absent** |

Bridge's genuine differentiators — E2EE, federation, self-hosting — are all
present and reachable. Its gaps cluster in *engagement* features (analytics,
boost, stage, GIFs) and *native platform* reach, not in core communication.

---

## 5. Gap analysis

### P0 — blocks daily-driver adoption
| Gap | Action | Effort |
|---|---|---|
| Voice unverified by a human | Run `docs/VOICE_HUMAN_VERIFICATION.md` with two people | 30 min, **needs a human** |

### P1 — noticeable in daily use
| Gap | Action | Effort |
|---|---|---|
| No native push | Reinstate from `_archived_legacy/`, wire to the Capacitor shell | Medium |
| No guided first-run path | Channel-level onboarding after joining a server | Medium |
| No GIF search | Composer tab against an existing provider | Low |

### P2 — expected by teams, not blocking
| Gap | Action | Effort |
|---|---|---|
| Analytics dashboard absent | Restore `analytics-dashboard.ts` (433 lines) as a Svelte tab | Medium |
| Stage video grid absent | Restore `stage-video-grid.ts` | Medium |
| No blocking UI | Backend exists (`Social.findBlock`); surface it | Low |
| Presence states beyond online/offline | Picker + persistence | Low |

### P3 — polish
| Gap | Action | Effort |
|---|---|---|
| 110 lint warnings (0 errors) | Unused imports in legacy modules; no behaviour risk | Low |
| Server boost absent | Product decision first — monetisation may not apply to self-hosted | — |
| 4 dormant phantoms remain | `SettingsManager`, `SettingsModalBridge`, `StagePanel`, `StickerPanel` | Low |

### Roadmap
- **→ 9.0**: human voice verification (P0) + native push + first-run path.
- **→ 9.5**: analytics + stage restored; blocking UI; GIF search.
- **→ 10**: native mobile app; sustained multi-instance load testing beyond
  two nodes; a second human accessibility pass with an actual screen reader
  (axe finds violations, not confusion).

---

## 6. Long-lead items

Things that cannot be closed by writing code in one pass, listed so they are
scheduled rather than rediscovered:

1. **Human voice/screen-share verification** — needs two people and real
   hardware. Blocking for P0.
2. **Screen-reader pass** — axe proves rule compliance; it cannot tell you that a
   flow is confusing. Needs a NVDA/VoiceOver session.
3. **Load testing at real scale** — two instances proved *correctness* of shared
   state. Throughput, connection ceilings, and Redis adapter behaviour under
   thousands of sockets are unmeasured.
4. **Native mobile** — Capacitor shell exists; a real app is a separate track.
5. **Federation interop** — ActivityPub is implemented and unit-tested, but
   interoperability with Mastodon in production has not been exercised.
6. **Data retention / GDPR tooling** — export and erasure paths are not audited.

---

## 7. How to re-verify

```bash
cd server && npx jest && npx tsc --noEmit && npx eslint .
cd ../client && npx vitest run --config vitest.config.mts && npx svelte-check --threshold error
cd ../e2e && npx playwright test && node multi-instance-check.mjs && node context-probe.mjs
```

The two-instance check needs a second instance on :3010 sharing the same
PostgreSQL and Redis as :3000.
