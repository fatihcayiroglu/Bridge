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
