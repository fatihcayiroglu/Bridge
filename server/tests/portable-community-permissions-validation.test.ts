// P7 C3: permission intake is validation only, never authorization to apply.
import { buildPortableCommunityPermissionManifest } from '../lib/portableCommunityPermissions';
import {
  validatePortableCommunityPermissionManifest, PortableCommunityPermissionsError,
} from '../lib/portableCommunityPermissionsValidation';
import { PERMS } from '../lib/permissions';

const ID = 'source-community';
function sample() {
  return buildPortableCommunityPermissionManifest(
    { _id: ID },
    [{ _id: 'ch-1', serverId: ID }, { _id: 'ch-2', serverId: ID }],
    [{ _id: 'role-1', serverId: ID }],
    [
      { channelId: 'ch-1', canonical: [
        { channelId: 'ch-1', serverId: ID, roleId: 'role-1',
          allow: PERMS.VIEW_CHANNELS, deny: 0 },
        { channelId: 'ch-1', serverId: ID, roleId: ID,
          allow: 0, deny: PERMS.SEND_MESSAGES },
      ], legacy: [{ channelId: 'ch-1', targetType: 'user', targetId: 'private-user-should-not-export' }] },
      { channelId: 'ch-2', canonical: [], legacy: [] },
    ],
    '2026-10-12T00:00:00.000Z',
  );
}
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const clone = <T>(x: T): Mutable<T> => JSON.parse(JSON.stringify(x)) as Mutable<T>;
const invalid = (value: unknown) => expect(() => validatePortableCommunityPermissionManifest(value))
  .toThrow(PortableCommunityPermissionsError);

describe('P7 C3 permission file strict preflight', () => {
  it('accepts exact C2 serializer output while remaining explicitly nonimportable', () => {
    const value = sample();
    const result = validatePortableCommunityPermissionManifest(clone(value));
    expect(result).toEqual(value);
    expect(result.portability.migrationReady).toBe(false);
    expect(result.portability.importSupported).toBe(false);
    expect(result.unsupported.legacyOverrideRows).toBe(1);
    expect(JSON.stringify(result)).not.toContain('private-user-should-not-export');
  });

  it('detects modified masks, unsupported count edits and modified digest', () => {
    const changed = clone(sample());
    changed.channels[0]!.overrides[0]!.deny = 0;
    invalid(changed);
    const changedCount = clone(sample());
    changedCount.unsupported.legacyOverrideRows = 0;
    invalid(changedCount);
    invalid({ ...sample(), integrity: { ...sample().integrity, digest: '0'.repeat(64) } });
  });

  it('rejects wrong versions, extraneous user fields, and fabricated import capabilities', () => {
    invalid({ ...sample(), version: 2 });
    invalid({ ...sample(), targetUserId: 'secret-user' });
    const badChannel = clone(sample());
    (badChannel.channels[0] as unknown as Record<string, unknown>).memberIds = ['someone'];
    invalid(badChannel);
    invalid({ ...sample(), portability: { ...sample().portability, migrationReady: true } });
    invalid({ ...sample(), portability: { ...sample().portability, importSupported: true } });
  });

  it('rejects invalid masks and allow/deny overlap before any migration planning', () => {
    const malformed = clone(sample());
    malformed.channels[0]!.overrides[0]!.allow = -1;
    invalid(malformed);
    const overlapped = clone(sample());
    overlapped.channels[0]!.overrides[1]!.deny = PERMS.VIEW_CHANNELS;
    invalid(overlapped);
  });

  it('rejects duplicate or reordered channel and role records (no silently dropped mappings)', () => {
    const dupChannel = clone(sample());
    dupChannel.channels.push(dupChannel.channels[0]!);
    invalid(dupChannel);
    const dupRole = clone(sample());
    dupRole.channels[0]!.overrides.push(dupRole.channels[0]!.overrides[0]!);
    invalid(dupRole);
    const reordered = clone(sample());
    reordered.channels.reverse();
    invalid(reordered);
  });

  it('fails on oversized or incomplete exports, never infers destination privileges', () => {
    invalid({ ...sample(), unexpected: 'x'.repeat(600 * 1024) });
    const noUnsupported = clone(sample()) as unknown as Record<string, unknown>;
    delete noUnsupported.unsupported;
    invalid(noUnsupported);
    const valid = validatePortableCommunityPermissionManifest(sample());
    expect(valid.portability.migrationReady).toBe(false);
    expect(Object.keys(valid)).not.toContain('apply');
  });
});
