// P7 C3: explicit source-to-existing-target mappings are an inspect-only input.
// Neither valid mappings nor zero risk signals can authorize an import.
import { buildPortableCommunityStructure } from '../lib/portableCommunity';
import { buildPortableCommunityPermissionManifest } from '../lib/portableCommunityPermissions';
import { inspectExplicitCommunityMapping, PortableCommunityMappingError } from '../lib/portableCommunityMappingReview';
import { PERMS } from '../lib/permissions';
import { fingerprintDestinationTopology } from '../lib/portableCommunityTargetFingerprint';

const SOURCE = 'mapping-source', TARGET = 'mapping-target';
const AT = '2026-10-12T11:00:00.000Z';
function fixtures() {
  const structure = buildPortableCommunityStructure(
    { _id: SOURCE, name: 'Community Source' },
    [{ _id: 'cat-a', name: 'General', position: 0 }],
    [{ _id: 'channel-a', name: 'Announcements', type: 'text', categoryId: 'cat-a', order: 0 }],
    [{ _id: 'role-a', name: 'Readers', permissions: PERMS.VIEW_CHANNELS, position: 0 }],
    AT,
  );
  const permissions = buildPortableCommunityPermissionManifest(
    { _id: SOURCE },
    [{ _id: 'channel-a', serverId: SOURCE }],
    [{ _id: 'role-a', serverId: SOURCE }],
    [{ channelId: 'channel-a', canonical: [
      { serverId: SOURCE, channelId: 'channel-a', roleId: 'role-a',
        allow: PERMS.VIEW_CHANNELS, deny: 0 },
    ], legacy: [] }],
    AT,
  );
  const target = {
    serverId: TARGET,
    categories: [{ _id: 'target-cat', serverId: TARGET, name: 'Renamed category' }],
    roles: [{ _id: 'target-role', serverId: TARGET, name: 'Readers', permissions: PERMS.VIEW_CHANNELS }],
    channels: [{ _id: 'target-channel', serverId: TARGET, name: 'Announcements', type: 'text' }],
  };
  const mapping = {
    targetServerId: TARGET,
    expectedTargetDigest: fingerprintDestinationTopology(target),
    structureDigest: structure.integrity.digest,
    permissionsDigest: permissions.integrity.digest,
    categories: [{ sourceId: 'cat-a', targetId: 'target-cat' }],
    roles: [{ sourceId: 'role-a', targetId: 'target-role' }],
    channels: [{ sourceId: 'channel-a', targetId: 'target-channel' }],
  };
  return { structure, permissions, target, mapping };
}
const invalid = (f: ReturnType<typeof fixtures>) =>
  expect(() => inspectExplicitCommunityMapping(f.structure, f.permissions, f.mapping, f.target))
    .toThrow(PortableCommunityMappingError);

describe('P7 C3 explicit community mapping review', () => {
  it('accepts full one-to-one explicit choices strictly as read-only diagnostics', () => {
    const f = fixtures();
    const result = inspectExplicitCommunityMapping(f.structure, f.permissions, f.mapping, f.target);
    expect(result).toMatchObject({
      mode: 'read-only', writesPerformed: false, importSupported: false,
      mappingApproved: false,
      sourceServerId: SOURCE, targetServerId: TARGET,
      counts: {
        categories: 1, roles: 1, channels: 1, renamedLabels: 1,
        unsafeRoleMappings: 0, unsupportedPermissionRows: 0,
      },
      mapping: { channels: [{ sourceId: 'channel-a', targetId: 'target-channel' }] },
      risks: { rolePermissionWidening: [] },
    });
    expect(result.blockers).toContain('TRANSACTIONAL_IMPORT_AND_ROLLBACK_NOT_IMPLEMENTED');
    expect(result.blockers).toContain('OWNER_MAPPING_APPROVAL_NOT_DURABLY_RECORDED');
  });

  it('rejects stale target digests after destination role or category changes', () => {
    const rename = fixtures();
    rename.target.categories[0]!.name = 'changed after preview';
    invalid(rename);
    const changedRole = fixtures();
    changedRole.target.roles[0]!.permissions = PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES;
    invalid(changedRole);
    const changedType = fixtures();
    changedType.target.channels[0]!.type = 'voice';
    invalid(changedType);
  });

  it('rejects missing, invented or foreign target-revision fingerprints', () => {
    const absent = fixtures();
    delete (absent.mapping as unknown as Record<string, unknown>).expectedTargetDigest;
    invalid(absent);
    const bad = fixtures();
    bad.mapping.expectedTargetDigest = '0'.repeat(64);
    invalid(bad);
  });

  it('uses stable hashes for reordered target rows but not different target IDs', () => {
    const f = fixtures();
    const first = fingerprintDestinationTopology(f.target);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(fingerprintDestinationTopology({
      ...f.target, categories: [...f.target.categories].reverse(),
    }));
    expect(first).not.toBe(fingerprintDestinationTopology({
      ...f.target, channels: [{ ...f.target.channels[0]!, _id: 'another-target-channel' }],
    }));
  });

  it('refuses invalid or incomplete target topology instead of inventing a fingerprint', () => {
    const check = (mutate: (f: ReturnType<typeof fixtures>) => void) => {
      const f = fixtures();
      mutate(f);
      expect(() => fingerprintDestinationTopology(f.target)).toThrow();
    };
    check(f => { f.target.roles[0]!.permissions = -1; });
    check(f => { delete (f.target.roles[0] as unknown as Record<string, unknown>).permissions; });
    check(f => { f.target.roles.push({ ...f.target.roles[0]! }); });
    check(f => { f.target.channels[0]!.type = 'bad-type'; });
    check(f => {
      (f.target.channels[0] as unknown as Record<string, unknown>).categoryId = 'missing-category';
    });
    check(f => { f.target.categories[0]!.serverId = 'foreign-target'; });
    check(f => { (f.target.roles[0] as unknown as Record<string, unknown>).name = 42; });
    check(f => {
      (f.target.channels[0] as unknown as Record<string, unknown>).categoryId = '';
    });
  });

  it('rejects digests or target IDs not bound exactly to both source files and route', () => {
    const f = fixtures();
    f.mapping.permissionsDigest = 'f'.repeat(64);
    invalid(f);
    const g = fixtures();
    g.mapping.targetServerId = 'switched-target';
    invalid(g);
    const h = fixtures();
    h.mapping.structureDigest = '0'.repeat(64);
    invalid(h);
  });

  it('rejects incomplete, duplicate, ambiguous or destination-reused mapping choices', () => {
    const f = fixtures();
    f.mapping.categories = [];
    invalid(f);
    const g = fixtures();
    g.mapping.roles.push(g.mapping.roles[0]!);
    invalid(g);
    const h = fixtures();
    h.mapping.channels[0]!.targetId = 'foreign-channel';
    invalid(h);
    const j = fixtures();
    j.mapping.categories[0]!.sourceId = 'missing-category';
    invalid(j);
  });

  it('rejects target-ID reuse across multiple real source channels', () => {
    const f = fixtures();
    f.structure = buildPortableCommunityStructure(
      { _id: SOURCE, name: 'Source' },
      [{ _id: 'cat-a', name: 'General', position: 0 }],
      [
        { _id: 'channel-a', name: 'Announcements', type: 'text', categoryId: 'cat-a', order: 0 },
        { _id: 'channel-b', name: 'Another', type: 'text', categoryId: 'cat-a', order: 1 },
      ],
      [{ _id: 'role-a', name: 'Readers', permissions: PERMS.VIEW_CHANNELS, position: 0 }], AT,
    );
    f.permissions = buildPortableCommunityPermissionManifest(
      { _id: SOURCE },
      [{ _id: 'channel-a', serverId: SOURCE }, { _id: 'channel-b', serverId: SOURCE }],
      [{ _id: 'role-a', serverId: SOURCE }],
      [
        { channelId: 'channel-a', canonical: [], legacy: [] },
        { channelId: 'channel-b', canonical: [], legacy: [] },
      ], AT,
    );
    f.mapping.structureDigest = f.structure.integrity.digest;
    f.mapping.permissionsDigest = f.permissions.integrity.digest;
    f.mapping.channels = [
      { sourceId: 'channel-a', targetId: 'target-channel' },
      { sourceId: 'channel-b', targetId: 'target-channel' },
    ];
    invalid(f);
  });

  it('rejects any target child row from another community or with malformed permissions', () => {
    const f = fixtures();
    f.target.roles[0]!.serverId = 'other-server';
    invalid(f);
    const g = fixtures();
    (g.target.roles[0] as unknown as Record<string, unknown>).permissions = 'not-a-mask';
    invalid(g);
    const h = fixtures();
    h.target.channels[0]!.type = 'voice';
    invalid(h);
  });

  it('reports widened destination role permissions as a hard blocker, not an approval', () => {
    const f = fixtures();
    f.target.roles[0]!.permissions = PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES;
    f.mapping.expectedTargetDigest = fingerprintDestinationTopology(f.target);
    const result = inspectExplicitCommunityMapping(f.structure, f.permissions, f.mapping, f.target);
    expect(result.counts.unsafeRoleMappings).toBe(1);
    expect(result.risks.rolePermissionWidening[0]).toMatchObject({
      sourceId: 'role-a', targetId: 'target-role', extraMask: PERMS.SEND_MESSAGES,
    });
    expect(result.blockers).toContain('TARGET_ROLE_PERMISSION_WIDENING');
    expect(result.importSupported).toBe(false);
  });

  it('counts excluded user/legacy overrides and never outputs their identities', () => {
    const f = fixtures();
    f.permissions = buildPortableCommunityPermissionManifest(
      { _id: SOURCE }, [{ _id: 'channel-a', serverId: SOURCE }],
      [{ _id: 'role-a', serverId: SOURCE }],
      [{ channelId: 'channel-a', canonical: [], legacy: [
        { channelId: 'channel-a', targetType: 'user', targetId: 'SENSITIVE_MEMBER' },
      ] }], AT,
    );
    f.mapping.permissionsDigest = f.permissions.integrity.digest;
    const result = inspectExplicitCommunityMapping(f.structure, f.permissions, f.mapping, f.target);
    expect(result.counts.unsupportedPermissionRows).toBe(1);
    expect(result.blockers).toContain('UNSUPPORTED_PERMISSION_ROWS_PRESENT');
    expect(JSON.stringify(result)).not.toContain('SENSITIVE_MEMBER');
  });

  it('fails closed on malformed destination IDs, missing ownership and duplicate stored IDs', () => {
    const check = (mutate: (value: ReturnType<typeof fixtures>) => void) => {
      const f = fixtures();
      mutate(f);
      invalid(f);
    };
    check(f => { f.target.categories.push({ ...f.target.categories[0]! }); });
    check(f => { delete (f.target.categories[0] as unknown as Record<string, unknown>).serverId; });
    check(f => { (f.target.categories[0] as unknown as Record<string, unknown>)._id = ''; });
    check(f => { (f.target.categories[0] as unknown as Record<string, unknown>).name = 123; });
    check(f => { (f.target as unknown as Record<string, unknown>).categories = null; });
    check(f => { (f.target as unknown as Record<string, unknown>).channels = Array.from(
      { length: 501 }, (_, i) => ({ _id: `ch-${i}`, name: 'x', type: 'text', serverId: TARGET }),
    ); });
    check(f => { (f.target.channels[0] as unknown as Record<string, unknown>).type = 7; });
    check(f => { f.target.channels[0]!.type = 'not-a-channel-type'; });
    check(f => { delete (f.target.roles[0] as unknown as Record<string, unknown>).permissions; });
    check(f => { f.target.roles[0]!.permissions = -1; });
  });

  it('fails closed on malformed source/target choices and arrays without partial approval', () => {
    const check = (mutate: (value: ReturnType<typeof fixtures>) => void) => {
      const f = fixtures();
      mutate(f);
      invalid(f);
    };
    check(f => { f.mapping.categories[0]!.sourceId = ''; });
    check(f => { f.mapping.channels[0]!.targetId = ''; });
    check(f => { f.mapping.roles[0]!.targetId = 'missing-role'; });
    check(f => { f.mapping.roles[0]!.sourceId = 'unknown-source-role'; });
    check(f => { (f.mapping as unknown as Record<string, unknown>).roles = null; });
    check(f => { (f.mapping as unknown as Record<string, unknown>).channels = [null]; });
    check(f => { f.mapping.categories.push({ ...f.mapping.categories[0]! }); });
    check(f => { (f.mapping.roles[0] as unknown as Record<string, unknown>).apply = true; });
    check(f => { f.mapping.channels[0]!.targetId = 'a'.repeat(257); });
    check(f => { f.structure.channels[0]!.name = 'tampered-source'; });
    check(f => { f.permissions.channels[0]!.overrides[0]!.allow = 0; });
  });

  it('treats a lower-privilege existing target role as inspection only, not approval', () => {
    const f = fixtures();
    f.target.roles[0]!.permissions = 0;
    f.target.roles[0]!.name = 'Renamed destination role';
    f.mapping.expectedTargetDigest = fingerprintDestinationTopology(f.target);
    const result = inspectExplicitCommunityMapping(f.structure, f.permissions, f.mapping, f.target);
    expect(result.counts.renamedLabels).toBe(2);
    expect(result.counts.unsafeRoleMappings).toBe(0);
    expect(result.mappingApproved).toBe(false);
    expect(result.blockers).toContain('OWNER_MAPPING_APPROVAL_NOT_DURABLY_RECORDED');
  });

  it('rejects extra keys and malformed mapping documents rather than ignoring apply flags', () => {
    const f = fixtures();
    const malicious = { ...f.mapping, apply: true };
    expect(() => inspectExplicitCommunityMapping(
      f.structure, f.permissions, malicious, f.target,
    )).toThrow(PortableCommunityMappingError);
    expect(() => inspectExplicitCommunityMapping(
      f.structure, f.permissions, null, f.target,
    )).toThrow(PortableCommunityMappingError);
  });
});
