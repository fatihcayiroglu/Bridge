// server/tests/bots-coverage.test.ts
// Sprint 110: bots.ts coverage artırımı — webhook edge cases, token rotation, delete, perm checks
// Hedef: routes/bots.ts satır coverage %70 → %80

process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';
process.env.BOT_TOKEN_SECRET = 'test-bot-secret';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

jest.mock('../middleware/rateLimit', () => ({
  limits: { bots: () => (_req, _res, next) => next() },
}));

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db  = require('../db/loader');
const jwt = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import botsRouter from '../routes/bots';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers', authMiddleware, botsRouter);
  app.use('/api/webhooks', botsRouter); // no auth for webhooks
  return app;
}
function tok(uid: string) {
  return jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('Bots — coverage artırımı', () => {
  let app: ReturnType<typeof express>;
  let ownerId: string;
  let otherId: string;
  let serverId: string;
  let channelId: string;
  let ownerToken: string;
  let otherToken: string;

  beforeEach(async () => {
    db._reset?.();
    app       = buildApp();
    ownerId   = uuidv4();
    otherId   = uuidv4();
    serverId  = uuidv4();
    channelId = uuidv4();
    ownerToken = tok(ownerId);
    otherToken = tok(otherId);

    await db.users.insert({ _id: ownerId, username: 'owner', displayName: 'Owner', tokenVersion: 0 });
    await db.users.insert({ _id: otherId, username: 'other', displayName: 'Other', tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'Test Server', ownerId, createdAt: Date.now() });
    await db.members.insert({ userId: ownerId, serverId, roles: ['admin'] });
    await db.channels.insert({ _id: channelId, serverId, name: 'general', type: 'text' });
  });

  // ── POST /:serverId/bots — create ────────────────────────────────────────

  describe('POST /:serverId/bots — oluşturma', () => {
    it('owner bot oluşturabilir', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/bots`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'helper-bot', description: 'Yardımcı bot' });
      expect(res.status).toBe(201);
      expect(res.body.bot).toBeDefined();
      expect(res.body.token).toMatch(/^brg_bot_/);
    });

    it('name zorunlu', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/bots`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ description: 'Eksik isim' });
      expect(res.status).toBe(400);
    });

    it('non-member bot oluşturamaz', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/bots`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ name: 'sneaky-bot' });
      expect([403, 404]).toContain(res.status);
    });

    it('uzun isim kesilir veya 400 döner', async () => {
      const longName = 'b'.repeat(200);
      const res = await request(app)
        .post(`/api/servers/${serverId}/bots`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: longName });
      expect([201, 400]).toContain(res.status);
    });
  });

  // ── GET /:serverId/bots — list ────────────────────────────────────────────

  describe('GET /:serverId/bots — listeleme', () => {
    it('üye bot listesini görebilir', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/bots`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('bot oluşturduktan sonra listede görünür', async () => {
      await request(app)
        .post(`/api/servers/${serverId}/bots`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'visible-bot' });
      const res = await request(app)
        .get(`/api/servers/${serverId}/bots`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      const names = res.body.map((b: { name: string }) => b.name);
      expect(names).toContain('visible-bot');
    });

    it('non-member listeye erişemez', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/bots`)
        .set('Authorization', `Bearer ${otherToken}`);
      expect([403, 404]).toContain(res.status);
    });
  });

  // ── DELETE /:serverId/bots/:botId ─────────────────────────────────────────

  describe('DELETE /:serverId/bots/:botId — silme', () => {
    let botId: string;
    beforeEach(async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/bots`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'to-delete' });
      botId = res.body.bot?._id;
    });

    it('owner botu silebilir', async () => {
      const res = await request(app)
        .delete(`/api/servers/${serverId}/bots/${botId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect([200, 204]).toContain(res.status);
    });

    it('non-member silme yapamaz', async () => {
      const res = await request(app)
        .delete(`/api/servers/${serverId}/bots/${botId}`)
        .set('Authorization', `Bearer ${otherToken}`);
      expect([403, 404]).toContain(res.status);
    });

    it('var olmayan botId 404 döner', async () => {
      const res = await request(app)
        .delete(`/api/servers/${serverId}/bots/${uuidv4()}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect([404, 403]).toContain(res.status);
    });
  });

  // ── POST /:serverId/bots/:botId/token — rotate ────────────────────────────

  describe('POST /:serverId/bots/:botId/token — token yenile', () => {
    let botId: string;
    beforeEach(async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/bots`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'rotate-test' });
      botId = res.body.bot?._id;
    });

    it('owner token yenileyebilir', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/bots/${botId}/token`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.token).toMatch(/^brg_bot_/);
    });

    it('non-member token yenileyemez', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/bots/${botId}/token`)
        .set('Authorization', `Bearer ${otherToken}`);
      expect([403, 404]).toContain(res.status);
    });

    it('iki ardışık rotate farklı tokenlar üretir', async () => {
      const r1 = await request(app)
        .post(`/api/servers/${serverId}/bots/${botId}/token`)
        .set('Authorization', `Bearer ${ownerToken}`);
      const r2 = await request(app)
        .post(`/api/servers/${serverId}/bots/${botId}/token`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(r1.body.token).not.toBe(r2.body.token);
    });
  });

  // ── POST /webhooks/:webhookId ─────────────────────────────────────────────

  describe('POST /webhooks/:webhookId — webhook', () => {
    let webhookId: string;
    let botId: string;

    beforeEach(async () => {
      // Bot oluştur ve webhook ID ata
      const createRes = await request(app)
        .post(`/api/servers/${serverId}/bots`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'webhook-bot' });
      botId     = createRes.body.bot?._id;
      webhookId = createRes.body.bot?.webhookId ?? uuidv4();
      // DB'ye webhook ID kaydet
      if (botId) {
        await db.bots?.update?.(botId, { webhookId, channelId });
      }
    });

    it('content yoksa 400 döner', async () => {
      const res = await request(app)
        .post(`/api/webhooks/${webhookId}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('geçersiz webhookId 401 döner', async () => {
      const res = await request(app)
        .post(`/api/webhooks/${uuidv4()}`)
        .send({ content: 'Hello' });
      expect(res.status).toBe(401);
    });

    it('boş embeds dizisi 400 döner', async () => {
      const res = await request(app)
        .post(`/api/webhooks/${webhookId}`)
        .send({ embeds: [] });
      expect(res.status).toBe(400);
    });
  });
});
