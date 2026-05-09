// server/tests/sso.test.js
process.env.NODE_ENV       = 'test';
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

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

const request  = require('supertest');
const express  = require('express');
const jwt      = require('jsonwebtoken');
const ssoRouter = require('../routes/sso');
const db       = require('../db/loader');

function buildApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api/sso', ssoRouter);
  return app;
}

function tok(uid) {
  return jwt.sign({ id: uid }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('SSO routes', () => {
  let app;
  const adminId = 'u-admin';
  const userId  = 'u-user';

  beforeEach(async () => {
    db._reset?.();
    app = buildApp();

    await db.users.insert({ _id: adminId, username: 'admin', displayName: 'Admin', tokenVersion: 0, isAdmin: 1 });
    await db.users.insert({ _id: userId,  username: 'user',  displayName: 'User',  tokenVersion: 0, isAdmin: 0 });

    // Tüm SSO sağlayıcılarını devre dışı tut (uzak fetch'i tetiklememek için)
    delete process.env.OIDC_ENABLED;
    delete process.env.SAML_ENABLED;
  });

  describe('OIDC', () => {
    it('GET /api/sso/oidc/start döngüyü 503 ile kapat (OIDC devre dışı)', async () => {
      const res = await request(app).get('/api/sso/oidc/start');
      expect(res.status).toBe(503);
    });

    it('GET /api/sso/oidc/callback döngüyü 503 ile kapat (OIDC devre dışı)', async () => {
      const res = await request(app).get('/api/sso/oidc/callback?code=abc&state=xyz');
      expect(res.status).toBe(503);
    });
  });

  describe('SAML', () => {
    it('GET /api/sso/saml/start 503 döndürür (SAML devre dışı)', async () => {
      const res = await request(app).get('/api/sso/saml/start');
      expect(res.status).toBe(503);
    });
  });

  describe('Admin config', () => {
    it('GET /api/sso/config 401 döner (unauth)', async () => {
      const res = await request(app).get('/api/sso/config');
      expect(res.status).toBe(401);
    });

    it('GET /api/sso/config 403 döner (non-admin)', async () => {
      const res = await request(app)
        .get('/api/sso/config')
        .set('Authorization', `Bearer ${tok(userId)}`);
      expect(res.status).toBe(403);
    });

    it('GET /api/sso/config 200 döner (admin)', async () => {
      const res = await request(app)
        .get('/api/sso/config')
        .set('Authorization', `Bearer ${tok(adminId)}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('oidc');
      expect(res.body).toHaveProperty('saml');
      expect(res.body).toHaveProperty('metadataUrl');
    });
  });
});

