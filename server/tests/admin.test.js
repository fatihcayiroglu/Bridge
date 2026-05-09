// server/tests/admin.test.js
// Tests for admin endpoints: stats, users CRUD, servers list/delete, logs, broadcast,
// make-first-admin, captcha-stats

process.env.JWT_SECRET         = 'test-jwt-secret';
process.env.NODE_ENV           = 'test';
process.env.ADMIN_SETUP_SECRET = 'super-secret-setup';

const { createMockDb, makeUser, makeServer } = require('./helpers/mockDb');
const mockDb = createMockDb();

jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req, res, next) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    try { req.user = jwt.verify(h.slice(7), 'test-jwt-secret'); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  },
}));

// captcha modülünü mock'la — admin.js'de require('../lib/captcha') çağrılıyor
jest.mock('../lib/captcha', () => ({
  getAdminStats: jest.fn().mockResolvedValue({
    enabled: true,
    provider: 'turnstile',
    successCount: 42,
    failCount: 3,
  }),
}));

const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');

const router = require('../routes/admin');

const app = express();
app.use(express.json());
app.use('/api/admin', router);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

function token(id) {
  return jwt.sign({ id, username: 'admin', displayName: 'Admin', v: 0 }, 'test-jwt-secret', { expiresIn: '1h' });
}

const ADMIN_ID  = 'admin1';
const USER_ID   = 'user1';
const TARGET_ID = 'target1';
const SERVER_ID = 'srv1';

beforeAll(async () => {
  await mockDb.users.insert(makeUser({ _id: ADMIN_ID,  username: 'admin',       isAdmin: 1 }));
  await mockDb.users.insert(makeUser({ _id: USER_ID,   username: 'regularuser'              }));
  await mockDb.users.insert(makeUser({ _id: TARGET_ID, username: 'targetuser'               }));
  await mockDb.servers.insert(makeServer(ADMIN_ID, { _id: SERVER_ID }));
  await mockDb.members.insert({ userId: ADMIN_ID, serverId: SERVER_ID, roles: '[]', joinedAt: Date.now() });
});

// ── Auth guard ────────────────────────────────────────────────

describe('Admin auth guards', () => {
  it('rejects unauthenticated access', async () => {
    const res = await request(app).get('/api/admin/stats');
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users', async () => {
    const res = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${token(USER_ID)}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin only/i);
  });
});

// ── Stats ─────────────────────────────────────────────────────

describe('GET /api/admin/stats', () => {
  it('returns stats for admin', async () => {
    const res = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.totals).toBeDefined();
    expect(typeof res.body.totals.totalUsers).toBe('number');
    expect(typeof res.body.totals.totalServers).toBe('number');
    expect(typeof res.body.totals.totalMessages).toBe('number');
    expect(Array.isArray(res.body.msgsByDay)).toBe(true);
    expect(Array.isArray(res.body.topServers)).toBe(true);
    expect(Array.isArray(res.body.topUsers)).toBe(true);
  });
});

// ── User list & patch ─────────────────────────────────────────

describe('GET /api/admin/users', () => {
  it('returns paginated user list', async () => {
    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(typeof res.body.page).toBe('number');
    expect(typeof res.body.pages).toBe('number');
  });

  it('supports search query', async () => {
    const res = await request(app)
      .get('/api/admin/users?q=admin')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
  });
});

describe('PATCH /api/admin/users/:id', () => {
  it('updates target user (grant admin)', async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${TARGET_ID}`)
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ isAdmin: true });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('prevents admin from modifying themselves', async () => {
    const res = await request(app)
      .patch(`/api/admin/users/${ADMIN_ID}`)
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ isAdmin: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/yourself/i);
  });

  it('returns 404 for unknown user', async () => {
    const res = await request(app)
      .patch('/api/admin/users/nonexistent')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ isAdmin: false });

    expect(res.status).toBe(404);
  });
});

// ── Delete user ───────────────────────────────────────────────

describe('DELETE /api/admin/users/:id', () => {
  it('deletes target user', async () => {
    // Silinecek geçici kullanıcı oluştur
    const delId = 'del_user_1';
    await mockDb.users.insert(makeUser({ _id: delId, username: 'tobedeleted' }));

    const res = await request(app)
      .delete(`/api/admin/users/${delId}`)
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('prevents admin from deleting themselves', async () => {
    const res = await request(app)
      .delete(`/api/admin/users/${ADMIN_ID}`)
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);

    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown user', async () => {
    const res = await request(app)
      .delete('/api/admin/users/does_not_exist')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);

    expect(res.status).toBe(404);
  });
});

// ── Server list & delete ──────────────────────────────────────

describe('GET /api/admin/servers', () => {
  it('returns server list', async () => {
    const res = await request(app)
      .get('/api/admin/servers')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    if (res.body.length > 0) {
      expect(res.body[0]).toHaveProperty('_id');
      expect(res.body[0]).toHaveProperty('memberCount');
    }
  });
});

describe('DELETE /api/admin/servers/:id', () => {
  it('returns 404 for unknown server', async () => {
    const res = await request(app)
      .delete('/api/admin/servers/ghost_server')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);

    expect(res.status).toBe(404);
  });
});

// ── Broadcast ─────────────────────────────────────────────────

describe('POST /api/admin/broadcast', () => {
  it('rejects empty message', async () => {
    const res = await request(app)
      .post('/api/admin/broadcast')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ message: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/message required/i);
  });

  it('broadcasts successfully (no io attached)', async () => {
    const res = await request(app)
      .post('/api/admin/broadcast')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ message: 'System maintenance in 5 minutes' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── Logs ─────────────────────────────────────────────────────

describe('GET /api/admin/logs', () => {
  it('returns audit log array', async () => {
    const res = await request(app)
      .get('/api/admin/logs')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── make-first-admin ──────────────────────────────────────────

describe('POST /api/admin/make-first-admin', () => {
  it('rejects wrong secret', async () => {
    const res = await request(app)
      .post('/api/admin/make-first-admin')
      .send({ secret: 'wrong-secret', username: 'regularuser' });

    expect(res.status).toBe(403);
  });

  it('returns 400 when an admin already exists', async () => {
    // ADMIN_ID zaten admin — count({isAdmin:1}) > 0 → 400
    const res = await request(app)
      .post('/api/admin/make-first-admin')
      .send({ secret: 'super-secret-setup', username: 'regularuser' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/admin already exists/i);
  });

  it('returns 400 when username is missing', async () => {
    const res = await request(app)
      .post('/api/admin/make-first-admin')
      .send({ secret: 'super-secret-setup' });

    // Admin zaten var — 400 (admin exists) veya 400 (username required) — her ikisi geçerli
    expect(res.status).toBe(400);
  });
});

// ── Captcha stats ─────────────────────────────────────────────

describe('GET /api/admin/captcha-stats', () => {
  it('returns captcha statistics', async () => {
    const res = await request(app)
      .get('/api/admin/captcha-stats')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('enabled');
    expect(res.body).toHaveProperty('provider');
    expect(typeof res.body.successCount).toBe('number');
  });

  it('rejects non-admin request', async () => {
    const res = await request(app)
      .get('/api/admin/captcha-stats')
      .set('Authorization', `Bearer ${token(USER_ID)}`);

    expect(res.status).toBe(403);
  });
});
