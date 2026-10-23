# P7 D2 — live media follows channel expiry (2026-10-23)

Branch `claude/p7-d2-media-expiry`, stacked on `p7/d2-client-stale-20261023`.
Issue #321. No migration; 085–092 are unchanged.

## What was wrong

Live media never touches the message write barrier (086/092). The expiry
worker evicts live room members when it **claims** a channel. That happens up
to a minute after `expiresAt`, best effort, on whichever node runs the
tick. Until then, and for every path that admits or mutates media state, the
only authority was membership and permissions. Reproduced on real PostgreSQL
with Socket.IO (in-memory and real Redis rosters):

| Path | Before |
|---|---|
| `voice:join` into an expired-but-unclaimed or tombstoned channel | admitted |
| `voice:join` that waited on the roster lock while the channel expired | admitted |
| `webrtc:offer` / `ice-candidate` from a peer admitted before expiry | relayed |
| `GET /channels/:id/voice-members`, `POST …/voice-state` | served |
| `stage:join` into an expired or tombstoned Stage | admitted, `canManage: true` |
| `stage:promote`, `setTopic`, `setLive`, `setRole`, `handRaise` after expiry | applied |
| `isStageParticipant` / `isStageSpeaker` / `canManageStage` (used by the SFU and video grid) | true |
| SFU channel authority (`sfu:get-rtp-capabilities`, `join`, `create-transport`, `produce`, `consume`, …) | granted |
| `GET /voice-messages/:id/transcript` of an expired channel | served |
| `stage:leave` from an expired Stage | acknowledged without removing the roster entry |

## The fix

One predicate, `channelLiveForMedia(channelId, serverId)` in
`lib/channelContentAvailability.ts`, wraps the existing authoritative read
(`channelLiveForMessageRead`: row, tenant, tombstone, `clock_timestamp()`).
Missing, tenant-mismatched, expired, tombstoned and unverifiable
(database error) all answer *not live*.

- **Voice admission** (`mayJoinVoice`): checked before the roster lock and again
  after it (the existing post-admission recheck), so a lock wait across
  `expiresAt` is undone.
- **Voice relays** (`webrtc:*`, `voice:state-update`, `voice:activity`,
  `voice:e2e-key`): the sender's room is used only while its channel is live. A
  positive answer is reused for at most 2 s (`VOICE_LIVE_RECHECK_MS`) to bound
  database load during ICE bursts, and **never past the channel's
  `expiresAt`**: the reuse deadline is the local monotonic time at which the
  read was sent plus (`expiresAt` − database now), so it can only end early.
  The expiry API's one-hour minimum lifetime means no expiry can be moved
  inside that window. A refusal is never cached. A refused sender
  leaves the roster and the room, so it can negotiate nothing further.
  Group-DM calls are SFU rooms with no server and no channel lifecycle: they
  are exempt here, and the SFU authorizes them by group membership on every
  operation. A regression test pins this, because a first draft of this change
  evicted group calls.
- **Stage**: `_stageAccess` requires liveness, which covers join, every mutation
  and the helpers the SFU and video grid use. Mutations re-check inside the
  roster lock (`_withLiveRoomMutation`). `stage:leave` needs no access: a member
  whose Stage expired can always drop its roster entry.
- **SFU**: channel authority moved to `socket/handlers/mediasoup/authority.ts`
  (testable without media workers) and requires liveness; every `sfu:*`
  operation re-enters it.
- **The expiry instant** (`socket/mediaExpiryEviction.ts`): admission alone
  cannot end media that is already flowing. Every successful voice, Stage and
  SFU join on an expiring channel arms one timer per channel on the admitting
  node, set for the authoritative `expiresAt` (same send-time-plus-remaining
  rule). When it fires it re-reads PostgreSQL. If the channel is no longer
  live, it runs the same all-node eviction the worker runs at claim
  (`evictSocketsWithoutChannelAccess(…, { channelGone: true })`):
  - SFU peers are torn down server-side (producers, consumers, transports);
  - every voice member gets `voice:evicted` and leaves the roster and the
    room.

  If the owner moved the expiry later, it re-arms instead. An unverifiable read
  at that instant (database error) evicts: fail closed, as admission does.
- **Clients**: both RTC engines handle `voice:evicted` by closing every peer
  connection and SFU transport and stopping the microphone and screen tracks.
  The SFU engine already did; the P2P-only engine (`webrtc.ts`) did not and now
  does.
- **HTTP**: the voice-state and voice-members routes answer 404 like a missing
  channel; voice-message upload is refused (403) before any byte is written; the
  transcript of an expired channel answers 404.

## Evidence (local, real services)

- `tests/pg-integration/media-channel-expiry.pgtest.ts`, 26 cases (21 below
  plus 5 for the expiry instant, which run with no expiry worker):
  - **multi-node** (real Redis only): two Socket.IO nodes share one Redis
    adapter; only node A holds the timer. A member whose socket is on node B
    gets `voice:evicted`, leaves the room and the shared roster. It is reached
    through the adapter's remote `fetchSockets` and the cluster eviction
    event. Negative control: without node B's
    `bindVoiceEvictionClusterControl` listener the case fails. In-memory mode
    has no cluster, so the case is skipped there; CI's PG job always sets
    `REDIS_TEST_URL` and rejects skipped tests;
  - live voice is evicted when `expiresAt` passes: nobody at −250 ms; both
    members told, off the roster and out of the room by +750 ms. The harness
    runs the production node-local evictor (`socket/voiceEviction.ts`);
  - an expiry moved later before the instant re-arms and evicts nobody
    (positive control);
  - a relay at `expiresAt` + 150 ms is refused although liveness was confirmed
    under 2 s earlier (the expiry-instant timer is disabled in this case to
    isolate the relay check);
  - a live Stage arms one timer, a permanent channel none.
- The original 21 cases: It covers
  every row above plus positive controls on permanent and live ephemeral
  channels. It passes with in-memory rosters, and with real Redis through the
  production Socket.IO adapter (`REDIS_TEST_URL`, as in CI). It also covers:
  - each of the six relay paths (`webrtc:offer`/`answer`/`ice-candidate`,
    `voice:state-update`, `voice:activity`, `voice:e2e-key`) on its own,
    delivered while live and refused after expiry;
  - the database clock deciding when the application clock is skewed two
    hours either way;
  - four Stage mutations (`setRole`, `setTopic`, `setLive`, `promote`) held on
    the roster lock while the channel expires: refused, roster unchanged.
- **Negative controls:**
  - without the product change, 8 of the first 10 cases fail;
  - without the in-lock re-check, exactly the four lock-held cases fail;
  - without the relay check, the six per-path cases and the stale-peer case fail;
  - without arming the expiry-instant timer, the three cases that depend on it
    fail;
  - with the relay reuse not capped at `expiresAt`, the relay-after-expiry case
    fails;
  - without the P2P client's `voice:evicted` handler, its client test fails
    (`client/tests/voice-rtc-lifecycle.test.ts`).
- **Full real-PG + Redis suite:** 380 passed / 14 skipped. The skipped cases
  need MinIO and pgvector, which CI provides.
- **Server unit tests:** 711 suites / 13,179 tests, with coverage thresholds
  met. `socket/mediaExpiryEviction.ts` has its own unit test (100% of the
  module): instant, re-arm, removed expiry, earliest deadline, 6 h cap, no
  arming for permanent/group-DM/closed channels, and a contained failure. Three fixtures were corrected to model production join state: a real
  channel record, `currentVoiceServer` set together with
  `currentVoiceChannel`, and a mock that keeps prototype methods. No assertion
  was removed.
- **Client:** 333 files / 5,627 tests, both 90% coverage gates pass.
- **E2E (at `eae5a1f3`):** `voice.spec.ts` 12/12; the `voice-media` project (real WebRTC P2P
  and SFU media) 33/33.
- **Other gates:** lint, typecheck, strict, test-strict, hardening,
  coverage-debt, test ownership and release integrity (218/218) are clean.

## What remains: not immediate revocation

This change does **not** make revocation instantaneous, and it does not claim
to. What it guarantees, and what is left over:

- **Signaling and control:** refused from `expiresAt` on, per the database
  clock. No relay reuse extends past it. The only slack is a request that was
  already being processed when the instant passed.
- **Server-carried media (SFU):** torn down by the expiry-instant timer. This
  happens shortly after `expiresAt`: timer and event-loop delay, one
  PostgreSQL read, then the eviction itself, plus the cross-node broadcast
  when the room lives on another node. The tests assert by +750 ms locally;
  no production latency figure is claimed.
- **P2P media is not carried by the server.** The server stops relaying,
  drops the room and tells both clients `voice:evicted`. An unmodified client
  then closes its peer connections and releases the microphone. A **modified
  client pair that ignores `voice:evicted`** can keep an already established
  direct DTLS-SRTP connection open. No server can end media it does not carry.
  Relayed TURN traffic is also not cut at expiry: TURN credentials are
  time-limited to 24 h (`lib/turnConfig.ts`), not to the channel. Closing this
  fully would need SFU-only media for expiring channels; that is a product
  decision, not done here.
- **Best effort, with the worker as backstop.** Each timer lives in the
  memory of the node that admitted the member:
  - **Restart:** a node's timers die with it, but so do the socket
    connections it served: every member that node admitted is disconnected
    by the restart. When a member reconnects and rejoins, a new timer is
    armed. Members admitted on other nodes are covered by those nodes' own
    timers. A restart therefore leaves no connected member without a timer,
    by construction; no test kills a node mid-call.
  - **Database failure at the expiry instant:** the re-read fails closed and
    the eviction runs. That can end a call whose expiry was extended while
    the database was unreachable; its members can rejoin once it is back.
  - **Database failure when arming:** no timer is armed. Admission itself
    already required a successful read moments earlier, so this needs the
    database to fail between two reads of the same join. The worker's
    claim-time eviction then applies, up to a minute after `expiresAt`.
  Every control path above stays refused regardless.
- **Voice-message uploads:** an upload that passes the check just before
  `expiresAt` can still store its object. The write barrier then refuses its
  message row and the route removes the voice row. This is the existing
  two-table rollback, unchanged here.

## Option: SFU-only media for expiring channels (proposal, not implemented)

The only residual that the server cannot close today is P2P media between
modified clients. Closing it needs every expiring channel's media to pass
through the SFU, which the server can tear down. This is a product decision
(availability and cost), so it is **not** implemented here.

**Today**
- `voice:get-capabilities` answers `{ p2p: true, sfu: <ready> }`.
- The shipped client uses the SFU when it is ready and falls back to P2P.
- The server also accepts the P2P path (`voice:join` and `webrtc:*` relays)
  while the SFU is up, so a modified client can choose P2P deliberately.

**Change**
1. Server: for a channel with `expiresAt` set, `voice:join` (the P2P
   admission) answers `voice:join-rejected` with `code: 'SFU_REQUIRED'`, and
   the `webrtc:*` relays refuse it. Stage is already SFU-only.
   `voice:get-capabilities` gains an optional `channelId` and answers
   `p2p: false` for such a channel.
2. Client: an expiring channel joins through the SFU only. When the SFU is
   not ready, the user is told that voice is unavailable in temporary
   channels, with no silent P2P fallback.
3. Tests:
   - P2P join and relays refused on an expiring channel, accepted on a
     permanent one (real PostgreSQL);
   - an SFU-only call evicted at the instant, with the media transports
     closed server-side;
   - the client message when the SFU is down.

**What it buys:** for an expired channel, Bridge carries and relays no media
at all. All media of an expiring channel runs through server-owned SFU
transports that the expiry eviction closes. A TURN allocation pointed at the
SFU then forwards nothing. The residual becomes the eviction latency above,
not "until both clients choose to hang up".

**What it costs**

| Area | Impact |
|---|---|
| Availability | When no SFU worker is ready, voice in expiring channels is unavailable (today it falls back to P2P) |
| Server load and cost | Every call in an expiring channel uses SFU bandwidth and CPU (mediasoup workers), including 1:1 calls that are P2P today |
| Latency | One extra network hop (client → SFU → client) |
| E2EE | Voice E2EE keys travel over `voice:e2e-key`; frames through the SFU stay end-to-end encrypted only where insertable streams are used. To be verified before enabling |
| Scope | It does not stop two users from setting up their own WebRTC call outside Bridge; the guarantee is "Bridge relays no media", not control over user devices |

Estimated effort: about a day of implementation plus tests. It should land
behind a server setting (`EPHEMERAL_VOICE_SFU_ONLY`, default off) until the
owner decides.

## Relation to the interrupted Codex session

A Codex session found the same class of gaps on 2026-10-23 and reported 21
real PostgreSQL/Redis/Socket.IO cases for its fix. That fix and its tests were
never committed or pushed: no branch on GitHub contains them, so they could not
be recovered. This branch is an independent implementation. Its tests were
extended to cover each category that session's log names:
- HTTP reads and writes;
- the six signaling paths;
- application-clock rollback;
- four Stage mutations held on a real Redis lock across expiry.
