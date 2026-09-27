// server/tests/admin.test.ts
// Tests for admin endpoints: stats, users CRUD, servers list/delete, logs, broadcast,
// make-first-admin, captcha-stats

process.env.JWT_SECRET         = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV           = 'test';
process.env.ADMIN_SETUP_SECRET = 'super-secret-setup';

import { createMockDb, makeServer, makeUser, requireDoc } from './helpers/mockDb';
const mockDb = createMockDb();

jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (
    req: { headers: { authorization?: string }; user?: unknown },
    res: { status: (c: number) => { json: (b: unknown) => unknown } },
    next: () => void,
  ) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    try { req.user = jwt.verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!'); next(); }
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

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');

import router from '../routes/admin';
const { Users: UserRepo, Auth: AuthRepo } = require('../db/repositories');

// ── isAdmin GERCEK BOOLEAN'DIR ─────────────────────────────────────────────
// `users."isAdmin"` semada BOOLEAN'dir ve `pg` surucusu okurken HER ZAMAN
// gercek bir boolean dondurur; `1` olarak OKUNAMAZ. Mock artik PostgreSQL'e
// sadik (helpers/mockDb.ts: BOOLEAN_COLUMNS), bu yuzden iddialar da tamsayi
// yerine boolean olcer. Uretim yazma yollari da gercek boolean yaziyor
// (routes/admin/core.ts, routes/admin/users.ts).

const app = express();
app.use(express.json());
app.use('/api/admin', router);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

function token(id: string) {
  return jwt.sign({ id, username: 'admin', displayName: 'Admin', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

const ADMIN_ID  = 'admin1';
const USER_ID   = 'user1';
const TARGET_ID = 'target1';
const SERVER_ID = 'srv1';

beforeAll(async () => {
  await mockDb.users.insert(makeUser({ _id: ADMIN_ID,  username: 'admin',       isAdmin: true }));
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
  it('fails CLOSED without PostgreSQL instead of a partial, policy-less deletion', async () => {
    // Final21 Faz 19: yönetici silmesi artık kanonik hesap silme politikasını uygular
    // (lib/accountDeletion.ts) ve kişinin kendi silmesi gibi PostgreSQL ister. Bellek-içi
    // adaptörde eskisi gibi yarım bir silme (yalnız mesaj + üyelik + users) YAPILMAZ.
    // Başarılı yol gerçek veritabanında: tests/pg-integration/account-erasure.pgtest.ts.
    const delId = 'del_user_1';
    await mockDb.users.insert(makeUser({ _id: delId, username: 'tobedeleted' }));

    const res = await request(app)
      .delete(`/api/admin/users/${delId}`)
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);

    expect(res.status).toBe(503);
    expect(await mockDb.users.findOne({ _id: delId })).not.toBeNull();
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

// ── Deep branch / strict input regression coverage ──────────────────────────
describe('Admin core strict contracts and destructive lifecycle', () => {
  it('rejects malformed/negative user-list pagination before it reaches LIMIT/OFFSET', async () => {
    for (const query of ['page=-10&limit=-5', 'page=1.5&limit=10oops', 'page=1&limit=0']) {
      const res = await request(app).get(`/api/admin/users?${query}`)
        .set('Authorization', `Bearer ${token(ADMIN_ID)}`);
      expect(res.status).toBe(400);
    }
  });

  it('rejects non-boolean isAdmin instead of silently accepting a malformed mutation', async () => {
    const res = await request(app).patch(`/api/admin/users/${TARGET_ID}`)
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`).send({ isAdmin: 'true' });
    expect(res.status).toBe(400);
  });

  it('broadcast rejects non-string and overlong messages without throwing', async () => {
    expect((await request(app).post('/api/admin/broadcast').set('Authorization', `Bearer ${token(ADMIN_ID)}`).send({ message: { x: 1 } })).status).toBe(400);
    expect((await request(app).post('/api/admin/broadcast').set('Authorization', `Bearer ${token(ADMIN_ID)}`).send({ message: 'x'.repeat(501) })).status).toBe(400);
  });

  it('broadcast emits canonical trimmed payload when Socket.IO is attached', async () => {
    const io = { emit: jest.fn() };
    const local = express(); local.use(express.json()); local.set('io', io); local.use('/api/admin', router);
    const res = await request(local).post('/api/admin/broadcast').set('Authorization', `Bearer ${token(ADMIN_ID)}`).send({ message: '  hello  ' });
    expect(res.status).toBe(200);
    expect(io.emit).toHaveBeenCalledWith('system_announcement', expect.objectContaining({ message: 'hello' }));
  });

  it('deletes a server graph through the canonical admin endpoint', async () => {
    const sid = 'admin-delete-srv';
    await mockDb.servers.insert(makeServer(ADMIN_ID, { _id: sid, name: 'Delete Me' }));
    await mockDb.channels.insert({ _id:'del-ch', serverId:sid, name:'x', type:'text', createdAt:Date.now() });
    await mockDb.members.insert({ userId:USER_ID, serverId:sid, roles:'[]', joinedAt:Date.now() });
    await mockDb.roles.insert({ _id:'del-role', serverId:sid, name:'r', permissions:0 });
    await mockDb.messages.insert({ _id:'del-msg', serverId:sid, channelId:'del-ch', userId:USER_ID, content:'x', createdAt:Date.now() });
    const res = await request(app).delete(`/api/admin/servers/${sid}`).set('Authorization', `Bearer ${token(ADMIN_ID)}`);
    expect(res.status).toBe(200);
    expect(await mockDb.servers.findOne({ _id:sid })).toBeNull();
    expect(await mockDb.channels.find({ serverId:sid })).toHaveLength(0);
    expect(await mockDb.members.find({ serverId:sid })).toHaveLength(0);
    expect(await mockDb.roles.find({ serverId:sid })).toHaveLength(0);
  });

  it('admin logs obey bounded limit and enrich actor identities', async () => {
    await mockDb.adminLogs.insert({ _id:'deep-log-known', adminId:ADMIN_ID, action:'x', timestamp:Date.now() });
    await mockDb.adminLogs.insert({ _id:'deep-log-unknown', adminId:'gone-admin', action:'y', timestamp:Date.now() });
    const res = await request(app).get('/api/admin/logs?limit=2').set('Authorization', `Bearer ${token(ADMIN_ID)}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(2);
    for (const row of res.body) expect(typeof row.adminUsername).toBe('string');
  });

  it('stats aggregate non-empty message/server/member data', async () => {
    const now = Date.now();
    await mockDb.messages.insert({ _id:'stats-1', serverId:SERVER_ID, channelId:'c', userId:ADMIN_ID, displayName:'Admin', content:'a', createdAt:now });
    await mockDb.messages.insert({ _id:'stats-2', serverId:SERVER_ID, channelId:'c', userId:ADMIN_ID, displayName:'Admin', content:'b', createdAt:now });
    const res = await request(app).get('/api/admin/stats').set('Authorization', `Bearer ${token(ADMIN_ID)}`);
    expect(res.status).toBe(200);
    expect(res.body.msgsByDay.length).toBeGreaterThan(0);
    expect(res.body.topUsers.some((u: Record<string, unknown>) => u.userId === ADMIN_ID)).toBe(true);
    expect(res.body.topServers.some((s: Record<string, unknown>) => s._id === SERVER_ID)).toBe(true);
  });
});

// ── Core edge branches: bootstrap/log enrichment/stats ordering ────────────
describe('admin core edge contracts', () => {
  it('make-first-admin rejects malformed username before repository lookup when no admin exists', async () => {
    const countSpy = jest.spyOn(UserRepo, 'count').mockResolvedValueOnce(0);
    try {
      const res = await request(app).post('/api/admin/make-first-admin')
        .send({ secret: 'super-secret-setup', username: { bad: true } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/username required/i);
    } finally {
      countSpy.mockRestore();
    }
  });

  it('make-first-admin returns 404 for a missing username when no admin exists', async () => {
    const countSpy = jest.spyOn(UserRepo, 'count').mockResolvedValueOnce(0);
    const findSpy = jest.spyOn(UserRepo, 'findByUsername').mockResolvedValueOnce(null);
    try {
      const res = await request(app).post('/api/admin/make-first-admin')
        .send({ secret: 'super-secret-setup', username: 'does-not-exist-bootstrap' });
      expect(res.status).toBe(404);
    } finally {
      countSpy.mockRestore();
      findSpy.mockRestore();
    }
  });

  it('make-first-admin promotes an existing user exactly once when bootstrap is open', async () => {
    const candidate = makeUser({ _id: 'bootstrap-user', username: 'bootstrap-user', isAdmin: false });
    const countSpy = jest.spyOn(UserRepo, 'count').mockResolvedValueOnce(0);
    const findSpy = jest.spyOn(UserRepo, 'findByUsername').mockResolvedValueOnce(candidate);
    const updateSpy = jest.spyOn(UserRepo, 'update').mockResolvedValueOnce(undefined);
    try {
      const res = await request(app).post('/api/admin/make-first-admin')
        .send({ secret: 'super-secret-setup', username: '  bootstrap-user  ' });
      expect(res.status).toBe(200);
      expect(updateSpy).toHaveBeenCalledWith('bootstrap-user', { isAdmin: true });
    } finally {
      countSpy.mockRestore();
      findSpy.mockRestore();
      updateSpy.mockRestore();
    }
  });

  it('logs handle empty and malformed actor ids without leaking undefined names', async () => {
    await mockDb.adminLogs.insert({ _id:'edge-log-empty', adminId:'', action:'x', timestamp:Date.now() });
    await mockDb.adminLogs.insert({ _id:'edge-log-null', adminId:null, action:'x', timestamp:Date.now() });
    const res = await request(app).get('/api/admin/logs?limit=200')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);
    expect(res.status).toBe(200);
    const empty = res.body.find((x: Record<string, unknown>) => x._id === 'edge-log-empty');
    const nil = res.body.find((x: Record<string, unknown>) => x._id === 'edge-log-null');
    if (empty) expect(empty.adminUsername).toBe('unknown');
    if (nil) expect(nil.adminUsername).toBe('unknown');
  });

  it('stats orders multiple server/member and user activity candidates deterministically', async () => {
    const now = Date.now();
    const sid2 = 'stats-srv-2';
    await mockDb.servers.insert(makeServer(ADMIN_ID, { _id: sid2, name: 'Stats Two' }));
    await mockDb.members.insert({ userId: USER_ID, serverId: sid2, roles:'[]', joinedAt:now });
    await mockDb.members.insert({ userId: TARGET_ID, serverId: sid2, roles:'[]', joinedAt:now });
    await mockDb.messages.insert({ _id:'stats-edge-u1', serverId:sid2, channelId:'edge-c', userId:USER_ID, displayName:'User One', content:'x', createdAt:now - 86400000 });
    await mockDb.messages.insert({ _id:'stats-edge-u2a', serverId:sid2, channelId:'edge-c', userId:TARGET_ID, displayName:'Target', content:'x', createdAt:now });
    await mockDb.messages.insert({ _id:'stats-edge-u2b', serverId:sid2, channelId:'edge-c', userId:TARGET_ID, displayName:'Target', content:'x', createdAt:now });
    const res = await request(app).get('/api/admin/stats').set('Authorization', `Bearer ${token(ADMIN_ID)}`);
    expect(res.status).toBe(200);
    expect(res.body.msgsByDay.length).toBeGreaterThanOrEqual(1);
    const s2 = res.body.topServers.find((x: Record<string, unknown>) => x._id === sid2);
    expect(s2?.memberCount).toBeGreaterThanOrEqual(2);
    expect(res.body.topUsers.find((x: Record<string, unknown>) => x.userId === TARGET_ID)?.msgCount).toBeGreaterThanOrEqual(2);
  });
});

describe('admin core remaining fallback branches', () => {
  it('broadcast succeeds without Socket.IO and logs the trimmed message', async () => {
    const local = express(); local.use(express.json()); local.use('/api/admin', router);
    const res = await request(local).post('/api/admin/broadcast')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ message: '  no socket  ' });
    expect(res.status).toBe(200);
    const logs = await mockDb.adminLogs.find({ action: 'broadcast' });
    expect(logs.some((l) => l.detail === JSON.stringify({ message: 'no socket' }))).toBe(true);
  });

  it('broadcast falls back from displayName to username and then admin label', async () => {
    const io = { emit: jest.fn() };
    const local = express(); local.use(express.json()); local.set('io', io); local.use('/api/admin', router);

    const findSpy = jest.spyOn(UserRepo, 'findById');
    findSpy.mockResolvedValueOnce(makeUser({ _id: ADMIN_ID, username: 'admin-user', displayName: '', isAdmin: true }));
    let res = await request(local).post('/api/admin/broadcast')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`).send({ message: 'first' });
    expect(res.status).toBe(200);
    expect(io.emit).toHaveBeenLastCalledWith('system_announcement', expect.objectContaining({ from: 'admin-user' }));

    findSpy.mockResolvedValueOnce(makeUser({ _id: ADMIN_ID, username: '', displayName: '', isAdmin: true }));
    res = await request(local).post('/api/admin/broadcast')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`).send({ message: 'second' });
    expect(res.status).toBe(200);
    expect(io.emit).toHaveBeenLastCalledWith('system_announcement', expect.objectContaining({ from: 'admin' }));
    findSpy.mockRestore();
  });

  it('rejects malformed log limits instead of silently widening the query', async () => {
    const logsSpy = jest.spyOn(AuthRepo, 'findAdminLogs');
    try {
      const res = await request(app).get('/api/admin/logs?limit=not-a-number')
        .set('Authorization', `Bearer ${token(ADMIN_ID)}`);
      expect(res.status).toBe(400);
      expect(logsSpy).not.toHaveBeenCalled();
    } finally {
      logsSpy.mockRestore();
    }
  });
});
