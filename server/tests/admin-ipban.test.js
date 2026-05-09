// server/tests/admin-ipban.test.js
process.env.JWT_SECRET         = 'test-jwt-secret';
process.env.NODE_ENV           = 'test';
process.env.ADMIN_SETUP_SECRET = 'super-secret-setup';

jest.mock('../db/index', () => require('./helpers/mockDb').createMockDb());

// Admin.js içinde CAPTCHA admin-stats çağrıları olabilir — testte stub'lıyoruz
jest.mock('../lib/captcha', () => ({
  getAdminStats: jest.fn().mockResolvedValue({
    enabled: true,
    provider: 'turnstile',
    successCount: 42,
    failCount: 3,
  }),
}));

// rate limit/redis gibi yan etkileri azaltmak için — express-rate-limit burada kullanılmıyor ama bazı testlerde tercih ediliyor
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());

const { createMockDb, makeUser, makeServer, makeChannel, makeRole } = require('./helpers/mockDb');
const mockDb = createMockDb();

// Jest import sırası önemli: admin route loader → db/index üzerinden mockDb'yi görebilmeli
jest.mock('../db/loader', () => {
  // loader, testte direk mock DB'yi kullanacak şekilde yönlendiriliyor
  return mockDb;
});

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req, res, next) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    try {
      req.user = jwt.verify(h.slice(7), 'test-jwt-secret');
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  },
}));

const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const adminRouter = require('../routes/admin');
const { unbanIp } = require('../middleware/ipBan');

function token(id) {
  return jwt.sign({ id, username: 'admin', displayName: 'Admin', v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

describe('Admin IP bans', () => {
  let app;
  const ADMIN_ID = 'admin1';
  const USER_ID  = 'user1';
  const TEST_IP  = '1.2.3.4';

  beforeAll(async () => {
    // Fixture (db/index jest.mock ile geliyor ama emniyet için yeniden dolduruyoruz)
    mockDb._reset?.();
    await mockDb.users.insert(makeUser({ _id: ADMIN_ID, username: 'admin', isAdmin: 1 }));
    await mockDb.users.insert(makeUser({ _id: USER_ID,  username: 'regularuser' }));

    await mockDb.servers.insert(makeServer(ADMIN_ID, { _id: 'srv1' }));
  });

  beforeEach(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/admin', adminRouter);
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  });

  afterEach(async () => {
    await unbanIp(TEST_IP);
  });

  it('GET /api/admin/ip-bans unauth → 401', async () => {
    const res = await request(app).get('/api/admin/ip-bans');
    expect(res.status).toBe(401);
  });

  it('GET /api/admin/ip-bans non-admin → 403', async () => {
    const res = await request(app)
      .get('/api/admin/ip-bans')
      .set('Authorization', `Bearer ${token(USER_ID)}`);
    expect(res.status).toBe(403);
  });

  it('GET /api/admin/ip-bans admin → 200', async () => {
    const res = await request(app)
      .get('/api/admin/ip-bans')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/admin/ip-bans invalid ip → 400', async () => {
    const res = await request(app)
      .post('/api/admin/ip-bans')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ ip: 'not-an-ip', reason: 'x', durationMs: null });
    expect(res.status).toBe(400);
  });

  it('POST /api/admin/ip-bans valid ip → ok true', async () => {
    const res = await request(app)
      .post('/api/admin/ip-bans')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ ip: TEST_IP, reason: 'spamming', durationMs: 60_000 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.ban).toHaveProperty('ip', TEST_IP);
  });

  it('DELETE /api/admin/ip-bans/:ip unban ok true', async () => {
    await request(app)
      .post('/api/admin/ip-bans')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ ip: TEST_IP, reason: 'spamming', durationMs: null });

    const res = await request(app)
      .delete(`/api/admin/ip-bans/${encodeURIComponent(TEST_IP)}`)
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

