// server/tests/chunk-upload-abuse-boundary.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// PARÇALI YÜKLEME (/api/upload/chunk) KAYNAK TÜKETME SINIRI
// ════════════════════════════════════════════════════════════════════════════
// ÖLÇÜLEN AÇIK (main @ 8508a5c, bu dosya o ağaçta KIRMIZI koşturuldu):
//
//   · `POST /upload` ve `POST /upload/server-gif` `limits.upload()` ile
//     korunuyordu; `POST /upload/chunk` yalnızca `authMiddleware` ile
//     bağlanmıştı. Tek sınır küresel `/api` bütçesiydi (200 istek/dk).
//     200 × 10 MB = kullanıcı başına dakikada ~2 GB diske yazım.
//   · Kullanıcı başına eşzamanlı oturum sınırı YOKTU: her yeni `x-upload-id`
//     yeni bir `_chunks/<sha256>` dizini açıyordu.
//   · Boost/küresel dosya sınırı yalnızca SON parça birleştirilirken
//     denetleniyordu. Son parçayı hiç göndermeyen bir istemci, 25 MB sınırlı
//     bir hesapla bile oturum başına 2 GB'a kadar parça biriktirebiliyordu.
//   · Kullanıcı başına toplam geçici bayt sınırı YOKTU.
//   · `_chunks/` hiçbir temizlik işinin kapsamında değildi (bkz.
//     jobs/cleanupUploads.ts `isReapable`): terk edilmiş oturumlar disk
//     dolana kadar kalıyordu.
//   · `Content-Length` zorunlu değildi; bildirilen boyut 10 MB'ı aşsa bile
//     oturum dizini ve manifest, gövde okunmadan ÖNCE diske yazılıyordu.
//
// Bu dosya rotayı GERÇEK rateLimit + GERÇEK kota (tek-node yerel arka uç) +
// GERÇEK chunkUploadSafety ile, kara kutu olarak HTTP üzerinden sınar.
// Dağıtık (Redis) arka uç ayrıca tests/pg-integration/chunk-upload-quota-
// redis.pgtest.ts içinde GERÇEK Redis'e karşı kanıtlanır.

import os from 'os';
import path from 'path';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import request from 'supertest';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-chunk-abuse-'));
process.env.NODE_ENV = 'test';
process.env.BRIDGE_UPLOAD_ROOT = ROOT;
process.env.MAX_FILE_SIZE_MB = '2048';
delete process.env.WEBP_CONVERT;
delete process.env.REDIS_URL;

const MB = 1024 * 1024;

const mockGetHighestActiveTier = jest.fn().mockResolvedValue(0);
const mockUploadFile = jest.fn(async (_p: string, key: string) => ({ url: `/public/${key}`, key: null, provider: 'local' }));
const mockLuaEvalAuthoritative = jest.fn();
const mockRedisAuthoritativeCommand = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const value = String(req.headers.authorization || '');
    if (!value.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    req.user = { id: value.slice(7), username: `user-${value.slice(7)}` };
    next();
  },
}));
jest.mock('../lib/adminAuthority', () => ({
  isDatabaseAdmin: jest.fn(async () => false),
  databaseAdminOnly: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../lib/contentScanner', () => ({ scanFile: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../lib/svgSanitizer', () => ({ sanitizeSvgFile: jest.fn().mockResolvedValue({ safe: true }) }));
jest.mock('../lib/uploadFileSafety', () => ({
  canonicalExtensionForMime: () => '.txt',
  checkMagicBytes: () => true,
}));
jest.mock('../lib/storageAdapter', () => ({
  getStorageAdapter: () => ({ uploadFile: mockUploadFile, deleteFile: jest.fn() }),
  getPrivateStorageAdapter: () => ({ uploadFile: mockUploadFile, deleteFile: jest.fn() }),
  getProvider: () => 'local',
  getPrivateStorageProvider: () => 'local',
}));
jest.mock('../db/postgres', () => ({ db: { _pool: { query: jest.fn(async () => ({ rows: [] })) } } }));
jest.mock('../db/repositories', () => ({
  Boosts: { getHighestActiveTierForUser: (...args: unknown[]) => mockGetHighestActiveTier(...args) },
}));
jest.mock('../db/loader', () => ({
  __esModule: true,
  default: { uploads: { insert: jest.fn().mockResolvedValue({}), findOne: jest.fn(), remove: jest.fn() } },
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: (...a: unknown[]) => mockLoggerWarn(...a), error: jest.fn(), debug: jest.fn(), fatal: jest.fn() },
}));

type Env = Record<string, string | undefined>;

/**
 * Loads the upload router in an isolated module registry with the given env,
 * so every scenario gets its own limiter/quota state and configuration.
 */
function loadApp(env: Env = {}, opts: { redisDown?: 'quota' | 'limiter'; quota?: Record<string, unknown>; declaredLength?: number } = {}) {
  const saved: Env = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  let router: express.Router;
  // `jest.doMock` is registry-wide, not scoped to `isolateModules`: every
  // per-scenario override must be cleared or it leaks into later scenarios.
  for (const mod of ['../lib/redisAdapter', '../lib/chunkUploadQuota', '../lib/chunkUploadSafety']) jest.dontMock(mod);
  try {
    jest.isolateModules(() => {
      if (opts.redisDown) {
        // Redis is the configured authority (REDIS_URL set) but the command
        // path fails. Only the selected layer fails so each boundary is
        // proven to fail CLOSED on its own.
        jest.doMock('../lib/redisAdapter', () => {
          const actual = jest.requireActual('../lib/redisAdapter');
          return {
            ...actual,
            isRedisAvailable: () => true,
            redisAuthoritativeCommand: (...args: unknown[]) => mockRedisAuthoritativeCommand(...args),
            cache: { ...actual.cache, luaEvalAuthoritative: (...args: unknown[]) => mockLuaEvalAuthoritative(...args) },
          };
        });
      }
      if (opts.quota) jest.doMock('../lib/chunkUploadQuota', () => opts.quota);
      if (opts.declaredLength !== undefined) {
        const declared = opts.declaredLength;
        jest.doMock('../lib/chunkUploadSafety', () => ({
          ...jest.requireActual('../lib/chunkUploadSafety'),
          parseChunkContentLength: () => declared,
        }));
      }
      router = require('../routes/upload').default;
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  const app = express();
  app.use('/api/upload', router!);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

function chunk(app: express.Express, user: string, uploadId: string, index: number, total: number, body: Buffer) {
  return request(app)
    .post('/api/upload/chunk')
    .set('Authorization', `Bearer ${user}`)
    .set('Content-Type', 'application/octet-stream')
    .set('x-upload-id', uploadId)
    .set('x-chunk-index', String(index))
    .set('x-total-chunks', String(total))
    .set('x-file-name', 'file.txt')
    .set('x-file-type', 'text/plain')
    .send(body);
}

function sessionDir(user: string, uploadId: string): string {
  const { chunkSessionKey } = jest.requireActual('../lib/chunkUploadSafety') as typeof import('../lib/chunkUploadSafety');
  return path.join(ROOT, '_chunks', chunkSessionKey(user, uploadId));
}

function bytesOnDisk(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir)
    .filter(name => name.startsWith('chunk_'))
    .reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
}

const bytes = (n: number, fill = 7) => Buffer.alloc(n, fill);

beforeEach(() => {
  mockGetHighestActiveTier.mockReset();
  mockGetHighestActiveTier.mockResolvedValue(0);
  mockLuaEvalAuthoritative.mockReset();
  mockRedisAuthoritativeCommand.mockReset();
  mockLoggerWarn.mockReset();
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('route-specific, user-scoped chunk limiter', () => {
  it('throttles one account on /upload/chunk without touching another account', async () => {
    const app = loadApp({ RL_UPLOAD_CHUNK_MAX: '3' });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await chunk(app, 'rl-a', 'rl-session', i, 10, bytes(16))).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);

    const other = await chunk(app, 'rl-b', 'rl-session', 0, 10, bytes(16));
    expect(other.status).toBe(200);
  });

  it('the default chunk budget is user-scoped and matches the operator limits report', async () => {
    const app = loadApp({ RL_UPLOAD_CHUNK_MAX: undefined });
    const res = await chunk(app, 'rl-default', 'rl-session', 0, 10, bytes(16));
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-policy']).toBe('120;w=60;mode=user;keys=1');
    const { collectLimits } = jest.requireActual('../lib/limitsReport') as typeof import('../lib/limitsReport');
    expect(collectLimits().find(r => r.env === 'RL_UPLOAD_CHUNK_MAX')?.fallback).toBe(120);
  });

  it('a throttled request writes nothing to disk', async () => {
    const app = loadApp({ RL_UPLOAD_CHUNK_MAX: '1' });
    expect((await chunk(app, 'rl-c', 'first', 0, 2, bytes(16))).status).toBe(200);
    const res = await chunk(app, 'rl-c', 'second', 0, 2, bytes(16));
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(fs.existsSync(sessionDir('rl-c', 'second'))).toBe(false);
  });
});

describe('maximum concurrent chunk sessions per user', () => {
  it('rejects a new upload id past the cap before creating any session state', async () => {
    const app = loadApp({ CHUNK_UPLOAD_MAX_SESSIONS: '2' });
    expect((await chunk(app, 'sess', 's1', 0, 2, bytes(8))).status).toBe(200);
    expect((await chunk(app, 'sess', 's2', 0, 2, bytes(8))).status).toBe(200);

    const third = await chunk(app, 'sess', 's3', 0, 2, bytes(8));
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('CHUNK_SESSION_LIMIT');
    expect(fs.existsSync(sessionDir('sess', 's3'))).toBe(false);

    // Existing sessions stay resumable at the cap (duplicate retry + progress).
    const retry = await chunk(app, 'sess', 's2', 0, 2, bytes(8));
    expect(retry.status).toBe(200);
    expect(retry.body.duplicate).toBe(true);

    // Another account is not affected by this account's sessions.
    expect((await chunk(app, 'sess-other', 's3', 0, 2, bytes(8))).status).toBe(200);

    // Finalizing a session releases its slot.
    const done = await chunk(app, 'sess', 's1', 1, 2, bytes(8));
    expect(done.status).toBe(200);
    expect(done.body.done).toBe(true);
    expect((await chunk(app, 'sess', 's3', 0, 2, bytes(8))).status).toBe(200);
  });

  it('many abandoned upload ids cannot accumulate session directories', async () => {
    const app = loadApp({ CHUNK_UPLOAD_MAX_SESSIONS: '3' });
    const results = [];
    for (let i = 0; i < 12; i++) results.push((await chunk(app, 'flood', `flood-${i}`, 0, 5, bytes(4))).status);
    expect(results.filter(s => s === 200)).toHaveLength(3);
    expect(results.filter(s => s === 429)).toHaveLength(9);
    const dirs = Array.from({ length: 12 }, (_, i) => sessionDir('flood', `flood-${i}`)).filter(d => fs.existsSync(d));
    expect(dirs).toHaveLength(3);
  });
});

describe('per-session bytes are bounded by the live upload entitlement', () => {
  it('rejects the chunk that would exceed the boost limit instead of storing it until finalization', async () => {
    mockGetHighestActiveTier.mockResolvedValue(0); // 25 MB
    const app = loadApp();
    const dir = sessionDir('cap', 'big');
    expect((await chunk(app, 'cap', 'big', 0, 4, bytes(10 * MB))).status).toBe(200);
    expect((await chunk(app, 'cap', 'big', 1, 4, bytes(10 * MB))).status).toBe(200);

    const over = await chunk(app, 'cap', 'big', 2, 4, bytes(10 * MB));
    expect(over.status).toBe(413);
    expect(over.body.code).toBe('BOOST_LIMIT');
    // Terminal: the session can never finalize within the entitlement, so its
    // committed bytes are purged immediately (same as the finalization path).
    expect(bytesOnDisk(dir)).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('negative control: a file exactly at the entitlement still uploads out of order', async () => {
    mockGetHighestActiveTier.mockResolvedValue(0); // 25 MB
    const app = loadApp();
    expect((await chunk(app, 'cap-ok', 'exact', 2, 3, bytes(5 * MB, 3))).status).toBe(200);
    expect((await chunk(app, 'cap-ok', 'exact', 0, 3, bytes(10 * MB, 1))).status).toBe(200);
    // Duplicate retry of an already committed chunk near the cap is idempotent,
    // not a quota violation.
    const retry = await chunk(app, 'cap-ok', 'exact', 0, 3, bytes(10 * MB, 1));
    expect(retry.status).toBe(200);
    expect(retry.body.duplicate).toBe(true);
    const done = await chunk(app, 'cap-ok', 'exact', 1, 3, bytes(10 * MB, 2));
    expect(done.status).toBe(200);
    expect(done.body.done).toBe(true);
    expect(done.body.size).toBe(25 * MB);
  });
});

describe('total temporary bytes per user', () => {
  it('rejects bytes past the per-user temp quota across sessions, without writing', async () => {
    mockGetHighestActiveTier.mockResolvedValue(3); // 100 MB per file
    const app = loadApp({ CHUNK_UPLOAD_MAX_TEMP_MB: '12' });
    expect((await chunk(app, 'quota', 'qa', 0, 3, bytes(5 * MB))).status).toBe(200);
    expect((await chunk(app, 'quota', 'qa', 1, 3, bytes(5 * MB))).status).toBe(200);

    const over = await chunk(app, 'quota', 'qb', 0, 2, bytes(5 * MB));
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('CHUNK_QUOTA_EXCEEDED');
    expect(fs.existsSync(sessionDir('quota', 'qb'))).toBe(false);

    // Quota is per authenticated user.
    expect((await chunk(app, 'quota-other', 'qb', 0, 2, bytes(5 * MB))).status).toBe(200);
  });
});

describe('Content-Length is mandatory and checked before any disk state', () => {
  function rawChunk(app: express.Express, headers: Record<string, string>, body: Buffer): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        const req = http.request({ port, method: 'POST', path: '/api/upload/chunk', headers }, res => {
          res.resume();
          res.on('end', () => server.close(() => resolve(res.statusCode ?? 0)));
        });
        req.on('error', err => server.close(() => reject(err)));
        req.write(body);
        req.end();
      });
    });
  }

  const base = (user: string, id: string) => ({
    Authorization: `Bearer ${user}`,
    'Content-Type': 'application/octet-stream',
    'x-upload-id': id,
    'x-chunk-index': '0',
    'x-total-chunks': '2',
    'x-file-name': 'file.txt',
    'x-file-type': 'text/plain',
  });

  it('a streamed chunk without Content-Length is refused with 411', async () => {
    const app = loadApp();
    const status = await rawChunk(app, { ...base('cl', 'no-length'), 'Transfer-Encoding': 'chunked' }, bytes(1024));
    expect(status).toBe(411);
    expect(fs.existsSync(sessionDir('cl', 'no-length'))).toBe(false);
  });

  it('a declared oversize chunk is refused before a session directory or manifest exists', async () => {
    const app = loadApp();
    const res = await chunk(app, 'cl', 'oversize', 0, 2, bytes(10 * MB + 1));
    expect(res.status).toBe(413);
    expect(fs.existsSync(sessionDir('cl', 'oversize'))).toBe(false);
  });
});

describe('fail-closed when Redis is the configured authority', () => {
  it('quota authority outage rejects the chunk with 503 and writes nothing', async () => {
    // Limiter succeeds (fake Redis sliding window returns count 1) ...
    mockRedisAuthoritativeCommand.mockImplementation(async (_op: string, fn: (c: unknown) => Promise<unknown>) => fn({
      multi: () => {
        const pipe = { zAdd: () => pipe, zRemRangeByScore: () => pipe, zCard: () => pipe, expire: () => pipe, exec: async () => [0, 0, 1, 1] };
        return pipe;
      },
    }));
    // ... but the quota script cannot reach Redis.
    mockLuaEvalAuthoritative.mockRejectedValue(new Error('Redis authoritative cache unavailable'));
    const app = loadApp({ REDIS_URL: 'redis://127.0.0.1:1' }, { redisDown: 'quota' });
    const res = await chunk(app, 'fc', 'redis-down', 0, 2, bytes(64));
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(fs.existsSync(sessionDir('fc', 'redis-down'))).toBe(false);
  });

  it('limiter authority outage rejects the chunk route with 503 before the quota runs', async () => {
    mockRedisAuthoritativeCommand.mockRejectedValue(new Error('Redis authoritative command unavailable'));
    const app = loadApp({ REDIS_URL: 'redis://127.0.0.1:1' }, { redisDown: 'limiter' });
    const res = await chunk(app, 'fc', 'limiter-down', 0, 2, bytes(64));
    expect(res.status).toBe(503);
    expect(mockLuaEvalAuthoritative).not.toHaveBeenCalled();
    expect(fs.existsSync(sessionDir('fc', 'limiter-down'))).toBe(false);
  });
});

describe('abandoned session directories are never resumed with unaccounted bytes', () => {
  it('an idle leftover directory for a session the quota does not know is discarded first', async () => {
    const app = loadApp();
    const dir = sessionDir('leftover', 'reused-id');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ uploadId: 'reused-id', totalChunks: 2, fileName: 'file.txt', fileType: 'text/plain' }));
    fs.writeFileSync(path.join(dir, 'chunk_000000'), 'bytes from an abandoned upload');
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), old, old);
    fs.utimesSync(dir, old, old);

    // Resuming would complete the 2-chunk file with bytes nobody accounted for.
    const res = await chunk(app, 'leftover', 'reused-id', 1, 2, bytes(8));
    expect(res.status).toBe(200);
    expect(res.body.done).toBe(false);
    expect(fs.existsSync(path.join(dir, 'chunk_000000'))).toBe(false);
  });
});

describe('quota wiring edge paths', () => {
  const fakeLease = (over: Record<string, unknown> = {}) => ({
    bytes: 0,
    commit: jest.fn().mockResolvedValue('committed'),
    refund: jest.fn().mockResolvedValue(undefined),
    uncommit: jest.fn().mockResolvedValue(undefined),
    ...over,
  });
  const fakeQuota = (reserve: jest.Mock, release = jest.fn().mockResolvedValue(undefined)) => ({
    chunkQuotaConfig: () => ({ maxSessions: 4, userMaxBytes: 400 * MB, sessionTtlMs: 60 * 60_000, leaseTtlMs: 15 * 60_000 }),
    reserveChunkQuota: reserve,
    releaseChunkQuotaSession: release,
  });
  const ok = (lease = fakeLease()) => ({ ok: true, newSession: false, lease });

  it('re-reserves as a retry when the same index was committed concurrently', async () => {
    const reserve = jest.fn().mockResolvedValue(ok());
    const app = loadApp({}, { quota: fakeQuota(reserve) });
    expect((await chunk(app, 'race', 'r1', 0, 3, bytes(8))).status).toBe(200);

    const dir = sessionDir('race', 'r1');
    reserve.mockReset();
    reserve.mockImplementationOnce(async () => {
      // Another request commits index 1 while this one is being admitted.
      fs.writeFileSync(path.join(dir, 'chunk_000001'), bytes(8));
      return { ok: false, reason: 'SESSION_BYTES', sessionInflight: 1 };
    });
    reserve.mockResolvedValueOnce(ok());
    const res = await chunk(app, 'race', 'r1', 1, 3, bytes(8));
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve.mock.calls[0][0].retry).toBe(false);
    expect(reserve.mock.calls[1][0].retry).toBe(true);
    // Identical bytes: an idempotent duplicate, not an entitlement violation.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ done: false, received: 1, duplicate: true });
  });

  it('does not purge an over-limit session while another request is still streaming into it', async () => {
    const reserve = jest.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce({ ok: false, reason: 'SESSION_BYTES', sessionInflight: 1 });
    const release = jest.fn().mockResolvedValue(undefined);
    const app = loadApp({}, { quota: fakeQuota(reserve, release) });
    expect((await chunk(app, 'inflight', 'i1', 0, 3, bytes(8))).status).toBe(200);
    const res = await chunk(app, 'inflight', 'i1', 1, 3, bytes(8));
    expect(res.status).toBe(413);
    expect(release).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(sessionDir('inflight', 'i1'), 'chunk_000000'))).toBe(true);
  });

  it('reports the absolute size policy when it is stricter than the boost entitlement', async () => {
    mockGetHighestActiveTier.mockResolvedValue(3); // 100 MB boost
    const reserve = jest.fn().mockResolvedValue({ ok: false, reason: 'SESSION_BYTES', sessionInflight: 0 });
    const app = loadApp({ MAX_FILE_SIZE_MB: '20' }, { quota: fakeQuota(reserve) });
    const res = await chunk(app, 'global', 'g1', 0, 2, bytes(8));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'File too large (max 20MB)' });
    expect(reserve.mock.calls[0][0].sessionMaxBytes).toBe(20 * MB);
  });

  it('an over-limit purge that cannot reach the authority still refuses the chunk', async () => {
    const reserve = jest.fn().mockResolvedValue({ ok: false, reason: 'SESSION_BYTES', sessionInflight: 0 });
    const release = jest.fn().mockRejectedValue(new Error('authority down'));
    const app = loadApp({}, { quota: fakeQuota(reserve, release) });
    const res = await chunk(app, 'purge-fail', 'p1', 0, 2, bytes(8));
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('BOOST_LIMIT');
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.objectContaining({ event: 'upload.chunk_session_purge_failed' }), expect.any(String));
  });

  it('a lease commit the authority cannot confirm stores nothing (503)', async () => {
    const lease = fakeLease({ commit: jest.fn().mockRejectedValue(new Error('authority down')) });
    const app = loadApp({}, { quota: fakeQuota(jest.fn().mockResolvedValue(ok(lease))) });
    const res = await chunk(app, 'commit-fail', 'c1', 0, 2, bytes(8));
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    const dir = sessionDir('commit-fail', 'c1');
    expect(fs.readdirSync(dir).filter(f => f.startsWith('chunk_'))).toEqual([]);
    expect(lease.refund).toHaveBeenCalled(); // backstop runs; the lease itself makes it a no-op
  });

  it('a lease for a session that ended meanwhile stores nothing (409)', async () => {
    const lease = fakeLease({ commit: jest.fn().mockResolvedValue('gone') });
    const app = loadApp({}, { quota: fakeQuota(jest.fn().mockResolvedValue(ok(lease))) });
    const res = await chunk(app, 'gone', 'g1', 0, 2, bytes(8));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CHUNK_SESSION_EXPIRED');
    expect(fs.readdirSync(sessionDir('gone', 'g1')).filter(f => f.startsWith('chunk_'))).toEqual([]);
  });

  it('a duplicate corrects the committed bytes, and a failed correction is logged, not fatal', async () => {
    const first = fakeLease();
    const dup = fakeLease({ uncommit: jest.fn().mockRejectedValue(new Error('authority down')) });
    const reserve = jest.fn().mockResolvedValueOnce(ok(first)).mockResolvedValueOnce(ok(dup));
    const app = loadApp({}, { quota: fakeQuota(reserve) });
    expect((await chunk(app, 'dup', 'd1', 0, 2, bytes(8))).status).toBe(200);
    const res = await chunk(app, 'dup', 'd1', 0, 2, bytes(8));
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(first.uncommit).not.toHaveBeenCalled();
    expect(dup.uncommit).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.objectContaining({ event: 'upload.chunk_quota_uncommit_failed' }), expect.any(String));
  });

  it('a refund that cannot reach the authority is logged and the lease is left to expire', async () => {
    const lease = fakeLease({ refund: jest.fn().mockRejectedValue(new Error('authority down')) });
    const reserve = jest.fn().mockResolvedValue(ok(lease));
    const app = loadApp({}, { quota: fakeQuota(reserve) });
    expect((await chunk(app, 'refund', 'f1', 0, 2, bytes(8))).status).toBe(200);
    // Same upload id, different metadata → 409 before any body is stored.
    const res = await request(app)
      .post('/api/upload/chunk')
      .set('Authorization', 'Bearer refund')
      .set('x-upload-id', 'f1').set('x-chunk-index', '1').set('x-total-chunks', '3')
      .set('x-file-name', 'file.txt').set('x-file-type', 'text/plain')
      .send(bytes(8));
    expect(res.status).toBe(409);
    await new Promise(r => setImmediate(r));
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.objectContaining({ event: 'upload.chunk_lease_refund_failed' }), expect.any(String));
  });

  it('a finalized upload succeeds even if its quota release cannot reach the authority', async () => {
    const release = jest.fn().mockRejectedValue(new Error('authority down'));
    const app = loadApp({}, { quota: fakeQuota(jest.fn().mockResolvedValue(ok()), release) });
    const res = await chunk(app, 'release', 'x1', 0, 1, bytes(8));
    expect(res.status).toBe(200);
    expect(res.body.done).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.objectContaining({ event: 'upload.chunk_quota_release_failed' }), expect.any(String));
    expect(fs.existsSync(sessionDir('release', 'x1'))).toBe(false);
  });

  it('defence in depth: a body longer than the reserved length is refused and discarded', async () => {
    // Node's parser already bounds the body by Content-Length; this proves the
    // streaming guard still holds if the declared/reserved length and the
    // delivered body ever disagree.
    const lease = fakeLease();
    const app = loadApp({}, { quota: fakeQuota(jest.fn().mockResolvedValue(ok(lease))), declaredLength: 4 });
    const res = await chunk(app, 'overflow', 'o1', 0, 2, bytes(64));
    expect(res.status).toBe(413);
    const dir = sessionDir('overflow', 'o1');
    expect(fs.readdirSync(dir).filter(f => f.startsWith('chunk_'))).toEqual([]);
    expect(lease.commit).not.toHaveBeenCalled();
    expect(lease.refund).toHaveBeenCalled();
  });

  it('a session directory that cannot be removed after finalization is logged and left to the sweeper', async () => {
    const release = jest.fn().mockResolvedValue(undefined);
    const app = loadApp({}, { quota: fakeQuota(jest.fn().mockResolvedValue(ok()), release) });
    const rm = jest.spyOn(fs.promises, 'rm').mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    try {
      const res = await chunk(app, 'rm-fail', 'r1', 0, 1, bytes(8));
      expect(res.status).toBe(200);
      expect(res.body.done).toBe(true);
    } finally {
      rm.mockRestore();
    }
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.objectContaining({ event: 'upload.chunk_session_purge_failed' }), expect.any(String));
    // The quota is still released: a stuck directory must not also pin a slot.
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a client abort mid-body leaves no temp file and returns the lease', async () => {
    const lease = fakeLease();
    const app = loadApp({}, { quota: fakeQuota(jest.fn().mockResolvedValue(ok(lease))) });
    const dir = sessionDir('abort', 'a1');
    await new Promise<void>((resolve, reject) => {
      const server = app.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        const req = http.request({
          port, method: 'POST', path: '/api/upload/chunk',
          headers: {
            Authorization: 'Bearer abort', 'Content-Type': 'application/octet-stream', 'Content-Length': '4096',
            'x-upload-id': 'a1', 'x-chunk-index': '0', 'x-total-chunks': '2', 'x-file-name': 'file.txt', 'x-file-type': 'text/plain',
          },
        });
        req.on('error', () => undefined);
        req.write(bytes(16));
        const deadline = Date.now() + 5_000;
        const tick = () => {
          if (fs.existsSync(dir)) { req.destroy(); return setTimeout(check, 20); }
          if (Date.now() > deadline) { server.close(); return reject(new Error('session never started')); }
          setTimeout(tick, 5);
        };
        const check = () => {
          const parts = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.startsWith('chunk_')) : [];
          if (parts.length === 0 && lease.refund.mock.calls.length > 0) return server.close(() => resolve());
          if (Date.now() > deadline) { server.close(); return reject(new Error(`left behind: ${parts.join(',')}`)); }
          setTimeout(check, 20);
        };
        tick();
      });
    });
    expect(lease.commit).not.toHaveBeenCalled();
  });
});

describe('concurrent identical chunks are not double-counted', () => {
  it('the file still finalizes at exactly its entitlement', async () => {
    mockGetHighestActiveTier.mockResolvedValue(0); // 25 MB
    const app = loadApp();
    const [a, b] = await Promise.all([
      chunk(app, 'twin', 't1', 0, 3, bytes(10 * MB, 1)),
      chunk(app, 'twin', 't1', 0, 3, bytes(10 * MB, 1)),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.duplicate, b.body.duplicate].filter(Boolean).length).toBeLessThanOrEqual(1);
    // If chunk 0 had been counted twice (20 MB), the next 10 MB would exceed 25 MB.
    expect((await chunk(app, 'twin', 't1', 1, 3, bytes(10 * MB, 2))).status).toBe(200);
    const done = await chunk(app, 'twin', 't1', 2, 3, bytes(5 * MB, 3));
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ done: true, size: 25 * MB });
  });
});
