// P7 C3: read-only cross-manifest preflight for a community structure and
// its separate role permission coverage file. This DOES NOT map or write IDs.
// SHA256 alone does not authenticate the source or prove an atomic snapshot.
import { validatePortableCommunityStructure } from './portableCommunityValidation';
import { validatePortableCommunityPermissionManifest } from './portableCommunityPermissionsValidation';

export class PortableCommunityPairError extends Error {
  readonly code = 'PORTABLE_COMMUNITY_PAIR_INVALID';
  constructor() {
    super('Inconsistent community structure and permission files');
    this.name = 'PortableCommunityPairError';
  }
}
function reject(): never { throw new PortableCommunityPairError(); }

export function inspectPortableCommunityManifestPair(
  structureInput: unknown,
  permissionInput: unknown,
) {
  try {
    const structure = validatePortableCommunityStructure(structureInput);
    const permissions = validatePortableCommunityPermissionManifest(permissionInput);
    if (permissions.sourceServerId !== structure.community.sourceServerId) reject();

    const channelIds = new Set(structure.channels.map(row => row.sourceId));
    const roleIds = new Set(structure.roles.map(row => row.sourceId));
    // These source IDs would collapse into the synthetic everyone marker
    // in the permission exporter. Reject instead of guessing a grant target.
    if (roleIds.has('__everyone__') || roleIds.has(structure.community.sourceServerId)) reject();
    if (permissions.channels.length !== channelIds.size) reject();
    const seenChannels = new Set<string>();
    let roleOverrideCount = 0;
    let everyoneOverrideCount = 0;
    for (const entry of permissions.channels) {
      if (!channelIds.has(entry.channelSourceId) || seenChannels.has(entry.channelSourceId)) reject();
      seenChannels.add(entry.channelSourceId);
      for (const override of entry.overrides) {
        if (override.roleSourceId === '__everyone__') {
          everyoneOverrideCount += 1;
        } else {
          if (!roleIds.has(override.roleSourceId)) reject();
          roleOverrideCount += 1;
        }
      }
    }
    if (seenChannels.size !== channelIds.size) reject();

    const excluded = permissions.unsupported;
    const unsupportedCount = excluded.legacyOverrideRows +
      excluded.individualOverrideRows + excluded.unknownTargetRows;
    if (!Number.isSafeInteger(unsupportedCount)) reject();
    // All entries can be well-formed without proving that two independent
    // live reads belong to one transactional source epoch.
    const blockers = [
      'SOURCE_AUTHENTICITY_NOT_VERIFIED',
      'CROSS_FILE_SNAPSHOT_ATOMICITY_NOT_VERIFIED',
      'DESTINATION_ROLE_CHANNEL_REMAP_NOT_IMPLEMENTED',
      'TRANSACTIONAL_IMPORT_AND_ROLLBACK_NOT_IMPLEMENTED',
    ];
    if (unsupportedCount > 0) blockers.push('UNSUPPORTED_PERMISSION_ROWS_PRESENT');
    return {
      mode: 'read-only',
      importSupported: false,
      writesPerformed: false,
      sourceServerId: structure.community.sourceServerId,
      structureDigest: structure.integrity.digest,
      permissionsDigest: permissions.integrity.digest,
      sourceSnapshotTimes: {
        structure: structure.exportedAt,
        permissions: permissions.exportedAt,
      },
      counts: {
        channels: channelIds.size,
        roles: roleIds.size,
        roleOverrides: roleOverrideCount,
        everyoneOverrides: everyoneOverrideCount,
        unsupportedPermissionRows: unsupportedCount,
      },
      unsupported: { ...excluded },
      blockers,
    };
  } catch {
    // No parser/schema reference details from potentially hostile files.
    return reject();
  }
}
