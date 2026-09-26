// server/tests/automod.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
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
import { requireDoc } from './helpers/mockDb';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:sid/automod', authMiddleware, automodRouter);
  return app;
}
function tok(uid: string, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('AutoMod Routes', () => {
  let app: express.Express;
  let ownerId: string;
  let memberId: string;
  let serverId: string;
  let ownerToken: string;
  let memberToken: string;

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
    perms.hasPermission.mockImplementation((p: number, flag: number) => (p & flag) !== 0);
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

    it('does not disclose rule configuration to a member without MANAGE_SERVER', async () => {
      perms.hasPermission.mockReturnValue(false);
      const res = await request(app)
        .get(`/api/servers/${serverId}/automod`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
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
        .send({ type: 'blocked_words', config: { words: ['badword'], action: 'delete' } });
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
    let ruleId: string;
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
    let ruleId: string;
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


  describe('strict config / tenant contract', () => {
    it('returns real PostgreSQL-style JSONB object config without erasing it', async () => {
      await db.automodRules.insert({
        _id: uuidv4(), serverId, type: 'blocked_words', enabled: true,
        config: { words: ['jsonb-word'], action: 'delete', timeoutMs: 60000, logChannelId: null, exemptRoles: [] },
        createdBy: ownerId, createdAt: Date.now(),
      });
      const res = await request(app).get(`/api/servers/${serverId}/automod`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body[0].config.words).toEqual(['jsonb-word']);
    });

    it.each([
      { type: 'spam_messages', config: { maxMessages: '5' } },
      { type: 'spam_messages', config: { maxMessages: -1 } },
      { type: 'spam_messages', config: { maxMessages: 2.5 } },
      { type: 'blocked_words', config: { words: [123] } },
      { type: 'link_filter', config: { unknown: true } },
      { type: 'link_filter', config: {}, enabled: 'false' },
      { type: 'link_filter', config: {}, action: 'delete' },
    ])('rejects coercive/malformed create body %#', async (body) => {
      const res = await request(app).post(`/api/servers/${serverId}/automod`)
        .set('Authorization', `Bearer ${ownerToken}`).send(body);
      expect(res.status).toBe(400);
    });

    it('rejects cross-server log channel and exempt role ids', async () => {
      const otherServerId = uuidv4();
      const otherChannelId = uuidv4();
      const otherRoleId = uuidv4();
      await db.servers.insert({ _id: otherServerId, name: 'Other', ownerId });
      await db.channels.insert({ _id: otherChannelId, serverId: otherServerId, name: 'other-log', type: 'text', createdAt: Date.now() });
      await db.roles.insert({ _id: otherRoleId, serverId: otherServerId, name: 'other-role', permissions: 0, position: 1, createdAt: Date.now() });

      const channelRes = await request(app).post(`/api/servers/${serverId}/automod`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ type: 'link_filter', config: { logChannelId: otherChannelId } });
      expect(channelRes.status).toBe(400);

      const roleRes = await request(app).post(`/api/servers/${serverId}/automod`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ type: 'link_filter', config: { exemptRoles: [otherRoleId] } });
      expect(roleRes.status).toBe(400);
    });

    it('PATCH merges and revalidates config instead of replacing/bypassing it', async () => {
      const created = await request(app).post(`/api/servers/${serverId}/automod`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ type: 'spam_messages', config: { maxMessages: 4, windowSecs: 12 } });
      expect(created.status).toBe(201);
      const rid = created.body._id;

      const patched = await request(app).patch(`/api/servers/${serverId}/automod/${rid}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ config: { maxMessages: 6 } });
      expect(patched.status).toBe(200);
      expect(patched.body.config).toMatchObject({ maxMessages: 6, windowSecs: 12 });

      const bad = await request(app).patch(`/api/servers/${serverId}/automod/${rid}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ config: { maxMessages: '6' } });
      expect(bad.status).toBe(400);
    });

    it('PATCH and DELETE cannot mutate same id through a different server scope', async () => {
      const rule = await db.automodRules.insert({
        _id: uuidv4(), serverId, type: 'link_filter', enabled: true, config: {}, createdBy: ownerId, createdAt: Date.now(),
      });
      const otherServerId = uuidv4();
      await db.servers.insert({ _id: otherServerId, name: 'Other', ownerId });
      await db.members.insert({ userId: ownerId, serverId: otherServerId, roles: [] });

      const patch = await request(app).patch(`/api/servers/${otherServerId}/automod/${rule._id}`)
        .set('Authorization', `Bearer ${ownerToken}`).send({ enabled: false });
      expect(patch.status).toBe(404);
      const del = await request(app).delete(`/api/servers/${otherServerId}/automod/${rule._id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(del.status).toBe(404);
      expect(await db.automodRules.findOne({ _id: rule._id, serverId })).toBeTruthy();
    });
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get(`/api/servers/${serverId}/automod`);
    expect(res.status).toBe(401);
  });
});
