import { buildPortableCommunityStructure } from '../lib/portableCommunity';
import { buildPortableCommunityPermissionManifest } from '../lib/portableCommunityPermissions';
import { previewCommunityPermissionRemapping } from '../lib/portableCommunityPermissionPreflight';

const SID = 'source-a';
const ts = '2026-10-12T00:00:00.000Z';
function source() {
  const server = { _id: SID, name: 'Source' };
  const channels = [
    { _id: 'c1', serverId: SID, name: 'general', type: 'text', order: 0 },
    { _id: 'c2', serverId: SID, name: 'voice', type: 'voice', order: 1 },
  ];
  const roles = [
    { _id: 'r1', serverId: SID, name: 'Reader', position: 0, permissions: 1 },
  ];
  const structure = buildPortableCommunityStructure(server, [], channels, roles, ts);
  const permission = buildPortableCommunityPermissionManifest(server, channels, roles, [
    { channelId: 'c1', canonical: [
      { channelId: 'c1', serverId: SID, roleId: 'r1', allow: 1, deny: 0 },
    ], legacy: [] },
    { channelId: 'c2', canonical: [
      { channelId: 'c2', serverId: SID, roleId: SID, allow: 0, deny: 2 },
    ], legacy: [] },
  ], ts);
  return { structure, permission };
}
const destination = {
  channels: [
    { _id: 'target-channel-a', name: 'general', type: 'text' },
    { _id: 'target-channel-b', name: 'voice', type: 'voice' },
  ],
  roles: [{ _id: 'target-role', name: 'Reader' }],
};
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('P7 C3 cross-manifest permission migration preflight', () => {
  it('accepts matching C2 files only as read-only diagnostics; never grants migration permission', () => {
    const { structure, permission } = source();
    const result = previewCommunityPermissionRemapping(structure, permission, destination);
    expect(result).toMatchObject({
      mode: 'read-only', writesPerformed: false, importSupported: false,
      sourceServerId: SID,
      coverage: { channels: 2, roleOverrides: 2, hasUnsupportedGrants: false },
      diagnosticNameMatches: { roles: 1, channels: 2, usableForImport: false },
      unresolved: { total: 0, truncated: false },
    });
    expect(result.blockers).toContain('IMPORT_NOT_IMPLEMENTED');
    expect(result.blockers).toContain('PERMISSION_ESCALATION_POLICY_NOT_REVIEWED');
  });

  it('does not infer role identity from duplicate destination role names', () => {
    const { structure, permission } = source();
    const preview = previewCommunityPermissionRemapping(structure, permission, {
      ...destination, roles: [...destination.roles, { _id: 'target-role-2', name: 'reader' }],
    });
    expect(preview.unresolved).toMatchObject({
      total: 1, items: [{ kind: 'role', sourceId: 'r1', reason: 'AMBIGUOUS_TARGET_MATCH', targetMatchCount: 2 }],
    });
    expect(preview.diagnosticNameMatches.usableForImport).toBe(false);
  });

  it('uses channel type plus normalized name and does not falsely match mismatched types', () => {
    const { structure, permission } = source();
    const preview = previewCommunityPermissionRemapping(structure, permission, {
      ...destination, channels: [
        { _id: 'target-channel-a', name: 'ＧＥＮＥＲＡＬ', type: 'voice' },
        destination.channels[1]!,
      ],
    });
    expect(preview.unresolved).toMatchObject({
      total: 1, items: [{ kind: 'channel', sourceId: 'c1', reason: 'NO_TARGET_NAME_MATCH' }],
    });
  });

  it('rejects a paired document from a foreign source server without a plan', () => {
    const { structure, permission } = source();
    const tampered = copy(permission);
    tampered.sourceServerId = 'other-source';
    expect(() => previewCommunityPermissionRemapping(structure, tampered, destination)).toThrow();
  });

  it('rejects cross-document missing channel coverage, even with valid recomputed permission digest', () => {
    const { structure } = source();
    const server = { _id: SID };
    const partial = buildPortableCommunityPermissionManifest(
      server,
      [{ _id: 'c1', serverId: SID }],
      [{ _id: 'r1', serverId: SID }],
      [{ channelId: 'c1', canonical: [{ channelId: 'c1', roleId: 'r1', allow: 1, deny: 0 }], legacy: [] }],
      ts,
    );
    expect(() => previewCommunityPermissionRemapping(structure, partial, destination)).toThrow('coverage');
  });

  it('fails when a valid permission file references a role absent from the C2 topology', () => {
    const { structure } = source();
    const foreign = buildPortableCommunityPermissionManifest(
      { _id: SID },
      [{ _id: 'c1', serverId: SID }, { _id: 'c2', serverId: SID }],
      [{ _id: 'unknown-role', serverId: SID }],
      [
        { channelId: 'c1', canonical: [{ channelId: 'c1', roleId: 'unknown-role', allow: 1, deny: 0 }], legacy: [] },
        { channelId: 'c2', canonical: [], legacy: [] },
      ],
      ts,
    );
    expect(() => previewCommunityPermissionRemapping(structure, foreign, destination)).toThrow('unknown source role');
  });

  it('counts excluded permission records and blocks rather than silently discarding them', () => {
    const { structure } = source();
    const srv = { _id: SID };
    const chans = [
      { _id: 'c1', serverId: SID },
      { _id: 'c2', serverId: SID },
    ];
    const doc = buildPortableCommunityPermissionManifest(srv, chans, [], [
      { channelId: 'c1', canonical: [], legacy: [{ channelId: 'c1', targetType: 'user', targetId: 'private-member' }] },
      { channelId: 'c2', canonical: [], legacy: [] },
    ], ts);
    const output = previewCommunityPermissionRemapping(structure, doc, destination);
    expect(output.coverage.hasUnsupportedGrants).toBe(true);
    expect(output.coverage.excludedRows.legacyOverrideRows).toBe(1);
    expect(output.blockers).toContain('UNSUPPORTED_PERMISSION_ROWS');
    expect(JSON.stringify(output)).not.toContain('private-member');
  });

  it('fails closed on malformed target topology and duplicate destination IDs', () => {
    const { structure, permission } = source();
    expect(() => previewCommunityPermissionRemapping(structure, permission, {
      ...destination, roles: [{ _id: 'same', name: 'One' }, { _id: 'same', name: 'Two' }],
    })).toThrow('Duplicate destination ID');
    expect(() => previewCommunityPermissionRemapping(structure, permission, {
      ...destination, channels: [{ _id: 'target-channel-a', name: 'general', type: 'missing-type' }],
    })).toThrow('Invalid destination channel type');
  });
});
