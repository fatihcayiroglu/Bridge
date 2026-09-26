// server/tests/health-required-media-and-probe-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SAĞLIK — İSTEĞE BAĞLI MEDYANIN ZORUNLU İLAN EDİLMESİ VE PROBE UÇLARI
// ════════════════════════════════════════════════════════════════════════════
//
// `tests/health-operational-states.test.ts` genel durum raporunu ölçer. Bu
// tamamlayıcı takım, operatörün AÇIKÇA "bu bende zorunlu" dediği medya
import type { Request, Response, NextFunction } from 'express';
// altyapısını ölçer:
//
//   · `REQUIRE_TURN` / `REQUIRE_SFU` ayarlanmadıkça TURN ve SFU İSTEĞE
//     BAĞLIDIR — P2P/STUN-only bir self-host kurulumu yeşil kalmalıdır.
//     Ayarlandığında ise eksiklik HAZIR DEĞİL demektir: aksi hâlde yük
//     dengeleyici, sesli görüşmeyi taşıyamayacak bir düğüme trafik yollar.
//   · `/mediasoup` bir izleme (probe) ucudur. SFU kurulu değilse 200 döner
//     (opsiyonel bileşen), kuruluysa SAĞLIKLI işçi sayısına göre 200/503.
//   · `/stats` süreç içi bilgiyi açar; üretimde YALNIZCA iç ağdan okunur.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';

import request from 'supertest';
import express from 'express';
import { createMockDb, makeUser, makeServer } from './helpers/mockDb';

let db: ReturnType<typeof createMockDb>;
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb({ withPgPool: true });
});

const socketStats = jest.fn();
jest.mock('../socket', () => ({ getSocketStats: (...a: unknown[]) => socketStats(...a) }));

const isSFUReady = jest.fn(() => false);
jest.mock('../socket/handlers/mediasoup', () => ({ isSFUReady: () => isSFUReady() }));

const workersModule: { getWorkerStats?: (...a: unknown[]) => unknown } = {};
jest.mock('../socket/handlers/mediasoup/workers', () => workersModule);

const publicHealth = jest.fn(async () => true);
const privateHealth = jest.fn(async () => true);
jest.mock('../lib/storageAdapter', () => ({
  getStorageAdapter: () => ({ healthCheck: publicHealth }),
  getPrivateStorageAdapter: () => ({ healthCheck: privateHealth }),
  getProvider: () => 'local',
  getPrivateStorageProvider: () => 'local',
}));

const turnStatus = jest.fn(() => ({ turn: false, provider: 'none', warning: null }));
jest.mock('../lib/turnConfig', () => ({
  getTurnStatus: () => turnStatus(),
  getRtcIceConfig: (...args: unknown[]) => jest.requireActual('../lib/turnConfig').getRtcIceConfig(...args),
}));

const redisHealth = jest.fn(async () => ({ redis: false, mode: 'in-memory' }));
jest.mock('../lib/redisAdapter', () => ({ healthCheck: () => redisHealth() }));

import healthRouter from '../routes/health';

function buildApp(ip?: string) {
  const app = express();
  app.use(express.json());
  if (ip) app.use((req: Request, _res: Response, next: NextFunction) => { Object.defineProperty(req, 'ip', { value: ip }); next(); });
  app.use('/api/health', healthRouter);
  return app;
}

const ENV_KEYS = ['NODE_ENV', 'REQUIRE_TURN', 'REQUIRE_SFU', 'REDIS_URL'];
const ORIGINAL: Record<string, string | undefined> = {};
const getWorkerStats = jest.fn();

beforeAll(() => { for (const k of ENV_KEYS) ORIGINAL[k] = process.env[k]; });

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k] as string;
  }
  process.env.NODE_ENV = 'test';
});

beforeEach(async () => {
  db = createMockDb({ withPgPool: true });
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);
  jest.clearAllMocks();

  socketStats.mockReturnValue({ connectedSockets: 3 });
  isSFUReady.mockReturnValue(false);
  publicHealth.mockResolvedValue(true);
  privateHealth.mockResolvedValue(true);
  turnStatus.mockReturnValue({ turn: false, provider: 'none', warning: null });
  redisHealth.mockResolvedValue({ redis: false, mode: 'in-memory' });
  workersModule.getWorkerStats = (...a: unknown[]) => getWorkerStats(...a);
  getWorkerStats.mockResolvedValue({ workers: 1, healthy: 1 });

  const owner = makeUser({ username: 'owner' });
  await db.users.insert(owner);
  await db.servers.insert(makeServer(owner._id, { name: 'Ops' }));

  delete process.env.REQUIRE_TURN;
  delete process.env.REQUIRE_SFU;
  delete process.env.REDIS_URL;
});

const ready = () => request(buildApp()).get('/api/health/ready');

describe('readiness treats optional media as optional by default', () => {
  it('a STUN-only self-hosted node without TURN or SFU is ready', async () => {
    turnStatus.mockReturnValue({ turn: false, provider: 'none', warning: null });
    getWorkerStats.mockResolvedValue({ workers: 0, healthy: 0 });

    const res = await ready();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', check: 'readiness' });
    // Nothing was asked of the media layer, because nothing was declared.
    expect(getWorkerStats).not.toHaveBeenCalled();
  });

  it('a node that declares TURN required is not ready without it', async () => {
    process.env.REQUIRE_TURN = 'true';
    turnStatus.mockReturnValue({ turn: false, provider: 'none', warning: null });

    const res = await ready();

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
  });

  it('a node that declares TURN required and has it is ready', async () => {
    process.env.REQUIRE_TURN = 'true';
    turnStatus.mockReturnValue({ turn: true, provider: 'coturn', warning: null });
    expect((await ready()).status).toBe(200);
  });

  it('a node that declares SFU required is not ready with zero healthy workers', async () => {
    process.env.REQUIRE_SFU = 'true';
    getWorkerStats.mockResolvedValue({ workers: 2, healthy: 0 });

    const res = await ready();

    expect(res.status).toBe(503);
    expect(getWorkerStats).toHaveBeenCalled();
  });

  it('a node that declares SFU required is ready with at least one healthy worker', async () => {
    process.env.REQUIRE_SFU = 'true';
    getWorkerStats.mockResolvedValue({ workers: 2, healthy: 1 });
    expect((await ready()).status).toBe(200);
  });

  it('a node that declares SFU required but has no SFU build at all is not ready', async () => {
    // Declaring a dependency that the build cannot provide must fail closed
    // rather than defaulting to "zero workers is fine".
    process.env.REQUIRE_SFU = 'true';
    delete workersModule.getWorkerStats;
    expect((await ready()).status).toBe(503);
  });

  it('a configured but unreachable Redis makes the node not ready', async () => {
    process.env.REDIS_URL = 'redis://cluster.test:6379';
    redisHealth.mockResolvedValue({ redis: false, mode: 'in-memory' });
    expect((await ready()).status).toBe(503);
  });

  it('a configured and reachable Redis keeps the node ready', async () => {
    process.env.REDIS_URL = 'redis://cluster.test:6379';
    redisHealth.mockResolvedValue({ redis: true, mode: 'redis' });
    expect((await ready()).status).toBe(200);
  });

  it('an unconfigured Redis is not consulted at all', async () => {
    await ready();
    expect(redisHealth).not.toHaveBeenCalled();
  });

  it('a failing storage probe makes the node not ready', async () => {
    privateHealth.mockRejectedValue(new Error('object store offline'));
    expect((await ready()).status).toBe(503);
  });
});

describe('the mediasoup probe endpoint', () => {
  const probe = () => request(buildApp()).get('/api/health/mediasoup');

  it('reports ok with the worker figures when the SFU is healthy', async () => {
    getWorkerStats.mockResolvedValue({ workers: 2, healthy: 2 });
    const res = await probe();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', workers: { workers: 2, healthy: 2 } });
  });

  it('reports degraded with a 503 when every worker is down', async () => {
    getWorkerStats.mockResolvedValue({ workers: 2, healthy: 0 });
    const res = await probe();
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
  });

  it('a build without an SFU reports ok, because the SFU is optional', async () => {
    delete workersModule.getWorkerStats;
    const res = await probe();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', workers: null, note: 'mediasoup not configured' });
  });

  it('a failing worker query is reported as "not configured" rather than crashing', async () => {
    getWorkerStats.mockRejectedValue(new Error('worker rpc failed'));
    const res = await probe();
    expect(res.status).toBe(200);
    expect(res.body.note).toBe('mediasoup not configured');
  });
});

describe('/stats exposes process internals only where it is safe', () => {
  it('is open outside production', async () => {
    const res = await request(buildApp('203.0.113.5')).get('/api/health/stats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('memory');
  });

  const internal = ['127.0.0.1', '::1', '10.0.0.4', '172.16.0.9'];
  for (const ip of internal) {
    it(`is readable from ${ip} in production`, async () => {
      process.env.NODE_ENV = 'production';
      const res = await request(buildApp(ip)).get('/api/health/stats');
      expect(res.status).toBe(200);
    });
  }

  const external = ['203.0.113.5', '8.8.8.8', ''];
  for (const ip of external) {
    it(`is refused from "${ip || 'an unknown address'}" in production`, async () => {
      process.env.NODE_ENV = 'production';
      const res = await request(buildApp(ip || undefined)).get('/api/health/stats');
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden' });
    });
  }

  it('still answers when the socket layer cannot report', async () => {
    socketStats.mockImplementation(() => { throw new Error('socket layer down'); });
    const res = await request(buildApp('127.0.0.1')).get('/api/health/stats');
    expect(res.status).toBe(200);
  });
});
