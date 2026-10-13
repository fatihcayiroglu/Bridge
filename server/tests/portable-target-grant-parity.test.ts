import { buildPortableCommunityPermissionManifest } from '../lib/portableCommunityPermissions';
import { requireMappedDestinationGrantParity, PortableTargetGrantParityError } from '../lib/portableTargetGrantParity';

const sid = 'destination';
const source = 'source';
const permissions = buildPortableCommunityPermissionManifest(
  { _id: source }, [{ _id: 'source-channel', serverId: source }],
  [{ _id: 'source-role', serverId: source }],
  [{ channelId: 'source-channel', canonical: [
    { channelId: 'source-channel', roleId: 'source-role', allow: 1, deny: 2 },
    { channelId: 'source-channel', roleId: source, targetType: 'everyone', allow: 4, deny: 8 },
  ], legacy: [] }],
  '2026-10-13T12:00:00.000Z',
);
const mapping = {
  roles: [{ sourceId: 'source-role', targetId: 'target-role' }],
  channels: [{ sourceId: 'source-channel', targetId: 'target-channel' }],
};
const grants = [
  { channelId: 'target-channel', serverId: sid, roleId: 'target-role', allow: 1, deny: 2 },
  { channelId: 'target-channel', serverId: sid, roleId: sid, allow: 4, deny: 8 },
];
function session(options: {
  isolation?: string; readOnly?: string; noOwner?: boolean;
  grants?: Array<Record<string, unknown>>; legacy?: boolean;
} = {}) {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes('transaction_isolation')) return { rows: [{
        isolation: options.isolation ?? 'serializable', readonly: options.readOnly ?? 'off',
      }] };
      if (sql.includes('FROM servers')) return { rows: options.noOwner ? [] : [{ _id: sid }] };
      if (sql.includes('FROM channels')) return { rows: [{ _id: 'target-channel', serverId: sid }] };
      if (sql.includes('FROM roles')) return { rows: [{ _id: 'target-role', serverId: sid }] };
      if (sql.includes('FROM channel_overrides')) return { rows: options.legacy ? [{ exists: true }] : [] };
      if (sql.includes('FROM channel_permissions')) return { rows: options.grants ?? grants };
      throw new Error('Unexpected SQL');
    },
  };
  return { client, statements };
}
function verify(client: ReturnType<typeof session>['client'], chosenMapping = mapping) {
  return requireMappedDestinationGrantParity({
    client, targetServerId: sid, ownerId: 'owner', sourcePermissions: permissions,
    mapping: chosenMapping,
  });
}
describe('portable target grant parity is an unmounted transaction-only guard', () => {
  it('accepts exact canonical rows on a serializable read-write session only', async () => {
    const { client, statements } = session();
    const result = await verify(client);
    expect(result).toMatchObject({
      mode: 'transaction-check-only', checkedChannels: 1, checkedGrants: 2,
      importSupported: false, writesPerformed: false,
    });
    expect(result.targetGrantDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(statements.some(sql => sql.includes('FOR UPDATE'))).toBe(true);
    expect(statements.filter(sql => sql.includes('FOR SHARE'))).toHaveLength(3);
  });

  it.each([
    { isolation: 'read committed' }, { isolation: 'repeatable read' },
    { readOnly: 'on' }, { noOwner: true }, { legacy: true },
  ])('refuses unsuitable session and unsafe target state %#', async options => {
    await expect(verify(session(options).client)).rejects.toBeInstanceOf(PortableTargetGrantParityError);
  });

  it('rejects partial, expanded, duplicate, and mismatched grants', async () => {
    const variants = [
      grants.slice(0, 1),
      [...grants, { ...grants[0]!, roleId: 'foreign-role' }],
      [...grants, { ...grants[1]!, roleId: '__everyone__' }],
      grants.map((row, i) => i === 0 ? { ...row, allow: 0 } : row),
    ];
    for (const rows of variants) {
      await expect(verify(session({ grants: rows }).client))
        .rejects.toBeInstanceOf(PortableTargetGrantParityError);
    }
  });

  it('accepts exactly one everyone alias; refuses reserved target role mappings', async () => {
    const alias = grants.map(row => row.roleId === sid ? { ...row, roleId: '__everyone__' } : row);
    expect((await verify(session({ grants: alias }).client)).checkedGrants).toBe(2);
    const bad = { ...mapping, roles: [{ sourceId: 'source-role', targetId: sid }] };
    await expect(verify(session().client, bad)).rejects.toBeInstanceOf(PortableTargetGrantParityError);
  });
});
