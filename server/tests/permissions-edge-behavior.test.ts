const mockServers = { findById: jest.fn() };
const mockMembers = { findOne: jest.fn() };
const mockRoles = {
  findByIdsInServer: jest.fn(),
  findByIdAndServer: jest.fn(),
  findWhere: jest.fn(),
};
const mockChannels = { findOverridesByChannel: jest.fn() };
const mockChannelPermissions = { findByChannel: jest.fn() };
const mockAuth = { insertAuditLog: jest.fn() };

jest.mock('../db/repositories', () => ({
  Servers: mockServers,
  Members: mockMembers,
  Roles: mockRoles,
  Channels: mockChannels,
  ChannelPermissions: mockChannelPermissions,
  Auth: mockAuth,
}));

import {
  DEFAULT_PERMISSIONS,
  PERMS,
  actorRolePosition,
  canManageRole,
  canViewChannel,
  explainResolvedPermission,
  logAudit,
  resolvePermissionResolution,
  resolvePermissions,
  resolveRolePermissionResolution,
  validateBitmask,
  viewableChannelIds,
  type PermissionResolution,
} from '../lib/permissions';

const ordinaryResolution = (patch: Partial<PermissionResolution> = {}): PermissionResolution => ({
  permissions: 0,
  subject: 'member',
  baseSource: 'roles',
  basePermissions: 0,
  roles: [],
  overrides: [],
  allow: 0,
  deny: 0,
  ...patch,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockServers.findById.mockResolvedValue({ _id: 's1', ownerId: 'owner' });
  mockMembers.findOne.mockResolvedValue({ roles: [] });
  mockRoles.findByIdsInServer.mockResolvedValue([]);
  mockRoles.findByIdAndServer.mockResolvedValue(null);
  mockRoles.findWhere.mockResolvedValue([]);
  mockChannels.findOverridesByChannel.mockResolvedValue([]);
  mockChannelPermissions.findByChannel.mockResolvedValue([]);
  mockAuth.insertAuditLog.mockResolvedValue(undefined);
});

describe('permission persistence boundaries', () => {
  test('rejects malformed legacy and canonical override targets instead of dropping deny state', async () => {
    mockChannels.findOverridesByChannel.mockResolvedValueOnce([null]);
    await expect(resolvePermissions('u1', 's1', 'c1')).rejects.toThrow(/override target/i);

    mockChannels.findOverridesByChannel.mockResolvedValueOnce([]);
    mockChannelPermissions.findByChannel.mockResolvedValueOnce([{ roleId: '', allow: 0, deny: PERMS.VIEW_CHANNELS }]);
    await expect(resolvePermissions('u1', 's1', 'c1')).rejects.toThrow(/permission role/i);
  });

  test('normalizes legacy role encodings without admitting non-string or duplicate ids', async () => {
    mockMembers.findOne.mockResolvedValueOnce({ roles: '["r1","r1",7,"",null]' });
    mockRoles.findByIdsInServer.mockResolvedValueOnce([
      { _id: 'r1', serverId: 's1', name: '', permissions: PERMS.BAN_MEMBERS },
    ]);
    expect(await resolvePermissions('u1', 's1')).toBe(PERMS.BAN_MEMBERS);
    expect(mockRoles.findByIdsInServer).toHaveBeenCalledWith(['r1'], 's1');

    mockMembers.findOne.mockResolvedValueOnce({ roles: 7 });
    expect(await resolvePermissions('u1', 's1')).toBe(DEFAULT_PERMISSIONS);
  });

  test('keeps legacy bare strings compatible and handles explicit empty strings as no roles', async () => {
    mockMembers.findOne.mockResolvedValueOnce({ roles: 'legacy-role' });
    mockRoles.findByIdsInServer.mockResolvedValueOnce([
      { _id: 'legacy-role', serverId: 's1', permissions: PERMS.KICK_MEMBERS },
    ]);
    expect(await resolvePermissions('u1', 's1')).toBe(PERMS.KICK_MEMBERS);

    mockMembers.findOne.mockResolvedValueOnce({ roles: '' });
    expect(await resolvePermissions('u1', 's1')).toBe(DEFAULT_PERMISSIONS);
  });

  test('applies sorted matching role overrides and safe fallback names/masks', async () => {
    mockMembers.findOne.mockResolvedValue({ roles: ['r1', 'r2'] });
    mockRoles.findByIdsInServer.mockResolvedValue([
      { _id: 'r1', serverId: 's1', name: '', permissions: PERMS.VIEW_CHANNELS },
      { _id: 'r2', serverId: 's1', permissions: 0 },
    ]);
    mockChannels.findOverridesByChannel.mockResolvedValue([
      { targetType: 'role', targetId: 'r2', allow: undefined, deny: PERMS.VIEW_CHANNELS },
      { targetType: 'role', targetId: 'r1', allow: PERMS.SEND_MESSAGES, deny: undefined, position: 2 },
      { targetType: 'user', targetId: 'u1', allow: PERMS.ATTACH_FILES, deny: 0 },
    ]);
    mockChannelPermissions.findByChannel.mockResolvedValue(null);

    const result = await resolvePermissionResolution('u1', 's1', 'c1');
    expect(result.permissions & PERMS.SEND_MESSAGES).toBe(PERMS.SEND_MESSAGES);
    expect(result.permissions & PERMS.ATTACH_FILES).toBe(PERMS.ATTACH_FILES);
    expect(result.overrides.map(entry => entry.targetName)).toEqual(['r2', 'r1', 'Üyeye özel']);
  });

  test('role-only preview returns null for a foreign role and supports default channel arguments', async () => {
    expect(await resolveRolePermissionResolution('missing', 's1')).toBeNull();

    mockRoles.findByIdAndServer.mockResolvedValueOnce({
      _id: 'r1', serverId: 's1', name: 'Role', permissions: PERMS.SEND_MESSAGES,
    });
    expect((await resolveRolePermissionResolution('r1', 's1'))?.permissions).toBe(PERMS.SEND_MESSAGES);
    expect((await resolveRolePermissionResolution('__everyone__', 's1'))?.permissions).toBe(DEFAULT_PERMISSIONS);
  });
});

describe('safe permission explanations', () => {
  test.each([
    [ordinaryResolution({ subject: 'owner', permissions: 0x7fffffff, baseSource: 'owner', basePermissions: 0x7fffffff }), 'SERVER_OWNER'],
    [ordinaryResolution({ subject: 'administrator', permissions: 0x7fffffff, baseSource: 'administrator', basePermissions: PERMS.ADMINISTRATOR }), 'ADMINISTRATOR'],
    [ordinaryResolution({ permissions: PERMS.SEND_MESSAGES, allow: PERMS.SEND_MESSAGES }), 'CHANNEL_OVERRIDE_ALLOW'],
    [ordinaryResolution({ permissions: PERMS.SEND_MESSAGES, basePermissions: PERMS.SEND_MESSAGES }), 'BASE_PERMISSION'],
    [ordinaryResolution({ subject: 'not_member', baseSource: 'none' }), 'NOT_A_MEMBER'],
    [ordinaryResolution(), 'MISSING_PERMISSION'],
  ])('reports the canonical reason without exposing raw masks: %s', (resolution, reasonCode) => {
    const explanation = explainResolvedPermission(resolution as PermissionResolution, PERMS.SEND_MESSAGES);
    expect(explanation.reasonCode).toBe(reasonCode);
    expect(explanation.effective).toBe(explanation.allowed ? 'allowed' : 'denied');
  });

  test('maps member overrides and ignores overrides unrelated to the requested flag', () => {
    const explanation = explainResolvedPermission(ordinaryResolution({
      permissions: PERMS.SEND_MESSAGES,
      allow: PERMS.SEND_MESSAGES,
      roles: [{ _id: 'r1', serverId: 's1', permissions: PERMS.SEND_MESSAGES }],
      overrides: [
        { scope: 'user', targetId: 'u1', targetName: 'Member', allow: PERMS.SEND_MESSAGES, deny: 0 },
        { scope: 'role', targetId: 'r1', targetName: 'Role', allow: 0, deny: PERMS.ATTACH_FILES },
      ],
    }), PERMS.SEND_MESSAGES);
    expect(explanation.base.sources).toEqual(['Rol: r1']);
    expect(explanation.overrides).toEqual([{ scope: 'member', label: 'Member', state: 'allowed' }]);
  });
});

describe('visibility and hierarchy fail-closed edges', () => {
  test('rejects missing channel coordinates and contains resolver failures', async () => {
    await expect(canViewChannel('', 's1', 'c1')).resolves.toBe(false);
    await expect(canViewChannel('u1', '', 'c1')).resolves.toBe(false);
    await expect(canViewChannel('u1', 's1', '')).resolves.toBe(false);
    mockServers.findById.mockRejectedValueOnce(new Error('db unavailable'));
    await expect(canViewChannel('u1', 's1', 'c1')).resolves.toBe(false);
  });

  test('bulk visibility de-duplicates channels and returns only authorized ids', async () => {
    mockServers.findById.mockImplementation(async (serverId: string) =>
      serverId === 's1' ? { _id: 's1', ownerId: 'owner' } : null);
    const result = await viewableChannelIds('owner', 's1', ['c1', 'c1', 'c2']);
    expect(result).toEqual(new Set(['c1', 'c2']));
    expect(mockServers.findById).toHaveBeenCalledTimes(2);
  });

  test('canManageRole validates coordinates, tenant existence, membership and strict rank', async () => {
    await expect(canManageRole('', 'r1', 's1')).resolves.toBe(false);
    await expect(canManageRole('u1', '', 's1')).resolves.toBe(false);
    await expect(canManageRole('u1', 'r1', '')).resolves.toBe(false);

    mockServers.findById.mockResolvedValueOnce(null);
    await expect(canManageRole('u1', 'r1', 's1')).resolves.toBe(false);
    await expect(canManageRole('owner', 'r1', 's1')).resolves.toBe(true);

    mockMembers.findOne.mockResolvedValueOnce(null);
    mockRoles.findByIdAndServer.mockResolvedValueOnce({ _id: 'r1', serverId: 's1', position: 1 });
    await expect(canManageRole('u1', 'r1', 's1')).resolves.toBe(false);

    mockMembers.findOne.mockResolvedValueOnce({ roles: [] });
    mockRoles.findByIdAndServer.mockResolvedValueOnce({ _id: 'r1', serverId: 's1' });
    await expect(canManageRole('u1', 'r1', 's1')).resolves.toBe(false);

    mockMembers.findOne.mockResolvedValueOnce({ roles: ['high'] });
    mockRoles.findByIdAndServer.mockResolvedValueOnce({ _id: 'r1', serverId: 's1', position: 1 });
    mockRoles.findWhere.mockResolvedValueOnce([{ _id: 'high', serverId: 's1', position: 2 }]);
    await expect(canManageRole('u1', 'r1', 's1')).resolves.toBe(true);
  });

  test('actorRolePosition covers owner, absent authority, empty roles and maximum persisted rank', async () => {
    await expect(actorRolePosition('', 's1')).resolves.toBe(0);
    await expect(actorRolePosition('u1', '')).resolves.toBe(0);
    mockServers.findById.mockResolvedValueOnce(null);
    await expect(actorRolePosition('u1', 's1')).resolves.toBe(0);
    await expect(actorRolePosition('owner', 's1')).resolves.toBe(Number.POSITIVE_INFINITY);
    mockMembers.findOne.mockResolvedValueOnce(null);
    await expect(actorRolePosition('u1', 's1')).resolves.toBe(0);
    mockMembers.findOne.mockResolvedValueOnce({ roles: [] });
    await expect(actorRolePosition('u1', 's1')).resolves.toBe(0);
    mockMembers.findOne.mockResolvedValueOnce({ roles: ['low', 'high'] });
    mockRoles.findWhere.mockResolvedValueOnce([
      { _id: 'low', serverId: 's1', position: undefined },
      { _id: 'high', serverId: 's1', position: 9 },
    ]);
    await expect(actorRolePosition('u1', 's1')).resolves.toBe(9);
  });
});

describe('audit and bitmask edge behavior', () => {
  test('audit logging uses an empty default payload and remains best-effort on storage failure', async () => {
    await expect(logAudit('s1', 'u1', 'CREATE', 'r1')).resolves.toBeUndefined();
    expect(mockAuth.insertAuditLog).toHaveBeenCalledWith({
      serverId: 's1', actorId: 'u1', action: 'CREATE', target: 'r1', extra: {},
    });
    mockAuth.insertAuditLog.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(logAudit('s1', 'u1', 'DELETE', 'r1', { reason: 'cleanup' })).resolves.toBeUndefined();
  });

  test.each([
    [Number.NaN, 0, /allow/],
    [0, Number.NaN, /deny/],
    [PERMS.SEND_MESSAGES, PERMS.SEND_MESSAGES, /aynı biti/],
    [0, 0, null],
  ])('validates bitmask pair %#', (allow, deny, error) => {
    const result = validateBitmask(allow, deny);
    if (error) expect(result).toEqual(expect.objectContaining({ ok: false, error: expect.stringMatching(error) }));
    else expect(result).toEqual({ ok: true });
  });
});
