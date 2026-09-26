# RUNBOOK — ROLLBACK

**The single most important rule: code rollback is not database rollback.**

Reverting the application is fast and safe. Reverting a schema change is neither. A
release that dropped a column cannot be undone by redeploying the old image — the data
is gone.

---

## 1. Decide fast

Roll back when, after a deploy:

- Error rate is materially elevated (`bridge_http_errors_total`)
- A core journey is broken (login, send message, join server)
- Health flaps or instances fail readiness
- Data is being written incorrectly — **roll back immediately**, corruption compounds

**Decide within 15 minutes.** A long partial outage is worse than a rollback.

## 2. Migration classification — do this BEFORE deploying

| Class | Example | Rollback-safe? |
|---|---|---|
| **Additive** | `ADD COLUMN IF NOT EXISTS`, new table, new index | Yes — old code ignores it |
| **Constraint relaxation** | `DROP NOT NULL` (e.g. the v1.123 `threads.parentMessageId` fix) | Yes — old code still satisfies the looser rule |
| **Constraint tightening** | `SET NOT NULL`, new `CHECK`, new `UNIQUE` | No — old code may write rows the new constraint rejects |
| **Lock-heavy** | rewriting `ALTER TABLE`, index build without `CONCURRENTLY` | Blocks writes; treat as a maintenance window |
| **Backfill** | `UPDATE` across a large table | Slow; run separately from the deploy |
| **Destructive** | `DROP COLUMN`, `DROP TABLE`, type narrowing | **Irreversible.** Only after the old code is fully retired |

### The safe pattern

```
expand   → add the new column/table, nullable, no constraint
deploy   → ship code that WRITES both old and new, READS old
backfill → populate the new shape for existing rows
deploy   → ship code that READS new
contract → (a later release) drop the old column
```

Each step is independently reversible. A release that does expand *and* contract
together cannot be rolled back.

## 3. Rolling back code only (the common case)

Safe when the release was additive or constraint-relaxing.

```bash
# redeploy the previous artifact
# verify
curl -s /api/health          # 200
```

Additive columns left behind are harmless — old code ignores them.

## 4. Rolling back across a schema change

1. **Stop writes** (maintenance mode).
2. **Backup the current state first** — even if you believe it is broken. It is
   evidence and you cannot recover it after a restore.
3. Decide:
   - **Constraint relaxation only** → redeploy old code; leave the schema. Done.
   - **Tightening / destructive** → you need `RUNBOOK-DATABASE-RESTORE.md`, and you
     will lose everything written since the backup.
4. Restore, verify integrity, cut over, resume traffic.

## 5. Verify after rollback

| Check | Expected |
|---|---|
| `GET /api/health` | `200` |
| Login | works |
| Send + receive a message with two clients | works |
| `bridge_http_errors_total` | flat |
| `bridge_active_sockets` | returns to normal |

## 6. Rollback of the v1.123 schema change specifically

v1.123 relaxed `threads."parentMessageId"` from `NOT NULL` to nullable, and added six
real column names to `pgCollection`'s `ALLOWED_COLUMNS`.

Both are **rollback-safe in the code direction**: older code never wrote `NULL` there,
so it continues to work against the relaxed schema.

The reverse is **not** safe. Re-applying `SET NOT NULL` would fail while any forum
thread exists (they legitimately have `parentMessageId = NULL`), and forcing it would
delete valid forum topics. Do not re-tighten that constraint.

## 7. Escalate when

- The previous artifact also fails → the problem is data or infrastructure, not code
- Rollback requires a restore → this is now a data-loss incident; see
  `RUNBOOK-INCIDENT.md`
- You cannot determine whether the migration was destructive → **stop and ask**.
  Guessing here loses data.
