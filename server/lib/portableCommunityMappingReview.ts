// P7 C3 — Explicit source-to-existing-target ID mapping INSPECTION.
// This is a pure, bounded, no-write preflight. It cannot approve an import,
// create a commit token, prove source authenticity, or authorize permissions.
import { parsePermissionMask } from './permissionMaskInvariant';
import { validatePortableCommunityStructure } from './portableCommunityValidation';
import { inspectPortableCommunityManifestPair } from './portableCommunityPair';
import { fingerprintDestinationTopology } from './portableCommunityTargetFingerprint';

type Row = Record<string, unknown>;
type Kind = 'categories' | 'roles' | 'channels';
type Mapping = { sourceId: string; targetId: string };
type SourceRow = { sourceId: string; name: string; type?: string; permissions?: number };
type TargetRow = { id: string; name: string; type?: string; permissions?: number };

export class PortableCommunityMappingError extends Error {
  readonly code = 'PORTABLE_COMMUNITY_MAPPING_INVALID';
  constructor() {
    super('Invalid explicit community identity mapping');
    this.name = 'PortableCommunityMappingError';
  }
}
function bad(): never { throw new PortableCommunityMappingError(); }
function record(value: unknown, fields: readonly string[]): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad();
  const v = value as Row, keys = Object.keys(v);
  if (keys.length !== fields.length || keys.some(k => !fields.includes(k))) bad();
  return v;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) bad();
  return value;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200) bad();
  return value;
}
function indexTarget(kind: Kind, rows: readonly Row[], sid: string): Map<string, TargetRow> {
  if (!Array.isArray(rows) || rows.length > (kind === 'roles' ? 2000 : kind === 'channels' ? 500 : 2000)) bad();
  const result = new Map<string, TargetRow>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        row.serverId !== sid) bad();
    const targetId = id(row._id);
    if (result.has(targetId)) bad();
    const target: TargetRow = { id: targetId, name: name(row.name) };
    if (kind === 'channels') {
      if (typeof row.type !== 'string' ||
          !['text', 'voice', 'forum', 'stage', 'announcement'].includes(row.type)) bad();
      target.type = row.type;
    }
    if (kind === 'roles') {
      if (row.permissions === undefined) bad();
      target.permissions = parsePermissionMask(row.permissions, 'destination role permissions');
    }
    result.set(targetId, target);
  }
  return result;
}
function validatedLinks(
  value: unknown,
  kind: Kind,
  sources: readonly SourceRow[],
  targets: Map<string, TargetRow>,
): { links: Mapping[]; widened: Array<{ sourceId: string; targetId: string; extraMask: number }>; renamed: number } {
  const max = kind === 'channels' ? 500 : 2000;
  if (!Array.isArray(value) || value.length !== sources.length || value.length > max) bad();
  const sourceIds = new Map(sources.map(s => [s.sourceId, s]));
  if (sourceIds.size !== sources.length) bad();
  const seenSource = new Set<string>(), seenTarget = new Set<string>();
  const links: Mapping[] = [], widened: Array<{ sourceId: string; targetId: string; extraMask: number }> = [];
  let renamed = 0;
  for (const raw of value) {
    const entry = record(raw, ['sourceId', 'targetId']);
    const sourceId = id(entry.sourceId), targetId = id(entry.targetId);
    const source = sourceIds.get(sourceId), dest = targets.get(targetId);
    if (!source || !dest || seenSource.has(sourceId) || seenTarget.has(targetId)) bad();
    seenSource.add(sourceId); seenTarget.add(targetId);
    if (kind === 'channels' && source.type !== dest.type) bad();
    if (source.name !== dest.name) renamed++;
    if (kind === 'roles') {
      const sourcePermissions = parsePermissionMask(source.permissions, 'source role permissions');
      const targetPermissions = dest.permissions;
      if (targetPermissions === undefined) bad();
      const extraMask = targetPermissions & ~sourcePermissions;
      if (extraMask !== 0) widened.push({ sourceId, targetId, extraMask });
    }
    links.push({ sourceId, targetId });
  }
  if (seenSource.size !== sources.length) bad();
  links.sort((a,b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
  widened.sort((a,b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
  return { links, widened, renamed };
}

/** Validates a user's explicit mapping choices; never authorizes their use. */
export function inspectExplicitCommunityMapping(
  structureInput: unknown,
  permissionInput: unknown,
  mappingInput: unknown,
  destination: { serverId: string; categories: readonly Row[];
    roles: readonly Row[]; channels: readonly Row[] },
) {
  try {
    const sid = id(destination.serverId);
    // Fully validate both files and all cross-document IDs before mapping.
    const pair = inspectPortableCommunityManifestPair(structureInput, permissionInput);
    const structure = validatePortableCommunityStructure(structureInput);
    const mapping = record(mappingInput, [
      'targetServerId', 'structureDigest', 'permissionsDigest', 'expectedTargetDigest',
      'categories', 'roles', 'channels',
    ]);
    if (mapping.targetServerId !== sid ||
        mapping.structureDigest !== pair.structureDigest ||
        mapping.permissionsDigest !== pair.permissionsDigest) bad();
    // A pair of preflight responses can straddle a destination edit.
    // This only detects a stale READ-ONLY review; it cannot guard future writes.
    const targetDigest = fingerprintDestinationTopology(destination);
    if (mapping.expectedTargetDigest !== targetDigest) bad();
    const categories = validatedLinks(mapping.categories, 'categories', structure.categories,
      indexTarget('categories', destination.categories, sid));
    const roles = validatedLinks(mapping.roles, 'roles', structure.roles,
      indexTarget('roles', destination.roles, sid));
    const channels = validatedLinks(mapping.channels, 'channels', structure.channels,
      indexTarget('channels', destination.channels, sid));
    const unsupported = pair.counts.unsupportedPermissionRows;
    const blockers = [
      'IMPORT_NOT_IMPLEMENTED',
      'SOURCE_AUTHENTICITY_NOT_VERIFIED',
      'CROSS_FILE_SNAPSHOT_ATOMICITY_NOT_VERIFIED',
      'TARGET_TOPOLOGY_CONCURRENT_CHANGE_NOT_PREVENTED',
      'OWNER_MAPPING_APPROVAL_NOT_DURABLY_RECORDED',
      'TRANSACTIONAL_IMPORT_AND_ROLLBACK_NOT_IMPLEMENTED',
      ...(unsupported > 0 ? ['UNSUPPORTED_PERMISSION_ROWS_PRESENT'] : []),
      ...(roles.widened.length > 0 ? ['TARGET_ROLE_PERMISSION_WIDENING'] : []),
    ];
    return {
      mode: 'read-only' as const,
      writesPerformed: false as const,
      importSupported: false as const,
      mappingApproved: false as const,
      sourceServerId: pair.sourceServerId,
      targetServerId: sid,
      targetTopologyDigest: targetDigest,
      sourceDigests: { structure: pair.structureDigest, permissions: pair.permissionsDigest },
      mapping: { categories: categories.links, roles: roles.links, channels: channels.links },
      counts: {
        categories: categories.links.length,
        roles: roles.links.length,
        channels: channels.links.length,
        renamedLabels: categories.renamed + roles.renamed + channels.renamed,
        unsafeRoleMappings: roles.widened.length,
        unsupportedPermissionRows: unsupported,
      },
      risks: { rolePermissionWidening: roles.widened },
      blockers,
    };
  } catch {
    // Malformed source documents and target read failures must not expose
    // private topology or generate a partial mapping.
    return bad();
  }
}
