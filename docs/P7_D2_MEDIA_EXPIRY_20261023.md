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

- `tests/pg-integration/media-channel-expiry.pgtest.ts`, 25 cases (21 below
  plus 4 for the expiry instant, which run with no expiry worker):
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
- **Full real-PG + Redis suite:** 379 passed / 14 skipped. The skipped cases
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
  memory of the node that admitted the member. It is lost if that node
  restarts, and it is never armed if the arming read fails. A later join on
  any node re-arms it. Otherwise the worker's claim-time eviction still runs,
  up to a minute after `expiresAt`. Every control path above stays refused
  regardless.
- **Voice-message uploads:** an upload that passes the check just before
  `expiresAt` can still store its object. The write barrier then refuses its
  message row and the route removes the voice row. This is the existing
  two-table rollback, unchanged here.

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
