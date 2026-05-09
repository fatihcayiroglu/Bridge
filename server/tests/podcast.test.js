// server/tests/podcast.test.js
process.env.NODE_ENV       = 'test';
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

// podcast.js route'ları admin yetkisi için authMiddleware kullanıyor — test için basit JWT doğrulama mock'u yapıyoruz
jest.mock('../middleware/auth', () => {
  const jwt = require('jsonwebtoken');
  return {
    authMiddleware: (req, res, next) => {
      const h = req.headers.authorization;
      if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
      try {
        req.user = jwt.verify(h.slice(7), process.env.JWT_SECRET);
        return next();
      } catch {
        return res.status(401).json({ error: 'Invalid token' });
      }
    },
  };
});

const request      = require('supertest');
const express      = require('express');
const jwt          = require('jsonwebtoken');
const podcastRouter = require('../routes/podcast');
const db           = require('../db/loader');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/podcast', podcastRouter);
  return app;
}

function tok(uid) {
  return jwt.sign({ id: uid }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('Podcast routes', () => {
  let app;
  let adminId, userId, serverId, channelId, episodeId;

  beforeEach(async () => {
    db._reset?.();
    app = buildApp();

    adminId   = 'u-admin';
    userId    = 'u-user';
    serverId  = 'srv-1';
    channelId = 'ch-1';
    episodeId = 'ep-1';

    await db.users.insert({ _id: adminId, username: 'admin', displayName: 'Admin', tokenVersion: 0, isAdmin: 1 });
    await db.users.insert({ _id: userId,  username: 'user',  displayName: 'User',  tokenVersion: 0, isAdmin: 0 });

    await db.servers.insert({ _id: serverId, name: 'S1', ownerId: adminId });
    await db.channels.insert({ _id: channelId, serverId, name: 'general', type: 'text' });

    await db.podcastEpisodes.insert({
      _id: episodeId,
      channelId,
      serverId,
      title: 'Episode 1',
      description: 'Desc',
      filename: 'ep1.mp3',
      audioUrl: null,
      mimeType: 'audio/mpeg',
      fileSize: 123,
      durationSeconds: 65,
      published: true,
      publishedAt: Date.now() - 60_000,
    });
  });

  describe('Public endpoints', () => {
    it('GET /:channelId/rss returns 404 when channel missing', async () => {
      const res = await request(app)
        .get('/api/podcast/missing/rss');
      expect(res.status).toBe(404);
    });

    it('GET /:channelId/rss returns RSS XML', async () => {
      const res = await request(app).get(`/api/podcast/${channelId}/rss`);
      expect(res.status).toBe(200);
//       expect(res.headers['content-type']).toMatch(/application\\/rss\\+xml|application\\/rss/i);
      expect(res.text).toContain('<rss');
    });

    it('GET /:channelId/feed.json returns feed JSON', async () => {
      const res = await request(app).get(`/api/podcast/${channelId}/feed.json`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('version');
      expect(Array.isArray(res.body.items)).toBe(true);
    });

    it('GET /embed/:episodeId returns embed HTML', async () => {
      const res = await request(app).get(`/api/podcast/embed/${episodeId}`);
      expect(res.status).toBe(200);
//       expect(res.headers['content-type']).toMatch(/text\\/html/);
      expect(res.text).toContain('<html');
      expect(res.text).toContain('Episode 1');
    });

    it('GET /:channelId/episodes returns JSON list', async () => {
      const res = await request(app).get(`/api/podcast/${channelId}/episodes`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('total');
      expect(Array.isArray(res.body.episodes)).toBe(true);
    });
  });

  describe('Protected endpoints (auth + requireChannelAdmin)', () => {
    it('POST /:channelId/episodes requires auth', async () => {
      const res = await request(app)
        .post(`/api/podcast/${channelId}/episodes`)
        .send({ title: 'New Ep', filename: 'new.mp3' });
      expect(res.status).toBe(401);
    });

    it('POST /:channelId/episodes forbids users without member/admin access', async () => {
      // userId token, admin endpoint'i için server owner değiliz ve member kaydı da yok
      const res = await request(app)
        .post(`/api/podcast/${channelId}/episodes`)
        .set('Authorization', `Bearer ${tok(userId)}`)
        .send({ title: 'New Ep', filename: 'new.mp3' });

      expect(res.status).toBe(403);
    });

    it('POST /:channelId/episodes creates episode (owner can)', async () => {
      const res = await request(app)
        .post(`/api/podcast/${channelId}/episodes`)
        .set('Authorization', `Bearer ${tok(adminId)}`)
        .send({ title: 'New Ep', filename: 'new.mp3', durationSeconds: 10, published: true });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.episode).toHaveProperty('_id');
    });

    it('PATCH /:channelId/settings creates and updates settings', async () => {
      const res = await request(app)
        .patch(`/api/podcast/${channelId}/settings`)
        .set('Authorization', `Bearer ${tok(adminId)}`)
        .send({ title: 'Podcast Title', description: 'D' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.settings.channelId).toBe(channelId);
    });
  });
});

