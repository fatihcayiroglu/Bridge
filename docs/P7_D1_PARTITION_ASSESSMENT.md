# P7 D1 — read-only PostgreSQL scale assessment

**Status: NOT CLOSED.** Measured evidence and a recommendation (no partition) are in [P7_D1_PARTITION_DECISION.md](P7_D1_PARTITION_DECISION.md). This is a reproducible evidence collection tool, not a conclusion that partitioning is necessary, nor proof of good performance.

Run from the repository root against a representative **PostgreSQL instance** after normal migrations. Use a **read-only database role**; the script itself also starts `BEGIN TRANSACTION READ ONLY`, sets a 5-second statement timeout and a 1-second lock timeout. It does not use `EXPLAIN ANALYZE`, run `COUNT(*)` on large tables, alter schema or print any message content or IDs. Example:

```bash
cd server
P7_D1_READ_ONLY_ACK=I_UNDERSTAND DATABASE_URL='postgresql://readonly:***@host:5432/bridge' \\
  node scripts/p7-partition-assessment.cjs > p7-d1-evidence.json
node --test scripts/p7-partition-assessment.test.cjs
```

The output includes estimated table rows, live/dead tuple stats, table/index bytes, basic analyze presence, index scans and a bounded, redacted `EXPLAIN (ANALYZE FALSE)` shape for (1) message channel cursor reads and (2) member server paging. By default, plan probes use artificial IDs; `inputKind=synthetic` is not representative. To plan for real row distributions, optionally supply **existing** `P7_CHANNEL_PROBE_ID` and `P7_SERVER_PROBE_ID` in environment variables. Those values never appear in output. Do not upload raw database logs or client records.

**Cautions:** PostgreSQL's `reltuples=-1` means no usable estimate exists; the collector emits `estimatedRows: null` rather than falsely claiming zero rows. Index scan counts reset with PostgreSQL statistics; row counts are estimates and may be stale. EXPLAIN costs are planner estimates, **not measured latency**, and this tool does not run load, lock-impact, retention, write-rate, or migration rollback benchmarks. No partition/no-partition decision is made automatically. If live plans or sizes warrant partitioning, separately test uniqueness/FK behavior, pruning, rolling deployment and rollback with production-shaped data before accepting D1.

**Remaining acceptance:** capture one named representative production-like dataset, indexed row sizes/time trends, actual hot query p50/p95 latencies and writes, lock impact, and a recorded yes/no partition decision with tradeoffs. Attach run IDs, test failures and rollback evidence to P7 closure ledger. Existing D2/D3 and Android #209 remain open.
