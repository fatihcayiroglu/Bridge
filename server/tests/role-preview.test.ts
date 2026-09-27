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

import rolesRouter from '../routes/roles';
import { DEFAULT_PERMISSIONS, hasPermission, PERMS, resolvePermissions } from '../lib/permissions';

function token(userId: string): string {
  return jwt.sign({ id: userId, username: userId, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers', rolesRouter);
  app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(500).json({ error: err.message }));
  return app;
}

describe('View as Role API', () => {
  let db: ReturnType<typeof import('./helpers/mockDb').createMockDb>;
  let app: ReturnType<typeof buildApp>;
  const serverId = 'preview-server';
  const ownerId = 'preview-owner';
  const ordinaryId = 'preview-ordinary';
  const simulatedMemberId = 'preview-simulated-member';
  const moderatorRoleId = 'preview-moderator-role';

  beforeEach(async () => {
    const { createMockDb } = require('./helpers/mockDb');
    db = createMockDb();
    Object.assign(require('../db/index'), db);
    Object.assign(require('../db/loader'), db);

    for (const id of [ownerId, ordinaryId, simulatedMemberId]) {
      await db.users.insert({ _id: id, username: id, displayName: id, tokenVersion: 0 });
    }
    await db.servers.insert({ _id: serverId, name: 'Preview Lab', ownerId });
    await db.members.insert({ _id: 'ordinary-membership', userId: ordinaryId, serverId, roles: [] });
    await db.members.insert({
      _id: 'simulated-membership', userId: simulatedMemberId, serverId, roles: [moderatorRoleId],
    });
    await db.roles.insert({
      _id: moderatorRoleId,
      serverId,
      name: 'Moderator',
      permissions: DEFAULT_PERMISSIONS | PERMS.MANAGE_MESSAGES,
      position: 5,
    });
    await db.channels.insert({ _id: 'public-text', serverId, name: 'general', type: 'text', order: 1 });
    await db.channels.insert({ _id: 'staff-text', serverId, name: 'staff', type: 'text', order: 2 });
    await db.channels.insert({ _id: 'voice-room', serverId, name: 'Voice', type: 'voice', order: 3 });
    await db.channelPermissions.insert({
      _id: 'staff-hidden', channelId: 'staff-text', serverId, roleId: moderatorRoleId,
      allow: 0, deny: PERMS.VIEW_CHANNELS, createdAt: Date.now(),
    });
    await db.channelPermissions.insert({
      _id: 'voice-muted', channelId: 'voice-room', serverId, roleId: moderatorRoleId,
      allow: 0, deny: PERMS.SPEAK, createdAt: Date.now(),
    });
    app = buildApp();
  });

  const preview = (userId: string, roleId = moderatorRoleId) => request(app)
    .get(`/api/servers/${serverId}/roles/${roleId}/preview`)
    .set('Authorization', `Bearer ${token(userId)}`);

  it('authorized admin gets a read-only channel capability simulation from canonical decisions', async () => {
    const memberCountBefore = await db.members.count({ serverId });
    const response = await preview(ownerId);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      simulation: true,
      role: { id: moderatorRoleId, name: 'Moderator' },
      summary: { totalChannels: 3, visibleChannels: 2, sendableChannels: 2, manageableChannels: 2 },
    });
    expect(response.body.channels.find((channel: { channelId: string }) => channel.channelId === 'staff-text'))
      .toMatchObject({ name: 'staff', visible: false });
    expect(response.body.channels.find((channel: { channelId: string }) => channel.channelId === 'voice-room'))
      .toMatchObject({ visible: true, capabilities: { connect: true, speak: false } });

    for (const channel of response.body.channels) {
      const actual = await resolvePermissions(simulatedMemberId, serverId, channel.channelId);
      expect(channel.visible).toBe(hasPermission(actual, PERMS.VIEW_CHANNELS));
      expect(channel.capabilities.sendMessages).toBe(hasPermission(actual, PERMS.SEND_MESSAGES));
      expect(channel.capabilities.attachFiles).toBe(hasPermission(actual, PERMS.ATTACH_FILES));
      expect(channel.capabilities.manageMessages).toBe(hasPermission(actual, PERMS.MANAGE_MESSAGES));
    }

    expect(await db.members.count({ serverId })).toBe(memberCountBefore);
    expect(JSON.stringify(response.body)).not.toMatch(/token|userId|basePermissions|allow|deny/i);
  });

  it('ordinary member receives generic denial only', async () => {
    const response = await preview(ordinaryId);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Forbidden' });
  });

  it('cross-server or missing roles are not previewable', async () => {
    await db.roles.insert({
      _id: 'other-role', serverId: 'other-server', name: 'Secret', permissions: PERMS.ADMINISTRATOR,
    });
    const response = await preview(ownerId, 'other-role');
    expect(response.status).toBe(404);
  });

  it('@everyone can be simulated without fabricating a role row', async () => {
    const response = await preview(ownerId, '__everyone__');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      simulation: true,
      role: { id: '__everyone__', name: '@everyone' },
      summary: { totalChannels: 3 },
    });
  });
});
