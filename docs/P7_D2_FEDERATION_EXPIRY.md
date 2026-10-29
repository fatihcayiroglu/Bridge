# P7 D2 — channel expiry and federation

Issue #321 asks how expiry propagates across federated bridges, delayed or
duplicate events, out-of-order replays and remote offline windows, and requires
that a remote server can neither override local policy nor resurrect expired
content. This records what Bridge's federation actually carries (audited from
code on 2026-10-22) and why each requirement holds.

## What crosses an instance boundary

| Path | Carries channel content? | Evidence |
|---|---|---|
| ActivityPub inbox `POST /users/:username/inbox` (`routes/federation/inbox-handlers.ts`) | **No.** Creates user-level `ap_messages` (public notes, direct notes), DMs, follows, likes, announces. `channelId` is never set from remote input. | `handleCreate` builds `fedMsg` without `channelId`; Delete/Update address `apId` only. |
| ActivityPub outbox `POST /users/:username/outbox` | **No.** A local user's own notes. | `routes/federation/activitypub.ts` |
| Peer discovery `GET /api/federation/servers`, `/stats`, `/ping`, `/join-remote` | Metadata only: server name, member count, text-channel **count**. | `routes/federation/peers.ts`; the count uses `Channels.findWhere`, which omits expired channels. |
| Channel bridges `routes/bridge.ts`, crossposts `routes/announcement.ts` | Local only: both endpoints are channels of this instance. | Bridge creation resolves both channels with `Channels.findByIdAndServer`. |

Channel messages therefore never leave the instance as federated objects, and no
remote server holds a mirrored copy that would need a tombstone.

## Requirements, mapped

- **A remote server cannot resurrect expired content.** No federation path writes
  `messages`, `threads` or `thread_messages`. Independently, the PostgreSQL write
  barrier (migration 086) refuses every write into an expired or tombstoned
  channel whatever path issues it (`BX001`), so a future federation path could
  not either.
- **A remote server cannot override local policy.** Expiry is configured only
  through the owner-only local API (`lib/channelExpiryConfig.ts`); no federation
  message reads or writes `channels."expiresAt"`/`"expiryVersion"`.
- **Delayed, duplicate and out-of-order events.** For the content federation does
  carry (user-level notes), `ap_messages` already keeps a permanent tombstone per
  `apId`: a Delete that arrives before its Create is stored as a tombstone, and a
  late Create cannot resurrect it (`federation.note.*` handling, migration 079).
- **Local bridges and crossposts.** Expiry cleanup deletes `channel_bridges`,
  `channel_follows` and `crosspost_log` edges from both sides; the write barrier
  refuses a crosspost into an expired target in the same transaction as its log
  row (`channel-write-barrier.pgtest.ts`).
- **Remote offline windows.** Nothing to converge remotely; local clients are
  covered by the local-first purge (`docs/P7_D2_CHANNEL_EXPIRY_LIVE.md`).

## If channel federation is ever added

It must (1) send an expiry tombstone (`channelId`, `expiryVersion`, `expiredAt`)
signed by the origin instance, (2) let only the origin instance expire its own
channels, (3) treat the highest `expiryVersion` as authoritative and ignore older
replays, and (4) route every inbound write through the same write barrier. Until
then there is deliberately no federation tombstone protocol to maintain.
