// server/tests/upload-chunk-session-locality.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// PARÇALI YÜKLEME — İKİ DÜĞÜM, TEK OTORİTE
// ════════════════════════════════════════════════════════════════════════════
// Çok-düğüm düzeneğinde (scripts/multinode, uploads senaryosu) ölçülen boşluklar:
//
//   UP-02/06  Düğüme yerel hazırlamada parçalar farklı düğümlere düşünce her
//             parça 200 dönüyor, yükleme asla tamamlanmıyordu (SESSİZ).
//   UP-04     Son parçanın yanıtı kaybolunca yeniden deneme yeni bir oturum
//             açıyor, `{done:false}` alıyor ve dosya adresini öğrenemiyordu.
//
// Burada iki "düğüm", rota modülünün iki ayrı kopyasıdır: farklı INSTANCE_ID,
// farklı (ya da negatif kontrol için ORTAK) yükleme kökü, tek paylaşılan
// otorite (Redis yerine bellek içi `cache`). Gerçek süreçlerle kanıt çok-düğüm
// düzeneğindedir; bu dosya hızlı CI'da aynı sözleşmeyi korur.

import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.MAX_FILE_SIZE_MB = '2048';
delete process.env.WEBP_CONVERT;

const mockAuthority = new Map<string, unknown>();
const mockReserve = jest.fn();
const mockRelease = jest.fn(async (..._a: unknown[]) => undefined);
const mockUploadFile = jest.fn(async (_p: string, key: string) => ({ url: `/p/${key}`, key: null, provider: 'local' }));

jest.mock('../lib/redisAdapter', () => ({
  cache: {
    getAuthoritative: async (k: string) => (mockAuthority.has(k) ? mockAuthority.get(k) : null),
    setAuthoritative: async (k: string, v: unknown) => { mockAuthority.set(k, v); },
    delAuthoritative: async (k: string) => { mockAuthority.delete(k); },
  },
}));
jest.mock('../lib/chunkUploadQuota', () => {
  const seen = new Set<string>();
  return {
    chunkQuotaConfig: () => ({ maxSessions: 4, userMaxBytes: 400 * 1024 * 1024, sessionTtlMs: 60 * 60_000, leaseTtlMs: 15 * 60_000 }),
    reserveChunkQuota: async (args: { sessionKey: string }) => {
      mockReserve(args);
      const newSession = !seen.has(args.sessionKey);
      seen.add(args.sessionKey);
      return { ok: true, newSession, lease: { bytes: 0, commit: async () => 'committed', refund: async () => undefined, uncommit: async () => undefined } };
    },
    releaseChunkQuotaSession: (...a: unknown[]) => mockRelease(...a),
  };
});
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => { req.user = { id: 'u1', username: 'u1' }; next(); },
}));
jest.mock('../middleware/rateLimit', () => ({ limits: { upload: () => (_q: any, _s: any, n: any) => n(), uploadChunk: () => (_q: any, _s: any, n: any) => n() } }));
jest.mock('../lib/adminAuthority', () => ({ isDatabaseAdmin: jest.fn(async () => false), databaseAdminOnly: (_q: any, _s: any, n: any) => n() }));
jest.mock('../lib/contentScanner', () => ({ scanFile: jest.fn(async () => undefined) }));
jest.mock('../lib/svgSanitizer', () => ({ sanitizeSvgFile: jest.fn(async () => ({ safe: true })) }));
jest.mock('../lib/storageAdapter', () => ({
  getStorageAdapter: () => ({ uploadFile: mockUploadFile, deleteFile: jest.fn() }),
  getPrivateStorageAdapter: () => ({ uploadFile: mockUploadFile, deleteFile: jest.fn() }),
  getProvider: () => 'local',
  getPrivateStorageProvider: () => 'local',
}));
jest.mock('../db/postgres', () => ({ db: { _pool: { query: async (sql: string) => (sql.includes('boostTier') ? { rows: [{ boostTier: 3 }] } : { rows: [] }) } } }));
jest.mock('../db/repositories', () => ({ Boosts: { getHighestActiveTierForUser: jest.fn(async () => 3) } }));
jest.mock('../db/loader', () => ({ __esModule: true, default: { uploads: { insert: jest.fn(async () => ({})), findOne: jest.fn(async () => null) } } }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockDeadNodes = new Set<string>();
jest.mock('../lib/nodeLiveness', () => ({ isNodeAlive: async (id: string) => !mockDeadNodes.has(id) }));

const roots: string[] = [];
function node(instanceId: string, root: string) {
  let router: express.Router | undefined;
  const prev = { INSTANCE_ID: process.env.INSTANCE_ID, ROOT: process.env.BRIDGE_UPLOAD_ROOT, REDIS: process.env.REDIS_URL };
  process.env.INSTANCE_ID = instanceId;
  process.env.BRIDGE_UPLOAD_ROOT = root;
  process.env.REDIS_URL = 'redis://authority.test:6379';
  jest.isolateModules(() => { router = require('../routes/upload').default; });
  for (const [k, v] of [['INSTANCE_ID', prev.INSTANCE_ID], ['BRIDGE_UPLOAD_ROOT', prev.ROOT], ['REDIS_URL', prev.REDIS]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const app = express();
  app.use('/api/upload', router!);
  app.use((err: any, _q: any, res: any, _n: any) => res.status(500).json({ error: err.message }));
  return app;
}
function mkRoot(): string { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-chunk-locality-')); roots.push(r); return r; }
function chunk(app: express.Express, id: string, index: number, total: number, body: string, name = 'file.txt') {
  return request(app).post('/api/upload/chunk')
    .set('Content-Type', 'application/octet-stream')
    .set('x-upload-id', id).set('x-chunk-index', String(index)).set('x-total-chunks', String(total))
    .set('x-file-name', name).set('x-file-type', 'text/plain')
    .send(Buffer.from(body));
}
const sessionDirs = (root: string) => { try { return fs.readdirSync(path.join(root, '_chunks')); } catch { return []; } };

beforeEach(() => { mockAuthority.clear(); mockDeadNodes.clear(); jest.clearAllMocks(); });
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

describe('completed upload replay (lost final response)', () => {
  it('a retry of the finalizing chunk — on the same or another node — returns the SAME completion and opens no session', async () => {
    const a = node('node-a', mkRoot());
    const b = node('node-b', mkRoot());
    const first = await chunk(a, 'replay-1', 0, 1, 'hello world\n');
    expect(first.status).toBe(200);
    expect(first.body.done).toBe(true);
    const reservations = mockReserve.mock.calls.length;

    const againA = await chunk(a, 'replay-1', 0, 1, 'hello world\n');
    const againB = await chunk(b, 'replay-1', 0, 1, 'hello world\n');
    expect(againA.status).toBe(200);
    expect(againA.body).toEqual(first.body);
    expect(againB.body).toEqual(first.body);
    expect(mockReserve.mock.calls.length).toBe(reservations);
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
  });

  it('negative control: the same upload id with different metadata is refused, not replayed', async () => {
    const a = node('node-a', mkRoot());
    expect((await chunk(a, 'replay-2', 0, 1, 'abc\n')).body.done).toBe(true);
    const other = await chunk(a, 'replay-2', 0, 1, 'abc\n', 'other-name.txt');
    expect(other.status).toBe(409);
    expect(other.body.done).toBeUndefined();
  });
});

describe('staging locality with node-local upload roots', () => {
  it('a chunk that reaches a node without the session staging is refused loudly (no silent partial staging)', async () => {
    const rootA = mkRoot();
    const rootB = mkRoot();
    const a = node('node-a', rootA);
    const b = node('node-b', rootB);
    const c0 = await chunk(a, 'split-1', 0, 2, 'part zero\n');
    expect(c0.body).toMatchObject({ done: false });
    const reservations = mockReserve.mock.calls.length;

    const c1 = await chunk(b, 'split-1', 1, 2, 'part one\n');
    expect(c1.status).toBe(409);
    expect(c1.body).toMatchObject({ code: 'CHUNK_STAGED_ELSEWHERE', stagingNode: 'node-a' });
    expect(sessionDirs(rootB)).toEqual([]);
    expect(mockReserve.mock.calls.length).toBe(reservations);

    // Routed to the staging node, the same upload completes.
    const done = await chunk(a, 'split-1', 1, 2, 'part one\n');
    expect(done.body.done).toBe(true);
  });

  it('a session staged on a DEAD node releases its quota and asks for a restart instead of holding the slot', async () => {
    const a = node('node-a', mkRoot());
    const b = node('node-b', mkRoot());
    expect((await chunk(a, 'dead-1', 0, 2, 'part zero\n')).body.done).toBe(false);
    mockDeadNodes.add('node-a');                      // node A was SIGKILLed; its lease expired
    const next = await chunk(b, 'dead-1', 1, 2, 'part one\n');
    expect(next.status).toBe(409);
    expect(next.body.code).toBe('CHUNK_STAGING_LOST');
    expect(mockRelease).toHaveBeenCalledWith('u1', expect.any(String));
    // Restarting the upload on a live node works.
    expect((await chunk(b, 'dead-1', 0, 2, 'part zero\n')).body.done).toBe(false);
    expect((await chunk(b, 'dead-1', 1, 2, 'part one\n')).body.done).toBe(true);
  });

  it('negative control: with a SHARED upload root the other node finalizes the session', async () => {
    const shared = mkRoot();
    const a = node('node-a', shared);
    const b = node('node-b', shared);
    expect((await chunk(a, 'shared-1', 0, 2, 'part zero\n')).body.done).toBe(false);
    const c1 = await chunk(b, 'shared-1', 1, 2, 'part one\n');
    expect(c1.status).toBe(200);
    expect(c1.body.done).toBe(true);
  });

  it('a node that lost its own staging (restart without persistent storage) releases the quota and asks for a restart', async () => {
    const rootA = mkRoot();
    const a = node('node-a', rootA);
    expect((await chunk(a, 'lost-1', 0, 2, 'part zero\n')).body.done).toBe(false);
    for (const d of sessionDirs(rootA)) fs.rmSync(path.join(rootA, '_chunks', d), { recursive: true, force: true });

    const next = await chunk(a, 'lost-1', 1, 2, 'part one\n');
    expect(next.status).toBe(409);
    expect(next.body.code).toBe('CHUNK_STAGING_LOST');
    expect(mockRelease).toHaveBeenCalledWith('u1', expect.any(String));
    // The marker is gone: restarting the same upload id starts a fresh session.
    const restart = await chunk(a, 'lost-1', 0, 2, 'part zero\n');
    expect(restart.status).toBe(200);
    expect(restart.body.done).toBe(false);
  });
});
