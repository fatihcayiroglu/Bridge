# P7 B5 message report evidence: deployment and rollback

Migration 085 adds bounded report-time evidence, removes the cascading message
foreign key, and installs a `users` deletion trigger that anonymizes captured
report author identity in the same PostgreSQL transaction as account deletion.
Existing reports are not backfilled: current message text is not proof of what
was reported earlier.

## Mixed application versions

Run migration 085 before starting a reporting node that writes evidence. Older
nodes can still create legacy reports without snapshots. Their reports remain
marked `not_captured`; a mixed-version rollout does **not** provide complete
report-time evidence capture. Drain older reporting nodes before claiming the
B5 evidence guarantee.

An older erasure node does not know the evidence columns. The migration's
`users` deletion trigger clears captured author ID and name when it deletes a
human account. New reporting nodes also hold `FOR SHARE` on the human `users`
row through insertion. Erasure takes `FOR UPDATE` on that row before touching
messages or reports. If erasure wins, the reporting transaction sees no user
and stores an anonymized snapshot; if reporting wins, erasure scrubs that
committed report before deleting the user. The lock and report insertion share
one transaction. A process failure rolls it back and releases the lock.
Machine principals (`system`, `bot:`, `webhook:`, `bridge:`, `crosspost:`, `ap:`)
do not have a `users` row and retain their attribution.

The 90-day post-resolution retention period, author erasure behavior, and
channel moderator visibility are proposed defaults awaiting owner approval in
#336. Do not widen access or retention during rollout.

## Rollback

Rolling back the *application* to a version without evidence capture is a
feature regression. Older nodes ignore the new columns and may create
`not_captured` reports. It is not an evidence-safe steady state.

The **schema** rollback runs in one transaction and takes `ACCESS EXCLUSIVE`
on `message_reports` before checking for evidence or missing message rows. It
refuses to drop evidence columns while any captured or scrubbed evidence exists,
and refuses to restore the cascading foreign key if any report references a
missing message. Never delete reports or clear evidence merely to make a
rollback pass. Roll forward to repair a bad deployment. Backup and restore is
a separate recovery operation and needs its own verification.

The PostgreSQL concurrency and rollback tests in
`server/tests/pg-integration/report-evidence.pgtest.ts` exercise both lock
orders, interrupted erasure, legacy-node deletion, machine attribution, and
rollback rejection. They require a real PostgreSQL 16 test database.
