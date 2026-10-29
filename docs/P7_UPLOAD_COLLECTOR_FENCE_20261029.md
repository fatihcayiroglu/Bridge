# Daily orphan upload collection — reference fence

The daily collector listed old root objects, took a global reference snapshot,
and deleted objects missing from that snapshot. A reference writer could commit
after the snapshot and before physical deletion. The actual PostgreSQL 18/S3
regression on parent `9b67078d` reproduced a committed live message reference
with its backing object gone: one failed race test, one passing permanent-
reference control, zero skipped tests. The parent had already passed all nine
Quality Gate jobs; that did not establish this missing concurrency property.

Reuse migration 091's `reserveUploadReleaseKeys`, already used by the D2 object
releaser. The old complete reference snapshot remains a prefilter. For at most
50 eligible canonical keys at a time, the existing helper locks reference writers,
rechecks all owners at READ COMMITTED, releases reservations for referenced keys,
and commits the reservations before any storage call. A writer that got there
first can commit and keep its object. A later writer receives the existing
`55000 upload_release_reserved` refusal. Storage failures and lost acknowledgements
keep the durable reservation; subsequent collection is safe and idempotent.

Reservation failure stops further deletion. The local/remote adapters, recognized
root scope, ten-minute grace and daily interval are unchanged. Physical deletion
still precedes ownership-metadata removal. There is no new schema, lifecycle
implementation, storage transaction, authorization exception or product policy.
Migrations 085–092, especially 091, remain prerequisites: do not cherry-pick the
collector onto a schema without the reservation fence.

Verification before the full server/CI gates:

- Five real PostgreSQL/S3 controls pass: a late writer is refused before actual
  deletion; a permanent reference survives; an uncommitted writer blocks the
  reservation, then commits and keeps its object; a storage failure retries;
  a lost acknowledgement cannot revive a reference on a later run.
- These controls use actual SQL, the actual private S3 adapter and real HEAD/
  DELETE requests. Only the test object's age metadata crosses the grace window,
  and listing is restricted to its exact random key. Other objects are untouched.
  Missing prerequisites fail collection rather than skipping. The lost-ACK
  injection exercises the boundary; it does not kill a process or storage server.
- The full real PG18/Redis/S3 suite passes 446 tests, zero failures/skips. The
  focused unit/coordination/shutdown/invariant run passes 91. Legacy collector
  unit suites explicitly stub the reservation boundary; real lock evidence is
  in the integration suite. Existing assertions are retained, with new refusal,
  concurrent-reference and bounded-batch controls.
- Production types, strict test types and the production build pass. The full
  server coverage run and new exact-head CI remain independent gates.

This corrects the reproduced collector race. It does not recover previously lost
bytes, make S3 atomic with PostgreSQL, guarantee ownership-metadata repair after
a crash following physical deletion, or add a durable pre-upload voice intent.
Keep those D2/P7 acceptance boundaries open. Keep #321 and #209 open. This draft
inherits #375; main integration still needs explicit owner approval.
