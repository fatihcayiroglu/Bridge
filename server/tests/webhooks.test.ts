// server/tests/webhooks.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/permissions', () => ({
  resolvePermissions: jest.fn(),
  hasPermission:      jest.fn(),
  PERMS: { MANAGE_SERVER: 8, ADMINISTRATOR: 1 << 30 },
}));

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import webhooksRouter from '../routes/webhooks';
const perms   = require('../lib/permissions');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/channels', authMiddleware, webhooksRouter);
  return app;
}
function tok(uid, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Webhooks Routes', () => {
  let app, ownerId, serverId, channelId;
  let ownerToken;

  beforeEach(async () => {
    db._reset?.();
    app       = buildApp();
    ownerId   = uuidv4();
    serverId  = uuidv4();
    channelId = uuidv4();
    ownerToken = tok(ownerId);

    await db.users.insert({ _id: ownerId, username: 'owner', displayName: 'Owner', tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'TestServer', ownerId });
    await db.channels.insert({ _id: channelId, serverId, name: 'general', type: 'text' });

    perms.resolvePermissions.mockResolvedValue(8);
    perms.hasPermission.mockImplementation((p, flag) => true);
  });

  describe('GET /api/channels/:cid/webhooks', () => {
    it('returns webhooks for channel owner', async () => {
      await db.webhooks.insert({ _id: uuidv4(), channelId, serverId, name: 'MyHook', token: 'tok123', createdAt: Date.now() });
      const res = await request(app)
        .get(`/api/channels/${channelId}/webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].name).toBe('MyHook');
      // Secret should not be exposed
      expect(res.body[0].token).toBeUndefined();
    });

    it('returns 404 for nonexistent channel', async () => {
      const res = await request(app)
        .get(`/api/channels/${uuidv4()}/webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });

    it('returns 403 without permission', async () => {
      perms.hasPermission.mockReturnValue(false);
      const res = await request(app)
        .get(`/api/channels/${channelId}/webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/channels/:cid/webhooks', () => {
    it('creates a webhook', async () => {
      const res = await request(app)
        .post(`/api/channels/${channelId}/webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Deploy Hook' });
      expect([200, 201]).toContain(res.status);
      const hooks = await db.webhooks.find({ channelId });
      expect(hooks.length).toBe(1);
      expect(hooks[0].name).toBe('Deploy Hook');
    });

    it('returns 400 when name is missing', async () => {
      const res = await request(app)
        .post(`/api/channels/${channelId}/webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 404 for nonexistent channel', async () => {
      const res = await request(app)
        .post(`/api/channels/${uuidv4()}/webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'hook' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/channels/:cid/webhooks/:wid', () => {
    let webhookId;
    beforeEach(async () => {
      const wh = await db.webhooks.insert({ _id: uuidv4(), channelId, serverId, name: 'ToDelete', token: 'x', createdAt: Date.now() });
      webhookId = wh._id;
    });

    it('deletes a webhook', async () => {
      const res = await request(app)
        .delete(`/api/channels/${channelId}/webhooks/${webhookId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect([200, 204]).toContain(res.status);
      const hook = await db.webhooks.findOne({ _id: webhookId });
      expect(hook).toBeNull();
    });

    it('returns 404 for nonexistent webhook', async () => {
      const res = await request(app)
        .delete(`/api/channels/${channelId}/webhooks/${uuidv4()}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  it('rejects unauthenticated', async () => {
    const res = await request(app).get(`/api/channels/${channelId}/webhooks`);
    expect(res.status).toBe(401);
  });
});
