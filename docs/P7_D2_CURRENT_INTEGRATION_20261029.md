# P7 D2 current integration candidate — OPEN, draft only

The current P7 branch had expiry preflights without the complete durable
lifecycle. This candidate combines #591 `2467131223ccc02c1d9fed61ef2c752c3fd22641`
with the corrected #375 stack `1bde050f848a9d676c84b7cf1b4b4ea4cf54ce4b`.
It preserves their commit histories through a merge commit. It does **not**
merge either PR into production main, deploy, or close #321, #209 or P7.
Any route containing #375's code to main still requires explicit owner approval.

Read [the integration plan](P7_D2_INTEGRATION_PLAN.md), including its later
object-release and source-copy corrections. Do not substitute the defective
intermediate #356/#357 heads. The complete migration sequence is preserved:

| Migration | Responsibility |
| --- | --- |
| 085 | Bounded moderation evidence |
| 086 | PostgreSQL content write barrier |
| 087 | Worker indexes |
| 088 | Report retention after channel deletion |
| 089 | Durable post-commit object-release outbox |
| 090 | Stored report visibility policy |
| 091 | Durable upload deletion reservations |
| 092 | Source-copy and final-statement write barriers |

## Resolution of the overlapping changes

Reuse the existing worker, database barriers, tombstones, cleanup graph, outbox,
deletion reservations, owner configuration, client expiry UI, report retention,
and media access/eviction code. No replacement lifecycle or new cryptosystem is
introduced. The expiry policy still derives from the canonical PostgreSQL row,
tombstone and database-clock query; preflights are not transaction fences.

The shared publisher retains #375's boolean result and final source/destination
authority, including for detached committed rows. It also retains #590's optional
caller authority after asynchronous cache invalidation. Webhooks inspect both
results: a caller-live result cannot turn refused publication into HTTP success.
That naive integration initially failed its new regression (HTTP 200 instead
of 404); the corrected path and real-PG interleaving are covered.

The newer channel-join generation, explicit leave cancellation and removal of a
refused target subscription survive. The older selection tests target that same
authority boundary; their permission, room and stale-result assertions remain.
Thread replies keep both parent preflights, with the newer terminal response
before nonce lookup. Authorized expired voice uploads use #581's 404 contract;
the inherited 403 expectation is updated to 404 plus an exact fixed error body.
Its no-write assertions remain, and an actual JWT from another tenant must still
receive 403 with no file or database write. No assertion accepts multiple outcomes.

## Reused privacy corrections

The older stack's SwiftPM build downloads a prebuilt Capacitor framework, which
bypasses the reviewed npm SDK source patch. Reuse #502's bounded corrections
`7f574386`, `8531e5d9` and `64b1c215`: CocoaPods source compilation, the unchanged
CryptoKit plugin's podspec, exact SDK-version/source-hash checking, generic native
result-payload redaction, and the mandatory real-simulator decrypt-log positive
control. The inspection marker remains confined to the Debug simulator build.
No Swift cryptography source, key format or lifetime is changed. Existing native
projects are preserved; the overlay refuses an incompatible prebuilt project.

The Redis success log still contained the previously reproduced #455 masking
bug. Reuse `63e4c01a` and its actual Pino capture tests: all three regressions fail
against the integrated masked-URL logger, then pass after configuration URLs are
omitted. Connection settings and credentials still reach Redis unchanged. The
existing masking assertion is strengthened to require omission. This is a
bounded privacy correction, not full B3 acceptance.

## Verification and limits

Local validation of the final source tree:

- Server: 13,237 tests; client: 5,667 tests; real PostgreSQL 18/Redis 7/S3-compatible
  RustFS: 436 tests; mobile assets/overlay: 149 tests; iOS Node harness: nine tests.
  All executed with zero failed/skipped tests. Client all-source and production-
  reachable S/B/F/L coverage gates remain at 90% and pass.
- Redis follow-up: 64 unit and 15 real Redis cache/SFU ownership controls pass,
  zero failed/skipped. Totals overlap the complete suites; do not sum them.
- All 92 migrations apply. Independent fresh and upgraded databases match all
  seven catalogs: columns, constraints, indexes, functions, triggers, table
  access and policies. Upgrade from deployed-main `c061d72f` preserves the seeded
  user/server, two channels, two messages and report data by hash. The permanent
  channel remains live; the expired legacy channel is unreadable.
- Ordered rollback/roll-forward gate: no problems. Its classifications are
  73 lossless, 15 expected dependency, one expected irreversible and three shared-
  object cases, plus the ordered chain check. This is not permission to delete
  pending release entries or retained evidence. Migration classifications and
  rollback safety conditions are unchanged.
- Four locked dependency audits retain the high-severity threshold and pass;
  low findings remain root/server/Electron/E2E 7/6/6/0, with no moderate or higher
  finding. Fresh locked root dependency installation succeeds.

The first mobile fixture run had 22 unexecuted shell tests because `www/` was
absent. Building the actual client and mobile assets precedes the final 149/149
run; skipped fixtures are not counted as passing. Initial integration assertion
failures are preserved. No retries, timeout increases, relaxed coverage or audit
exceptions were introduced to make this candidate green.

Local S3 tests use the real static RustFS binary from the same cached official
`rustfs/rustfs:1.0.0-rc.6` image as CI, with isolated public/private buckets. This
avoids exhausting the small VFS workspace with another container. It proves the
S3-compatible protocol, not MinIO-specific deployment or production throughput.

New-head CI, actual Android/iOS expiry journeys, native log privacy, cluster and
federation convergence and required reviews remain independent gates. A native
build or OS-open smoke is not a lifecycle journey. Modified direct P2P peers
cannot be forced to revoke an established connection merely by an eviction event;
the existing media document records that residual. Production-scale expiry/S3
latency, physical devices and the other P7 pillars remain unqualified. The voice
upload rollback still uses best-effort physical deletion before persistence;
failed-delete and process-crash compensation require a separate fault-injection
proof and must not be counted as covered by the committed-object release outbox.
Main and
#375 remain unchanged; no full D2/P7 acceptance is claimed from this draft.
