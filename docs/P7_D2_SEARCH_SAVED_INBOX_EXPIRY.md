# P7 D2 — search, saved and inbox expiry enforcement

Extends the authoritative read preflight of #352 (`channelLiveForMessageRead`)
to the list surfaces that return channel content outside the message routes.
No expiry API, worker or trigger is enabled; channels stay permanent unless
`expiresAt` is set directly in PostgreSQL.

## Mechanism

`liveChannelIdsForRead(pool, pairs)` (`server/lib/channelReadExpiryGuard.ts`)
decides many channels in ONE statement: channel row, tombstone and one
`clock_timestamp()` sample. A channel is live only if its row exists under the
server the caller expects, has no tombstone and classifies as accessible with
`classifyChannelExpiryWithTombstone`. Corrupt metadata, a missing row,
disagreeing pairs and a tenant mismatch all mean "not live". A database error
throws; routes answer 503. `server/lib/channelLiveReadSet.ts` is the route
entry; its unit-test fallback (no pool, `NODE_ENV=test` only) classifies the
record the caller holds.

## Surfaces

| Surface | Before | Now |
|---|---|---|
| `GET /api/search` (messages, channel names, `channelId`, `in:`) | VIEW_CHANNELS allowlist only | allowlist ∩ live, computed **before** FTS so expired channels never enter the ranked window |
| `GET /api/search/unified` | same | same |
| `GET /api/search/context` | VIEW_CHANNELS | expired/tombstoned anchor → the same 404 as missing |
| FTS SQL (`db/postgres/fts.ts`, channel + thread sources) | `serverId = ANY` and `channelId = ANY` checked independently | additionally the row's channel must belong to the row's server, before the candidate limit |
| `POST /api/saved`, `PUT /api/saved/:id/reminder` | membership + permissions | also refused (404) for an expired/tombstoned channel |
| `GET /api/saved` | rehydrated per item | one batch check; expired items are `unavailable` with no preview |
| `GET /api/inbox` | `LIMIT 100` then filter | live-channel prefilter in SQL **before** the limit, then the batch check per channel |

The inbox regression: 130 mentions from an expired channel used to fill the
100-row window and hide a live mention entirely.

## Evidence

- `server/tests/channel-live-read-set.test.ts` — 13 decision-rule cases.
- `server/tests/pg-integration/search-saved-inbox-expiry.pgtest.ts` — real
  PostgreSQL + HTTP, 5 cases; all 5 fail on the unchanged base (case 1 only
  because the batch function does not exist there).
- `search-rank-window.pgtest.ts` fixture now creates the channel rows its
  messages reference (production allowlists only name existing channels).

## Not covered here

Check-to-response race (non-transactional preflight, like #352); socket
broadcasts to existing subscribers; notification previews already delivered
by push; semantic/AI search and digests (`routes/semantic.ts`); saved
reminder delivery still fires a content-free reminder for an item whose
channel expired (Saved shows it as unavailable); writer enforcement, cleanup,
offline and federation convergence (#321).
