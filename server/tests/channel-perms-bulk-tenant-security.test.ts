process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV = 'test';

jest.mock('../lib/permCache', () => ({ invalidatePerms: jest.fn() }));
jest.mock('express-rate-limit', () => () => (_req: unknown, _res: unknown, next: () => void) => next());
jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/permissions', () => ({
  resolvePermissions: jest.fn().mockResolvedValue(2),
  hasPermission: jest.fn().mockReturnValue(true),
  PERMS: jest.requireActual('../lib/permissions').PERMS,
  VALID_BITS: jest.requireActual('../lib/permissions').VALID_BITS,
  validateBitmask: jest.requireActual('../lib/permissions').validateBitmask,
  DEFAULT_PERMISSIONS: jest.requireActual('../lib/permissions').DEFAULT_PERMISSIONS,
  resolvePermissionResolution: jest.requireActual('../lib/permissions').resolvePermissionResolution,
  explainResolvedPermission: jest.requireActual('../lib/permissions').explainResolvedPermission,
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import channelPermsRouter from '../routes/channelPerms';
import { PERMS } from '../lib/permissions';

const db = require('../db/loader');
const permissions = require('../lib/permissions');
import { requireDoc } from './helpers/mockDb';

const SID = 'bulk-local-server';
const CID = 'bulk-local-channel';
const TARGET = 'bulk-target-channel';
const ROLE = 'bulk-local-role';
const USER = 'bulk-owner';
const FOREIGN_SID = 'bulk-foreign-server';
const FOREIGN_CID = 'bulk-foreign-channel';
const FOREIGN_ROLE = 'bulk-foreign-role';

function token(): string {
  return jwt.sign({ id: USER, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}
function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/servers/:sid/channels/:cid/permissions', channelPermsRouter);
  return a;
}
async function seed() {
  db._reset?.();
  jest.clearAllMocks();
  permissions.resolvePermissions.mockResolvedValue(PERMS.MANAGE_CHANNELS);
  permissions.hasPermission.mockReturnValue(true);
  await db.users.insert({ _id: USER, username: USER, displayName: 'Owner', tokenVersion: 0 });
  await db.servers.insert({ _id: SID, name: 'Local', ownerId: USER });
  await db.servers.insert({ _id: FOREIGN_SID, name: 'Foreign', ownerId: 'someone-else' });
  await db.channels.insert({ _id: CID, serverId: SID, name: 'general', type: 'text' });
  await db.channels.insert({ _id: TARGET, serverId: SID, name: 'target', type: 'text' });
  await db.channels.insert({ _id: FOREIGN_CID, serverId: FOREIGN_SID, name: 'secret', type: 'text' });
  await db.roles.insert({ _id: ROLE, serverId: SID, name: 'Moderator', permissions: 0, position: 1 });
  await db.roles.insert({ _id: FOREIGN_ROLE, serverId: FOREIGN_SID, name: 'ForeignRole', permissions: 0, position: 1 });
}

describe('channel permission bulk tenant boundary', () => {
  beforeEach(seed);

  it.each([
    ['batch', 'put'],
    ['import', 'post'],
    ['export', 'get'],
  ] as const)('%s rejects a channel that belongs to another server', async (suffix, method) => {
    let r = request(app())[method](`/api/servers/${SID}/channels/${FOREIGN_CID}/permissions/${suffix}`)
      .set('Authorization', `Bearer ${token()}`);
    if (method !== 'get') r = r.send(suffix === 'batch' ? { overrides: [], deletes: [] } : { overrides: [{ roleId: ROLE, allow: 0, deny: 0 }] });
    const res = await r;
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/channel not found/i);
  });

  it('bulk-sync rejects a foreign source channel before touching local targets', async () => {
    const res = await request(app())
      .post(`/api/servers/${SID}/channels/${FOREIGN_CID}/permissions/bulk-sync`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ channelIds: [TARGET], overrides: [{ roleId: ROLE, allow: PERMS.SEND_MESSAGES, deny: 0 }] });
    expect(res.status).toBe(404);
    expect(await db.channelPermissions.count({ channelId: TARGET })).toBe(0);
  });

  it('bulk-sync rejects a role owned by another server', async () => {
    const res = await request(app())
      .post(`/api/servers/${SID}/channels/${CID}/permissions/bulk-sync`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ channelIds: [TARGET], overrides: [{ roleId: FOREIGN_ROLE, allow: PERMS.SEND_MESSAGES, deny: 0 }] });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/role not found/i);
    expect(await db.channelPermissions.count({ channelId: TARGET })).toBe(0);
  });

  it('bulk-sync rejects malformed bitmasks rather than persisting them', async () => {
    const res = await request(app())
      .post(`/api/servers/${SID}/channels/${CID}/permissions/bulk-sync`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ channelIds: [TARGET], overrides: [{ roleId: ROLE, allow: PERMS.SEND_MESSAGES, deny: PERMS.SEND_MESSAGES }] });
    expect(res.status).toBe(400);
    expect(await db.channelPermissions.count({ channelId: TARGET })).toBe(0);
  });

  it('batch rejects cross-server override and delete role ids before mutation', async () => {
    await db.channelPermissions.insert({ _id: 'existing', channelId: CID, serverId: SID, roleId: ROLE, allow: 0, deny: 0 });
    const override = await request(app())
      .put(`/api/servers/${SID}/channels/${CID}/permissions/batch`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ overrides: [{ roleId: FOREIGN_ROLE, allow: 0, deny: 0 }], deletes: [] });
    expect(override.status).toBe(404);

    const del = await request(app())
      .put(`/api/servers/${SID}/channels/${CID}/permissions/batch`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ overrides: [], deletes: [FOREIGN_ROLE] });
    expect(del.status).toBe(404);
    expect(await db.channelPermissions.count({ channelId: CID, roleId: ROLE })).toBe(1);
  });

  it('batch validates request collection shapes instead of throwing on objects', async () => {
    const res = await request(app())
      .put(`/api/servers/${SID}/channels/${CID}/permissions/batch`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ overrides: {}, deletes: [] });
    expect(res.status).toBe(400);
  });

  it('import skips unknown foreign roles and reports the skipped entry', async () => {
    const res = await request(app())
      .post(`/api/servers/${SID}/channels/${CID}/permissions/import`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ overrides: [{ roleId: FOREIGN_ROLE, allow: 0, deny: PERMS.SEND_MESSAGES }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mevcut izinler korunuyor/i);
    expect(res.body.skipped[0]).toMatchObject({ roleId: FOREIGN_ROLE, reason: 'role not found in this server' });
    expect(await db.channelPermissions.count({ channelId: CID })).toBe(0);
  });

  it('import can map a foreign source id to a same-named local role without persisting the foreign id', async () => {
    const res = await request(app())
      .post(`/api/servers/${SID}/channels/${CID}/permissions/import`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ overrides: [{ roleId: FOREIGN_ROLE, roleName: 'Moderator', allow: PERMS.SEND_MESSAGES, deny: 0 }] });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(await db.channelPermissions.count({ channelId: CID, roleId: ROLE })).toBe(1);
    expect(await db.channelPermissions.count({ channelId: CID, roleId: FOREIGN_ROLE })).toBe(0);
  });

  it('bulk preview rejects foreign roles and invalid override collection shapes', async () => {
    const foreign = await request(app())
      .post(`/api/servers/${SID}/channels/${CID}/permissions/bulk-sync/preview`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ channelIds: [TARGET], overrides: [{ roleId: FOREIGN_ROLE, allow: 0, deny: 0 }] });
    expect(foreign.status).toBe(404);

    const malformed = await request(app())
      .post(`/api/servers/${SID}/channels/${CID}/permissions/bulk-sync/preview`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ channelIds: [TARGET], overrides: {} });
    expect(malformed.status).toBe(400);
  });

  it('batch rejects duplicate/conflicting role operations and coercible masks before mutation', async () => {
    for (const body of [
      { overrides: [{ roleId: ROLE, allow: 0, deny: 0 }, { roleId: ROLE, allow: PERMS.SEND_MESSAGES, deny: 0 }], deletes: [] },
      { overrides: [{ roleId: ROLE, allow: 0, deny: 0 }], deletes: [ROLE] },
      { overrides: [{ roleId: ROLE, allow: '0' as any, deny: 0 }], deletes: [] },
      { overrides: [], deletes: [ROLE, ROLE] },
    ]) {
      const res = await request(app()).put(`/api/servers/${SID}/channels/${CID}/permissions/batch`)
        .set('Authorization', `Bearer ${token()}`).send(body);
      expect(res.status).toBe(400);
    }
    expect(await db.channelPermissions.count({ channelId: CID })).toBe(0);
  });

  it('bulk-sync/preview reject duplicate or foreign/missing targets instead of partially applying', async () => {
    const dup = await request(app()).post(`/api/servers/${SID}/channels/${CID}/permissions/bulk-sync`)
      .set('Authorization', `Bearer ${token()}`).send({ channelIds: [TARGET, TARGET], overrides: [] });
    expect(dup.status).toBe(400);
    const foreign = await request(app()).post(`/api/servers/${SID}/channels/${CID}/permissions/bulk-sync`)
      .set('Authorization', `Bearer ${token()}`).send({ channelIds: [TARGET, FOREIGN_CID], overrides: [] });
    expect(foreign.status).toBe(404);
    expect(await db.channelPermissions.count({ channelId: TARGET })).toBe(0);
    const preview = await request(app()).post(`/api/servers/${SID}/channels/${CID}/permissions/bulk-sync/preview`)
      .set('Authorization', `Bearer ${token()}`).send({ channelIds: [TARGET, 'missing'], overrides: [] });
    expect(preview.status).toBe(404);
  });

  it('import requires a real boolean merge flag and replace mode cannot erase state when every row is skipped', async () => {
    await db.channelPermissions.insert({ _id: 'keep', channelId: CID, serverId: SID, roleId: ROLE, allow: 0, deny: 0 });
    const coerced = await request(app()).post(`/api/servers/${SID}/channels/${CID}/permissions/import`)
      .set('Authorization', `Bearer ${token()}`).send({ merge: 'false', overrides: [{ roleId: ROLE, allow: 0, deny: 0 }] });
    expect(coerced.status).toBe(400);
    const skipped = await request(app()).post(`/api/servers/${SID}/channels/${CID}/permissions/import`)
      .set('Authorization', `Bearer ${token()}`).send({ merge: false, overrides: [{ roleId: FOREIGN_ROLE, allow: 0, deny: 0 }] });
    expect(skipped.status).toBe(400);
    expect(await db.channelPermissions.findOne({ _id: 'keep' })).toBeTruthy();
  });

  it.each([
    ['bulk-sync', 'post', 400],
    ['bulk-sync/preview', 'post', 400],
    ['batch', 'put', 200],
    ['import', 'post', 400],
  ] as const)('%s handles a missing request body without a server error', async (suffix, method, status) => {
    const res = await request(app())[method](`/api/servers/${SID}/channels/${CID}/permissions/${suffix}`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(status);
  });

});
