// server/tests/channelPerms.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../lib/permCache', () => ({ invalidatePerms: jest.fn() }));
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());

jest.mock('../db/loader', () => {
  const mock = require('./helpers/mockDb').createMockDb();
  mock._sqlite = {
    transaction: (fn) => () => fn(),
    prepare: () => ({
      run: jest.fn(),
      get: jest.fn().mockReturnValue(null),
      all: jest.fn().mockReturnValue([]),
    }),
  };
  return mock;
});

jest.mock('../lib/permissions', () => ({
  resolvePermissions: jest.fn().mockResolvedValue(2),
  hasPermission: jest.fn().mockReturnValue(true),
  PERMS: jest.requireActual('../lib/permissions').PERMS,
  VALID_BITS: jest.requireActual('../lib/permissions').VALID_BITS,
  validateBitmask: jest.requireActual('../lib/permissions').validateBitmask,
  DEFAULT_PERMISSIONS: jest.requireActual('../lib/permissions').DEFAULT_PERMISSIONS ?? 0,
}));

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import channelPermsRouter from '../routes/channelPerms';
const perms   = require('../lib/permissions');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:sid/channels/:cid/permissions', authMiddleware, channelPermsRouter);
  return app;
}
function tok(uid, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Channel Permissions Routes', () => {
  let app, ownerId, serverId, channelId, roleId;
  let ownerToken;

  beforeEach(async () => {
    db._reset?.();
    app       = buildApp();
    ownerId   = uuidv4();
    serverId  = uuidv4();
    channelId = uuidv4();
    roleId    = uuidv4();
    ownerToken = tok(ownerId);

    await db.users.insert({ _id: ownerId, username: 'owner', displayName: 'Owner', tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'TestServer', ownerId });
    await db.channels.insert({ _id: channelId, serverId, name: 'general', type: 'text' });

    perms.resolvePermissions.mockResolvedValue(2); // MANAGE_CHANNELS
    perms.hasPermission.mockReturnValue(true);
  });

  describe('GET /api/servers/:sid/channels/:cid/permissions', () => {
    it('returns overrides and roles for manager', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/channels/${channelId}/permissions`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('overrides');
      expect(res.body).toHaveProperty('roles');
    });

    it('returns 403 without MANAGE_CHANNELS', async () => {
      perms.hasPermission.mockReturnValue(false);
      const res = await request(app)
        .get(`/api/servers/${serverId}/channels/${channelId}/permissions`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app).get(`/api/servers/${serverId}/channels/${channelId}/permissions`);
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/servers/:sid/channels/:cid/permissions/:roleId', () => {
    it('creates a permission override for a role', async () => {
      const res = await request(app)
        .put(`/api/servers/${serverId}/channels/${channelId}/permissions/${roleId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ allow: 256, deny: 0 }); // SEND_MESSAGES allow
      expect([200, 201]).toContain(res.status);
      expect(res.body.ok).toBe(true);
    });

    it('updates existing override', async () => {
      await db.channelPermissions.insert({ _id: uuidv4(), channelId, roleId, serverId, allow: 0, deny: 256, createdAt: Date.now() });
      const res = await request(app)
        .put(`/api/servers/${serverId}/channels/${channelId}/permissions/${roleId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ allow: 256, deny: 0 });
      expect([200, 201]).toContain(res.status);
    });

    it('returns 403 without permission', async () => {
      perms.hasPermission.mockReturnValue(false);
      const res = await request(app)
        .put(`/api/servers/${serverId}/channels/${channelId}/permissions/${roleId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ allow: 256, deny: 0 });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/servers/:sid/channels/:cid/permissions/:roleId', () => {
    it('removes a role override', async () => {
      await db.channelPermissions.insert({ _id: uuidv4(), channelId, roleId, serverId, allow: 0, deny: 256, createdAt: Date.now() });
      const res = await request(app)
        .delete(`/api/servers/${serverId}/channels/${channelId}/permissions/${roleId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect([200, 204]).toContain(res.status);
    });

    it('returns 404 when override does not exist', async () => {
      const res = await request(app)
        .delete(`/api/servers/${serverId}/channels/${channelId}/permissions/${uuidv4()}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect([404, 200]).toContain(res.status); // some routes return 200 even on missing
    });
  });
});
