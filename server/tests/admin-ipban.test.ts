// server/tests/admin-ipban.test.ts
import type { JwtPayload } from '../middleware/auth';
import type { Express, Request } from 'express';
process.env.JWT_SECRET         = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV           = 'test';
process.env.ADMIN_SETUP_SECRET = 'super-secret-setup';

jest.mock('../db/index', () => require('./helpers/mockDb').createMockDb());

jest.mock('../lib/captcha', () => ({
  getAdminStats: jest.fn().mockResolvedValue({
    enabled: true, provider: 'turnstile', successCount: 42, failCount: 3,
  }),
}));

jest.mock('express-rate-limit', () => () => (_req: unknown, _res: unknown, next: () => void) => next());

import { createMockDb, makeUser, makeServer } from './helpers/mockDb';
const mockDb = createMockDb();

jest.mock('../db/loader', () => mockDb);

jest.mock('../middleware/auth', () => ({
  authMiddleware: (
    req: { headers: { authorization?: string }; user?: unknown },
    res: { status: (c: number) => { json: (b: unknown) => unknown } },
    next: () => void,
  ) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    try {
      req.user = jwt.verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!');
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  },
  castAuthed: (req: Request) => ({ user: req.user }),
}));

// Stub rate-limit middleware used by the IP ban routes
jest.mock('../middleware/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  limits: new Proxy({}, {
    get: () => () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

// ipBan middleware — in-memory store for tests
let ipBanStore: Record<string, unknown> = {};
jest.mock('../middleware/ipBan', () => ({
  banIp: jest.fn(async (ip, opts = {}) => {
    const entry = {
      ip,
      reason:    opts.reason    ?? 'Admin ban',
      bannedAt:  Date.now(),
      expiresAt: opts.durationMs ? Date.now() + opts.durationMs : null,
      adminId:   opts.adminId   ?? null,
    };
    ipBanStore[ip] = entry;
    return entry;
  }),
  unbanIp: jest.fn(async (ip) => { delete ipBanStore[ip]; }),
  listBans: jest.fn(async () => Object.values(ipBanStore)),
  getClientIp: jest.fn((req) => req.headers['x-forwarded-for'] ?? '127.0.0.1'),
}));

const request    = require('supertest');
const express    = require('express');
const jwt        = require('jsonwebtoken');
import adminRouter from '../routes/admin';
import { unbanIp, banIp } from '../middleware/ipBan';

function token(id: string, extra = {}) {
  return jwt.sign(
    { id, username: 'u', displayName: 'U', v: 0, ...extra },
    'test-jwt-secret-long-enough-32chars!!',
    { expiresIn: '1h' },
  );
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

describe('Admin IP bans', () => {
  const ADMIN_ID = 'admin1';
  const USER_ID  = 'user1';
  const TEST_IP  = '1.2.3.4';
  let app: Express;

  beforeAll(async () => {
    mockDb._reset?.();
    await mockDb.users.insert(makeUser({ _id: ADMIN_ID, username: 'admin', isAdmin: 1 }));
    await mockDb.users.insert(makeUser({ _id: USER_ID,  username: 'regularuser' }));
    await mockDb.servers.insert(makeServer(ADMIN_ID, { _id: 'srv1' }));
  });

  beforeEach(() => {
    app = makeApp();
    ipBanStore = {};
    jest.clearAllMocks();
    // Re-wire mock implementations after clearAllMocks
    const { banIp: b, unbanIp: u, listBans: l } = require('../middleware/ipBan');
    // `opts = {}` varsayilani tipi `{}` yapiyordu; alanlar ACIKCA yazilir.
    interface BanOptions { reason?: string; durationMs?: number; adminId?: string | null }
    b.mockImplementation(async (ip: string, opts: BanOptions = {}) => {
      const entry = {
        ip, reason: opts.reason ?? 'Admin ban',
        bannedAt: Date.now(),
        expiresAt: opts.durationMs ? Date.now() + opts.durationMs : null,
        adminId: opts.adminId ?? null,
      };
      ipBanStore[ip] = entry;
      return entry;
    });
    u.mockImplementation(async (ip: string) => { delete ipBanStore[ip]; });
    l.mockImplementation(async () => Object.values(ipBanStore));
  });

  afterEach(async () => {
    await unbanIp(TEST_IP);
  });

  // ── Auth & authz ────────────────────────────────────────────────

  it('GET /ip-bans — unauthenticated → 401', async () => {
    const res = await request(app).get('/api/admin/ip-bans');
    expect(res.status).toBe(401);
  });

  it('GET /ip-bans — non-admin → 403', async () => {
    const res = await request(app)
      .get('/api/admin/ip-bans')
      .set('Authorization', `Bearer ${token(USER_ID)}`);
    expect(res.status).toBe(403);
  });

  it('POST /ip-bans — unauthenticated → 401', async () => {
    const res = await request(app)
      .post('/api/admin/ip-bans')
      .send({ ip: TEST_IP });
    expect(res.status).toBe(401);
  });

  it('DELETE /ip-bans/:ip — unauthenticated → 401', async () => {
    const res = await request(app).delete(`/api/admin/ip-bans/${TEST_IP}`);
    expect(res.status).toBe(401);
  });

  // ── GET /ip-bans ────────────────────────────────────────────────

  it('GET /ip-bans — admin, empty list → 200 []', async () => {
    const res = await request(app)
      .get('/api/admin/ip-bans')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it('GET /ip-bans — returns bans sorted by bannedAt desc', async () => {
    const now = Date.now();
    ipBanStore['1.1.1.1'] = { ip: '1.1.1.1', bannedAt: now - 2000, expiresAt: null, reason: 'old' };
    ipBanStore['2.2.2.2'] = { ip: '2.2.2.2', bannedAt: now - 1000, expiresAt: null, reason: 'newer' };
    ipBanStore['3.3.3.3'] = { ip: '3.3.3.3', bannedAt: now,        expiresAt: null, reason: 'newest' };

    const res = await request(app)
      .get('/api/admin/ip-bans')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body[0].ip).toBe('3.3.3.3');
    expect(res.body[1].ip).toBe('2.2.2.2');
    expect(res.body[2].ip).toBe('1.1.1.1');
  });

  // ── POST /ip-bans ───────────────────────────────────────────────

  it('POST /ip-bans — missing ip → 400', async () => {
    const res = await request(app)
      .post('/api/admin/ip-bans')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ reason: 'test' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ip/i);
  });

  it('POST /ip-bans — blank ip → 400', async () => {
    const res = await request(app)
      .post('/api/admin/ip-bans')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ ip: '   ' });
    expect(res.status).toBe(400);
  });

  it('POST /ip-bans — invalid ip format → 400', async () => {
    const res = await request(app)
      .post('/api/admin/ip-bans')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ ip: 'not-an-ip', reason: 'test' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/geçersiz/i);
  });

  it('POST /ip-bans — invalid duration is rejected instead of silently becoming a permanent ban', async () => {
    for (const durationMs of ['banana', '123oops', -1, 1.5]) {
      const res = await request(app)
        .post('/api/admin/ip-bans')
        .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
        .send({ ip: TEST_IP, durationMs });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/duration/i);
    }
  });

  it('POST /ip-bans — rejects structurally invalid IPv4/IPv6 values that regexes used to accept', async () => {
    for (const ip of ['999.999.999.999', '256.1.1.1', '::::', 'abcd:']) {
      const res = await request(app)
        .post('/api/admin/ip-bans')
        .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
        .send({ ip });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/geçersiz/i);
    }
  });

  it('POST /ip-bans — admin banning their own IP → 400', async () => {
    const res = await request(app)
      .post('/api/admin/ip-bans')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .set('X-Forwarded-For', '127.0.0.1')   // getClientIp reads this header
      .send({ ip: '127.0.0.1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kendi/i);
  });

  it('POST /ip-bans — valid IPv4, permanent ban', async () => {
    const res = await request(app)
      .post('/api/admin/ip-bans')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ ip: TEST_IP, reason: 'spamming', durationMs: null });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.ban).toMatchObject({ ip: TEST_IP, expiresAt: null });
  });

  it('POST /ip-bans — valid IPv4, temporary ban with durationMs', async () => {
    const res = await request(app)
      .post('/api/admin/ip-bans')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ ip: TEST_IP, reason: 'temp', durationMs: 3_600_000 });
    expect(res.status).toBe(200);
    expect(res.body.ban.expiresAt).toBeGreaterThan(Date.now());
  });

  it('POST /ip-bans — valid IPv6 address', async () => {
    const ipv6 = '2001:db8::1';
    const res = await request(app)
      .post('/api/admin/ip-bans')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ ip: ipv6, reason: 'ipv6 test' });
    expect(res.status).toBe(200);
    expect(res.body.ban.ip).toBe(ipv6);
  });

  it('POST /ip-bans — reason defaults to "Admin ban" when omitted', async () => {
    const res = await request(app)
      .post('/api/admin/ip-bans')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ ip: TEST_IP });
    expect(res.status).toBe(200);
    expect(res.body.ban.reason).toBe('Admin ban');
  });

  it('POST /ip-bans — reason is trimmed and capped at 200 chars', async () => {
    const longReason = 'x'.repeat(250);
    const res = await request(app)
      .post('/api/admin/ip-bans')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ ip: TEST_IP, reason: longReason });
    expect(res.status).toBe(200);
    expect(banIp).toHaveBeenCalledWith(
      TEST_IP,
      expect.objectContaining({ reason: expect.stringMatching(/^x{200}$/) }),
    );
  });

  it('POST /ip-bans — calls banIp with adminId from JWT', async () => {
    await request(app)
      .post('/api/admin/ip-bans')
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`)
      .send({ ip: TEST_IP });
    expect(banIp).toHaveBeenCalledWith(
      TEST_IP,
      expect.objectContaining({ adminId: ADMIN_ID }),
    );
  });

  // ── DELETE /ip-bans/:ip ─────────────────────────────────────────

  it('DELETE /ip-bans/:ip — bans then unbans successfully', async () => {
    ipBanStore[TEST_IP] = { ip: TEST_IP, bannedAt: Date.now(), expiresAt: null, reason: 'x' };

    const res = await request(app)
      .delete(`/api/admin/ip-bans/${encodeURIComponent(TEST_IP)}`)
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(unbanIp).toHaveBeenCalledWith(TEST_IP);
  });

  it('DELETE /ip-bans/:ip — non-existent IP → still 200 (graceful)', async () => {
    const res = await request(app)
      .delete(`/api/admin/ip-bans/${encodeURIComponent('9.9.9.9')}`)
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);
    // unbanIp is a no-op for unknown IPs — endpoint is idempotent
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('DELETE /ip-bans/:ip — URL-encoded IPv6 decoded correctly', async () => {
    const ipv6 = '2001:db8::1';
    ipBanStore[ipv6] = { ip: ipv6, bannedAt: Date.now(), expiresAt: null, reason: 'x' };

    const res = await request(app)
      .delete(`/api/admin/ip-bans/${encodeURIComponent(ipv6)}`)
      .set('Authorization', `Bearer ${token(ADMIN_ID)}`);

    expect(res.status).toBe(200);
    expect(unbanIp).toHaveBeenCalledWith(ipv6);
  });
});
