/**
 * P7 D2: ONE PostgreSQL statement reads channel expiry + the separate durable
 * tombstone under a single statement snapshot. DORMANT: not wired into routes.
 *
 * This is NOT a user authorization primitive. Future read/write endpoints must
 * also enforce tenant membership, roles, owner-only mutations, and atomic
 * mutation/expiry version checks. A concurrent write after this SELECT can
 * change eligibility, so mutation paths must re-check under a row lock.
 */
import {
  classifyChannelExpiryWithTombstone,
  type ChannelExpiryDecision,
} from './channelExpiry';

interface QueryResult {
  rows: Record<string, unknown>[];
}
export interface ExpiryEvidenceReader {
  query(sql: string, values: unknown[]): Promise<QueryResult>;
}

const INVALID: ChannelExpiryDecision = { state: 'invalid', accessible: false };
const UNVERIFIED: ChannelExpiryDecision = { state: 'unverified', accessible: false };

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= 256 && value.trim() === value;
}

export const CHANNEL_EXPIRY_EVIDENCE_SQL = [
  'SELECT',
  ' c._id AS "channelId",',
  ' c."serverId" AS "ownerServerId",',
  ' c."expiresAt" AS "expiresAt",',
  ' c."expiryVersion" AS "expiryVersion",',
  ' t."channelId" AS "tombstoneChannelId",',
  ' t."serverId" AS "tombstoneServerId",',
  ' t."expiredAt" AS "tombstoneExpiredAt",',
  ' t."expiryVersion" AS "tombstoneExpiryVersion",',
  ' t."recordedAt" AS "tombstoneRecordedAt",',
  ' t."cleanupState" AS "tombstoneCleanupState"',
  'FROM (SELECT $1::text AS channel_id, $2::text AS server_id) AS needle',
  'LEFT JOIN channels c',
  '  ON c._id = needle.channel_id AND c."serverId" = needle.server_id',
  // Channel identities are global: do not silently ignore a retained marker
  // if an old ID appears with a different tenant.
  'LEFT JOIN channel_expiry_tombstones t ON t."channelId" = needle.channel_id',
].join('\n');

/**
 * Fails closed for unqueried/error evidence, malformed rows, missing channel,
 * or stale cross-server tombstones. No retry or fallback to a channel-only
 * read is permitted. The query is parameterized (no interpolated identifiers).
 */
export async function readAndClassifyChannelExpiry(
  db: ExpiryEvidenceReader,
  channelId: unknown,
  serverId: unknown,
  serverNowMs: unknown,
): Promise<ChannelExpiryDecision> {
  if (!validIdentity(channelId) || !validIdentity(serverId) ||
      typeof serverNowMs !== 'number' ||
      !Number.isSafeInteger(serverNowMs) || serverNowMs < 0) return INVALID;

  let row: Record<string, unknown>;
  try {
    const result = await db.query(CHANNEL_EXPIRY_EVIDENCE_SQL, [channelId, serverId]);
    if (!result || !Array.isArray(result.rows) || result.rows.length !== 1 ||
        !result.rows[0] || typeof result.rows[0] !== 'object')
      return UNVERIFIED;
    row = result.rows[0];
  } catch {
    // A database outage is an unavailable authorization dependency,
    // NOT evidence that no tombstone exists.
    return UNVERIFIED;
  }

  const channel = row.channelId === null ? null : {
    _id: row.channelId,
    serverId: row.ownerServerId,
    expiresAt: row.expiresAt,
    expiryVersion: row.expiryVersion,
  };
  const tombstone = row.tombstoneChannelId === null ? null : {
    channelId: row.tombstoneChannelId,
    serverId: row.tombstoneServerId,
    expiredAt: row.tombstoneExpiredAt,
    expiryVersion: row.tombstoneExpiryVersion,
    recordedAt: row.tombstoneRecordedAt,
    cleanupState: row.tombstoneCleanupState,
  };

  if (channel !== null &&
      (channel._id !== channelId || channel.serverId !== serverId)) return INVALID;
  if (tombstone !== null &&
      (tombstone.channelId !== channelId || tombstone.serverId !== serverId)) return INVALID;

  return classifyChannelExpiryWithTombstone(channel, tombstone, serverNowMs);
}
