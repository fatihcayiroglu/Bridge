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
 *    deleted here: its FK cascades (message_reports, channel_read_positions,
 *    server_events, ...) are unbounded and would run inside the claim. From
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
 *    safe. Attachment files are released by the existing reference-based
 *    upload cleanup once no row references them.
 *
 * Retention: `audit_logs` (security audit history) is never deleted.
 * `message_reports` of the channel are deleted with its content, the same as
 * ordinary channel deletion (their channelId FK cascades); see
 * docs/P7_D2_EXPIRY_CLEANUP_GRAPH_AND_SCHEDULE.md for the policy and its
 * interaction with evidence-safe reports (#345).
 *
 * A server's last live channel is never claimed. The expiry API
 * (lib/channelExpiryConfig.ts) also keeps one permanent channel per server.
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

/** Tables never cleaned by expiry: the channel itself, tombstones and security audit history. */
const RETAINED_TABLES = ['channels', 'channel_expiry_tombstones', 'audit_logs'];

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

/** Discover channel-owned content, with durable security audit rows excluded. */
async function channelOwnedTables(db: ExpiryQueryable): Promise<{
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
  return { owned, references, edges, saved, linkedReplies, pointers };
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

    const { owned, references, edges, saved, linkedReplies, pointers } = await channelOwnedTables(client);
    let deleted = 0;
    const batch = async (table: string, predicate: string, params: unknown[]) => {
      const r = await client.query(
        `DELETE FROM ${quote(table)} WHERE ctid = ANY(ARRAY(
           SELECT ctid FROM ${quote(table)} WHERE ${predicate} LIMIT ${batchSize}))`, params);
      deleted += r.rowCount ?? 0;
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

export interface ExpiryTickLimits { maxClaims?: number; maxCleanupPasses?: number; batchSize?: number }
export interface ExpiryTickReport {
  claimed: string[];
  /** The same claims with their server, for broadcasting and cache invalidation. */
  claimedChannels: Array<{ channelId: string; serverId: string }>;
  converged: string[];
  deleted: number;
}

/** One bounded worker tick: claim up to N channels, then up to M cleanup passes. */
export async function runChannelExpiryTick(pool: ExpiryPool, limits: ExpiryTickLimits = {}): Promise<ExpiryTickReport> {
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
  return report;
}
