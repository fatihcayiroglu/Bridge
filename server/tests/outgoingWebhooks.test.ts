// server/tests/outgoingWebhooks.test.ts
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
import owRouter from '../routes/outgoingWebhooks';
const perms   = require('../lib/permissions');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:sid/outgoing-webhooks', authMiddleware, owRouter);
  return app;
}
function tok(uid, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Outgoing Webhooks Routes', () => {
  let app, ownerId, serverId;
  let ownerToken;

  beforeEach(async () => {
    db._reset?.();
    app      = buildApp();
    ownerId  = uuidv4();
    serverId = uuidv4();
    ownerToken = tok(ownerId);

    await db.users.insert({ _id: ownerId, username: 'owner', displayName: 'Owner', tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'TestServer', ownerId });
    await db.members.insert({ userId: ownerId, serverId, roles: [] });

    perms.resolvePermissions.mockResolvedValue(8);
    perms.hasPermission.mockReturnValue(true);
  });

  describe('GET /api/servers/:sid/outgoing-webhooks', () => {
    it('returns empty list initially', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns 403 without MANAGE_SERVER', async () => {
      perms.hasPermission.mockReturnValue(false);
      const res = await request(app)
        .get(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app).get(`/api/servers/${serverId}/outgoing-webhooks`);
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/servers/:sid/outgoing-webhooks', () => {
    it('creates an outgoing webhook', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Slack Relay', url: 'https://hooks.slack.com/services/test', events: ['message:new'] });
      expect([200, 201]).toContain(res.status);
      expect(res.body).toHaveProperty('_id');
    });

    it('returns 400 for missing name', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ url: 'https://example.com', events: ['message:new'] });
      expect(res.status).toBe(400);
    });

    it('returns 400 for missing url', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Hook', events: ['message:new'] });
      expect(res.status).toBe(400);
    });

    it('returns 400 for unsupported event type', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/outgoing-webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Hook', url: 'https://example.com', events: ['invalid:event'] });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/servers/:sid/outgoing-webhooks/:id', () => {
    let hookId;
    beforeEach(async () => {
      const hook = await db.outgoingWebhooks.insert({
        _id: uuidv4(), serverId, name: 'ToDelete', url: 'https://example.com',
        events: '["message:new"]', enabled: true, createdBy: ownerId, createdAt: Date.now()
      });
      hookId = hook._id;
    });

    it('deletes a webhook', async () => {
      const res = await request(app)
        .delete(`/api/servers/${serverId}/outgoing-webhooks/${hookId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect([200, 204]).toContain(res.status);
      const hook = await db.outgoingWebhooks.findOne({ _id: hookId });
      expect(hook).toBeNull();
    });

    it('returns 404 for nonexistent webhook', async () => {
      const res = await request(app)
        .delete(`/api/servers/${serverId}/outgoing-webhooks/${uuidv4()}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });
});
