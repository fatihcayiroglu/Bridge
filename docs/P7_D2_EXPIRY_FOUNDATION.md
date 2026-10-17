# P7 D2 — schema foundation only (NOT feature launch)

This draft is a **nonoperational prerequisite** for issue #321. It does NOT
create/expire channels, wire a worker, delete uploads or alter permissions.

- Existing channels: `expiresAt=NULL`, `expiryVersion=0`, no automatic expiry.
- Future operator-only lifecycle: absolute server epoch milliseconds, bounded
  from 1 hour through 30 days; this requires real authorization and UI review
  before enabling create/edit.
- Version increments must be serialized with any owner change/expiry claim.
  API reads, socket sends, offline replay and scheduled dispatch **must deny**
  expired channels before worker cleanup; migration alone does not enforce it.
- `channel_expiry_tombstones` retains channel ID after physical channel deletion
  (no FK to channels), with a cleanup state. This table currently has **no producer
  or consumer**; do not claim stale-client resurrection is prevented.
- A later atomic worker must coordinate via PostgreSQL rows/leases, retain
  last-channel invariants, commit the database graph deletion and tombstone on
  ONE transaction and handle S3/attachments via a separate durable outbox.
- Federation, offline tombstone consumption, old-client compatibility, full
  permission/metadata graph deletion, rollback and perf remain unimplemented.
- Before merge: check 084 migration against existing live PostgreSQL and fresh
  schema; all exact-head CI must be green. The source-contract unit test only
  proves additive SQL intent, **not** production migration behavior.

No one should use this schema to claim D2, P7 or Android #209 is complete.


## Pure policy and inter-PR integration boundary

The canonical migration-084 data model is a separate, durable
channel_expiry_tombstones table; there is NO expiryTombstonedAt column in
channels. The in-record marker used by draft #324 is not authoritative.

server/lib/channelExpiry.ts now defines two **unwired** policy helpers:

- classifyChannelExpiryWithTombstone(channel, tombstone, serverNow): requires
  an explicit tombstone query result. Undefined means NOT QUERIED and always
  returns unverified / inaccessible; null means QUERIED AND ABSENT. A valid
  durable tombstone denies even if server time moves backwards. Invalid or
  mismatched tombstone and malformed BIGINT metadata fail closed. Legacy rows
  without both expiry columns are permanent only after a negative tombstone
  query is verified.
- validateChannelExpiryRequest(expiresAt, serverNow, bounds): requires explicit
  owner-policy bounds and an explicit input. Undefined is invalid. Explicit
  null may request permanence only when bounds.allowPermanent is true.

Neither helper checks tenant membership or user permissions, and returning
accessible=true must NEVER alone grant an API/socket read or write. Before
activation, tenant-scoped SQL must obtain a consistent channel/tombstone view,
enforce expiry and version in every authorized entry path, commit tombstone
and graph deletion atomically, and prove offline/federated non-resurrection.

Draft #324 defines another channelExpiryPolicy.ts implementation using
expiryTombstonedAt in the channel record and different request defaults.
Do NOT combine the two independently; rebase #324 onto this canonical
persistence model and remove/replace duplicate policy before merging it.
Any future policy default (1h to 30d is only a proposed window here) requires
explicit owner/UI/product review. No feature activation or D2 acceptance yet.
