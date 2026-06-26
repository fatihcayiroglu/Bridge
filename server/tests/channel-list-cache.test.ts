// server/tests/channel-list-cache.test.ts
// Sprint 106: channel list Redis cache testleri
// GET /api/servers/:sid/channels — cache hit/miss/invalidation

process.env.JWT_SECRET     = 'test-jwt-secret-minimum-32-chars-long';
process.env.REFRESH_SECRET = 'test-refresh-secret-minimum-32-chars-long';
process.env.NODE_ENV       = 'test';

// ── Mocks ────────────────────────────────────────────────────────

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

// Cache mock — her test başında sıfırlanabilir store
const _cacheStore = new Map<string, unknown>();
const mockCacheGet = jest.fn().mockImplementation(async (key: string) => _cacheStore.get(key) ?? null);
const mockCacheSet = jest.fn().mockImplementation(async (key: string, val: unknown) => { _cacheStore.set(key, val); });
const mockCacheDel = jest.fn().mockImplementation(async (key: string) => { _cacheStore.delete(key); });

jest.mock('../lib/redisAdapter', () => ({
  cache: {
    get: mockCacheGet,
    set: mockCacheSet,
    del: mockCacheDel,
  },
  subscribeToChannel:  jest.fn().mockResolvedValue(() => Promise.resolve()),
  publishToChannel:    jest.fn().mockResolvedValue(undefined),
  redisClient:         jest.fn().mockReturnValue(null),
  isRedisAvailable:    jest.fn().mockReturnValue(false),
}));

import request    from 'supertest';
import express    from 'express';
import { v4 as uuidv4 } from 'uuid';
const db  = require('../db/loader');
const jwt = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';

// servers/channels router (Sprint 106 cache eklendi)
let channelsRouter: express.Router;

function buildApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:sid/channels', authMiddleware, channelsRouter);
  return app;
}

function tok(uid: string): string {
  return jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

// ── Test Suite ───────────────────────────────────────────────────

describe('Channel List Cache (Sprint 106)', () => {
  let app: express.Application;
  let ownerId: string;
  let serverId: string;
  let ownerToken: string;
  let channelId: string;

  beforeAll(() => {
    // Router'ı mock'lar kurulduktan sonra yükle
    channelsRouter = require('../routes/servers/channels').default;
  });

  beforeEach(async () => {
    db._reset?.();
    _cacheStore.clear();
    jest.clearAllMocks();

    app      = buildApp();
    ownerId  = uuidv4();
    serverId = uuidv4();
    channelId = uuidv4();
    ownerToken = tok(ownerId);

    await db.users.insert({ _id: ownerId, username: 'owner', displayName: 'Owner', tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'Test Server', ownerId });
    await db.members.insert({ userId: ownerId, serverId, roles: [] });
    await db.channels.insert({ _id: channelId, serverId, name: 'general', type: 'text', order: 0, createdAt: Date.now() });
  });

  // ── GET: cache miss → miss dönmeli, DB çağrısı yapılmalı ───────

  describe('GET /api/servers/:sid/channels', () => {
    it('boş cache üzerinde DB\'den döner, cache\'e yazar', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/channels`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);

      // Cache'e yazıldı mı?
      expect(mockCacheSet).toHaveBeenCalledWith(
        `channels:list:${serverId}`,
        expect.any(Array),
        30,
      );
    });

    it('X-Cache: MISS döner ilk istekte', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/channels`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.headers['x-cache']).toBe('MISS');
    });

    it('cache doluyken DB\'ye vurmaz, HIT döner', async () => {
      // İlk istek — cache'i doldurur
      await request(app)
        .get(`/api/servers/${serverId}/channels`)
        .set('Authorization', `Bearer ${ownerToken}`);

      jest.clearAllMocks();
      // Şimdi store zaten dolu

      const res = await request(app)
        .get(`/api/servers/${serverId}/channels`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.headers['x-cache']).toBe('HIT');
      // Cache set çağrılmamalı (zaten var)
      expect(mockCacheSet).not.toHaveBeenCalled();
    });

    it('üye olmayan kullanıcıya 403 döner (cache bypass)', async () => {
      const stranger = uuidv4();
      await db.users.insert({ _id: stranger, username: 'stranger', displayName: 'Stranger', tokenVersion: 0 });

      const res = await request(app)
        .get(`/api/servers/${serverId}/channels`)
        .set('Authorization', `Bearer ${tok(stranger)}`);

      expect(res.status).toBe(403);
    });

    it('cache get hatası olsa bile DB\'den döner', async () => {
      mockCacheGet.mockRejectedValueOnce(new Error('Redis connection error'));

      const res = await request(app)
        .get(`/api/servers/${serverId}/channels`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('cache set hatası yanıtı engellemez', async () => {
      mockCacheSet.mockRejectedValueOnce(new Error('Redis write error'));

      const res = await request(app)
        .get(`/api/servers/${serverId}/channels`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
    });
  });

  // ── POST: yeni kanal eklenince cache invalidate edilmeli ───────

  describe('POST /api/servers/:sid/channels — cache invalidation', () => {
    it('kanal eklenince cache key silinir', async () => {
      // Önce cache'i doldur
      await request(app)
        .get(`/api/servers/${serverId}/channels`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(_cacheStore.has(`channels:list:${serverId}`)).toBe(true);

      // Owner'a MANAGE_CHANNELS izni ver
      await db.roles.insert({ _id: uuidv4(), serverId, name: 'admin', color: '#fff', permissions: 0xFFFFFFFF, position: 10 });
      const roleId = (await db.roles.find({ serverId }))[0]._id;
      await db.members.update({ userId: ownerId, serverId }, { $set: { roles: JSON.stringify([roleId]) } });

      const res = await request(app)
        .post(`/api/servers/${serverId}/channels`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'yeni-kanal', type: 'text' });

      expect(res.status).toBe(200);
      expect(mockCacheDel).toHaveBeenCalledWith(`channels:list:${serverId}`);
      expect(_cacheStore.has(`channels:list:${serverId}`)).toBe(false);
    });
  });

  // ── invalidateChannelList — export edilmiş fonksiyon ──────────

  describe('invalidateChannelList() — doğrudan', () => {
    it('belirtilen serverId için cache key\'i siler', async () => {
      const { invalidateChannelList } = require('../routes/servers/channels');

      // Önce bir şey koy
      _cacheStore.set(`channels:list:${serverId}`, [{ _id: channelId }]);
      expect(_cacheStore.has(`channels:list:${serverId}`)).toBe(true);

      await invalidateChannelList(serverId);

      expect(mockCacheDel).toHaveBeenCalledWith(`channels:list:${serverId}`);
    });

    it('cache del hatası fırlatmaz', async () => {
      const { invalidateChannelList } = require('../routes/servers/channels');
      mockCacheDel.mockRejectedValueOnce(new Error('Redis down'));

      // Hata fırlatmamalı
      await expect(invalidateChannelList(serverId)).resolves.toBeUndefined();
    });
  });
});
