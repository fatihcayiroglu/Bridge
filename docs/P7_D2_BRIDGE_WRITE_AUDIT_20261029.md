# P7 D2 bridge forwarding expiry boundary

Base: #589 `7e07b104c2af416216a71f281152cfe69e0dae27`. P7 and #321 remain
OPEN. Existing branches and the uncommitted SFU prototype are preserved.
No main merge, deployment, Android source change or Abuse Lab change.

## Reproduction and correction

The production Socket.IO send handler checked the source's availability but
forwarded into an expired receiving channel. A durable receiver tombstone or
expiry during target moderation also failed to stop the copy. A later expiry
did not stop the copy's `message:new` and `channel:activity` publication.

Before correction, the entire existing send unit suite plus six regressions
reported 99 PASS / 6 FAIL / 0 skipped. The actual PostgreSQL/Redis reproduction
reported 1 permanent-channel control PASS / 5 FAIL / 0 skipped. These first
failures are retained; no retries or assertion changes made them pass.

Reuse `channelWriteAvailability` and its canonical live-row, tenant, tombstone
and database-clock query for **both** channels. Recheck before target moderation,
after moderation, and after receiving-history cache invalidation immediately
before synchronous publication. Refuse gone or unverifiable authority. A refused
copy preserves the source, and other valid destinations can continue. Keep the
existing target AutoMod and source/target tenant checks.

If expiry follows a committed copy, suppress publication and retain that row.
Deleting the row here would conceal the unresolved transactional boundary and
could bypass later cleanup/retention rules. No external storage operation is added.

## Verification and limits

Local final D2 and adjacent unit set: **430 PASS / 0 FAIL / 0 skipped**. The seven added send-unit
cases cover expired/corrupt/unverifiable receivers, a permanent sibling, source
or receiving expiry during moderation, and expiry after persistence or during
cache invalidation. Three shared-publisher controls additionally require final
authority after invalidation and suppress both events on refusal or failure.
Existing assertions remain. The source contract now requires the canonical
publisher with its final authority callback, preserving the existing cache owner.

Local actual PostgreSQL **18** / Redis 7: **24 PASS / 0 FAIL / 0 skipped**,
including the existing 15 scheduling/voice/thread/join cases and nine new bridge
cases. New cases include permanent and live-expiring controls, a stale permanent
DTO against expired SQL, durable tombstone precedence, tenant mismatch, both
moderation interleavings, committed-copy preservation and actual Redis cache
invalidation. Wrappers execute the real operation before mutating actual SQL.
Only socket recipients are transport doubles; this is not authenticated wire E2E.

The existing mandatory CI workflow retains PostgreSQL **16** and Redis 7 and now
executes both integration files with the zero-skips checker. Local PostgreSQL 18
does not substitute for that exact-head PostgreSQL 16 result. The isolated local
16 image could not fit the workspace; only that newly created failed disposable
container/image was removed. Existing databases, volumes and work were untouched.

Production types, strict test types (zero new debt) and build are required before
push. Release-integrity: **223 PASS / 0 FAIL / 0 skipped**. Its first run caught
the bypass of the canonical cache/publication owner and an inherited forbidden
palette literal in the scheduling fixture. The owner is now retained, the
publication contract strengthened, and only that fixture's color changed; no
assertion, skip rule or allowed-color list was weakened. Four locked dependency
audits pass at the unchanged high-severity threshold: 7/6/6/0 low findings remain
in root/server/Electron/E2E, respectively, with no moderate/high/critical finding.

These are repeated preflight checks, **not** expiry-versus-commit serialization.
There remain windows between the SQL check and insertion or publication. The
corrected database barrier already exists in the older #362/#375 integration
history; do not recreate it or cherry-pick defective #356. Preserve its reviewed
migration sequence and integration requirements in a separate qualified unit.
No expiry activation, cleanup worker, offline/federation convergence, full writer
graph, cross-node socket eviction or representative performance is claimed here.
The three guard phases add six channel availability queries per attempted copy;
production latency/throughput has not been qualified.
