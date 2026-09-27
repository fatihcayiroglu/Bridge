# BACKUP & RESTORE — Bridge v1.123

**Status: EXECUTED + VERIFIED.** The procedure below was performed end-to-end on
disposable infrastructure during the v1.123 release pass. Every number is measured,
not estimated. No production system was touched.

---

## 1. What is durable

| Data | Store | Authoritative source | Backed up by |
|---|---|---|---|
| Accounts, servers, channels, messages, threads, polls, scheduled messages, prefs, moderation, federation keys | PostgreSQL | PostgreSQL | `pg_dump` |
| Uploads, avatars, banners, attachments, stickers, Soundboard audio | Filesystem (`server/uploads/`) or object storage | Filesystem / S3-compatible | `rsync` (prod) / archive |
| Sessions (refresh tokens) | PostgreSQL | PostgreSQL | `pg_dump` |
| Rate-limit counters, presence, socket leases, caches | Redis | **Not durable — deliberately** | *Not backed up* |

**Redis is a cache and coordination layer, not a backup target.** Losing it costs
counters and presence, both of which rebuild. Treating it as durable state would be a
mistake: nothing in Redis is the sole copy of anything.

---

## 2. Supported method

`backup/backup.sh` (already in the repo) performs:

```bash
pg_dump -h postgres -U bridge -d bridge | gzip > bridge_<timestamp>.sql.gz
rsync -a --delete /app/server/uploads/ /backups/uploads/
# optional: aws s3 cp <dump> s3://$S3_BUCKET/postgres/
find /backups/postgres -name "*.sql.gz" -mtime +${BACKUP_KEEP_DAYS:-7} -delete
```

---

## 3. Measured drill (v1.123)

### 3.1 Dataset

The source database held real API-created data — not synthetic rows. Seeding used
the product's own endpoints wherever one exists (forum thread `201`, poll `200`,
scheduled message `200`, podcast settings `200`, notification preference `200`,
boost `200`).

**33 populated tables**, including every entity class the release brief requires:
users, refresh tokens, servers, members, roles (with positions), channels, forum
threads + thread messages, messages, replies, reactions, DM and group-DM
conversations/members/messages, invites, audit logs, uploads, notification
preferences, scheduled messages, polls, podcast settings, soundboard + per-user
soundboard stats, unread counts, boosts, channel permission overrides, WebAuthn
credentials, badges, and federation actor keys.

### 3.2 Backup

| Metric | Measured |
|---|---|
| Method | `pg_dump … \| gzip` |
| Duration | **615 ms** |
| Size (compressed) | **73,057 bytes** |
| Uploads archive | **122 ms**, 307 files |

### 3.3 Restore

Target database was **created empty and verified empty** (`0` tables in
`information_schema`) before restoring — so nothing could be inherited from the
source.

| Metric | Measured |
|---|---|
| Restore duration | **1,283 ms** |
| Restore errors | **0** |
| Uploads restore | **212 ms** |

### 3.4 Validation

**Row counts: all 33 tables identical**, source vs restored (exact `diff`).

**Referential integrity:**

| Check | Result |
|---|---|
| FK constraints present | 34 |
| Orphan members (no server) | 0 |
| Orphan channels (no server) | 0 |
| Orphan messages (no channel) | 0 |
| Forum threads with `parentMessageId IS NULL` (the v1.123 fix) | 5 |
| Podcast rows with `language` (the v1.123 fix) | 4 |
| `threads.locked` column present | yes |
| Roles with position | 6 |
| Reply messages | 6 |
| Messages carrying reactions | 85 |

**Uploads: byte-for-byte.** Aggregate SHA-256 over all 307 files was identical
before and after (`ab91f8a9db566ab3…`).

### 3.5 Application recovery

Bridge was started **against the restored database** (confirmed via
`DATABASE_URL = <ortamdan>` and a marker row written only into the restored copy,
then read back through the API).

| Metric | Measured |
|---|---|
| Boot to `GET /api/health` = 200 | **3,409 ms** |

**API smoke on restored data: 11/11 passed.**

| Check | Result |
|---|---|
| Login using a restored password hash | PASS |
| Server list readable (44 servers) | PASS |
| Serving from the restored DB (marker visible) | PASS |
| Channels readable | PASS |
| Messages readable | PASS |
| Forum threads readable, `parentMessageId = null` | PASS |
| Polls readable | PASS |
| Scheduled messages readable (5) | PASS |
| `/unread` works on restored data | PASS |
| Membership / permission resolution works | PASS |
| Restored DB accepts **writes** | PASS |

Login and permission resolution matter most here: they prove password hashes,
role positions and membership rows all survived in a *usable* form, not merely as
row counts.

---

## 4. RPO / RTO

Clearly separated, as required.

### MEASURED (this drill, small dataset)

| Metric | Value |
|---|---|
| Backup duration | 0.6 s |
| Restore duration | 1.3 s |
| App recovery after restore | 3.4 s |
| **Total technical recovery** | **≈ 5.3 s** |
| Data loss window | **0** (dump taken at a quiescent point) |

### RECOMMENDED INITIAL TARGETS (private beta)

| Target | Value | Basis |
|---|---|---|
| **RPO** | **24 hours** | A nightly `pg_dump` is the only schedule proven here. |
| **RTO** | **1 hour** | Technical recovery is seconds; the hour is for human detection, decision and DNS/deploy steps. |

**These are TARGETS, not guarantees.** The measured drill used a ~73 KB dump. Restore
time grows with data volume, and these numbers say nothing about a multi-gigabyte
production database. Re-measure once real data volume exists.

To improve RPO below 24 h, PITR (WAL archiving) is required — `pg_dump` alone cannot
do better than its schedule interval.

---

## 5. Ordering (uploads vs database)

Restore **database first, then uploads**.

A message row referencing a missing file degrades to a broken attachment. A file with
no row is invisible and harmless. So the DB is the constraint, and uploads may lag it
without producing a worse failure. Never restore uploads *without* a matching DB —
that produces orphaned storage that nothing will ever clean up.

---

## 6. Known gaps

- **Object storage (S3/R2) backup was not executed.** No provider is configured
  locally; only the filesystem path was verified.
- **PITR / WAL archiving is not configured.** RPO is bounded by dump frequency.
- **Restore has not been timed at production data volume.**
- **No automated restore verification job.** The drill was manual; a scheduled
  "restore into a scratch database and run the smoke script" job is the obvious
  next step and would keep this document honest over time.
