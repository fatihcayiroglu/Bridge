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
  database load during ICE bursts; a refusal is never cached. A refused sender
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
- **HTTP**: the voice-state and voice-members routes answer 404 like a missing
  channel; voice-message upload is refused (403) before any byte is written; the
  transcript of an expired channel answers 404.

## Evidence (local, real services)

- `tests/pg-integration/media-channel-expiry.pgtest.ts`, 10 cases. It covers
  every row above plus positive controls on permanent and live ephemeral
  channels. It passes with in-memory rosters, and with real Redis through the
  production Socket.IO adapter (`REDIS_TEST_URL`, as in CI).
  - **Negative control:** without the product change, 8 of 10 fail. Only the
    two positive controls pass.
- **Full real-PG + Redis suite:** 364 passed / 14 skipped. The skipped cases
  need MinIO and pgvector, which CI provides.
- **Server unit tests:** 710 suites / 13,154 tests, with coverage thresholds
  met. Three fixtures were corrected to model production join state: a real
  channel record, `currentVoiceServer` set together with
  `currentVoiceChannel`, and a mock that keeps prototype methods. No assertion
  was removed.
- **E2E:** `voice.spec.ts` 12/12; the `voice-media` project (real WebRTC P2P
  and SFU media) 33/33.
- **Other gates:** lint, typecheck, strict, test-strict, hardening,
  coverage-debt, test ownership and release integrity (218/218) are clean.

## What remains bounded, not closed

- **Relay window:** an admitted peer may relay for at most 2 s after expiry,
  the reuse window.
- **Established media keeps flowing:** media between peers that already
  negotiated keeps flowing until the claim-time eviction or their next
  signaling. P2P media does not pass through the server.
- **Voice-message uploads:** an upload that passes the check just before
  `expiresAt` can still store its object. The write barrier then refuses its
  message row and the route removes the voice row. This is the existing
  two-table rollback, unchanged here.
