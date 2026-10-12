// P7 C3 — owner-only destination topology fingerprint.
// Field allowlist matches the C2 community structure export, so review
// comparisons catch structural edits beyond name and ID changes.
// Still NOT a database revision, signed snapshot, transaction lock, approval,
// or authorization to import. User/member/secret data is never serialized.
import { buildPortableCommunityStructure } from './portableCommunity';
import { parsePermissionMask } from './permissionMaskInvariant';

type Row = Record<string, unknown>;
export type DestinationTopology = {
  serverId: string;
  categories: readonly Row[];
  roles: readonly Row[];
  channels: readonly Row[];
};
const SNAPSHOT_AT = '1970-01-01T00:00:00.000Z';
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throw new TypeError('Invalid destination topology identifier');
  }
  return value;
}
function validatedRows(rows: readonly Row[], sid: string, max: number) {
  if (!Array.isArray(rows) || rows.length > max) {
    throw new TypeError('Invalid destination topology row count');
  }
  const ids = new Set<string>();
  return rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        row.serverId !== sid) throw new TypeError('Foreign destination topology row');
    const id = identifier(row._id);
    if (ids.has(id)) throw new TypeError('Duplicate destination topology identifier');
    ids.add(id);
    return row;
  });
}

/**
 * Canonical, bounded fingerprint of ALL portable community structure v1 fields.
 * Its input MUST come from the destination, not an untrusted client's copy.
 * Doesn't cover permission override tables, memberships or nonportable fields.
 */
export function fingerprintDestinationTopology(value: DestinationTopology): string {
  const serverId = identifier(value.serverId);
  const categories = validatedRows(value.categories, serverId, 2000);
  const roles = validatedRows(value.roles, serverId, 2000);
  const channels = validatedRows(value.channels, serverId, 500);
  for (const role of roles) {
    if (role.permissions === undefined) throw new TypeError('Missing destination role permissions');
    parsePermissionMask(role.permissions, 'destination role mask');
  }
  // Reuse the exporter field allowlist and stable position/ID sorting to
  // avoid maintaining a subtly divergent second topology definition.
  const canonical = buildPortableCommunityStructure(
    { _id: serverId, name: '' }, categories, channels, roles, SNAPSHOT_AT,
  );
  if (Buffer.byteLength(JSON.stringify(canonical), 'utf8') > 512 * 1024) {
    throw new TypeError('Destination topology fingerprint exceeds 512 KiB');
  }
  return canonical.integrity.digest;
}
