# P7 D3: measured lock and runtime evidence for migrations 085–092 (2026-10-24)

D3 asks for per-migration lock and runtime evidence on real PostgreSQL. Two
things were already measured on the D2 candidate (PR #375):
- the ordered rollback gate: 085–092 each `LOSSLESS_PASS`;
- a database upgraded from `main` (084) has a schema identical to a fresh one.

This adds what was missing: what each migration **locks** and for how **long**
at realistic table sizes, and what a concurrent writer experiences meanwhile.
`P7_D2_PERFORMANCE.md` reasoned about 086–089 and listed production-sized
tables as not measured.

## Method

`server/scripts/p7-d3-migration-lock-evidence.cjs` (reproducible):
1. **Pre-migration schema:** a disposable database built by `main`'s own code
   (`c061d72f`, migration 084), with no D2 migration applied.
2. **Synthetic data** (`--populate`; no personal data): users, servers,
   members, channels, `messages`, `message_reports`, `threads` and
   `thread_messages`, with valid foreign keys. Then `ANALYZE`.
3. **Apply exactly as production does**
   (`versionedMigrations.ts applyPendingMigrations`): one transaction per file,
   recorded in `schema_migrations`.
4. **Locks:** just before each `COMMIT`, every relation lock the migration
   still holds, read from `pg_locks`. These are held for the whole
   transaction; the strongest mode per table is reported.
5. **A concurrent writer** on a second connection keeps inserting a message
   plus a report (into `messages` and `message_reports`) every 5 ms. The
   slowest write overlapping each migration is reported, so a lock that blocks
   writers shows as measured latency.

Environment: PostgreSQL 16.15 on a local cloud VM (CI uses 18). The numbers
are relative evidence on one machine, not a production SLA.

## Results

Run 1: 2,000,000 messages, 200,000 reports, 50,000 channels, 20,000 threads,
200,000 thread messages. Baseline write (message + report): p50 1.98 ms,
p99 3.20 ms.

Run 2: 5,000,000 messages, 1,000,000 reports, 50,000 channels, 20,000 threads,
500,000 thread messages. Baseline write: p50 2.03 ms, p99 9.13 ms.

| Migration | Run 1: time / worst concurrent write (ms) | Run 2: time / worst concurrent write (ms) | Locks held until commit (strongest) |
|---|---:|---:|---|
| 085 report evidence | 86.6 / 83.6 | **320.7 / 320.9** | `message_reports`, `messages`: ACCESS EXCLUSIVE; `users`: SHARE ROW EXCLUSIVE |
| 086 write barrier | 4.7 / 3.8 | 4.3 / 3.4 | `messages`, `thread_messages`, `threads`: SHARE ROW EXCLUSIVE |
| 087 expiry indexes | 11.7 / 2.2 | 16.4 / 5.6 | `channels`, `channel_expiry_tombstones`: SHARE |
| 088 report retention | 3.4 / 3.1 | 2.9 / 1.9 | `message_reports`, `channels`: ACCESS EXCLUSIVE |
| 089 release outbox | 8.2 / 2.3 | 9.5 / 2.3 | new table only |
| 090 report visibility | 25.5 / 22.3 | **105.4 / 106.6** | `message_reports`: ACCESS EXCLUSIVE |
| 091 upload reservations | 9.8 / 7.0 | 9.2 / 2.9 | 13 upload-referencing tables incl. `messages`, `users`, `servers`, `uploads`: SHARE ROW EXCLUSIVE; new `upload_release_keys` |
| 092 copy-source barrier | 4.4 / 2.1 | 3.3 / 2.1 | `messages`: SHARE ROW EXCLUSIVE |

## Reading the results

- **Six of eight are constant-time.** 086, 087, 088, 089, 091 and 092 do not
  scale with data. They create triggers and functions, drop one foreign key,
  create small indexes and new tables, and finish in 3–16 ms. Their
  write-blocking locks (SHARE ROW EXCLUSIVE, SHARE) are held for that long.
  - 087's indexes are on `channels` and `channel_expiry_tombstones`, and are
    not built `CONCURRENTLY`. At 50,000 channels the build takes 12–16 ms.
- **085 and 090 scale with `message_reports`.** Each adds a validated `CHECK`
  constraint, which scans the table while holding ACCESS EXCLUSIVE. 085 also
  drops the report→message foreign key, so `messages` is locked ACCESS
  EXCLUSIVE for the same time.
  - From 200k to 1M reports, 085 went from 87 to 321 ms and 090 from 26 to
    105 ms: roughly linear.
  - Concurrent writes to `messages` and `message_reports` waited exactly that
    long (83.6 → 320.9 ms), then resumed.
  - By linear extrapolation, a deployment with **about 10M reports** would
    pause writes to `messages` for **about 3 s** during 085. That is an
    estimate, not a measurement.
- **Mitigation, if a deployment's `message_reports` is that large:** run the
  `CHECK`s as `ADD CONSTRAINT … NOT VALID` followed by a separate
  `VALIDATE CONSTRAINT`. Validation takes only SHARE UPDATE EXCLUSIVE, which
  does not block writes. This is not applied to 085/090 here: they belong to
  the reviewed D2 stack, and at the sizes measured the pause is well under a
  second. Revisit before upgrading an instance with millions of reports.
- **No migration rewrites `messages`**; none holds a write lock on it for more
  than about 10 ms except 085 (above).
- **Rollback:** the ordered gate proves 085–092 roll back losslessly, measured
  on the candidate. The down scripts refuse rather than destroy data (088:
  reports pointing at missing channels; 089: objects pending release).

## Not covered

- Production hardware, network-attached storage, replication lag, and tables
  above 5M messages / 1M reports.
- A migration racing an expiry worker. The worker uses its own row locks; the
  migrations above run before the new code serves traffic.
- `lock_timeout` behaviour. The runner sets none, so a long-running query
  holding a conflicting lock delays a migration rather than failing it.

Reproduce:

```sh
# a disposable database at the pre-migration schema (main's code, 084), then:
PG_URL=postgresql://user@host:port/disposable \
  node server/scripts/p7-d3-migration-lock-evidence.cjs --populate \
  --messages 2000000 --reports 200000 --json d3.json
```
