// P7 C2 — separate, owner-gated and READ-ONLY permission coverage manifest.
// Deliberately NOT part of community structure JSON v1 and not importable.
// Cross-instance role IDs are mapping inputs, never write-authority.
import { createHash } from 'node:crypto';
import { parsePermissionPair } from './permissionMaskInvariant';

type Row = Record<string, unknown>;
export type SourcePermissionRows = {
  channelId: string;
  canonical: readonly Row[];
  legacy: readonly Row[];
};

const LIMIT = 500;
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}
function distinct(rows: readonly string[], label: string): Set<string> {
  const set = new Set(rows);
  if (set.size !== rows.length) throw new TypeError(`Duplicate ${label}`);
  return set;
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildPortableCommunityPermissionManifest(
  server: Row, channels: readonly Row[], roles: readonly Row[],
  data: readonly SourcePermissionRows[],
  exportedAt: string = new Date().toISOString(),
) {
  const sourceServerId = id(server._id, 'server ID');
  if (new Date(exportedAt).toISOString() !== exportedAt) throw new TypeError('Invalid timestamp');
  if (channels.length > LIMIT || roles.length > 2000 || data.length !== channels.length) {
    throw new RangeError('Permission manifest exceeds safe source bounds');
  }

  const channelIds = distinct(channels.map(c => {
    if (c.serverId !== sourceServerId) throw new TypeError('Foreign channel');
    return id(c._id, 'channel ID');
  }), 'channel');
  const roleIds = distinct(roles.map(role => {
    if (role.serverId !== sourceServerId) throw new TypeError('Foreign role');
    return id(role._id, 'role ID');
  }), 'role');
  const seen = new Set<string>();
  let excludedUserSpecific = 0;
  let excludedUnknownTargets = 0;
  let excludedLegacy = 0;

  const output = data.map(({ channelId, canonical, legacy }) => {
    if (!channelIds.has(channelId) || seen.has(channelId)) {
      throw new TypeError('Foreign or duplicate permission channel');
    }
    seen.add(channelId);
    if (!Array.isArray(canonical) || !Array.isArray(legacy) ||
        canonical.length > 2000 || legacy.length > 2000) {
      throw new RangeError('Permission override rows exceed supported bound');
    }
    const overrides: Array<{ roleSourceId: string; allow: number; deny: number }> = [];
    const overrideIds = new Set<string>();
    for (const item of canonical) {
      if (!item || item.channelId !== channelId ||
          (item.serverId !== undefined && item.serverId !== sourceServerId)) {
        throw new TypeError('Foreign or incomplete permission row');
      }
      // Per-member/unknown override rows must never leak user identifiers.
      if (item.targetType === 'user') {
        excludedUserSpecific++;
        continue;
      }
      if (item.targetType !== undefined && item.targetType !== 'role' &&
          item.targetType !== 'everyone') {
        excludedUnknownTargets++;
        continue;
      }
      const roleId = id(item.roleId, 'permission role ID');
      const roleSourceId = roleId === sourceServerId ? '__everyone__' : roleId;
      if (roleSourceId !== '__everyone__' && !roleIds.has(roleSourceId)) {
        throw new TypeError('Permission references foreign role');
      }
      if (overrideIds.has(roleSourceId)) throw new TypeError('Duplicate role permission override');
      overrideIds.add(roleSourceId);
      const { allow, deny } = parsePermissionPair(item.allow ?? 0, item.deny ?? 0, 'portable channel permissions');
      overrides.push({ roleSourceId, allow, deny });
    }
    // Legacy target rows may include account IDs, per-user permissions and
    // untrusted extensions. NEVER serialize them as role permissions.
    excludedLegacy += legacy.length;
    overrides.sort((a, b) => compare(a.roleSourceId, b.roleSourceId));
    return { channelSourceId: channelId, overrides };
  });
  if (seen.size !== channelIds.size) throw new TypeError('Incomplete permission source');
  output.sort((a, b) => compare(a.channelSourceId, b.channelSourceId));
  const dataPart = {
    format: 'bridge-portable-community-permissions',
    version: 1,
    exportedAt,
    sourceServerId,
    channels: output,
    unsupported: {
      legacyOverrideRows: excludedLegacy,
      individualOverrideRows: excludedUserSpecific,
      unknownTargetRows: excludedUnknownTargets,
    },
  } as const;
  return {
    ...dataPart,
    integrity: {
      algorithm: 'sha256',
      canonicalization: 'ordered-json-v1',
      digest: createHash('sha256').update(JSON.stringify(dataPart), 'utf8').digest('hex'),
    },
    portability: {
      importSupported: false,
      migrationReady: false,
      included: ['canonical-role-overrides', 'canonical-everyone-overrides'],
      excluded: ['legacy-overrides', 'individual-user-overrides', 'unknown-target-overrides', 'member-assignments'],
    },
  };
}
