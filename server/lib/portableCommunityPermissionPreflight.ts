// P7 C3: read-only permission mapping safety diagnostics across two community
// structures. NEVER construct an executable plan from name matches.
import { validatePortableCommunityStructure } from './portableCommunityValidation';
import { validatePortableCommunityPermissionManifest } from './portableCommunityPermissionsValidation';

type Row = Record<string, unknown>;
type Kind = 'channel' | 'role';
type Reason = 'NO_TARGET_NAME_MATCH' | 'AMBIGUOUS_TARGET_MATCH' | 'AMBIGUOUS_SOURCE_NAME';
const MAX_RESULTS = 50;

function norm(s: string): string { return s.normalize('NFKC').trim().toLowerCase(); }
function safeId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256) throw new TypeError('Invalid destination ID');
  return value;
}
function safeName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200) throw new TypeError('Invalid destination name');
  return value;
}
function indexTarget(rows: readonly Row[], kind: Kind) {
  if (!Array.isArray(rows) || rows.length > (kind === 'role' ? 2000 : 500)) {
    throw new TypeError('Destination topology exceeds preflight limit');
  }
  const byName = new Map<string, string[]>();
  const uniqueIds = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('Invalid destination row');
    const id = safeId(row._id);
    if (uniqueIds.has(id)) throw new TypeError('Duplicate destination ID');
    uniqueIds.add(id);
    const name = safeName(row.name);
    const channelType = kind === 'channel'
      ? (typeof row.type === 'string' && ['text', 'voice', 'forum', 'stage', 'announcement'].includes(row.type)
          ? row.type : (() => { throw new TypeError('Invalid destination channel type'); })())
      : '';
    const key = norm(name) + '\u0000' + channelType;
    const matches = byName.get(key);
    if (matches) matches.push(id); else byName.set(key, [id]);
  }
  return byName;
}
function inspect(kind: Kind, source: readonly { sourceId: string; name: string; type?: string }[],
  target: Map<string, string[]>) {
  const tally = new Map<string, number>();
  for (const item of source) {
    const key = norm(item.name) + '\u0000' + (kind === 'channel' ? item.type ?? '' : '');
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const findings: Array<{ kind: Kind; sourceId: string; reason: Reason; targetMatchCount: number }> = [];
  let provisional = 0;
  for (const item of source) {
    const key = norm(item.name) + '\u0000' + (kind === 'channel' ? item.type ?? '' : '');
    const matches = target.get(key) ?? [];
    const reason: Reason | null =
      (tally.get(key) ?? 0) > 1 ? 'AMBIGUOUS_SOURCE_NAME'
      : matches.length === 0 ? 'NO_TARGET_NAME_MATCH'
      : matches.length > 1 ? 'AMBIGUOUS_TARGET_MATCH'
      : null;
    if (reason) findings.push({ kind, sourceId: item.sourceId, reason, targetMatchCount: matches.length });
    else provisional++;
  }
  return { findings, provisional };
}

export function previewCommunityPermissionRemapping(
  structureInput: unknown,
  permissionInput: unknown,
  destination: { channels: readonly Row[]; roles: readonly Row[] },
) {
  // Independent source integrity validation must happen before cross-references.
  const structure = validatePortableCommunityStructure(structureInput);
  const permission = validatePortableCommunityPermissionManifest(permissionInput);
  if (structure.community.sourceServerId !== permission.sourceServerId) {
    throw new TypeError('Structure and permissions refer to different source communities');
  }
  const channels = new Set(structure.channels.map(c => c.sourceId));
  if (permission.channels.length !== channels.size ||
      permission.channels.some(c => !channels.has(c.channelSourceId))) {
    throw new TypeError('Permission coverage does not match source channel set');
  }
  const roles = new Set(structure.roles.map(r => r.sourceId));
  for (const channel of permission.channels) {
    for (const override of channel.overrides) {
      if (override.roleSourceId !== '__everyone__' && !roles.has(override.roleSourceId)) {
        throw new TypeError('Permission manifest contains unknown source role');
      }
    }
  }
  const targetRoles = indexTarget(destination.roles, 'role');
  const targetChannels = indexTarget(destination.channels, 'channel');
  const roleCheck = inspect('role', structure.roles, targetRoles);
  const channelCheck = inspect('channel', structure.channels, targetChannels);
  const findings = [...roleCheck.findings, ...channelCheck.findings];
  const unsupported = permission.unsupported;
  // Avoid precision loss if several individually valid (safe-integer) counts
  // would overflow Number.MAX_SAFE_INTEGER when added together.
  const hasUnsupportedGrants = unsupported.legacyOverrideRows > 0 ||
    unsupported.individualOverrideRows > 0 || unsupported.unknownTargetRows > 0;
  const overrideRows = permission.channels.reduce((sum, ch) => sum + ch.overrides.length, 0);
  return {
    mode: 'read-only',
    writesPerformed: false,
    importSupported: false,
    sourceServerId: structure.community.sourceServerId,
    coverage: {
      channels: permission.channels.length,
      roleOverrides: overrideRows,
      excludedRows: unsupported,
      hasUnsupportedGrants,
    },
    diagnosticNameMatches: {
      roles: roleCheck.provisional,
      channels: channelCheck.provisional,
      // Names are not identity proofs or an approved source-to-destination map.
      usableForImport: false,
    },
    unresolved: {
      total: findings.length,
      truncated: findings.length > MAX_RESULTS,
      items: findings.slice(0, MAX_RESULTS),
    },
    blockers: [
      'IMPORT_NOT_IMPLEMENTED',
      'SOURCE_AUTHENTICITY_NOT_VERIFIED',
      'ROLE_AND_CHANNEL_IDENTITY_NOT_VERIFIED',
      'PERMISSION_ESCALATION_POLICY_NOT_REVIEWED',
      ...(hasUnsupportedGrants ? ['UNSUPPORTED_PERMISSION_ROWS'] : []),
    ],
  } as const;
}
