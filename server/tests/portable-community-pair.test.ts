// A passing pair inspection is never permission to import or modify a DB.
import { createHash } from 'node:crypto';
import { buildPortableCommunityStructure } from '../lib/portableCommunity';
import { buildPortableCommunityPermissionManifest } from '../lib/portableCommunityPermissions';
import { inspectPortableCommunityManifestPair, PortableCommunityPairError } from '../lib/portableCommunityPair';
import { PERMS } from '../lib/permissions';

const SERVER = 'source-community';
const at = '2026-10-12T00:00:00.000Z';
function structure() {
  return buildPortableCommunityStructure(
    { _id: SERVER, name: 'Source' },
    [],
    [
      { _id: 'channel-1', type: 'text', name: 'general', order: 1 },
      { _id: 'channel-2', type: 'text', name: 'logs', order: 2 },
    ],
    [{ _id: 'role-1', name: 'Admin', permissions: 0, position: 0 }],
    at,
  );
}
function permissions() {
  return buildPortableCommunityPermissionManifest(
    { _id: SERVER },
    [
      { _id: 'channel-1', serverId: SERVER },
      { _id: 'channel-2', serverId: SERVER },
    ],
    [{ _id: 'role-1', serverId: SERVER }],
    [
      { channelId: 'channel-1', canonical: [
        { serverId: SERVER, channelId: 'channel-1', roleId: 'role-1', allow: PERMS.VIEW_CHANNELS, deny: 0 },
        { serverId: SERVER, channelId: 'channel-1', roleId: SERVER, allow: 0, deny: PERMS.SEND_MESSAGES },
      ], legacy: [
        { targetType: 'user', targetId: 'private-identity', channelId: 'channel-1' },
      ] },
      { channelId: 'channel-2', canonical: [], legacy: [] },
    ],
    at,
  );
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function resign(value: ReturnType<typeof permissions>) {
  const { integrity: _integrity, portability: _portability, ...data } = value;
  value.integrity.digest = createHash('sha256').update(JSON.stringify(data), 'utf8').digest('hex');
}
const invalid = (s: unknown, p: unknown) => expect(() => inspectPortableCommunityManifestPair(s, p))
  .toThrow(PortableCommunityPairError);

describe('P7 C3 paired community structure/permissions intake', () => {
  it('matches valid manifests and reports excluded permissions without persisting or approving import', () => {
    const s = structure(), p = permissions();
    const result = inspectPortableCommunityManifestPair(clone(s), clone(p));
    expect(result).toMatchObject({
      mode: 'read-only', importSupported: false, writesPerformed: false,
      sourceServerId: SERVER,
      counts: {
        channels: 2, roles: 1, roleOverrides: 1,
        everyoneOverrides: 1, unsupportedPermissionRows: 1,
      },
      unsupported: { legacyOverrideRows: 1 },
    });
    expect(result.blockers).toContain('UNSUPPORTED_PERMISSION_ROWS_PRESENT');
    expect(result.blockers).toContain('CROSS_FILE_SNAPSHOT_ATOMICITY_NOT_VERIFIED');
    expect(JSON.stringify(result)).not.toContain('private-identity');
  });

  it('rejects two independently valid files from different source communities', () => {
    const foreign = buildPortableCommunityPermissionManifest(
      { _id: 'foreign-community' },
      [{ _id: 'channel-1', serverId: 'foreign-community' }, { _id: 'channel-2', serverId: 'foreign-community' }],
      [{ _id: 'role-1', serverId: 'foreign-community' }],
      [
        { channelId: 'channel-1', canonical: [], legacy: [] },
        { channelId: 'channel-2', canonical: [], legacy: [] },
      ], at,
    );
    invalid(structure(), foreign);
  });

  it('rejects checksum-valid orphan channels and missing channel permission matrices', () => {
    const foreign = clone(permissions());
    foreign.channels[0]!.channelSourceId = 'channel-0'; // Still sorted and individually valid
    resign(foreign);
    invalid(structure(), foreign);

    const missing = clone(permissions());
    missing.channels.pop();
    resign(missing);
    invalid(structure(), missing);
  });

  it('rejects checksum-valid role IDs not present in the structure', () => {
    const tampered = clone(permissions());
    tampered.channels[0]!.overrides[1]!.roleSourceId = 'other-role';
    resign(tampered);
    invalid(structure(), tampered);
  });

  it('rejects a valid source structure paired with corrupted permission fields', () => {
    const tampered = clone(permissions());
    tampered.unsupported.legacyOverrideRows = -1;
    invalid(structure(), tampered);
    invalid({ ...structure(), format: 'not-bridge' }, permissions());
  });

  it('refuses checksum-valid excluded counts whose sum is not a safe integer', () => {
    const p = clone(permissions());
    p.unsupported.legacyOverrideRows = Number.MAX_SAFE_INTEGER;
    p.unsupported.individualOverrideRows = Number.MAX_SAFE_INTEGER;
    resign(p);
    invalid(structure(), p);
  });

  it('rejects source role IDs that collide with the reserved everyone marker', () => {
    for (const reserved of ['__everyone__', SERVER]) {
      const roleRow = { _id: reserved, name: 'Ambiguous', permissions: 0, position: 0 };
      const src = buildPortableCommunityStructure(
        { _id: SERVER, name: 'Source' }, [],
        [{ _id: 'channel-1', name: 'general', type: 'text', order: 1 }],
        [roleRow], at,
      );
      const p = buildPortableCommunityPermissionManifest(
        { _id: SERVER },
        [{ _id: 'channel-1', serverId: SERVER }],
        [{ _id: reserved, serverId: SERVER }],
        [{ channelId: 'channel-1', canonical: [], legacy: [] }], at,
      );
      invalid(src, p);
    }
  });

  it('keeps apply blocked even if both files have zero excluded rows', () => {
    const p = clone(permissions());
    p.unsupported.legacyOverrideRows = 0;
    resign(p);
    const result = inspectPortableCommunityManifestPair(structure(), p);
    expect(result.counts.unsupportedPermissionRows).toBe(0);
    expect(result.importSupported).toBe(false);
    expect(result.blockers).toContain('TRANSACTIONAL_IMPORT_AND_ROLLBACK_NOT_IMPLEMENTED');
  });
});
