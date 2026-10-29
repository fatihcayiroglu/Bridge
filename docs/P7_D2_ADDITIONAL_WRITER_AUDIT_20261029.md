# D2 additional ingress-to-sink audit (2026-10-29)

Source inspected at #581 `e7c5e386e3d795197e87c347a69e438cde33f78b`.
This is a source audit, **not passing execution evidence**. P7/#321 remain OPEN.
It extends the initial `Messages.create` inventory from #578; channel-related
content can be written to other tables or mutated without creating a message.

| Ingress and actual sink | Existing control found | D2 qualification gap |
| --- | --- | --- |
| `routes/threads.ts` POST `/`, `Threads.insert` + `insertMessage`; POST `/:threadId/messages`, `Threads.insertMessageIdempotent` | Membership/timeout/channel permissions and shared content policy. `channelPermissions` delegates to `resolvePermissions`, which does not apply canonical expiry. Retry can return stored nonce reply. | Parent-channel expiry/tombstone must precede creation, idempotent replay response and publication. Actual expired/stale-client/reconnect/concurrency tests NOT EXECUTED. |
| Thread pin/lock/edit/delete in the same router | Existing permission checks; separate `Threads.update`/other repository mutations | Expiry lifecycle policy and transactional boundary unqualified. Do not automatically block approved internal cleanup or erase data. |
| `socket/handlers/messages-thread.ts` `thread:join` | Membership/visibility plus per-socket stale-join generation. Client-originated `thread:message:new` is explicitly refused, so it is **not** another persistence ingress. | Existing room members/late joins need expiry removal and live-publication qualification. Preserve the existing refusal of forged client publications. |
| `routes/polls.ts` create/vote/close/edit/unvote/delete | Auth, membership and permissions; content checks; `Polls.insert`, `update`, `updateEditableAtomic` | Separate poll storage bypasses `Messages.create`; no canonical expiry call in these ingress paths. All actual expired poll mutation cases NOT EXECUTED. |
| `routes/messages.ts` HTTP edit/delete -> `lib/messageMutations.ts` | Shared HTTP/socket mutation authority, membership, visibility/content rules and existing atomic mutation behavior | No canonical expiry check in shared mutation authority. Need lifecycle semantics and PG fault/concurrency tests. Deletion/erasure/cleanup policy cannot be inferred from a send guard. |
| HTTP reactions/read cursor/pinned/history via `requireChannelVisible` / `requireChannelMembership` | These helpers already call the authoritative PG expiry/tombstone read policy (including cached channel preflight) | Do not mislabel all HTTP reaction/read-cursor paths unguarded simply because `channelWriteAvailability` is absent by name. Their preflight-to-mutation race is still unqualified. |
| `socket/handlers/messages-edit.ts` pin/reaction, `super-reactions.ts` | Tenant binding, permission checks and existing atomic reaction updates | Separate socket paths lack canonical expiry preflight. Cannot inherit coverage from the guarded HTTP helper. |
| `socket/handlers/members.ts` `channel:join` | Persisted membership, `canViewChannel`, leaves previous room | Visibility policy has no canonical expiry gate. Joining/subscribing is not itself a message insert, but needs expired-channel join and stale-room publication tests. |
| `routes/bots.ts` incoming webhook -> `Messages.create` | Receiving-channel lookup and integration/content policy. `routes/webhooks.ts` is webhook configuration, not this message-send sink. | Attribute the real producer correctly; both webhook and bot interaction receiving-channel expiry remain unqualified. |
| `routes/announcement.ts` crosspost -> `Announcements.persistCrosspost` | Source/target permissions, content policy and separate SQL transaction/idempotency ledger | Source and each receiving channel require authoritative lifecycle enforcement inside the transaction protocol. A common `MessageRepository.create` patch alone cannot protect this SQL sink. |
| `routes/messages.ts` report creation | Auth, persisted message/channel and current read/visibility permissions | Moderation evidence has separate lifetime/retention/erasure/legal-hold policy (#336). Do not silently choose retention or make an expiry-send guard a legal deletion policy. |
| `routes/servers/channels.ts`, `channelPerms/overrides.ts` and `bulk.ts` | Existing create/edit/delete, role overrides, batch/import/sync authorization | Channel metadata/permission writes need lifecycle classification. Creating a new permanent channel, administrative cleanup and writing into a tombstoned identity are different operations. |
| `routes/upload.ts` small/chunk/GIF upload and CDN deletion | Existing authenticated upload ownership/quota/storage boundaries | An account-owned upload may precede channel selection. A blanket channel guard on every upload would be incorrect; follow the eventual attachment/message reference and cleanup graph. Existing storage/quota/ownership checks stay mandatory. |
| Voice transport/membership and channel E2EE state | Separate channel/socket/resource owners, not ordinary message-row insertions | Expiry must address resource membership, publication and recovery, not just message persistence. Actual calls/E2EE lifetime behavior NOT EXECUTED. |

Confirmed protected subsets remain narrow: #576 socket primary send; #578
schedule queue/worker preflights; #581 voice pre/post-upload preflights; existing
HTTP message-content read helpers. Their green tests are listed in the closure
matrix. None is a universal transaction fence or proof of expiry activation.

Before enabling expiry, a complete design must cover ordinary writes, delayed
producers, idempotent replays, read/cache/room visibility, administrative mutations
and internal cleanup. A check followed by an unrelated insert is still racy.
Row locks alone do not protect against a tombstone producer that ignores the same
locking protocol. No trigger/migration/bulk deletion is introduced by this audit.

This inventory distinguishes observed ingress/sinks from follow-up work; it does
not certify that every channel-associated mutation, plugin capability, SQL alias
or federation path is qualified. The remaining full graph audit and acceptance
tests are explicit closure gates, not inferred successes.
