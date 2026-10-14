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

// Every refusal below must leave no way to proceed: the caller gets the one
// opaque parity error, and malformed inputs are refused before any SQL runs.
type Rows = Array<Record<string, unknown>>;
function scripted(overrides: Partial<Record<'state' | 'servers' | 'channels' | 'roles' | 'legacy' | 'grants', unknown>> = {}) {
  const statements: string[] = [];
  const results: Record<string, unknown> = {
    state: { rows: [{ isolation: 'serializable', readonly: 'off' }] },
    servers: { rows: [{ _id: sid }] },
    channels: { rows: [{ _id: 'target-channel', serverId: sid }] },
    roles: { rows: [{ _id: 'target-role', serverId: sid }] },
    legacy: { rows: [] },
    grants: { rows: grants },
    ...overrides,
  };
  const table = (sql: string) => sql.includes('transaction_isolation') ? 'state'
    : sql.includes('FROM servers') ? 'servers' : sql.includes('FROM channels') ? 'channels'
      : sql.includes('FROM roles') ? 'roles' : sql.includes('FROM channel_overrides') ? 'legacy'
        : sql.includes('FROM channel_permissions') ? 'grants' : 'unexpected';
  const client = {
    async query(sql: string) {
      statements.push(table(sql));
      return results[table(sql)] as { rows: Rows };
    },
  };
  return { client, statements };
}
const refused = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(PortableTargetGrantParityError);

describe('portable target grant parity refuses malformed input before reading the destination', () => {
  it.each([
    ['an empty target server', { targetServerId: '' }],
    ['a padded target server', { targetServerId: ` ${sid}` }],
    ['a control character in the owner', { ownerId: 'owner\u0000' }],
    ['an over-long owner', { ownerId: 'o'.repeat(257) }],
    ['a non-string owner', { ownerId: 42 as unknown as string }],
  ])('%s', async (_name, change) => {
    const { client, statements } = scripted();
    await refused(requireMappedDestinationGrantParity({
      client, targetServerId: sid, ownerId: 'owner', sourcePermissions: permissions, mapping, ...change,
    }));
    expect(statements).toEqual([]);
  });

  const link = (sourceId: string, targetId: string) => ({ sourceId, targetId });
  it.each([
    ['roles that are not an array', { ...mapping, roles: { 'source-role': 'target-role' } }],
    ['more role links than the bound', { ...mapping, roles: Array.from({ length: 2001 }, (_, i) => link(`s${i}`, `t${i}`)) }],
    ['a null link', { ...mapping, roles: [null] }],
    ['an array as a link', { ...mapping, roles: [['source-role', 'target-role']] }],
    ['a link with an extra field', { ...mapping, roles: [{ ...mapping.roles[0], apply: true }] }],
    ['a link without a target', { ...mapping, roles: [{ sourceId: 'source-role', target: 'target-role' }] }],
    ['one source mapped twice', { ...mapping, roles: [link('source-role', 'target-role'), link('source-role', 'other-role')] }],
    ['two sources merged into one target', { ...mapping, roles: [link('source-role', 'target-role'), link('other-source', 'target-role')] }],
    ['a whitespace-padded target id', { ...mapping, roles: [link('source-role', 'target-role ')] }],
    ['the reserved everyone id as a role target', { ...mapping, roles: [link('source-role', '__everyone__')] }],
    ['no link for the exported channel', { ...mapping, channels: [] }],
    ['a link for a channel the source never exported', { ...mapping, channels: [link('other-channel', 'target-channel')] }],
    ['an extra channel link', { ...mapping, channels: [...mapping.channels, link('other-channel', 'other-target')] }],
  ])('a mapping with %s', async (_name, chosen) => {
    const { client, statements } = scripted();
    await refused(verify(client as never, chosen as typeof mapping));
    expect(statements).toEqual([]);
  });
});

describe('portable target grant parity refuses destination reads it cannot trust', () => {
  it.each([
    ['a session probe without rows', { state: { rows: null } }],
    ['a session probe that returns nothing', { state: undefined }],
    ['two session rows', { state: { rows: [{ isolation: 'serializable', readonly: 'off' }, { isolation: 'serializable', readonly: 'off' }] } }],
    ['an owner row for another server', { servers: { rows: [{ _id: 'other-server' }] } }],
    ['a missing target channel', { channels: { rows: [] } }],
    ['a target channel in another server', { channels: { rows: [{ _id: 'target-channel', serverId: 'other-server' }] } }],
    ['a channel the mapping never named', { channels: { rows: [{ _id: 'unrequested', serverId: sid }] } }],
    ['more channel rows than the bound', { channels: { rows: Array.from({ length: 501 }, () => ({ _id: 'target-channel', serverId: sid })) } }],
    ['a missing target role', { roles: { rows: [] } }],
    ['a target role in another server', { roles: { rows: [{ _id: 'target-role', serverId: 'other-server' }] } }],
    ['a role id with a control character', { roles: { rows: [{ _id: 'target-role\u0007', serverId: sid }] } }],
    ['a grant row from another server', { grants: { rows: grants.map((g, i) => i ? g : { ...g, serverId: 'other-server' }) } }],
    ['a grant row for an unmapped channel', { grants: { rows: [...grants, { ...grants[0], channelId: 'unmapped-channel' }] } }],
    ['a grant row with an empty role id', { grants: { rows: grants.map((g, i) => i ? g : { ...g, roleId: '' }) } }],
    ['the same grant twice', { grants: { rows: [...grants, grants[0]] } }],
  ])('%s', async (_name, change) => {
    await refused(verify(scripted(change).client as never));
  });

  it('a source override whose role the owner did not map is refused, not dropped', async () => {
    const twoRoles = buildPortableCommunityPermissionManifest(
      { _id: source }, [{ _id: 'source-channel', serverId: source }],
      [{ _id: 'source-role', serverId: source }, { _id: 'unmapped-role', serverId: source }],
      [{ channelId: 'source-channel', canonical: [
        { channelId: 'source-channel', roleId: 'source-role', allow: 1, deny: 2 },
        { channelId: 'source-channel', roleId: 'unmapped-role', allow: 16, deny: 0 },
      ], legacy: [] }],
      '2026-10-13T12:00:00.000Z',
    );
    const { client, statements } = scripted();
    await refused(requireMappedDestinationGrantParity({
      client, targetServerId: sid, ownerId: 'owner', sourcePermissions: twoRoles, mapping,
    }));
    // It got as far as reading the destination, then refused on the gap itself.
    expect(statements).toEqual(['state', 'servers', 'channels', 'roles']);
  });
});
