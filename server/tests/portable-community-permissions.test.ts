// P7 C2: permission-aware, owner-only export regression contract.
// This manifest is deliberately NOT importable and MUST NOT leak account IDs.
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../routes/discover', () => ({ invalidateMemberCount: jest.fn(async () => {}) }));
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import serversRouter from '../routes/servers';
import { stepUpHeader } from './helpers/stepUp';
import { PERMS } from '../lib/permissions';
import { ChannelPermissions, Channels } from '../db/repositories';
import { buildPortableCommunityPermissionManifest } from '../lib/portableCommunityPermissions';

const db = require('../db/loader') as import('./helpers/mockDb').MockDb;
const SID = 'portable-permission-source', OWNER = 'permission-owner', MEMBER = 'permission-member';
const token = (id: string) => jwt.sign({ id, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/servers', serversRouter);
  return a;
}
function download(id: string, scope: 'sensitive-export' | 'account-security' | null = null) {
  const q = request(app()).get(`/api/servers/${SID}/portable-permissions-export`)
    .set('Authorization', `Bearer ${token(id)}`);
  return scope ? q.set(stepUpHeader(id, scope)) : q;
}
async function snapshot() {
  return {
    channels: await db.channels.find({}),
    roles: await db.roles.find({}),
    permissions: await db.channelPermissions.find({}),
    legacy: await db.channelOverrides.find({}),
  };
}
beforeEach(async () => {
  db._reset();
  for (const id of [OWNER, MEMBER]) {
    await db.users.insert({ _id: id, username: id, password: 'hash', tokenVersion: 0 });
  }
  await db.servers.insert({ _id: SID, name: 'Source', ownerId: OWNER });
  await db.members.insert({ _id: 'member1', serverId: SID, userId: MEMBER, roles: [] });
  await db.roles.insert({
    _id: 'role1', serverId: SID, name: 'Reader', permissions: PERMS.SEND_MESSAGES, position: 1,
  });
  await db.channels.insert({ _id: 'channel1', serverId: SID, name: 'general', type: 'text', order: 0 });
  await db.channelPermissions.insert({
    _id: 'permission1', serverId: SID, channelId: 'channel1', roleId: 'role1',
    allow: PERMS.SEND_MESSAGES, deny: 0, secretKey: 'DO_NOT_EXPORT_SECRET',
  });
  await db.channelOverrides.insert({
    _id: 'legacy-user-override', serverId: SID, channelId: 'channel1',
    targetType: 'user', targetId: MEMBER, allow: PERMS.VIEW_CHANNELS, deny: 0,
    secret: 'DO_NOT_EXPORT_LEGACY',
  });
});

describe('P7 C2 permission manifest', () => {
  it('refuses anonymous, nonowner and owner without the exact export proof', async () => {
    const anonymous = await request(app()).get(`/api/servers/${SID}/portable-permissions-export`);
    expect(anonymous.status).toBe(401);
    const member = await download(MEMBER, 'sensitive-export');
    expect(member.status).toBe(403);
    const missing = await download(OWNER);
    expect(missing.status).toBe(403);
    expect(missing.body).toMatchObject({ error: 'STEP_UP_REQUIRED', scope: 'sensitive-export' });
    const wrong = await download(OWNER, 'account-security');
    expect(wrong.status).toBe(403);
    expect(wrong.body.reasons).toContain('step_up_scope_mismatch');
  });

  it('exports only source-local role permissions with excluded legacy counts and stable digest', async () => {
    const before = await snapshot();
    const out = await download(OWNER, 'sensitive-export');
    expect(out.status).toBe(200);
    expect(out.headers['cache-control']).toContain('no-store');
    expect(out.headers['content-disposition']).toContain('bridge-community-permissions-v1.json');
    expect(out.body).toMatchObject({
      format: 'bridge-portable-community-permissions', version: 1,
      sourceServerId: SID,
      channels: [{ channelSourceId: 'channel1', overrides: [
        { roleSourceId: 'role1', allow: PERMS.SEND_MESSAGES, deny: 0 },
      ] }],
      unsupported: { legacyOverrideRows: 1, individualOverrideRows: 0, unknownTargetRows: 0 },
      portability: { importSupported: false, migrationReady: false },
    });
    const plain = JSON.stringify(out.body);
    for (const privateMarker of [MEMBER, 'member1', 'DO_NOT_EXPORT_SECRET', 'DO_NOT_EXPORT_LEGACY', 'legacy-user-override']) {
      expect(plain).not.toContain(privateMarker);
    }
    const { integrity, portability, ...payload } = out.body;
    expect(integrity.digest).toBe(createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex'));
    expect(await snapshot()).toEqual(before);
  });

  it('counts a canonical user-target row but never outputs its identifier', async () => {
    await db.channelPermissions.insert({
      _id: 'user-specific', channelId: 'channel1', serverId: SID,
      targetType: 'user', roleId: MEMBER, targetId: MEMBER, allow: 1, deny: 0,
    });
    const out = await download(OWNER, 'sensitive-export');
    expect(out.status).toBe(200);
    expect(out.body.unsupported.individualOverrideRows).toBe(1);
    expect(out.body.channels[0].overrides).toHaveLength(1);
    expect(JSON.stringify(out.body)).not.toContain(MEMBER);
    expect(out.body.portability.migrationReady).toBe(false);
  });

  it('fails closed on cross-server role reference and overlapping allow/deny masks', async () => {
    await db.channelPermissions.insert({
      _id: 'cross-server', channelId: 'channel1', serverId: SID,
      roleId: 'nonexistent-role', allow: 1, deny: 0,
    });
    const invalidRole = await download(OWNER, 'sensitive-export');
    expect(invalidRole.status).toBe(503);
    expect(invalidRole.body.code).toBe('PORTABLE_COMMUNITY_PERMISSIONS_UNAVAILABLE');
    expect(invalidRole.body.channels).toBeUndefined();
    await db.channelPermissions.remove({ _id: 'cross-server' });
    await db.channelPermissions.update({ _id: 'permission1' }, { $set: { deny: PERMS.SEND_MESSAGES } });
    const invalidMask = await download(OWNER, 'sensitive-export');
    expect(invalidMask.status).toBe(503);
  });

  it('returns 503 rather than a successful incomplete manifest on either storage outage', async () => {
    const initial = await snapshot();
    const canonical = jest.spyOn(ChannelPermissions, 'findByChannel').mockRejectedValueOnce(new Error('PG permission read unavailable'));
    try {
      const fail = await download(OWNER, 'sensitive-export');
      expect(fail.status).toBe(503);
      expect(fail.body.code).toBe('PORTABLE_COMMUNITY_PERMISSIONS_UNAVAILABLE');
      expect(fail.body.channels).toBeUndefined();
    } finally {
      canonical.mockRestore();
    }
    const legacy = jest.spyOn(Channels, 'findOverridesByChannel').mockRejectedValueOnce(new Error('legacy override read unavailable'));
    try {
      const fail = await download(OWNER, 'sensitive-export');
      expect(fail.status).toBe(503);
      expect(fail.body.code).toBe('PORTABLE_COMMUNITY_PERMISSIONS_UNAVAILABLE');
      expect(fail.body.channels).toBeUndefined();
    } finally {
      legacy.mockRestore();
    }
    expect(await snapshot()).toEqual(initial);
  });

  it('refuses contradictory persisted everyone target labels rather than granting another role', async () => {
    await db.channelPermissions.insert({
      _id: 'ambiguous', channelId: 'channel1', serverId: SID,
      roleId: 'role1', targetType: 'everyone', allow: 0, deny: PERMS.VIEW_CHANNELS,
    });
    const bad = await download(OWNER, 'sensitive-export');
    expect(bad.status).toBe(503);
    expect(bad.body.code).toBe('PORTABLE_COMMUNITY_PERMISSIONS_UNAVAILABLE');
  });

  it('does not treat a partial source read as an empty permission set', () => {
    expect(() => buildPortableCommunityPermissionManifest(
      { _id: SID },
      [{ _id: 'channel1', serverId: SID }],
      [{ _id: 'role1', serverId: SID }],
      [],
    )).toThrow('safe source bounds');
  });

  it('normalizes everyone role IDs and rejects duplicate inherited overrides', () => {
    const server = { _id: SID };
    const channels = [{ _id: 'channel1', serverId: SID }];
    const roles: Array<Record<string, unknown>> = [];
    const row = (roleId: string) => ({ serverId: SID, channelId: 'channel1', roleId, allow: 0, deny: 1 });
    const valid = buildPortableCommunityPermissionManifest(server, channels, roles, [
      { channelId: 'channel1', canonical: [row(SID)], legacy: [] },
    ], '2026-10-12T00:00:00.000Z');
    expect(valid.channels[0].overrides[0]?.roleSourceId).toBe('__everyone__');
    expect(() => buildPortableCommunityPermissionManifest(server, channels, roles, [
      { channelId: 'channel1', canonical: [row(SID), row('__everyone__')], legacy: [] },
    ])).toThrow('Duplicate role permission override');
  });
});

// The builder is the export's last line of defence: whatever the route read,
// a manifest is produced only from one server's own, complete, unambiguous rows.
describe('P7 C2 permission manifest builder refuses inputs it cannot vouch for', () => {
  const AT = '2026-10-12T00:00:00.000Z';
  const channel = (id: string, serverId = SID) => ({ _id: id, serverId });
  const role = (id: string, serverId = SID) => ({ _id: id, serverId });
  const rows = (channelId: string, canonical: Array<Record<string, unknown>> = [], legacy: Array<Record<string, unknown>> = []) =>
    ({ channelId, canonical, legacy });
  const build = (over: { server?: Record<string, unknown>; channels?: Array<Record<string, unknown>>;
    roles?: Array<Record<string, unknown>>; data?: ReturnType<typeof rows>[]; at?: string } = {}) =>
    () => buildPortableCommunityPermissionManifest(
      over.server ?? { _id: SID }, over.channels ?? [channel('channel1')], over.roles ?? [role('role1')],
      over.data ?? [rows('channel1')], over.at ?? AT,
    );

  it('needs a real server id and an exact ISO timestamp', () => {
    expect(build({ server: { _id: '' } })).toThrow('Invalid server ID');
    expect(build({ server: { _id: 7 } })).toThrow('Invalid server ID');
    expect(build({ server: { _id: 's'.repeat(257) } })).toThrow('Invalid server ID');
    // A timestamp that parses but is not in canonical form would change the digest.
    expect(build({ at: '2026-10-12T00:00:00Z' })).toThrow('Invalid timestamp');
    expect(build({ at: 'yesterday' })).toThrow();
  });

  it('refuses channels or roles from another server, and duplicates of either', () => {
    expect(build({ channels: [channel('channel1', 'other-server')] })).toThrow('Foreign channel');
    expect(build({ roles: [role('role1', 'other-server')] })).toThrow('Foreign role');
    expect(build({ channels: [channel('channel1'), channel('channel1')], data: [rows('channel1'), rows('channel1')] }))
      .toThrow('Duplicate channel');
    expect(build({ roles: [role('role1'), role('role1')] })).toThrow('Duplicate role');
  });

  it('refuses permission rows for an unknown channel or the same channel twice', () => {
    expect(build({ data: [rows('channel-elsewhere')] })).toThrow('Foreign or duplicate permission channel');
    expect(build({ channels: [channel('channel1'), channel('channel2')], data: [rows('channel1'), rows('channel1')] }))
      .toThrow('Foreign or duplicate permission channel');
  });

  it('refuses unreadable or oversized override lists', () => {
    expect(build({ data: [{ channelId: 'channel1', canonical: null as never, legacy: [] }] })).toThrow('exceed supported bound');
    expect(build({ data: [{ channelId: 'channel1', canonical: [], legacy: 'x' as never }] })).toThrow('exceed supported bound');
    const many = Array.from({ length: 2001 }, () => ({ channelId: 'channel1', roleId: 'role1', allow: 0, deny: 0 }));
    expect(build({ data: [rows('channel1', many)] })).toThrow('exceed supported bound');
    expect(build({ data: [rows('channel1', [], many)] })).toThrow('exceed supported bound');
  });

  it('refuses an override row that is empty, for another channel, or from another server', () => {
    expect(build({ data: [rows('channel1', [null as never])] })).toThrow('Foreign or incomplete permission row');
    expect(build({ data: [rows('channel1', [{ channelId: 'channel2', roleId: 'role1', allow: 1, deny: 0 }])] }))
      .toThrow('Foreign or incomplete permission row');
    expect(build({ data: [rows('channel1', [{ channelId: 'channel1', serverId: 'other-server', roleId: 'role1', allow: 1, deny: 0 }])] }))
      .toThrow('Foreign or incomplete permission row');
  });

  it('counts unknown override targets but never exports them as role grants', () => {
    const manifest = build({ data: [rows('channel1', [
      { channelId: 'channel1', targetType: 'member', roleId: 'secret-member-id', allow: 8, deny: 0 },
      { channelId: 'channel1', targetType: 'webhook', roleId: 'secret-webhook-id', allow: 8, deny: 0 },
      { channelId: 'channel1', targetType: 'role', roleId: 'role1', allow: 8, deny: 0 },
    ])] })();
    expect(manifest.unsupported).toEqual({ legacyOverrideRows: 0, individualOverrideRows: 0, unknownTargetRows: 2 });
    expect(manifest.channels[0]?.overrides).toEqual([{ roleSourceId: 'role1', allow: 8, deny: 0 }]);
    expect(JSON.stringify(manifest)).not.toMatch(/secret-(member|webhook)-id/);
  });

  it('a row with no allow or deny exports as an explicit zero, not as missing data', () => {
    const manifest = build({ data: [rows('channel1', [{ channelId: 'channel1', roleId: 'role1' }])] })();
    expect(manifest.channels[0]?.overrides).toEqual([{ roleSourceId: 'role1', allow: 0, deny: 0 }]);
  });

  it('the digest does not depend on the order the database returned rows in', () => {
    const channels = [channel('channel-a'), channel('channel-b')];
    const roles = [role('role-a'), role('role-b')];
    const grant = (channelId: string, roleId: string, allow: number) => ({ channelId, roleId, allow, deny: 0 });
    const forward = buildPortableCommunityPermissionManifest({ _id: SID }, channels, roles, [
      rows('channel-a', [grant('channel-a', 'role-a', 1), grant('channel-a', 'role-b', 2)]),
      rows('channel-b', [grant('channel-b', 'role-a', 4)]),
    ], AT);
    const reversed = buildPortableCommunityPermissionManifest({ _id: SID }, [...channels].reverse(), [...roles].reverse(), [
      rows('channel-b', [grant('channel-b', 'role-a', 4)]),
      rows('channel-a', [grant('channel-a', 'role-b', 2), grant('channel-a', 'role-a', 1)]),
    ], AT);
    expect(reversed.channels.map((c) => c.channelSourceId)).toEqual(['channel-a', 'channel-b']);
    expect(reversed.channels[0]?.overrides.map((o) => o.roleSourceId)).toEqual(['role-a', 'role-b']);
    expect(reversed.integrity.digest).toBe(forward.integrity.digest);
  });
});
