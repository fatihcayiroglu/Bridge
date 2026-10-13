// P7 C4: source trust, explicit mapping, complete target topology and
// target grants on ONE caller-owned SERIALIZABLE PostgreSQL transaction.
// UNMOUNTED: no consent route, approval token, import, or destination write.
import { inspectStaticPortableImportConsentPolicy } from './portableImportConsentStaticPolicy';
import { requireMappedDestinationGrantParity } from './portableTargetGrantParity';
import { fingerprintDestinationTopology } from './portableCommunityTargetFingerprint';
import { parsePermissionMask } from './permissionMaskInvariant';

type Row = Record<string, unknown>;
type Client = { query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }> };

export class LockedPortableReviewError extends Error {
  readonly code = 'PORTABLE_LOCKED_REVIEW_UNAVAILABLE';
  constructor() {
    super('Locked portable community review is unavailable');
    this.name = 'LockedPortableReviewError';
  }
}
function refuse(): never { throw new LockedPortableReviewError(); }
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 ||
      value.trim() !== value) refuse();
  return value;
}
function integer(value: unknown): number {
  const n = typeof value === 'number' ? value :
    typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) refuse();
  return n;
}
function nsfw(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return refuse();
}
async function read(client: Client, sql: string, params: unknown[], max: number): Promise<Row[]> {
  const result = await client.query(sql, params);
  if (!result || !Array.isArray(result.rows) || result.rows.length > max) refuse();
  return result.rows;
}

export async function inspectLockedPortableImportReview(input: {
  client: Client;
  targetServerId: string;
  ownerId: string;
  structure: unknown;
  permissions: unknown;
  attestation: unknown;
  expectedSourceOrigin: string;
  expectedSourceServerId: string;
  /** Independently pinned operator config; NEVER take from HTTP request. */
  operatorRegistryJson: string;
  mapping: { categories: unknown; roles: unknown; channels: unknown };
  now?: number;
}): Promise<{
  mode: 'transaction-check-only';
  verifiedReviewFingerprint: string;
  targetTopologyDigest: string;
  targetGrantDigest: string;
  checkedChannels: number;
  checkedGrants: number;
  consentSupported: false;
  consentIssued: false;
  importSupported: false;
  writesPerformed: false;
}> {
  try {
    const sid = id(input.targetServerId), owner = id(input.ownerId);
    const state = await read(input.client,
      "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS readonly",
      [], 1);
    if (state.length !== 1 || state[0]?.isolation !== 'serializable' ||
        state[0]?.readonly !== 'off') refuse();

    // The owner and every target row are read on the SAME session. In a
    // SERIALIZABLE transaction the predicate reads also participate in SSI.
    const server = await read(input.client,
      'SELECT _id FROM servers WHERE _id=$1 AND "ownerId"=$2 FOR UPDATE', [sid, owner], 1);
    if (server.length !== 1 || server[0]?._id !== sid) refuse();

    const categoryRows = await read(input.client,
      'SELECT _id, "serverId", name, position, collapsed FROM channel_categories WHERE "serverId"=$1 ORDER BY _id LIMIT 2001 FOR SHARE',
      [sid], 2000);
    const roleRows = await read(input.client,
      'SELECT _id, "serverId", name, color, position, permissions FROM roles WHERE "serverId"=$1 ORDER BY _id LIMIT 2001 FOR SHARE',
      [sid], 2000);
    const channelRows = await read(input.client,
      'SELECT _id, "serverId", name, type, topic, "categoryId", category, "order", nsfw, slowmode FROM channels WHERE "serverId"=$1 ORDER BY _id LIMIT 501 FOR SHARE',
      [sid], 500);

    // Preserve the canonical exported v1 meaning; PostgreSQL BIGINT fields
    // can arrive as strings and nsfw is persisted as INTEGER 0/1.
    const categories = categoryRows.map(row => ({ ...row, position: integer(row.position),
      collapsed: row.collapsed }));
    if (categories.some(row => typeof row.collapsed !== 'boolean')) refuse();
    const roles = roleRows.map(row => ({ ...row, position: integer(row.position),
      permissions: parsePermissionMask(row.permissions, 'target role permissions') }));
    const channels = channelRows.map(row => ({ ...row, order: integer(row.order),
      slowmode: integer(row.slowmode), nsfw: nsfw(row.nsfw) }));
    const destination = { serverId: sid, categories, roles, channels };
    const targetTopologyDigest = fingerprintDestinationTopology(destination);
    const staticResult = inspectStaticPortableImportConsentPolicy({
      structure: input.structure, permissions: input.permissions,
      attestation: input.attestation, expectedSourceOrigin: input.expectedSourceOrigin,
      expectedSourceServerId: input.expectedSourceServerId,
      operatorRegistryJson: input.operatorRegistryJson,
      mapping: input.mapping, destination, now: input.now,
    });
    if (!staticResult.staticChecksPassed ||
        !staticResult.verifiedReviewFingerprint ||
        staticResult.targetTopologyDigest !== targetTopologyDigest) refuse();

    // This MUST use the very same PG client. Never call a repository/pool
    // method which obtains a fresh, potentially inconsistent connection.
    const grants = await requireMappedDestinationGrantParity({
      client: input.client, targetServerId: sid, ownerId: owner,
      sourcePermissions: input.permissions, mapping: input.mapping,
    });
    return {
      mode: 'transaction-check-only',
      verifiedReviewFingerprint: staticResult.verifiedReviewFingerprint,
      targetTopologyDigest,
      targetGrantDigest: grants.targetGrantDigest,
      checkedChannels: grants.checkedChannels,
      checkedGrants: grants.checkedGrants,
      consentSupported: false, consentIssued: false,
      importSupported: false, writesPerformed: false,
    };
  } catch {
    // No source-key, owner, topology or permission oracle.
    return refuse();
  }
}
