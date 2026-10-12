// P7 C3 — deterministic topology-only revision for read-only mapping review.
// This is a comparison hint, NOT an atomic database version or import token.
// Reuse the C2 field allowlist: never hash user identities, secrets or messages.
import { buildPortableCommunityStructure } from './portableCommunity';

type Row = Record<string, unknown>;
const AT = '1970-01-01T00:00:00.000Z';
function requiredId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throw new TypeError('Invalid target identifier');
  }
  return value;
}
function checkedRows(
  value: readonly Row[],
  serverId: string,
  limit: number,
): Row[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new TypeError('Unsupported destination topology');
  }
  const ids = new Set<string>();
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        row.serverId !== serverId) {
      throw new TypeError('Incomplete destination topology');
    }
    const identifier = requiredId(row._id);
    if (ids.has(identifier)) throw new TypeError('Duplicate target identifier');
    ids.add(identifier);
    return row;
  });
}

/**
 * This binds reviewed mappings to a reproducible snapshot of all fields
 * exported by portable-community-structure v1 (including role masks).
 * It DOES NOT lock rows, include per-user/legacy channel overrides, or
 * prevent concurrent changes between verification and a future write.
 */
export function computePortableCommunityTargetRevision(target: {
  serverId: string;
  categories: readonly Row[];
  roles: readonly Row[];
  channels: readonly Row[];
}): string {
  const serverId = requiredId(target.serverId);
  const categories = checkedRows(target.categories, serverId, 2000);
  const roles = checkedRows(target.roles, serverId, 2000);
  const channels = checkedRows(target.channels, serverId, 500);
  const canonical = buildPortableCommunityStructure(
    { _id: serverId, name: '' }, categories, channels, roles, AT,
  );
  if (Buffer.byteLength(JSON.stringify(canonical), 'utf8') > 512 * 1024) {
    throw new TypeError('Destination topology exceeds 512 KiB');
  }
  return canonical.integrity.digest;
}
