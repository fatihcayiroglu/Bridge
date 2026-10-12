// P7 C3: deterministic destination topology fingerprint, read-only.
// Includes every portable-community-structure v1 field for categories, roles,
// and channels, including permission masks and ordering metadata.
// NOT a DB revision, signed snapshot, transaction lock or import approval.
import { buildPortableCommunityStructure } from './portableCommunity';
import { parsePermissionMask } from './permissionMaskInvariant';

type Row = Record<string, unknown>;
export type DestinationTopology = {
  serverId: string;
  categories: readonly Row[];
  roles: readonly Row[];
  channels: readonly Row[];
};
const FIXED_TIMESTAMP = '1970-01-01T00:00:00.000Z';

function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throw new TypeError('Invalid target topology ID');
  }
  return value;
}

function completeRows(value: readonly Row[], sid: string, limit: number): Row[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new TypeError('Unsupported destination topology');
  }
  const seen = new Set<string>();
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        row.serverId !== sid) {
      throw new TypeError('Foreign or incomplete target topology row');
    }
    const rowId = id(row._id);
    if (seen.has(rowId)) throw new TypeError('Duplicate target topology ID');
    seen.add(rowId);
    return row;
  });
}

/**
 * Reuse the versioned C2 topology allowlist and its canonical ordering so
 * changes to labels, category positions/collapsed state, role colors/order
 * and permission masks, channel topics/category/order/nsfw/slowmode change
 * the digest. Avoid hashing secrets, memberships or unknown DB fields.
 *
 * The fixed timestamp and fixed empty server name ensure byte-stable output
 * regardless of array ordering and wall-clock time. The returned checksum
 * represents selected *values*, not a transactionally consistent snapshot.
 */
export function fingerprintDestinationTopology(target: DestinationTopology): string {
  const serverId = id(target.serverId);
  const categories = completeRows(target.categories, serverId, 2000);
  const roles = completeRows(target.roles, serverId, 2000);
  const channels = completeRows(target.channels, serverId, 500);
  // Missing persisted masks must never silently become zero via the C2
  // exporter's backward-compatible normalization.
  for (const role of roles) {
    if (role.permissions === undefined) throw new TypeError('Missing target role permissions');
    parsePermissionMask(role.permissions, 'target role permissions');
  }
  const canonical = buildPortableCommunityStructure(
    { _id: serverId, name: '' },
    categories, channels, roles,
    FIXED_TIMESTAMP,
  );
  if (Buffer.byteLength(JSON.stringify(canonical), 'utf8') > 512 * 1024) {
    throw new TypeError('Destination topology fingerprint exceeds 512 KiB');
  }
  return canonical.integrity.digest;
}
