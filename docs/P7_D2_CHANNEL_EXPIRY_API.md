# P7 D2 — channel expiry configuration API

`PUT /api/servers/:sid/channels/:cid/expiry`, body
`{ "expiresAt": <epoch ms> | null, "expectedVersion"?: <int> }`.
Logic in `server/lib/channelExpiryConfig.ts`; PostgreSQL only (503 otherwise).
Depends on the write barrier (086, #356) and the expiry worker (087, #357).

## Transaction

1. Lock the server row `FOR NO KEY UPDATE`. This serialises every expiry
   change in one server without blocking writers (the write barrier and FKs
   take `FOR KEY SHARE`, which does not conflict).
2. Require the actor to be the server owner.
3. Lock the channel row `FOR NO KEY UPDATE` and read it with the database
   clock and the tombstone. An expired or tombstoned channel is gone and is
   never revived. If the worker holds or deletes the row, the wait ends with
   no row: 404.
4. Validate against the database clock (`validateChannelExpiryRequest`), then
   set `expiresAt` and bump `expiryVersion`.

A new expiry is always at least the minimum lifetime away, so a writer that
passed the barrier just before the change stays valid.

## Responses

| Status | Code | When |
|---|---|---|
| 200 | — | `{ channelId, expiresAt, expiryVersion }` |
| 400 | `INVALID_REQUEST` | missing `expiresAt`, non-integer, ≤ 0, bad `expectedVersion` |
| 403 | `FORBIDDEN` | member who can see the channel but is not the owner |
| 404 | `NOT_FOUND` | unknown, invisible, foreign-server, expired or tombstoned channel |
| 409 | `VERSION_CONFLICT` | `expectedVersion` differs from the stored version |
| 409 | `LAST_PERMANENT_CHANNEL` | the change would leave the server without a permanent channel |
| 422 | `OUTSIDE_WINDOW` | lifetime outside the allowed window |

## Policy defaults — need owner approval

- **Who:** server owner only (not `MANAGE_CHANNELS`), because expiry
  permanently deletes content.
- **Window:** 1 hour to 30 days from the database clock
  (`MIN_/MAX_CHANNEL_LIFETIME_MS`).
- **Clearing:** an expiring channel may be made permanent again before it
  expires.
- **Last permanent channel:** a server must keep at least one permanent
  channel. Known gap: channel deletion does not apply this rule, so deleting
  the last permanent channel can still leave only expiring channels; the
  worker then never claims the server's last live channel.

## Not in this change

Client notification on expiry change or expiry, setting expiry at channel
creation, UI.

## Evidence (real PostgreSQL)

`server/tests/pg-integration/channel-expiry-config.pgtest.ts` (7 cases):
set/move/clear with version bumps and a stale-version 409; non-owner 403,
outsider and foreign-server 404; window and strict-type table; last permanent
channel 409 and five rounds of two concurrent requests where exactly one
wins; an expired unclaimed channel is never revived; a worker that deletes
the row mid-change yields 404; an in-flight writer neither blocks nor is
invalidated by the change, and the barrier denies writes after expiry.
Removing the server-row lock makes the concurrency case fail.
