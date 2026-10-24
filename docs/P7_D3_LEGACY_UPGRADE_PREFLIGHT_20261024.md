# P7 D3 — fail-closed upgrade-source preflight (2026-10-24)

This narrow guard is the first safety boundary for the owner's decision to support
**staged, verified upgrades with no loss of existing user data**. It does **not**
implement or certify a v1.122.0 migration. It is stacked on #382, whose
PostgreSQL 16.15 measurements show that direct boot fails on v1.122.0 and that
running the chain first fails at 046 after earlier commits. The staged probe
still leaves eight schema differences and a measured write-blocking index build.

## Paths guarded

- **Normal boot:** `db/postgres/index.ts` takes its existing schema advisory
  lock, calls `verifyUpgradeSource`, and only then starts `SCHEMA`, inline
  migrations and the numbered chain.
- **Manual CLI:** `db/migrate-postgres.ts` checks before
  `ensureMigrationsTable`, including the mutating `up`, `down`, and
  `rollback` commands (and `status`, which already creates the ledger).
- Both checks use read-only `SELECT` statements. Database errors and
  unsupported shapes stop execution. No fallback or skip is permitted.

A fresh schema (neither `users` nor `messages` present) proceeds to normal
new-install boot. An existing schema must have:

1. Both base tables, `users.ssoProvider`, `messages.ackId`, and a **nullable** `messages.embeds` column (the measured staged-release shape incorrectly leaves it `NOT NULL`).
2. A migration ledger with **084 applied and not rolled back**. This is the
   exact previous-main baseline measured in #382. Partial v1.122.0 attempts
   that applied 001–045 must be refused even if their columns now exist.

Other schema anomalies may still be found by later SQL and will fail normally.
These markers are a **minimum rejection filter**, not schema equivalence,
release provenance, backup verification or proof that an upgrade is safe.

## Operator handling

A rejected installation reports `BRIDGE_UPGRADE_SOURCE_UNVERIFIED` and names
missing markers. Preserve the database as-is. Do not run a speculative CLI
migration or copy it into a new production schema. Take an independently
restorable backup, perform preflight and reconciliation on an isolated copy,
and require full rollback/roll-forward and data-parity evidence before
authorizing an in-place production transition.

A supported v1.122.0 path still requires:

- a version-specific, read-only inventory and backup/restore drill;
- staged schema+inline+versioned steps with explicit transaction boundaries;
- all eight schema differences from #382 reconciled without data loss;
- index 027 write-lock mitigation or planned maintenance evidence;
- failure injection, rollback/roll-forward, post-upgrade parity and application
  read/write acceptance on realistic row volumes.

## Tests and release status

`server/tests/p7-d3-upgrade-preflight.test.ts` covers empty/current/legacy/
partial sources, a legacy 001–045 ledger, staged 084 schema drift, read failures
and the no-DDL contract. `server/tests/pg-integration/upgrade-source-preflight.pgtest.ts`
adds rollback-only real-PostgreSQL controls for current, legacy, partially
migrated and 084-complete but incompatible schemas. Exact-head CI and a real PostgreSQL before/after dry run must pass
before integration. Keep this branch draft and **do not merge it directly to
main**. Merge only after #382 review and the applicable code-owner approval.
