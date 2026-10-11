// P7 C3 — READ-ONLY source/target structure comparison.
// Never convert this preview into an apply permission or persistence plan.
import type { validatePortableCommunityStructure } from './portableCommunityValidation';

type Snapshot = ReturnType<typeof validatePortableCommunityStructure>;
type TargetRow = Record<string, unknown>;
type Kind = 'category' | 'role' | 'channel';
type Item = { sourceId: string; name: string };
type Collision = {
  kind: Kind;
  sourceId: string;
  name: string;
  targetSourceIds: string[];
  reason: 'TARGET_NAME_EXISTS' | 'DUPLICATE_SOURCE_NAME';
};
const PREVIEW_LIMIT = 50;
const MAX_TARGET_ROWS_PER_TYPE = 5000;

function key(name: string): string {
  // A conservative, case-insensitive preflight only. Not a DB uniqueness rule.
  return name.normalize('NFKC').trim().toLowerCase();
}
function asTargetRows(rows: readonly TargetRow[]): Item[] {
  if (!Array.isArray(rows) || rows.length > MAX_TARGET_ROWS_PER_TYPE) {
    throw new TypeError('Unsupported target topology size');
  }
  return rows.map(row => {
    if (!row || typeof row._id !== 'string' || !row._id ||
        typeof row.name !== 'string' || row.name.length > 200) {
      throw new TypeError('Invalid destination topology');
    }
    return { sourceId: row._id, name: row.name };
  });
}
function findCollisions(kind: Kind, source: readonly Item[], target: readonly Item[]): Collision[] {
  const destinationByName = new Map<string, string[]>();
  for (const row of target) {
    const k = key(row.name);
    destinationByName.set(k, [...(destinationByName.get(k) ?? []), row.sourceId]);
  }
  const sourceCounts = new Map<string, number>();
  for (const row of source) {
    const k = key(row.name);
    sourceCounts.set(k, (sourceCounts.get(k) ?? 0) + 1);
  }
  const collisions: Collision[] = [];
  for (const row of source) {
    const k = key(row.name);
    const destinationIds = destinationByName.get(k) ?? [];
    if (destinationIds.length) {
      collisions.push({
        kind, sourceId: row.sourceId, name: row.name,
        targetSourceIds: destinationIds.slice(0, PREVIEW_LIMIT),
        reason: 'TARGET_NAME_EXISTS',
      });
    }
    if ((sourceCounts.get(k) ?? 0) > 1) {
      collisions.push({
        kind, sourceId: row.sourceId, name: row.name,
        targetSourceIds: [], reason: 'DUPLICATE_SOURCE_NAME',
      });
    }
  }
  return collisions;
}

export function buildPortableCommunityPreview(
  document: Snapshot,
  target: { serverId: string; name: string; categories: readonly TargetRow[];
    roles: readonly TargetRow[]; channels: readonly TargetRow[] },
) {
  if (!target.serverId || typeof target.serverId !== 'string' ||
      typeof target.name !== 'string') throw new TypeError('Missing destination');
  const destinationCategories = asTargetRows(target.categories);
  const destinationRoles = asTargetRows(target.roles);
  const destinationChannels = asTargetRows(target.channels);
  const collisions = [
    ...findCollisions('category', document.categories, destinationCategories),
    ...findCollisions('role', document.roles, destinationRoles),
    ...findCollisions('channel', document.channels, destinationChannels),
  ];
  // Deliberately no suggested mapping: same names do not prove safe identity.
  // A checksum does not prove authenticity and cannot authorize a write.
  return {
    mode: 'read-only',
    writesPerformed: false,
    importSupported: false,
    source: {
      serverId: document.community.sourceServerId,
      name: document.community.name,
      checksum: document.integrity.digest,
      counts: {
        categories: document.categories.length,
        roles: document.roles.length,
        channels: document.channels.length,
      },
    },
    target: {
      serverId: target.serverId, name: target.name,
      counts: {
        categories: destinationCategories.length,
        roles: destinationRoles.length,
        channels: destinationChannels.length,
      },
    },
    conflicts: {
      total: collisions.length,
      truncated: collisions.length > PREVIEW_LIMIT,
      items: collisions.slice(0, PREVIEW_LIMIT),
    },
    unsupported: [
      'Member identities and memberships',
      'Messages and attachments',
      'Channel permission overrides and per-user grants',
      'Credential and secret transfer',
      'Actual import, rollback and ID remapping',
    ],
    blockers: [
      'IMPORT_NOT_IMPLEMENTED',
      'PERMISSION_OVERRIDES_NOT_EXPORTED',
      'IDENTITY_MAPPING_NOT_VERIFIED',
      'SOURCE_AUTHENTICITY_NOT_VERIFIED',
    ],
  } as const;
}
