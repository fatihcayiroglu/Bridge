// server/tests/badges.test.ts
// Rozet sistemi testleri

'use strict';

import request from 'supertest';
import { createTestApp, createTestUser, createAdminUser, loginUser } from './helpers/setup';

describe('Badge System', () => {
  let app, adminToken, userToken, userId, adminId;

  beforeAll(async () => {
    app = await createTestApp();

    // Admin kullanıcı
    const admin = await createAdminUser(app);
    adminId    = admin.userId;
    adminToken = await loginUser(app, admin.email, admin.password);

    // Normal kullanıcı
    const user = await createTestUser(app);
    userId    = user.userId;
    userToken = await loginUser(app, user.email, user.password);
  });

  // ── Rozet tanımları ───────────────────────────────────────────────────────
  describe('GET /api/badges/definitions', () => {
    it('should return badge catalog', async () => {
      const res = await request(app)
        .get('/api/badges/definitions')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      const earlyAdopter = res.body.find(b => b.badge === 'early_adopter');
      expect(earlyAdopter).toBeDefined();
      expect(earlyAdopter).toHaveProperty('label');
      expect(earlyAdopter).toHaveProperty('icon');
      expect(earlyAdopter).toHaveProperty('description');
    });
  });

  // ── Kullanıcı rozet listesi ───────────────────────────────────────────────
  describe('GET /api/users/:userId/badges', () => {
    it('should return empty array for new user', async () => {
      const res = await request(app)
        .get(`/api/users/${userId}/badges`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(res.body).toEqual([]);
    });

    it('should require authentication', async () => {
      await request(app)
        .get(`/api/users/${userId}/badges`)
        .expect(401);
    });
  });

  // ── Admin rozet verme ─────────────────────────────────────────────────────
  describe('POST /api/admin/badges/award', () => {
    it('admin should award a badge', async () => {
      const res = await request(app)
        .post('/api/admin/badges/award')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId, badge: 'early_adopter' })
        .expect(201);

      expect(res.body).toHaveProperty('badge', 'early_adopter');
      expect(res.body).toHaveProperty('awardedBy', adminId);
    });

    it('should not award duplicate badge', async () => {
      await request(app)
        .post('/api/admin/badges/award')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId, badge: 'early_adopter' })
        .expect(409);
    });

    it('non-admin should get 403', async () => {
      await request(app)
        .post('/api/admin/badges/award')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ userId, badge: 'contributor' })
        .expect(403);
    });

    it('should reject unknown badge', async () => {
      await request(app)
        .post('/api/admin/badges/award')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId, badge: 'nonexistent_badge_xyz' })
        .expect(400);
    });

    it('badge should appear in user profile after award', async () => {
      const res = await request(app)
        .get(`/api/users/${userId}/badges`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      const badge = res.body.find(b => b.badge === 'early_adopter');
      expect(badge).toBeDefined();
      expect(badge).toHaveProperty('icon');
      expect(badge).toHaveProperty('awardedAt');
    });
  });

  // ── Admin rozet geri alma ─────────────────────────────────────────────────
  describe('DELETE /api/admin/badges/revoke', () => {
    it('admin should revoke a badge', async () => {
      // Önce ver
      await request(app)
        .post('/api/admin/badges/award')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId, badge: 'bug_hunter' })
        .expect(201);

      // Sonra al
      await request(app)
        .delete('/api/admin/badges/revoke')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ userId, badge: 'bug_hunter' })
        .expect(200);

      // Artık yok
      const res = await request(app)
        .get(`/api/users/${userId}/badges`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(res.body.find(b => b.badge === 'bug_hunter')).toBeUndefined();
    });
  });
});
