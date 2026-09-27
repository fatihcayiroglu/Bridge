# RUNBOOK — DATABASE RESTORE

**Severity:** SEV-1 when data is lost or corrupted.
**Prerequisite:** a backup archive produced by `backup/backup.sh`.

This procedure was **executed and verified** in v1.123 (see `BACKUP-RESTORE.md`).

---

## Symptoms

- Data missing or visibly wrong after an incident or bad migration
- PostgreSQL will not start, or reports corruption
- Application boots but core reads fail

## Before you touch anything

1. **Stop writes.** Scale the application to zero or put it in maintenance. Restoring
   under live traffic produces a split-brain dataset that is worse than the outage.
2. **Take a snapshot of the damaged database anyway.** It is evidence. A restore
   overwrites it and you cannot get it back.
   ```bash
   pg_dump -U bridge -d bridge | gzip > /backups/FORENSIC_$(date +%Y%m%d_%H%M%S).sql.gz
   ```
3. **Identify the target archive** and confirm it predates the damage.
   ```bash
   ls -la /backups/postgres/
   ```

## Restore

Restore into a **new, empty** database first. Never restore over a live one — if the
archive turns out to be bad you still have a running system.

```bash
# 1. create an empty target and CONFIRM it is empty
psql -U bridge -d postgres -c "CREATE DATABASE bridge_restore_$(date +%Y%m%d);"
psql -U bridge -d bridge_restore_YYYYMMDD -tAc \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';"   # must be 0

# 2. restore
gunzip -c /backups/postgres/bridge_<timestamp>.sql.gz \
  | psql -U bridge -d bridge_restore_YYYYMMDD -q

# 3. restore uploads (AFTER the database — see BACKUP-RESTORE.md §5)
rsync -a /backups/uploads/ /app/server/uploads/
```

## Verify before cutting over

Do not point production at the restored database until all of these pass.

```bash
# row counts across populated tables
psql -U bridge -d bridge_restore_YYYYMMDD -tAc \
  "SELECT relname||'='||n_live_tup FROM pg_stat_user_tables WHERE n_live_tup>0 ORDER BY relname;"

# referential integrity — all three MUST be 0
psql -U bridge -d bridge_restore_YYYYMMDD -tAc "
  SELECT COUNT(*) FROM members m LEFT JOIN servers s ON s._id=m.\"serverId\" WHERE s._id IS NULL;
  SELECT COUNT(*) FROM channels c LEFT JOIN servers s ON s._id=c.\"serverId\" WHERE s._id IS NULL;
  SELECT COUNT(*) FROM messages m LEFT JOIN channels c ON c._id=m.\"channelId\" WHERE c._id IS NULL;"
```

Then start **one** Bridge instance against the restored database and confirm:

| Check | Expected |
|---|---|
| `GET /api/health` | `200` (measured cold start: ~3.4 s) |
| Login with an existing account | `200` — proves password hashes survived |
| Server list | populated |
| Channel list for a server | populated |
| Messages readable | `200` |
| Permission/membership resolution | `200` — proves roles and positions survived |
| A write (create a channel) | `201` — proves the DB is not read-only |

Login and permission resolution are the two that matter most: row counts can look
perfect while credentials or role positions are unusable.

## Cut over

1. Point `DATABASE_URL` at the restored database.
2. Start one instance, verify, then scale up.
3. Keep the damaged database for at least 7 days.

## Recovery expectations

| Measured (small dataset, v1.123 drill) | |
|---|---|
| Restore | 1.3 s |
| App recovery | 3.4 s |

**These scale with data volume.** Do not quote them as production figures.
Targets: **RPO 24 h**, **RTO 1 h** — the hour is human decision time, not machine time.

## Escalate when

- The archive fails to restore (non-zero errors) → try the previous archive
- Integrity checks return non-zero orphans → do not cut over; investigate
- No archive predates the damage → this is data loss; move to incident communication

## Known gap

There is **no automated restore verification job**. Until one exists, this runbook is
only as trustworthy as the last time a human ran it. Schedule a monthly drill into a
scratch database.
