/**
 * P7 D2: durable, multi-node channel expiry worker.
 *
 * Two phases, each in short transactions so a busy channel never holds a
 * long lock and a crash at any point is recovered by the next tick:
 *
 * 1. CLAIM (one O(1) transaction per channel). Lock ONE expired, untombstoned
 *    channel FOR UPDATE SKIP LOCKED (other nodes skip it), lock one
 *    surviving live sibling FOR KEY SHARE SKIP LOCKED (the server keeps a
 *    channel) and write the durable tombstone. The channel row is NOT
 *    deleted here: its FK cascades (channel_read_positions, server_events,
 *    ...) are unbounded and would run inside the claim. From
 *    this commit on, reads deny (read preflights) and writes deny (write
 *    barrier: tombstone first); listings already hide the row because its
 *    expiresAt has passed, and the expiry API refuses tombstoned channels.
 *    Lock order matches the write barrier: channel row first. A writer that
 *    already holds FOR KEY SHARE makes the claim skip the channel this tick.
 *
 * 2. CLEANUP (bounded batches). For every tombstone still `pending`, lock
 *    the tombstone row FOR UPDATE SKIP LOCKED and delete at most
 *    `batchSize` rows per channel-owned table, including every table whose
 *    foreign key references channels (discovered from pg_constraint). When a
 *    pass deletes nothing, the channel row itself is deleted (its cascades
 *    now find nothing to remove) and the tombstone becomes `converged`.
 *    Deletes are idempotent, so retries, crashes and concurrent nodes are
 *    safe. Upload URLs of deleted rows are queued in the same statement.
 *
 * 3. OBJECTS (post-commit, leased): releaseChannelObjects deletes the queued
 *    objects with retries, after a fail-closed live-reference check, and
 *    records a terminal state for each (migration 089).
 *
 * Retention: security `audit_logs` and `message_reports` (with migration
 * 085's bounded evidence snapshot) are never deleted by expiry. Since
 * migration 088 a report has no foreign key to its channel; its evidence is
 * kept while open and scrubbed 90 days (configurable) after resolution by
 * jobs/reportEvidenceRetention.ts. See docs/P7_D2_REPORT_RETENTION.md.
 */

export interface ExpiryQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}
export interface ExpiryClient extends ExpiryQueryable { release(): void }
export interface ExpiryPool { connect(): Promise<ExpiryClient> }

const NOW_MS = 'FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT';

export const CLAIM_EXPIRED_CHANNEL_SQL = `
  SELECT c._id, c."serverId", c."expiresAt", c."expiryVersion"
    FROM channels c
   WHERE c."expiresAt" IS NOT NULL
     AND c."expiresAt" <= ${NOW_MS}
     AND c."expiryVersion" > 0
     AND NOT EXISTS (SELECT 1 FROM channel_expiry_tombstones t WHERE t."channelId" = c._id)
     AND EXISTS (
       SELECT 1 FROM channels s
        WHERE s."serverId" = c."serverId" AND s._id <> c._id
          AND (s."expiresAt" IS NULL OR s."expiresAt" > ${NOW_MS}))
   ORDER BY c."expiresAt", c._id
   LIMIT 1
   FOR UPDATE OF c SKIP LOCKED`;

export const LOCK_SURVIVOR_SQL = `
  SELECT _id FROM channels
   WHERE "serverId" = $1 AND _id <> $2
     AND ("expiresAt" IS NULL OR "expiresAt" > ${NOW_MS})
   LIMIT 1
   FOR KEY SHARE SKIP LOCKED`;

export const INSERT_TOMBSTONE_SQL = `
  INSERT INTO channel_expiry_tombstones
    ("channelId", "serverId", "expiredAt", "expiryVersion", "recordedAt", "cleanupState")
  VALUES ($1, $2, $3, $4, ${NOW_MS}, 'pending')
  ON CONFLICT ("channelId") DO NOTHING`;

/** Tables whose rows point at a channel from either side (edges). */
const EDGE_TABLES: ReadonlyArray<[string, ReadonlyArray<string>]> = [
  ['channel_bridges', ['sourceChannelId', 'targetChannelId']],
  ['channel_follows', ['sourceChannelId', 'targetChannelId']],
  ['crosspost_log', ['sourceChannelId', 'targetChannelId']],
];

export type ClaimOutcome =
  | { state: 'claimed'; channelId: string; serverId: string }
  /** Another node tombstoned the same channel first; try the next one. */
  | { state: 'raced' }
  | { state: 'none' };

/** Claim and tombstone at most one expired channel. */
export async function claimExpiredChannel(pool: ExpiryPool): Promise<ClaimOutcome> {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN');
    open = true;
    const candidate = await client.query(CLAIM_EXPIRED_CHANNEL_SQL);
    const row = candidate.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      open = false;
      return { state: 'none' };
    }
    const channelId = String(row._id);
    const serverId = String(row.serverId);
    const survivor = await client.query(LOCK_SURVIVOR_SQL, [serverId, channelId]);
    if (!survivor.rows.length) {
      // The surviving sibling is being deleted or claimed right now; retry later.
      await client.query('ROLLBACK');
      open = false;
      return { state: 'none' };
    }
    // The tombstone's primary key is the authoritative claim. The candidate
    // query's NOT EXISTS uses the statement snapshot, so a node whose row lock
    // was granted right after another node committed its claim can still pick
    // the same channel; it must not report (and announce) that claim twice.
    const inserted = await client.query(INSERT_TOMBSTONE_SQL, [channelId, serverId, row.expiresAt, row.expiryVersion]);
    if (inserted.rowCount !== 1) {
      await client.query('ROLLBACK');
      open = false;
      return { state: 'raced' };
    }
    await client.query('COMMIT');
    open = false;
    return { state: 'claimed', channelId, serverId };
  } catch (err) {
    if (open) { try { await client.query('ROLLBACK'); } catch { /* keep original error */ } }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A channel can also be referenced by server configuration without an FK.
 * These are deliberately allowlisted: we do not delete server settings or
 * audit history just because they mention an expired channel.
 */
const CHANNEL_POINTERS = [
  { table: 'servers', serverKey: '_id', fields: ['verificationChannelId', 'logChannelId'] },
  { table: 'server_onboarding', serverKey: 'serverId', fields: ['rulesChannelId', 'welcomeChannelId'] },
] as const;

/**
 * Tables never cleaned by expiry: the channel itself, tombstones, security
 * audit history, moderation reports (owner decision on #321, migration 088)
 * and the object-release outbox (migration 089).
 */
const RETAINED_TABLES = ['channels', 'channel_expiry_tombstones', 'audit_logs', 'message_reports',
  // The object-release outbox is keyed by channelId too, but it is this worker's own durable queue.
  'channel_object_release_outbox'];

/**
 * Single-column foreign keys that reference channels(_id), whatever the
 * column is called (e.g. server_events.channel_id). Draining them before the
 * channel row is deleted keeps that final DELETE's cascades empty.
 */
export const CHANNEL_FK_SQL = `
  SELECT cl.relname AS table_name, a.attname AS column_name
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.contype = 'f' AND c.confrelid = 'channels'::regclass
     AND array_length(c.conkey, 1) = 1
     AND cl.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`;

/**
 * Upload URLs carried by channel-owned rows. The cleanup records them in the
 * object-release outbox (migration 089) in the same statement that deletes the
 * rows, so no deleted row can lose track of its object. `messages.avatarUrl` is
 * an author/webhook avatar shared across channels and is never released here.
 */
const URL_COLUMNS: ReadonlyArray<{ table: string; column: string; expr: string }> = [
  { table: 'messages', column: 'fileUrl', expr: '"fileUrl"' },
  { table: 'voice_messages', column: 'url', expr: 'url' },
  { table: 'podcast_settings', column: 'coverUrl', expr: '"coverUrl"' },
  { table: 'podcast_settings', column: 'imageUrl', expr: '"imageUrl"' },
  { table: 'podcast_episodes', column: 'audioUrl', expr: '"audioUrl"' },
  // Legacy episodes store a bare file name served as /uploads/<filename>.
  { table: 'podcast_episodes', column: 'filename', expr: `'/uploads/' || filename` },
];
const OUTBOX = 'channel_object_release_outbox';

/** Discover channel-owned content, with durable security audit rows excluded. */
async function channelOwnedTables(db: ExpiryQueryable): Promise<{
  /** Upload URL expressions per table, only when the outbox exists. */
  urlExprs: Map<string, string[]>;
  owned: string[];
  references: Array<[string, string]>;
  edges: Array<[string, string[]]>;
  saved: boolean;
  linkedReplies: boolean;
  pointers: Array<{ table: string; serverKey: string; fields: string[] }>;
}> {
  const result = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema()`);
  const cols = new Map<string, Set<string>>();
  for (const r of result.rows) {
    const t = String(r.table_name);
    if (!cols.has(t)) cols.set(t, new Set());
    cols.get(t)!.add(String(r.column_name));
  }
  const owned = [...cols.entries()]
    .filter(([t, c]) => c.has('channelId') && !RETAINED_TABLES.includes(t))
    .map(([t]) => t)
    .sort();
  const fk = await db.query(CHANNEL_FK_SQL);
  const references = fk.rows
    .map(r => [String(r.table_name), String(r.column_name)] as [string, string])
    .filter(([t, c]) => !RETAINED_TABLES.includes(t) && !(c === 'channelId' && owned.includes(t)))
    .sort();
  const edges = EDGE_TABLES
    .map(([t, candidates]) => [t, candidates.filter(c => cols.get(t)?.has(c))] as [string, string[]])
    .filter(([t, c]) => cols.has(t) && c.length > 0);
  const saved = cols.get('saved_messages')?.has('destinationType') === true &&
    cols.get('saved_messages')?.has('destinationId') === true;
  const linkedReplies = cols.get('threads')?.has('_id') === true &&
    cols.get('threads')?.has('channelId') === true &&
    cols.get('thread_messages')?.has('threadId') === true;
  const pointers = CHANNEL_POINTERS.flatMap(({ table, serverKey, fields }) => {
    const columns = cols.get(table);
    if (!columns?.has(serverKey)) return [];
    const present = fields.filter(field => columns.has(field));
    return present.length ? [{ table, serverKey, fields: present }] : [];
  });
  const urlExprs = new Map<string, string[]>();
  if (cols.has(OUTBOX)) {
    for (const { table, column, expr } of URL_COLUMNS) {
      if (!cols.get(table)?.has(column)) continue;
      urlExprs.set(table, [...(urlExprs.get(table) ?? []), expr]);
    }
  }
  return { urlExprs, owned, references, edges, saved, linkedReplies, pointers };
}

const quote = (identifier: string) => '"' + identifier.replace(/"/g, '""') + '"';

export type CleanupOutcome =
  | { state: 'progress'; channelId: string; deleted: number }
  | { state: 'converged'; channelId: string }
  | { state: 'none' };

/**
 * One bounded cleanup pass over the oldest pending tombstone that no other
 * node is processing. Deletes at most `batchSize` rows per table.
 */
export async function cleanupNextTombstone(pool: ExpiryPool, batchSize = 500): Promise<CleanupOutcome> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new RangeError('Invalid cleanup batch size');
  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN');
    open = true;
    const pending = await client.query(
      `SELECT "channelId", "serverId" FROM channel_expiry_tombstones
        WHERE "cleanupState" = 'pending'
        ORDER BY "recordedAt", "channelId"
        LIMIT 1
        FOR UPDATE SKIP LOCKED`);
    const channelId = pending.rows[0]?.channelId;
    const serverId = pending.rows[0]?.serverId;
    if (typeof channelId !== 'string' || typeof serverId !== 'string') {
      await client.query('ROLLBACK');
      open = false;
      return { state: 'none' };
    }
    // The claimed row stays until the graph is drained. Never touch a live
    // channel under the tombstoned id (defensive: ids are UUIDs).
    const live = await client.query(
      `SELECT 1 FROM channels WHERE _id = $1 AND ("expiresAt" IS NULL OR "expiresAt" > ${NOW_MS} OR "serverId" <> $2)`,
      [channelId, serverId]);
    if (live.rows.length) throw new Error('Tombstoned channel id has a live channel row');

    const { urlExprs, owned, references, edges, saved, linkedReplies, pointers } = await channelOwnedTables(client);
    let deleted = 0;
    // Every predicate binds the tombstoned channel id as $1.
    const batch = async (table: string, predicate: string, params: unknown[]) => {
      const exprs = urlExprs.get(table);
      if (!exprs?.length) {
        const r = await client.query(
          `DELETE FROM ${quote(table)} WHERE ctid = ANY(ARRAY(
             SELECT ctid FROM ${quote(table)} WHERE ${predicate} LIMIT ${batchSize}))`, params);
        deleted += r.rowCount ?? 0;
        return;
      }
      // Same statement: the rows go and their upload URLs are queued, or neither.
      const r = await client.query(
        `WITH gone AS (
           DELETE FROM ${quote(table)} WHERE ctid = ANY(ARRAY(
             SELECT ctid FROM ${quote(table)} WHERE ${predicate} LIMIT ${batchSize}))
           RETURNING ${exprs.map((e, i) => `${e} AS u${i}`).join(', ')}),
         urls AS (
           SELECT DISTINCT v.u FROM gone
             CROSS JOIN LATERAL (VALUES ${exprs.map((_, i) => `(gone.u${i})`).join(', ')}) AS v(u)
            WHERE v.u IS NOT NULL AND char_length(v.u) BETWEEN 1 AND 2048),
         queued AS (
           INSERT INTO ${OUTBOX} ("channelId", url, "enqueuedAt", "nextAttemptAt")
           SELECT $1, urls.u, ${NOW_MS}, ${NOW_MS} FROM urls
           -- A finished row is reopened: it may have been retained only because a
           -- not-yet-drained row of this channel still referenced the object.
           ON CONFLICT ("channelId", url) DO UPDATE
              SET state = 'pending', attempts = 0, "finishedAt" = NULL, "lastError" = NULL,
                  "nextAttemptAt" = EXCLUDED."nextAttemptAt"
            WHERE ${OUTBOX}.state <> 'pending'
           RETURNING 1)
         SELECT (SELECT COUNT(*) FROM gone)::int AS deleted, (SELECT COUNT(*) FROM queued)::int AS queued`, params);
      deleted += Number(r.rows[0]?.deleted ?? 0);
    };
    for (const [table, columns] of edges) {
      await batch(table, columns.map(c => `${quote(c)} = $1`).join(' OR '), [channelId]);
    }
    if (saved) await batch('saved_messages', `"destinationType" = 'channel' AND "destinationId" = $1`, [channelId]);

    // A reply can refer to a thread from this channel by threadId, even if its
    // stored channelId is absent/corrupt. Delete those in bounded passes FIRST.
    // Never delete a thread while any of its replies still exist: an orphan
    // with only threadId would otherwise become impossible to discover.
    if (linkedReplies) {
      await batch('thread_messages', '"threadId" IN (SELECT _id FROM threads WHERE "channelId" = $1)', [channelId]);
    }
    if (owned.includes('thread_messages')) {
      await batch('thread_messages', '"channelId" = $1', [channelId]);
    }
    for (const table of owned) {
      if (table === 'threads' || table === 'thread_messages') continue;
      await batch(table, '"channelId" = $1', [channelId]);
    }
    for (const [table, column] of references) {
      await batch(table, `${quote(column)} = $1`, [channelId]);
    }
    if (owned.includes('threads')) {
      await batch('threads', linkedReplies
        ? '"channelId" = $1 AND NOT EXISTS (SELECT 1 FROM thread_messages r WHERE r."threadId" = "threads"._id)'
        : '"channelId" = $1', [channelId]);
    }

    // Clear dangling server configuration pointers. Keep verification policy
    // flags unchanged; never silently weaken the server's security posture.
    for (const { table, serverKey, fields } of pointers) {
      for (const field of fields) {
        await client.query(
          `UPDATE ${quote(table)} SET ${quote(field)} = NULL
           WHERE ${quote(serverKey)} = $2 AND ${quote(field)} = $1`,
          [channelId, serverId],
        );
      }
    }

    if (deleted === 0) {
      // Everything that references the row is gone; its cascades are empty.
      await client.query(
        `DELETE FROM channels WHERE _id = $1 AND "serverId" = $2 AND "expiresAt" <= ${NOW_MS}`,
        [channelId, serverId]);
      await client.query(
        `UPDATE channel_expiry_tombstones SET "cleanupState" = 'converged'
          WHERE "channelId" = $1 AND "cleanupState" = 'pending'`, [channelId]);
      await client.query('COMMIT');
      open = false;
      return { state: 'converged', channelId };
    }
    await client.query('COMMIT');
    open = false;
    return { state: 'progress', channelId, deleted };
  } catch (err) {
    if (open) { try { await client.query('ROLLBACK'); } catch { /* keep original error */ } }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Deletes one stored object after the rows that referenced it are gone. It
 * must re-check live references itself (another channel may share the file)
 * and must never delete a location Bridge does not own.
 */
export interface ObjectReleaser {
  release(url: string): Promise<'released' | 'absent' | 'still_referenced' | 'unrecognized'>;
  /**
   * Optional: a releaser scoped to one leased batch that may answer reference
   * checks for all of it with one query. A failure falls back to `release`.
   */
  forBatch?(urls: readonly string[]): Promise<ObjectReleaser>;
}
export interface ObjectReleaseReport { released: number; retained: number; retried: number; failed: number }

export const OBJECT_RELEASE_MAX_ATTEMPTS = 8;
const OBJECT_RELEASE_LEASE_MS = 5 * 60_000;
const OBJECT_RELEASE_FINISHED_TTL_MS = 30 * 24 * 60 * 60_000;

/** 30 s, 1 min, 2 min ... capped at 6 h. */
export function objectReleaseBackoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60_000);
}

export const CLAIM_OBJECT_RELEASES_SQL = `
  UPDATE ${OUTBOX} o
     SET attempts = o.attempts + 1, "nextAttemptAt" = ${NOW_MS} + ${OBJECT_RELEASE_LEASE_MS}
   WHERE ("channelId", url) IN (
     SELECT "channelId", url FROM ${OUTBOX}
      WHERE state = 'pending' AND "nextAttemptAt" <= ${NOW_MS}
      ORDER BY "nextAttemptAt", "channelId", url
      LIMIT $1
      FOR UPDATE SKIP LOCKED)
  RETURNING o."channelId", o.url, o.attempts`;

/**
 * Post-commit object phase. Each due outbox row is leased (attempts + 1, next
 * attempt pushed out by the lease) in one short statement, so concurrent nodes
 * never release the same object and a crash mid-release simply lets the lease
 * expire. Outcomes are terminal (released/retained), retried with backoff, or
 * `failed` after OBJECT_RELEASE_MAX_ATTEMPTS for reconciliation.
 */
export async function releaseChannelObjects(
  pool: ExpiryPool, releaser: ObjectReleaser, limit = 50,
): Promise<ObjectReleaseReport> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid object release limit');
  const report: ObjectReleaseReport = { released: 0, retained: 0, retried: 0, failed: 0 };
  const client = await pool.connect();
  try {
    const leased = await client.query(CLAIM_OBJECT_RELEASES_SQL, [limit]);
    const active = releaser.forBatch && leased.rows.length
      ? await releaser.forBatch(leased.rows.map(row => String(row.url))).catch(() => releaser)
      : releaser;
    for (const row of leased.rows) {
      const channelId = String(row.channelId);
      const url = String(row.url);
      const attempts = Number(row.attempts);
      const finish = (state: 'released' | 'retained' | 'failed', note: string | null) => client.query(
        `UPDATE ${OUTBOX} SET state = $3, "finishedAt" = ${NOW_MS}, "lastError" = $4
          WHERE "channelId" = $1 AND url = $2 AND state = 'pending'`, [channelId, url, state, note]);
      try {
        const outcome = await active.release(url);
        if (outcome === 'released' || outcome === 'absent') {
          await finish('released', outcome === 'absent' ? 'already_absent' : null);
          report.released += 1;
        } else {
          await finish('retained', outcome);
          report.retained += 1;
        }
      } catch (err) {
        const note = String((err as Error)?.message ?? err).slice(0, 500);
        if (attempts >= OBJECT_RELEASE_MAX_ATTEMPTS) {
          await finish('failed', note);
          report.failed += 1;
        } else {
          await client.query(
            `UPDATE ${OUTBOX} SET "nextAttemptAt" = ${NOW_MS} + $3, "lastError" = $4
              WHERE "channelId" = $1 AND url = $2 AND state = 'pending'`,
            [channelId, url, objectReleaseBackoffMs(attempts), note]);
          report.retried += 1;
        }
      }
    }
    // Finished history is kept 30 days; `failed` rows stay until an operator acts.
    await client.query(
      `DELETE FROM ${OUTBOX} WHERE ctid = ANY(ARRAY(
         SELECT ctid FROM ${OUTBOX} WHERE state IN ('released', 'retained')
            AND "finishedAt" < ${NOW_MS} - ${OBJECT_RELEASE_FINISHED_TTL_MS} LIMIT 500))`);
    return report;
  } finally {
    client.release();
  }
}

export interface ExpiryTickLimits { maxClaims?: number; maxCleanupPasses?: number; batchSize?: number; maxObjectReleases?: number }
export interface ExpiryTickReport {
  claimed: string[];
  /** The same claims with their server, for broadcasting and cache invalidation. */
  claimedChannels: Array<{ channelId: string; serverId: string }>;
  converged: string[];
  deleted: number;
  /** Present when the tick ran the object phase (a releaser was given). */
  objects?: ObjectReleaseReport;
}

/** One bounded worker tick: claim up to N channels, then up to M cleanup passes. */
export async function runChannelExpiryTick(
  pool: ExpiryPool, limits: ExpiryTickLimits = {}, releaser?: ObjectReleaser,
): Promise<ExpiryTickReport> {
  const maxClaims = limits.maxClaims ?? 20;
  const maxPasses = limits.maxCleanupPasses ?? 50;
  const report: ExpiryTickReport = { claimed: [], claimedChannels: [], converged: [], deleted: 0 };
  for (let i = 0; i < maxClaims; i++) {
    const claim = await claimExpiredChannel(pool);
    if (claim.state === 'raced') continue;
    if (claim.state !== 'claimed') break;
    report.claimed.push(claim.channelId);
    report.claimedChannels.push({ channelId: claim.channelId, serverId: claim.serverId });
  }
  for (let i = 0; i < maxPasses; i++) {
    const pass = await cleanupNextTombstone(pool, limits.batchSize);
    if (pass.state === 'none') break;
    if (pass.state === 'converged') report.converged.push(pass.channelId);
    else report.deleted += pass.deleted;
  }
  if (releaser) report.objects = await releaseChannelObjects(pool, releaser, limits.maxObjectReleases ?? 50);
  return report;
}
