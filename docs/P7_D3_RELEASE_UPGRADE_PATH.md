# P7 D3: the upgrade path from the last tagged release (2026-10-24)

D3 asks for per-migration forward-path evidence. The project's upgrade evidence
so far starts from **the previous build of `main`**, not from a release.
`P5_FEDERATION_AI_SELFHOSTING.md` E-02 explains why: v1.122.0, the only tagged
release, returns 500 from `POST /api/register` on a fresh PostgreSQL install.
That choice was recorded as a judgement and never measured. This document
measures it.

**Result:** current `main` cannot start on a database created by v1.122.0, and
no reordering of today's boot steps fixes that alone. A staged sequence does
reach the current chain. It leaves 8 schema differences from a fresh install
and takes one 35 s write-blocking step at 2M messages. Whether v1.122.0
installations are supported is an **owner decision**; options are below. No
code path changes here.

## Method

All of it runs on disposable databases, on PostgreSQL 16.15 with 4 CPUs.
1. **Release state.** A worktree at tag `v1.122.0` (`e66aa68e`) boots a new
   database with its own `db/postgres/index.ts`. That release's boot runs
   `schema.ts` and its inline steps; it does not run the versioned chain.
   Its documented CLI, `node db/migrate-postgres.js up`, **fails on a fresh
   v1.122.0 install** at `006_move_ap_private_key.sql`
   (`column "apPrivateKey" does not exist`) after applying 001–005. So the
   state measured here is boot-only, the state every v1.122.0 install has.
2. **Rows.** `server/scripts/p7-d3-release-populate.sql` adds synthetic rows
   with no personal data:
   - 20,000 users, 100 servers, 20,000 members and 5,000 channels;
   - 2,000,000 messages (10% of them quoting another message);
   - 20,000 threads and 200,000 thread replies;
   - 10,000 DM conversations and 500,000 DM messages;
   - 500,000 notifications.

   This snapshot is the template for every run below.
3. **Probe.** `server/scripts/p7-d3-release-upgrade-probe.ts` runs in three
   modes, against `d3_*` databases only:

| mode | what it does |
|---|---|
| `schema-check` | each `schema.ts` statement under its own SAVEPOINT in one transaction that is rolled back; lists the refusals |
| `chain-first` | the pending versioned chain with no schema pass first, one transaction per file as production applies it |
| `staged` | tolerant schema pass, inline steps, chain (per-file times), then the strict schema pass and inline steps exactly as boot runs them |

A real boot of current code was run as well (`db/postgres/index.ts` with
`BRIDGE_AUTO_MIGRATE=true`), with a second connection inserting a message every
5 ms.

## Findings

### 1. Current boot fails on a v1.122.0 database

Boot runs all of `schema.ts` as **one query** (one implicit transaction,
verified: a failing multi-statement query leaves nothing behind) **before**
the versioned chain. On the release database the real boot logged
`Schema hatası` (`42703`) 0.35 s into the schema pass and exited 1; nothing was
applied.

`schema-check` lists every refusal: **22 of 169 statements**, all `42703`
(missing column). The release already has each of these tables, so
`CREATE TABLE IF NOT EXISTS` skips them, and the index then names a column that
only the versioned chain or an inline step adds:

| table.column (missing) | refused index |
|---|---|
| `users.ssoProvider` | `idx_users_sso_identity_unique` |
| `messages.ackId` | `idx_messages_user_ack` |
| `messages.autoModAlert` | `idx_automod_alert_flagged_msg` |
| `dm_messages.clientNonce` | `idx_dm_messages_client_nonce` |
| `thread_messages.clientNonce` | `uq_thread_messages_delivery_nonce` |
| `scheduled_msgs.failedAt` | `idx_sched_dispatch_due` |
| `notifications.activityId` / `messageId` / `channelId` | `idx_notifications_activity`, `idx_notifications_inbox_message`, `idx_notifications_inbox_channel` |
| `podcast_settings.channelId`, `podcast_episodes.channelId` | `idx_podcast_settings_channel`, `idx_podcast_episodes_channel`, `idx_podcast_episodes_published` |
| `ap_activities.*` (5), `ap_messages.*` (2), `ap_likes`, `ap_announces`, `ap_delivery_queue` | 10 ActivityPub indexes |

**Control:** on a database built by current `main`, `schema-check` refuses
0 of 169 statements and `chain-first` finds 0 pending files.

### 2. Running the chain first does not help either

`chain-first` applies 001–045, then stops at
`046_activitypub_message_visibility.sql`
(`column "targetUserId" does not exist`). Files in the chain depend on objects
that only the schema pass or the inline steps create. Neither order of today's
two steps works alone.

### 3. A staged sequence reaches the current chain

The `staged` mode runs:
1. a tolerant schema pass, skipping the 22 refusals;
2. the inline steps;
3. the chain;
4. the strict schema pass, which is boot's single query and now refuses nothing;
5. the inline steps again.

It applied all 84 pending files. It took 42.8 s in one run and 47.5 s in
another (the second ran on the 094 branch, 85 files).

| file | time at 2M messages |
|---|---|
| `027_search_index_alignment.sql` | 34.5–36.2 s (three runs) |
| `057_authentication_security_state.sql` | 0.72–0.78 s |
| `067_inbox_watch_attention.sql` | 0.53–0.59 s |
| `024_unified_inbox.sql` | 0.53 s |
| every other file | under 0.4 s |

027 builds five GIN indexes in one transaction: the unaccented full-text index
on messages, DMs and thread replies, and trigram indexes on DMs and thread
replies. `CREATE INDEX` holds a SHARE lock, which blocks INSERT, UPDATE and
DELETE on those tables for the whole file. The same lock was measured on 094
(PR #381): a 5.1 s wait matched the build time. Expect 027 to block writes for
about 35 s per 2M messages. Only installations from before 027 run it, which
means release installs; current self-hosters applied it long ago.

### 4. After the staged upgrade, 8 differences from a fresh install remain

I compared `pg_dump --schema-only` of the upgraded database with a database
booted fresh by the same code, with column order and dump tokens normalised:

| object | fresh install | upgraded from v1.122.0 |
|---|---|---|
| `channel_bridges` UNIQUE (`sourceChannelId`, `targetChannelId`) | present | **missing** |
| `podcast_settings` UNIQUE (`serverId`) | absent | **present**: a second channel's podcast settings in the same server would be refused |
| `channels."serverId"` FK to servers ON DELETE CASCADE | absent | present |
| `idx_rt_family` on `refresh_tokens(family)` | partial (`family IS NOT NULL`) | full |
| `messages.embeds` | nullable, no default | NOT NULL DEFAULT `'[]'` |
| `podcast_episodes.duration` | absent | extra NOT NULL column |
| `podcast_settings` `description` / `title` / `enabled` | nullable / nullable / default true | NOT NULL `''` / NOT NULL `''` / default **false** |
| `roles` permission CHECK | `roles_permissions_check` and `roles_permissions_valid` | `roles_permissions_valid` only (same expression) |

Each one is a release-era shape that nothing later reconciles. The rollback
gate cannot see them, because it starts from a fresh install.

### 5. Boot without pending work does not block writers

Two boots of current code over a 6.0M-message database that was already
current: write latency p50 1 ms, max 10–14 ms, no stall. The schema pass's
`IF NOT EXISTS` statements cause no measurable write stall when the objects
already exist.
New `CREATE INDEX` lines in `schema.ts`, such as 094's, are built in that pass
on upgrade; this is measured in #381.

## Options for the owner

1. **Declare v1.122.0 unsupported as an upgrade source.** Document it in the
   upgrade guide and make the boot error name it. A schema-pass `42703`
   failure, combined with an older `schema_migrations` state, would print
   "this database was created by a release that cannot be upgraded in place;
   export and import" instead of `Schema hatası`. Smallest change. It matches
   E-02's judgement, which is now backed by measurement.
2. **Support it with a staged first boot.** When the chain is far behind,
   run the `staged` sequence above. Each of the 8 differences above then needs
   a reconciling migration before the result equals a fresh install, and 027's
   35 s per 2M messages has to be documented or moved out of band. Larger
   change, and the tolerant pass must not hide genuine schema errors on
   current installations.

Until one is chosen, the D3 forward-path evidence covers upgrades from the
previous `main` build only (Self-host CI) and from `main` to the D2 candidate
(#377). It does not cover the v1.122.0 release.

## Reproduce

```sh
git worktree add --detach ../bridge-rel v1.122.0      # needs its node_modules
createdb d3_rel && (cd ../bridge-rel/server && DATABASE_URL=…/d3_rel npx ts-node --transpile-only db/postgres/index.ts)
psql …/d3_rel -f server/scripts/p7-d3-release-populate.sql
createdb -T d3_rel d3_rel_check   # one copy per mode
P7_D3_DISPOSABLE_ACK=I_UNDERSTAND PG_URL=…/d3_rel_check \
  npx ts-node --transpile-only server/scripts/p7-d3-release-upgrade-probe.ts schema-check
```
