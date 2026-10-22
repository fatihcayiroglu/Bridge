# P7 D2 — measured expiry performance (issue #321)

Measured with `server/scripts/bench-channel-expiry.ts` on **real PostgreSQL**,
the production worker code and real local-disk objects. Reproduce on a
disposable database:

```bash
BENCH_DATABASE_URL=postgresql://.../bench NODE_ENV=production \
  npx ts-node --transpile-only --project server/tsconfig.json \
  server/scripts/bench-channel-expiry.ts 50000 500
```

**Environment (2026-10-22):** 4 vCPU Linux container, PostgreSQL 16.15 on the
same host, default configuration, local-disk uploads. These are not production
numbers: storage latency, `shared_buffers`, network round trips to S3/MinIO and
concurrent load all change them. They show *shape* (what is bounded, what grows)
and give an order of magnitude.

## Dataset

The expiring channel holds N messages (10% with an attachment file), N/100
threads, N/5 thread replies and N/10 notifications. A permanent sibling channel
keeps writing during the drain. For the "large instance" row, another 1,000,000
messages (100,000 with attachments) live in an unrelated channel.

## Results

| Metric | N = 50,000 | N = 200,000 | N = 50,000 + 1M live rows |
|---|---|---|---|
| Claim transaction (tombstone only) p50 / max | 0.9 / 2.9 ms | 1.1 / 4.0 ms | 1.3 / 4.2 ms |
| Expiry → tombstone committed | 4 ms | — | 6 ms |
| Cleanup pass (batch 500 per table) p50 / p95 / max | 16.6 / 24.2 / 39.5 ms | 19.7 / 37.3 / 73.1 ms | 17.1 / 25.4 / 97.1 ms |
| Database graph drained | 1.8 s | 8.5 s | 1.9 s |
| Sibling-channel insert during drain p50 / p95 / max | 0.68 / 1.21 / 12.9 ms | 0.76 / 1.29 / 27.6 ms | 0.72 / 1.28 / 11.3 ms |
| Objects queued → released | 5,000 in 21.3 s (4.3 ms each)¹ | 20,000 in 94.8 s (4.7 ms each)¹ | 5,000 in 13.0 s (2.6 ms each)² |
| Expiry → fully converged (rows + objects) | 23.1 s | 103.3 s | 14.9 s |

¹ Before the batched reference check: one `hasLiveUploadReference` scan per object.
² With `liveUploadReferenceKeys`: one scan per leased batch.

**Write barrier.** The same 300 inserts in one transaction on a permanent
channel: p50 0.40 ms with the trigger, 0.26 ms without (+0.14 ms; p95 0.83 vs
0.57 ms). An earlier draft compared autocommit with a single transaction and is
superseded by this run.

**Reference check scaling (the one non-bounded cost found).** With 1M live
messages, one `hasLiveUploadReference` call for an object nothing references
(the normal release case) took **~52 ms p50**, because the check is a suffix
match over every upload column. Releasing 20k objects one by one would spend
about 17 minutes in sequential scans. `liveUploadReferenceKeys` answers a whole
leased batch from one scan (400 keys in ~270 ms, about 0.7 ms per key), with
identical semantics proven by a real-PG equivalence test over 13 URL shapes.

## What is bounded

- **Claim:** constant work per channel (row lock + tombstone insert). It no longer
  deletes the channel row, so FK cascades never run inside it.
- **Cleanup pass:** at most `batchSize` rows per table per transaction; p95 stays
  within tens of milliseconds as the channel grows 4×.
- **Sibling writers:** p95 insert latency on a busy permanent channel stays
  ~1.2–1.3 ms during the drain (the worker locks only the tombstone row and the
  batches it deletes; writers take `FOR KEY SHARE` on their own channel row).
- **Objects:** at most `maxObjectReleases` (default 50) per tick, leased, so a
  large channel spreads its object deletions over ticks instead of one burst.

## Time to expiry, end to end

`expiresAt` → read/write denial is immediate (read preflights and the write
barrier compare against the database clock), independent of the worker. The
worker tick runs every 60 s, so the tombstone is written at most ~60 s after
`expiresAt` (4–6 ms of work). At the default 50 cleanup passes and 50 object
releases per tick, a 50k-message channel drains in one tick and releases its
5,000 objects over ~100 ticks (bounded by `maxObjectReleases`, not by
PostgreSQL); raise `maxObjectReleases` where storage throughput allows.

## Lock impact, upgrade and rollback

- **086 (write barrier):** `CREATE TRIGGER` takes a brief `SHARE ROW EXCLUSIVE`
  lock on `messages`, `thread_messages`, `threads`; no rewrite.
- **087, 089:** new partial indexes / new table. 087's indexes are on
  `channels`/`channel_expiry_tombstones` (small); 089 creates an empty table.
- **088:** drops one FK constraint: a brief `ACCESS EXCLUSIVE` lock on
  `message_reports`, no rewrite, no validation scan.
- **Rollback:** each down script refuses instead of destroying data. 088 refuses
  while reports point at missing channels (it would have to delete them); 089
  refuses while objects are pending release. The ordered rollback gate runs the
  full chain down and up again with 0 lost / 0 extra objects.

## Not measured here

S3/MinIO object latency (the S3 suite proves correctness against an
S3-compatible bucket, not throughput), multi-node contention beyond the
four-worker race in `channel-expiry-worker.pgtest.ts`, and production-sized
`message_reports`/`notifications` tables.
