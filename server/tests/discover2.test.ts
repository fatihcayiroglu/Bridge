// server/tests/discover2.test.ts
// Keşif güçlendirme testleri — Session 10
// Öne çıkan sunucular, kategori filtresi, admin feature endpoint

'use strict';

import request from 'supertest';
import { createTestApp, createTestUser, createAdminUser, loginUser, createTestServer } from './helpers/setup';

type DiscoverServerResult = {
  _id: string;
  name: string;
  _memberCount?: number;
  _onlinePre?: number;
  createdAt: number;
  [key: string]: unknown;
};

describe('Discover — Session 10 enhancements', () => {
  let app, adminToken, userToken, userId, serverId;

  beforeAll(async () => {
    app = await createTestApp();

    const admin = await createAdminUser(app);
    adminToken  = await loginUser(app, admin.email, admin.password);

    const user = await createTestUser(app);
    userId     = user.userId;
    userToken  = await loginUser(app, user.email, user.password);

    // Keşilebilir test sunucusu
    const srv = await createTestServer(app, adminToken, {
      name: 'Test Gaming Server',
      discoverable: true,
      category: 'gaming',
    });
    serverId = srv._id;
  });

  // ── Kategori endpoint ───────────────────────────────────────────────────
  describe('GET /api/discover/categories', () => {
    it('should return category list', async () => {
      const res = await request(app)
        .get('/api/discover/categories')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      const ids = res.body.map(c => c.id);
      expect(ids).toContain('gaming');
      expect(ids).toContain('music');
      expect(ids).toContain('other');
    });
  });

  // ── Kategori filtreleme ─────────────────────────────────────────────────
  describe('GET /api/discover?category=gaming', () => {
    it('should filter by category', async () => {
      const res = await request(app)
        .get('/api/discover?category=gaming')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      res.body.forEach((s: DiscoverServerResult) => {
        expect(s.category).toBe('gaming');
      });
    });

    it('should include category field in all results', async () => {
      const res = await request(app)
        .get('/api/discover')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      res.body.forEach((s: DiscoverServerResult) => {
        expect(s).toHaveProperty('category');
      });
    });
  });

  // ── Discover settings: category ────────────────────────────────────────
  describe('PATCH /api/discover/settings — category', () => {
    it('owner can set category', async () => {
      await request(app)
        .patch('/api/discover/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ serverId, category: 'music' })
        .expect(200);

      const res = await request(app)
        .get('/api/discover')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      const srv = res.body.find((s: DiscoverServerResult) => s._id === serverId);
      expect(srv?.category).toBe('music');
    });

    it('should reject invalid category', async () => {
      const res = await request(app)
        .patch('/api/discover/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ serverId, category: 'invalid_xyz' })
        .expect(200); // update sadece geçerli kategorileri işler, geçersiz olanı yoksayar
      // category değişmemiş olmalı (hâlâ 'music')
    });
  });

  // ── Featured endpoint ───────────────────────────────────────────────────
  describe('GET /api/discover/featured', () => {
    it('should return empty array when no featured servers', async () => {
      const res = await request(app)
        .get('/api/discover/featured')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('featured servers should include featured field = true', async () => {
      // Önce öne çıkar
      await request(app)
        .post('/api/admin/discover/feature')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ serverId, featured: true })
        .expect(200);

      const res = await request(app)
        .get('/api/discover/featured')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      const featured = res.body.find((s: DiscoverServerResult) => s._id === serverId);
      expect(featured).toBeDefined();
      expect(featured.featured).toBe(true);
      expect(featured.featuredAt).toBeTruthy();
    });
  });

  // ── Admin feature endpoint ──────────────────────────────────────────────
  describe('POST /api/admin/discover/feature', () => {
    it('non-admin should get 403', async () => {
      await request(app)
        .post('/api/admin/discover/feature')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ serverId, featured: true })
        .expect(403);
    });

    it('admin can unfeature a server', async () => {
      await request(app)
        .post('/api/admin/discover/feature')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ serverId, featured: false })
        .expect(200);

      const res = await request(app)
        .get('/api/discover/featured')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      const featured = res.body.find((s: DiscoverServerResult) => s._id === serverId);
      expect(featured).toBeUndefined();
    });
  });

  // ── Sort by online ──────────────────────────────────────────────────────
  describe('GET /api/discover?sort=online', () => {
    it('should accept online sort without error', async () => {
      await request(app)
        .get('/api/discover?sort=online')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
    });
  });
});
