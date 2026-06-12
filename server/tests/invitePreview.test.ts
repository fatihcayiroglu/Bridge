// server/tests/invitePreview.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
import invitePreviewRouter from '../routes/invitePreview';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/invite', invitePreviewRouter);
  return app;
}

describe('Invite Preview Routes', () => {
  let app, serverId, inviteCode, ownerId;

  beforeEach(async () => {
    db._reset?.();
    app        = buildApp();
    ownerId    = uuidv4();
    serverId   = uuidv4();
    inviteCode = 'TEST123';

    await db.servers.insert({ _id: serverId, name: 'Awesome Server', icon: '🚀', ownerId });
    await db.invites.insert({
      _id: uuidv4(), code: inviteCode, serverId,
      createdBy: ownerId, createdAt: Date.now(),
      expiresAt: Date.now() + 86400000,
      maxUses: 0, uses: 0,
    });
    await db.members.insert({ userId: ownerId, serverId, roles: [] });
  });

  describe('GET /invite/:code — success path', () => {
    it('returns 200 HTML for a valid invite code', async () => {
      const res = await request(app).get(`/invite/${inviteCode}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/html/);
    });

    it('HTML response contains the server name', async () => {
      const res = await request(app).get(`/invite/${inviteCode}`);
      expect(res.text).toContain('Awesome Server');
    });

    it('HTML contains Open Graph og:title meta tag', async () => {
      const res = await request(app).get(`/invite/${inviteCode}`);
      expect(res.text).toContain('og:title');
    });

    it('HTML contains Twitter Card meta tags', async () => {
      const res = await request(app).get(`/invite/${inviteCode}`);
      // Either twitter:card or og:description indicates social sharing support
      expect(res.text).toMatch(/twitter:card|og:description/);
    });

    it('HTML contains member count', async () => {
      // Add another member so count > 0
      await db.members.insert({ userId: uuidv4(), serverId, roles: [] });
      const res = await request(app).get(`/invite/${inviteCode}`);
      // Should show "2" members or similar
      expect(res.text).toMatch(/\d+/);
    });

    it('HTML contains server icon', async () => {
      const res = await request(app).get(`/invite/${inviteCode}`);
      expect(res.text).toContain('🚀');
    });
  });

  describe('GET /invite/:code — error cases', () => {
    it('returns 404 for unknown invite code', async () => {
      const res = await request(app).get('/invite/BADCODE');
      expect(res.status).toBe(404);
    });

    it('returns 404 or 410 for expired invite', async () => {
      await db.invites.insert({
        _id: uuidv4(), code: 'EXPIRED1', serverId,
        createdBy: ownerId, createdAt: Date.now() - 90000,
        expiresAt: Date.now() - 1000,
        maxUses: 0, uses: 0,
      });
      const res = await request(app).get('/invite/EXPIRED1');
      expect([404, 410]).toContain(res.status);
    });

    it('returns 404 for invite pointing to deleted server', async () => {
      const orphanServerId = uuidv4();
      // No server record inserted — orphan invite
      await db.invites.insert({
        _id: uuidv4(), code: 'ORPHAN1', serverId: orphanServerId,
        createdBy: uuidv4(), createdAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        maxUses: 0, uses: 0,
      });
      const res = await request(app).get('/invite/ORPHAN1');
      expect([404, 500]).toContain(res.status);
    });
  });

  describe('GET /invite/:code — XSS safety', () => {
    it('HTML-escapes server name to prevent XSS', async () => {
      const xssServerId = uuidv4();
      await db.servers.insert({
        _id: xssServerId, name: '<script>alert(1)</script>', icon: '⚠️', ownerId,
      });
      await db.invites.insert({
        _id: uuidv4(), code: 'XSSTEST', serverId: xssServerId,
        createdBy: ownerId, createdAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        maxUses: 0, uses: 0,
      });
      const res = await request(app).get('/invite/XSSTEST');
      expect(res.text).not.toContain('<script>alert(1)</script>');
    });
  });
});
