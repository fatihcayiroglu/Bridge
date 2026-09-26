// server/tests/serverProfile.test.ts
import type { Express } from 'express';
process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';
process.env.INSTANCE_URL   = 'http://localhost:3001';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

const profileBoostMocks = {
  mutateVanityAtomic: jest.fn(),
  getLiveVanityServer: jest.fn(),
};
jest.mock('../db/repositories/BoostRepository.js', () => ({ Boosts: profileBoostMocks }));

const request  = require('supertest');
const express  = require('express');
import { v4 as uuidv4 } from 'uuid';
const db       = require('../db/loader');
const jwt      = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
const profileRouter    = require('../routes/serverProfile');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers',    authMiddleware, profileRouter);
  app.use('/s',              profileRouter);
  return app;
}
function tok(uid: string) { return jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Server Profile Routes', () => {
  let ownerId: string;
  let memberId: string;
  let serverId: string;
  let ownerToken: string;
  let memberToken: string;
  let app: Express;

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
    await db.servers.insert({ _id: serverId, name: 'Bridge Gaming', ownerId, icon: '🎮', discoverable: 1 });
    await db.members.insert({ userId: ownerId,  serverId, roles: [] });
    await db.members.insert({ userId: memberId, serverId, roles: [] });
    profileBoostMocks.mutateVanityAtomic.mockReset();
    profileBoostMocks.getLiveVanityServer.mockReset();
    profileBoostMocks.mutateVanityAtomic.mockResolvedValue('ok');
    profileBoostMocks.getLiveVanityServer.mockImplementation((slug: string) => db.servers.findOne({ vanityUrl: slug }));
  });

  // ── Slug API ─────────────────────────────────────────────────
  describe('GET /api/servers/:sid/slug', () => {
    it('returns null slug to the owner when not set', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/slug`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('slug');
    });

    it('does not reveal a vanity capability from a server id to non-owners', async () => {
      await db.servers.update({ _id: serverId }, { $set: { vanityUrl: 'private-capability' } });
      const res = await request(app)
        .get(`/api/servers/${serverId}/slug`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
      expect(res.body.slug).toBeUndefined();
    });

    it('returns 404 for nonexistent server', async () => {
      const res = await request(app)
        .get(`/api/servers/${uuidv4()}/slug`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/servers/:sid/slug', () => {
    it('owner can set slug only through the live boost entitlement owner', async () => {
      const res = await request(app)
        .put(`/api/servers/${serverId}/slug`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ slug: 'bridge-gaming' });
      expect(res.status).toBe(200);
      expect(res.body.slug).toBe('bridge-gaming');
      expect(profileBoostMocks.mutateVanityAtomic).toHaveBeenCalledWith(serverId, ownerId, 'bridge-gaming');
    });

    it('rejects slug mutation when live Level-3 entitlement has expired', async () => {
      profileBoostMocks.mutateVanityAtomic.mockResolvedValueOnce('boost_required');
      const res = await request(app)
        .put(`/api/servers/${serverId}/slug`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ slug: 'bridge-gaming' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('BOOST_REQUIRED');
    });

    it('auto-slugifies the server name if no slug provided', async () => {
      const res = await request(app)
        .put(`/api/servers/${serverId}/slug`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.slug).toBeTruthy();
      // Should be lowercase with dashes
      expect(res.body.slug).toMatch(/^[a-z0-9-]+$/);
    });

    it('rejects non-owner setting slug', async () => {
      const res = await request(app)
        .put(`/api/servers/${serverId}/slug`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ slug: 'hack' });
      expect(res.status).toBe(403);
    });

    it('maps atomic slug collision to 409', async () => {
      profileBoostMocks.mutateVanityAtomic.mockResolvedValueOnce('conflict');
      const res = await request(app)
        .put(`/api/servers/${serverId}/slug`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ slug: 'taken-slug' });
      expect(res.status).toBe(409);
    });
  });

  // ── Public profile page /s/:slug ────────────────────────────
  describe('GET /s/:slug', () => {
    beforeEach(async () => {
      await db.servers.update({ _id: serverId }, { $set: { vanityUrl: 'bridge-gaming-test' } });
    });

    it('returns HTML page for valid slug', async () => {
      const res = await request(app).get('/s/bridge-gaming-test');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/html/);
      expect(res.text).toContain('Bridge Gaming');
    });

    it('contains Open Graph meta tags', async () => {
      const res = await request(app).get('/s/bridge-gaming-test');
      expect(res.status).toBe(200);
      expect(res.text).toContain('og:title');
      expect(res.text).toContain('og:description');
    });

    it('contains join button', async () => {
      const res = await request(app).get('/s/bridge-gaming-test');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/katıl|join/i);
    });

    it('returns 404 HTML for unknown slug', async () => {
      const res = await request(app).get('/s/definitely-not-exists-xyz');
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/html/);
    });


    it('returns 404 when the stored vanity has lost live Level-3 entitlement', async () => {
      profileBoostMocks.getLiveVanityServer.mockResolvedValueOnce(null);
      const res = await request(app).get('/s/bridge-gaming-test');
      expect(res.status).toBe(404);
    });
  });

  it('rejects unauthenticated slug API', async () => {
    const res = await request(app).get(`/api/servers/${serverId}/slug`);
    expect(res.status).toBe(401);
  });
});
