process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV = 'test';

import express from 'express';
import request from 'supertest';

const jwt = require('jsonwebtoken');

jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb();
});
jest.mock('express-rate-limit', () => () => (_req: unknown, _res: unknown, next: () => void) => next());
jest.mock('../lib/permCache', () => ({ invalidatePerms: jest.fn() }));

import channelPermsRouter from '../routes/channelPerms';
import { DEFAULT_PERMISSIONS, PERMS } from '../lib/permissions';

function token(userId: string): string {
  return jwt.sign({ id: userId, username: userId, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:sid/channels/:cid/permissions', channelPermsRouter);
  app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(500).json({ error: err.message }));
  return app;
}

describe('Permission explainability API', () => {
  let db: ReturnType<typeof import('./helpers/mockDb').createMockDb>;
  let app: ReturnType<typeof buildApp>;
  const serverId = 'explain-server';
  const channelId = 'explain-channel';
  const ownerId = 'explain-owner';
  const managerId = 'explain-manager';
  const memberId = 'explain-member';
  const managerRole = 'manager-role';

  beforeEach(async () => {
    const { createMockDb } = require('./helpers/mockDb');
    db = createMockDb();
    Object.assign(require('../db/index'), db);
    Object.assign(require('../db/loader'), db);

    await db.users.insert({ _id: ownerId, username: ownerId, displayName: 'Owner', tokenVersion: 0 });
    await db.users.insert({ _id: managerId, username: managerId, displayName: 'Manager', tokenVersion: 0 });
    await db.users.insert({ _id: memberId, username: memberId, displayName: 'Member', tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'Explain', ownerId });
    await db.channels.insert({ _id: channelId, serverId, name: 'restricted', type: 'text' });
    await db.roles.insert({
      _id: managerRole,
      serverId,
      name: 'Developer',
      permissions: DEFAULT_PERMISSIONS | PERMS.MANAGE_CHANNELS,
      position: 1,
    });
    await db.members.insert({ _id: 'manager-membership', userId: managerId, serverId, roles: [managerRole] });
    await db.members.insert({ _id: 'member-membership', userId: memberId, serverId, roles: [] });
    await db.channelPermissions.insert({
      _id: 'manager-channel-override', channelId, serverId, roleId: managerRole,
      allow: 0, deny: PERMS.SEND_MESSAGES, createdAt: Date.now(),
    });
    app = buildApp();
  });

  const explain = (userId: string) => request(app)
    .get(`/api/servers/${serverId}/channels/${channelId}/permissions/explain/me`)
    .set('Authorization', `Bearer ${token(userId)}`);

  it('authorized admin receives canonical labelled reasoning without raw masks', async () => {
    const response = await explain(managerId);

    expect(response.status).toBe(200);
    const send = response.body.permissions.find((row: { key: string }) => row.key === 'SEND_MESSAGES');
    expect(send).toMatchObject({
      label: 'Mesaj gönder',
      allowed: false,
      effective: 'denied',
      reasonCode: 'CHANNEL_OVERRIDE_DENY',
      base: { state: 'allowed', sources: ['Rol: Developer'] },
      overrides: [{ scope: 'role', label: 'Developer', state: 'denied' }],
    });
    expect(send.message).toMatch(/rol izinleriyle kısıtlanmış/i);
    expect(send).not.toHaveProperty('flag');
    expect(send).not.toHaveProperty('allow');
    expect(send).not.toHaveProperty('deny');
  });

  it('ordinary member cannot request the detailed explanation', async () => {
    const response = await explain(memberId);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Forbidden' });
  });

  it('unauthenticated caller is rejected', async () => {
    const response = await request(app)
      .get(`/api/servers/${serverId}/channels/${channelId}/permissions/explain/me`);
    expect(response.status).toBe(401);
  });

  it('cross-server channel id is not explainable through an authorized server', async () => {
    await db.channels.insert({ _id: 'other-channel', serverId: 'other-server', name: 'secret', type: 'text' });
    const response = await request(app)
      .get(`/api/servers/${serverId}/channels/other-channel/permissions/explain/me`)
      .set('Authorization', `Bearer ${token(managerId)}`);
    expect(response.status).toBe(404);
  });
});
