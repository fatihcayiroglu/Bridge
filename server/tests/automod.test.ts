// server/tests/automod.test.ts
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
import automodRouter from '../routes/automod';
const perms   = require('../lib/permissions');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:sid/automod', authMiddleware, automodRouter);
  return app;
}
function tok(uid, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('AutoMod Routes', () => {
  let app, ownerId, memberId, serverId;
  let ownerToken, memberToken;

  beforeEach(async () => {
    db._reset?.();
    app      = buildApp();
    ownerId  = uuidv4();
    memberId = uuidv4();
    serverId = uuidv4();
    ownerToken  = tok(ownerId);
    memberToken = tok(memberId);

    await db.users.insert({ _id: ownerId,  username: 'owner',  displayName: 'Owner',  tokenVersion: 0 });
    await db.users.insert({ _id: memberId, username: 'member', displayName: 'Member', tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'TestServer', ownerId });
    await db.members.insert({ userId: ownerId,  serverId, roles: [] });
    await db.members.insert({ userId: memberId, serverId, roles: [] });

    perms.resolvePermissions.mockResolvedValue(8); // MANAGE_SERVER
    perms.hasPermission.mockImplementation((p, flag) => (p & flag) !== 0);
  });

  describe('GET /api/servers/:sid/automod', () => {
    it('returns empty rules list for member', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/automod`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns existing rules', async () => {
      await db.automodRules.insert({ _id: uuidv4(), serverId, type: 'blocked_words', enabled: true, config: '{"words":["spam"]}', createdAt: Date.now() });
      const res = await request(app)
        .get(`/api/servers/${serverId}/automod`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].config).toHaveProperty('words');
    });

    it('returns 403 for non-member', async () => {
      const strangeId = uuidv4();
      await db.users.insert({ _id: strangeId, username: 'x', displayName: 'X', tokenVersion: 0 });
      const strangeToken = tok(strangeId);
      const res = await request(app)
        .get(`/api/servers/${serverId}/automod`)
        .set('Authorization', `Bearer ${strangeToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/servers/:sid/automod — create rule', () => {
    it('creates a blocked_words rule', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/automod`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ type: 'blocked_words', config: { words: ['badword'] }, action: 'delete' });
      expect([200, 201]).toContain(res.status);
      const rules = await db.automodRules.find({ serverId });
      expect(rules.length).toBe(1);
    });

    it('returns 400 for invalid rule type', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/automod`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ type: 'invalid_type', config: {}, action: 'delete' });
      expect(res.status).toBe(400);
    });

    it('returns 403 without MANAGE_SERVER', async () => {
      perms.hasPermission.mockReturnValue(false);
      const res = await request(app)
        .post(`/api/servers/${serverId}/automod`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ type: 'blocked_words', config: {}, action: 'delete' });
      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /api/servers/:sid/automod/:rid — update rule', () => {
    let ruleId;
    beforeEach(async () => {
      const rule = await db.automodRules.insert({ _id: uuidv4(), serverId, type: 'blocked_words', enabled: true, config: '{}', createdAt: Date.now() });
      ruleId = rule._id;
    });

    it('toggles rule enabled state', async () => {
      const res = await request(app)
        .patch(`/api/servers/${serverId}/automod/${ruleId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ enabled: false });
      expect([200, 204]).toContain(res.status);
    });

    it('returns 404 for nonexistent rule', async () => {
      const res = await request(app)
        .patch(`/api/servers/${serverId}/automod/${uuidv4()}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ enabled: false });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/servers/:sid/automod/:rid', () => {
    let ruleId;
    beforeEach(async () => {
      const rule = await db.automodRules.insert({ _id: uuidv4(), serverId, type: 'spam_messages', enabled: true, config: '{}', createdAt: Date.now() });
      ruleId = rule._id;
    });

    it('deletes a rule', async () => {
      const res = await request(app)
        .delete(`/api/servers/${serverId}/automod/${ruleId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect([200, 204]).toContain(res.status);
      const rule = await db.automodRules.findOne({ _id: ruleId });
      expect(rule).toBeNull();
    });

    it('returns 404 for nonexistent rule', async () => {
      const res = await request(app)
        .delete(`/api/servers/${serverId}/automod/${uuidv4()}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get(`/api/servers/${serverId}/automod`);
    expect(res.status).toBe(401);
  });
});
