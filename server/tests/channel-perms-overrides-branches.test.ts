process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/permCache', () => ({ invalidatePerms: jest.fn() }));
jest.mock('express-rate-limit', () => () => (_req: unknown, _res: unknown, next: () => void) => next());
jest.mock('../lib/permissions', () => {
  const actual = jest.requireActual('../lib/permissions');
  return {
    ...actual,
    resolvePermissions: jest.fn().mockResolvedValue(actual.PERMS.MANAGE_CHANNELS),
    hasPermission: jest.fn().mockReturnValue(true),
  };
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import channelPermsRouter from '../routes/channelPerms';
import { Auth, Roles } from '../db/repositories';
import { PERMS } from '../lib/permissions';

const db = require('../db/loader');
const perms = require('../lib/permissions');
const { invalidatePerms } = require('../lib/permCache');

const SID = 'override-server';
const CID = 'override-channel';
const USER = 'override-owner';
const ROLE = 'override-role';

function token() { return jwt.sign({ id: USER, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' }); }
function app(io: any = null) {
  const a = express();
  a.use(express.json());
  if (io) a.set('io', io);
  a.use('/api/servers/:sid/channels/:cid/permissions', channelPermsRouter);
  return a;
}
async function seed() {
  db._reset?.();
  jest.clearAllMocks();
  perms.resolvePermissions.mockResolvedValue(PERMS.MANAGE_CHANNELS);
  perms.hasPermission.mockReturnValue(true);
  await db.users.insert({ _id: USER, username: 'owner-user', displayName: 'Owner Display', tokenVersion: 0 });
  await db.servers.insert({ _id: SID, name: 'Overrides', ownerId: USER, logChannelId: 'log-channel' });
  await db.channels.insert({ _id: CID, serverId: SID, name: 'general', type: 'text' });
  await db.channels.insert({ _id: 'log-channel', serverId: SID, name: 'audit-log', type: 'text' });
  await db.roles.insert({ _id: ROLE, serverId: SID, name: 'Moderator', permissions: PERMS.MANAGE_MESSAGES, position: 1 });
}

describe('channel override audit and inheritance branches', () => {
  beforeEach(seed);

  it('rejects malformed and reversed audit timestamp ranges', async () => {
    const bad = await request(app())
      .get(`/api/servers/${SID}/channels/${CID}/permissions/audit-log?since=nope`)
      .set('Authorization', `Bearer ${token()}`);
    expect(bad.status).toBe(400);

    const reversed = await request(app())
      .get(`/api/servers/${SID}/channels/${CID}/permissions/audit-log?since=200&until=100`)
      .set('Authorization', `Bearer ${token()}`);
    expect(reversed.status).toBe(400);
  });

  it('rejects partial/fractional/negative audit pagination instead of coercing it', async () => {
    for (const value of ['-5', '1.5', '10oops', '9007199254740993']) {
      const res = await request(app())
        .get(`/api/servers/${SID}/channels/${CID}/permissions/audit-log?limit=${encodeURIComponent(value)}`)
        .set('Authorization', `Bearer ${token()}`);
      expect(res.status).toBe(400);
    }
  });

  it('does not turn audit-store failure into an empty trustworthy history', async () => {
    const spy = jest.spyOn(Auth, 'auditLogsFind').mockImplementationOnce(() => { throw new Error('db down'); });
    const res = await request(app())
      .get(`/api/servers/${SID}/channels/${CID}/permissions/audit-log`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(503);
    spy.mockRestore();
  });

  it('filters audit rows, caps enrichment to this server, and parses valid JSON values', async () => {
    await db.users.insert({ _id: 'actor-1', username: 'actorname', displayName: '', tokenVersion: 0 });
    await db.auditLogs.insert({
      _id: 'a1', serverId: SID, channelId: CID, actorId: 'actor-1', action: 'PERM_UPDATE',
      targetId: ROLE, old: JSON.stringify({ allow: 0 }), new: JSON.stringify({ allow: PERMS.SEND_MESSAGES }), createdAt: 150,
    });
    await db.auditLogs.insert({
      _id: 'a2', serverId: SID, channelId: CID, actorId: USER, action: 'PERM_DELETE',
      targetId: '__everyone__', old: '{bad-json', new: 'bad-json}', actorName: 'Stored Actor', createdAt: 120,
    });
    await db.auditLogs.insert({
      _id: 'other-channel', serverId: SID, channelId: 'not-this-channel', actorId: USER,
      action: 'PERM_UPDATE', targetId: ROLE, createdAt: 160,
    });

    const findWhere = jest.spyOn(Roles, 'findWhere');
    const res = await request(app())
      .get(`/api/servers/${SID}/channels/${CID}/permissions/audit-log?action=PERM_UPDATE&targetId=${ROLE}&since=100&until=200&limit=999`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      _id: 'a1', actorName: 'actorname', targetName: 'Moderator',
      old: { allow: 0 }, new: { allow: PERMS.SEND_MESSAGES },
    });
    expect(findWhere).toHaveBeenCalledWith(expect.objectContaining({ serverId: SID }));
  });

  it('uses safe fallbacks for invalid audit JSON and @everyone target labels', async () => {
    await db.auditLogs.insert({
      _id: 'a2', serverId: SID, channelId: CID, actorId: 'missing-actor', actorName: 'Recorded actor',
      action: 'PERM_DELETE', targetId: '__everyone__', old: '{bad', new: '{bad', createdAt: 120,
    });
    const res = await request(app())
      .get(`/api/servers/${SID}/channels/${CID}/permissions/audit-log?limit=100`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ actorName: 'Recorded actor', targetName: '@everyone', old: null, new: null });
  });

  it('creates then updates an override, writes audit/log side effects, emits socket update, and invalidates cache', async () => {
    const emit = jest.fn();
    // `in(...).fetchSockets()` is what the live-membership eviction uses. Without it the
    // route's eviction call threw into its best-effort catch, so this test could never see
    // whether a permission write actually reaches OPEN sockets (Final21 Phase 16).
    const fetchSockets = jest.fn<Promise<unknown[]>, []>().mockResolvedValue([]);
    const io = { to: jest.fn().mockReturnValue({ emit }), in: jest.fn().mockReturnValue({ fetchSockets }) };
    const create = await request(app(io))
      .put(`/api/servers/${SID}/channels/${CID}/permissions/${ROLE}`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ allow: PERMS.SEND_MESSAGES, deny: 0, targetName: 'Moderator' });
    expect(create.status).toBe(200);

    const update = await request(app(io))
      .put(`/api/servers/${SID}/channels/${CID}/permissions/${ROLE}`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ allow: 0, deny: PERMS.SEND_MESSAGES });
    expect(update.status).toBe(200);
    const row = await db.channelPermissions.findOne({ channelId: CID, roleId: ROLE });
    expect(row).toMatchObject({ allow: 0, deny: PERMS.SEND_MESSAGES });
    expect(await db.auditLogs.count({ serverId: SID, channelId: CID })).toBe(2);
    expect(await db.messages.count({ channelId: 'log-channel', type: 'system' })).toBe(2);
    expect(invalidatePerms).toHaveBeenCalledWith(SID, null, CID);
    expect(emit).toHaveBeenCalledWith('permissions:updated', { serverId: SID, channelId: CID });
    // Cache invalidation alone left already-open sockets reading the channel; the route must
    // also sweep them out of the channel rooms.
    expect(io.in).toHaveBeenCalledWith(`server:${SID}`);
    expect(fetchSockets).toHaveBeenCalled();
  });

  it('rejects overlapping/unknown bitmasks before storage mutation', async () => {
    const overlap = await request(app())
      .put(`/api/servers/${SID}/channels/${CID}/permissions/${ROLE}`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ allow: PERMS.SEND_MESSAGES, deny: PERMS.SEND_MESSAGES });
    expect(overlap.status).toBe(400);

    const unknown = await request(app())
      .put(`/api/servers/${SID}/channels/${CID}/permissions/${ROLE}`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ allow: 1 << 25, deny: 0 });
    expect(unknown.status).toBe(400);
    expect(await db.channelPermissions.count({ channelId: CID })).toBe(0);
  });

  it('deleting a missing override remains idempotent while recording null old values', async () => {
    const res = await request(app())
      .delete(`/api/servers/${SID}/channels/${CID}/permissions/${ROLE}`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    const log = await db.auditLogs.findOne({ serverId: SID, channelId: CID, action: 'PERM_DELETE' });
    expect(log.old).toBeNull();
  });

  it('explains everyone/default role inheritance without pretending user overrides are supported', async () => {
    const everyone = await request(app())
      .get(`/api/servers/${SID}/channels/${CID}/permissions/inheritance/__everyone__`)
      .set('Authorization', `Bearer ${token()}`);
    expect(everyone.status).toBe(200);
    expect(everyone.body).toMatchObject({ roleName: '@everyone', isUser: false, hasOverride: false });
    expect(everyone.body.bitSources[String(PERMS.SEND_MESSAGES)].state).toBe('allow');

    const userLegacy = await request(app())
      .get(`/api/servers/${SID}/channels/${CID}/permissions/inheritance/user:${USER}`)
      .set('Authorization', `Bearer ${token()}`);
    expect(userLegacy.status).toBe(404);
  });

  it('explains allow, deny, role, default and none sources for a real role override', async () => {
    await db.channelPermissions.insert({
      _id: 'ovr', channelId: CID, serverId: SID, roleId: ROLE,
      allow: PERMS.ATTACH_FILES, deny: PERMS.SEND_MESSAGES, createdAt: Date.now(),
    });
    const res = await request(app())
      .get(`/api/servers/${SID}/channels/${CID}/permissions/inheritance/${ROLE}`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ roleName: 'Moderator', isUser: false, hasOverride: true });
    expect(res.body.bitSources[String(PERMS.ATTACH_FILES)]).toMatchObject({ source: 'channel_override', state: 'allow' });
    expect(res.body.bitSources[String(PERMS.SEND_MESSAGES)]).toMatchObject({ source: 'channel_override', state: 'deny' });
    expect(res.body.bitSources[String(PERMS.MANAGE_MESSAGES)]).toMatchObject({ source: 'role', state: 'allow' });
    expect(res.body.bitSources[String(PERMS.VIEW_CHANNELS)]).toMatchObject({ source: 'server_default', state: 'allow' });
    expect(res.body.bitSources[String(PERMS.BAN_MEMBERS)]).toMatchObject({ source: 'none', state: 'deny' });
  });

  it('fails closed for cross-server channel and role ids on inheritance', async () => {
    await db.servers.insert({ _id: 'other-server', name: 'Other', ownerId: 'other' });
    await db.channels.insert({ _id: 'other-channel', serverId: 'other-server', name: 'secret', type: 'text' });
    await db.roles.insert({ _id: 'other-role', serverId: 'other-server', name: 'Foreign', permissions: 0 });

    const channel = await request(app())
      .get(`/api/servers/${SID}/channels/other-channel/permissions/inheritance/${ROLE}`)
      .set('Authorization', `Bearer ${token()}`);
    expect(channel.status).toBe(404);

    const role = await request(app())
      .get(`/api/servers/${SID}/channels/${CID}/permissions/inheritance/other-role`)
      .set('Authorization', `Bearer ${token()}`);
    expect(role.status).toBe(404);
  });
});
