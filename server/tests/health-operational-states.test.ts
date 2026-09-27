// server/tests/health-operational-states.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// /api/health — SAGLIK RAPORU YALAN SOYLEYEMEZ
// ════════════════════════════════════════════════════════════════════════════
// Saglik uclari yalnizca "200 doner mi" sorusundan ibaret degildir. Bunlar
// YUK DENGELEYICIYE ve OPERATORE karar verdiren uclardir:
//
import type { HealthCheckResult } from '../lib/redisAdapter';
import type { Request, Response, NextFunction } from 'express';
//   · `/ready` bir dugumu ROTASYONA sokar. Yapilandirilmis ama erisilemez bir
//     bagimlilikla "hazirim" demek, trafigi kirik bir dugume yollamaktir.
//   · `/server/:sid/services` operatore hangi alt sistemin bozuk oldugunu
//     soyler. Her alt sistem AYRI AYRI raporlanmali; biri coktugunde digerleri
//     hakkinda uydurma "operational" yazilmamalidir.
//   · Toplam durum (`overall`) EN KOTU parcadan turetilir — biri bile
//     `unavailable` ise toplam `unavailable`, degrade varsa `degraded`.
//
// Ayri bir sinif: `/stats` surec ic bilgisini (bellek, soket sayilari) acar.
// Bu uç ağ topolojisine güvenmez; yalnız güncel DB-admin kimliği okuyabilir.
//
// Son sinif: `/ice-config`. `FORCE_TURN=true` ama TURN yapilandirilmamissa
// relay'e zorlamak TUM ses/goruntu baglantilarini keserdi. Urun bilerek
// geri duser ve UYARIR — sessizce kesmez.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';

import request from 'supertest';
import express from 'express';
import { createMockDb, makeUser, makeServer, makeChannel } from './helpers/mockDb';

const jwt = require('jsonwebtoken');

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

const getWorkerStats = jest.fn();
jest.mock('../socket/handlers/mediasoup/workers', () => ({
  getWorkerStats: (...a: unknown[]) => getWorkerStats(...a),
}));

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

// Donus tipi URUNDEN gelir: cikarim `{redis, mode}` ile sinirli kaliyor ve
// `latencyMs` gibi GERCEK alanlarla kurulan yanitlar reddediliyordu.
const redisHealth = jest.fn<Promise<HealthCheckResult>, []>(async () => ({ redis: false, mode: 'in-memory' }));
jest.mock('../lib/redisAdapter', () => ({ healthCheck: () => redisHealth() }));

import healthRouter from '../routes/health';

const token = (userId: string) =>
  jwt.sign({ id: userId, username: 'tester', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

function buildApp(ip?: string) {
  const app = express();
  app.use(express.json());
  if (ip) app.use((req: Request, _res: Response, next: NextFunction) => { Object.defineProperty(req, 'ip', { value: ip }); next(); });
  app.use('/api/health', healthRouter);
  return app;
}

const ENV_KEYS = ['NODE_ENV', 'FORCE_TURN', 'FORCE_RELAY', 'STUN_URLS', 'TURN_SECRET', 'TURN_HOST', 'TURN_PORT', 'TURN_TLS_PORT', 'TURN_TLS_443', 'TURN_URL', 'TURN_USERNAME', 'TURN_CREDENTIAL', 'TURN_URL_TLS'];
const ORIGINAL: Record<string, string | undefined> = {};

let owner: ReturnType<typeof makeUser>;
let member: ReturnType<typeof makeUser>;
let outsider: ReturnType<typeof makeUser>;
let server: ReturnType<typeof makeServer>;

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

  socketStats.mockReset(); socketStats.mockReturnValue({ connectedSockets: 3 });
  isSFUReady.mockReset(); isSFUReady.mockReturnValue(false);
  getWorkerStats.mockReset();
  publicHealth.mockReset(); publicHealth.mockResolvedValue(true);
  privateHealth.mockReset(); privateHealth.mockResolvedValue(true);
  turnStatus.mockReset(); turnStatus.mockReturnValue({ turn: false, provider: 'none', warning: null });
  redisHealth.mockReset(); redisHealth.mockResolvedValue({ redis: false, mode: 'in-memory' });

  owner = makeUser({ username: 'owner', isAdmin: true });
  member = makeUser({ username: 'member' });
  outsider = makeUser({ username: 'outsider' });
  server = makeServer(owner._id, { name: 'Ops' });

  await db.users.insert(owner);
  await db.users.insert(member);
  await db.users.insert(outsider);
  await db.servers.insert(server);
  await db.channels.insert(makeChannel(server._id, { name: 'general' }));
  await db.members.insert({ userId: owner._id, serverId: server._id, joinedAt: Date.now() });
  await db.members.insert({ userId: member._id, serverId: server._id, joinedAt: Date.now() });
});

// ── READINESS ───────────────────────────────────────────────────────────────
describe('GET /api/health/ready — a configured dependency is part of readiness', () => {
  const withRedisUrl = async (fn: () => Promise<void>) => {
    const previous = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://ops.example:6379';
    try { await fn(); } finally {
      if (previous === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previous;
    }
  };

  it('refuses readiness when a configured Redis is unreachable', async () => {
    await withRedisUrl(async () => {
      redisHealth.mockResolvedValue({ redis: false, mode: 'in-memory' });
      const res = await request(buildApp()).get('/api/health/ready');
      // Rotasyona girmek, kume durumunu tutamayacak bir dugume trafik yollamaktir.
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('error');
      expect(res.body.check).toBe('readiness');
    });
  });

  it('is ready when the configured Redis answers', async () => {
    await withRedisUrl(async () => {
      redisHealth.mockResolvedValue({ redis: true, mode: 'redis', latencyMs: 2 });
      const res = await request(buildApp()).get('/api/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  it('refuses readiness when configured storage fails its check', async () => {
    publicHealth.mockResolvedValue(false);
    const res = await request(buildApp()).get('/api/health/ready');
    expect(res.status).toBe(503);
  });

  it('is ready without Redis configured at all', async () => {
    const previous = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const res = await request(buildApp()).get('/api/health/ready');
      expect(res.status).toBe(200);
      // Tek dugumlu kurulum mesrudur; Redis YAPILANDIRILMAMISSA aranmaz.
      expect(redisHealth).not.toHaveBeenCalled();
    } finally { if (previous !== undefined) process.env.REDIS_URL = previous; }
  });
});

// ── STATS EXPOSURE ──────────────────────────────────────────────────────────
describe('GET /api/health/stats — process internals require current DB-admin auth', () => {
  it.each(['203.0.113.9', '127.0.0.1', '::1', '10.1.2.3', '172.16.0.4'])
  ('never treats source IP %s as an authorization capability', async (ip) => {
    process.env.NODE_ENV = 'production';
    const unauth = await request(buildApp(ip)).get('/api/health/stats');
    expect(unauth.status).toBe(401);
    const plain = await request(buildApp(ip)).get('/api/health/stats')
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(plain.status).toBe(403);
  });

  it.each(['203.0.113.9', '127.0.0.1', '10.1.2.3', '172.16.0.4'])
  ('allows a current DB admin regardless of proxy/source IP %s', async (ip) => {
    process.env.NODE_ENV = 'production';
    const res = await request(buildApp(ip)).get('/api/health/stats')
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(res.status).toBe(200);
    expect(res.body.socket).toEqual({ connectedSockets: 3 });
    expect(res.body.counts).toEqual(expect.objectContaining({ users: expect.any(Number) }));
  });

  it('still answers when the socket layer reports nothing', async () => {
    socketStats.mockReturnValue(undefined);
    const res = await request(buildApp()).get('/api/health/stats')
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(res.status).toBe(200);
    expect(res.body.socket).toEqual({});
  });
});

// ── PER-SERVICE OPERATIONAL VIEW ────────────────────────────────────────────
describe('GET /api/health/server/:sid/services — each subsystem is reported on its own', () => {
  const services = (body: Record<string, unknown>) =>
    Object.fromEntries((body.services as Array<{ key: string; status: string }>).map(s => [s.key, s.status]));

  it('requires membership and rejects a stranger', async () => {
    const missing = await request(buildApp()).get(`/api/health/server/${server._id}/services`)
      .set('Authorization', `Bearer ${token(outsider._id)}`);
    expect(missing.status).toBe(403);

    const unknownServer = await request(buildApp()).get('/api/health/server/nope/services')
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(unknownServer.status).toBe(404);
  });

  it('refuses a plain member without MANAGE_SERVER', async () => {
    const res = await request(buildApp()).get(`/api/health/server/${server._id}/services`)
      .set('Authorization', `Bearer ${token(member._id)}`);
    expect(res.status).toBe(403);
  });

  it('reports everything operational for a healthy node', async () => {
    isSFUReady.mockReturnValue(true);
    const res = await request(buildApp()).get(`/api/health/server/${server._id}/services`)
      .set('Authorization', `Bearer ${token(owner._id)}`);

    expect(res.status).toBe(200);
    expect(services(res.body)).toEqual(expect.objectContaining({
      database: 'operational', uploads: 'operational',
      protected_uploads: 'operational', realtime: 'operational', voice: 'operational',
    }));
    expect(res.body.overall).toBe('operational');
  });

  it('marks only the failing subsystem and degrades the overall verdict', async () => {
    publicHealth.mockResolvedValue(false);
    const res = await request(buildApp()).get(`/api/health/server/${server._id}/services`)
      .set('Authorization', `Bearer ${token(owner._id)}`);

    const map = services(res.body);
    expect(map.uploads).toBe('unavailable');
    // Diger alt sistemler hakkinda uydurma bir "bozuk" raporu YOKTUR.
    expect(map.database).toBe('operational');
    expect(map.protected_uploads).toBe('operational');
    expect(res.body.overall).toBe('unavailable');
  });

  it('separates public and protected storage failures', async () => {
    privateHealth.mockResolvedValue(false);
    const res = await request(buildApp()).get(`/api/health/server/${server._id}/services`)
      .set('Authorization', `Bearer ${token(owner._id)}`);
    const map = services(res.body);
    expect(map.uploads).toBe('operational');
    expect(map.protected_uploads).toBe('unavailable');
  });

  it('reports a thrown storage adapter as unavailable rather than crashing', async () => {
    publicHealth.mockRejectedValue(new Error('bucket gone'));
    const res = await request(buildApp()).get(`/api/health/server/${server._id}/services`)
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(res.status).toBe(200);
    expect(services(res.body).uploads).toBe('unavailable');
    // Ham hata metni disari SIZMAZ.
    expect(JSON.stringify(res.body)).not.toContain('bucket gone');
  });

  it('reports realtime as unavailable when the socket layer has no stats', async () => {
    socketStats.mockReturnValue(undefined);
    const res = await request(buildApp()).get(`/api/health/server/${server._id}/services`)
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(services(res.body).realtime).toBe('unavailable');
  });

  it('calls voice degraded on plain STUN and operational once TURN exists', async () => {
    const degraded = await request(buildApp()).get(`/api/health/server/${server._id}/services`)
      .set('Authorization', `Bearer ${token(owner._id)}`);
    const degradedVoice = (degraded.body.services as Array<{ key: string; status: string; detail: string }>)
      .find(s => s.key === 'voice')!;
    expect(degradedVoice.status).toBe('degraded');
    expect(degradedVoice.detail).toContain('TURN');
    expect(degraded.body.overall).toBe('degraded');

    turnStatus.mockReturnValue({ turn: true, provider: 'coturn', warning: null });
    const relayed = await request(buildApp()).get(`/api/health/server/${server._id}/services`)
      .set('Authorization', `Bearer ${token(owner._id)}`);
    const relayedVoice = (relayed.body.services as Array<{ key: string; status: string; detail: string }>)
      .find(s => s.key === 'voice')!;
    expect(relayedVoice.status).toBe('operational');
    expect(relayedVoice.detail).toContain('TURN relay');
  });
});

// ── MEDIASOUP PROBE ─────────────────────────────────────────────────────────
describe('GET /api/health/mediasoup — an optional subsystem never fails the node', () => {
  it('is ok while at least one worker is healthy', async () => {
    getWorkerStats.mockResolvedValue({ workers: 2, healthy: 2 });
    const res = await request(buildApp()).get('/api/health/mediasoup');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', workers: { workers: 2, healthy: 2 } });
  });

  it('is degraded with workers present but none healthy', async () => {
    getWorkerStats.mockResolvedValue({ workers: 2, healthy: 0 });
    const res = await request(buildApp()).get('/api/health/mediasoup');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
  });

  it('answers ok when mediasoup is simply not installed', async () => {
    getWorkerStats.mockRejectedValue(new Error('module missing'));
    const res = await request(buildApp()).get('/api/health/mediasoup');
    // Ses/goruntu SELF-HOST'ta istege baglidir; yoklugu dugumu dusurmez.
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ status: 'ok', workers: null }));
  });
});

// ── ICE POLICY ──────────────────────────────────────────────────────────────
describe('GET /api/health/ice-config — FORCE_TURN never silently kills calls', () => {
  const iceApp = () => {
    const app = express();
    app.use(express.json());
    app.use('/api/health', healthRouter);
    return app;
  };

  it('serves plain STUN with no TURN configured', async () => {
    const res = await request(iceApp()).get('/api/health/ice-config')
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(res.status).toBe(200);
    expect(res.body.iceTransportPolicy).toBe('all');
    expect(res.body.iceServers.every((s: { urls?: string | string[] }) => (Array.isArray(s.urls) ? s.urls : s.urls ? [s.urls] : []).every((url: string) => url.startsWith('stun:')))).toBe(true);
  });

  it('adds the TURN entry and its TLS variant when configured', async () => {
    process.env.TURN_URL = 'turn:relay.example:3478';
    process.env.TURN_USERNAME = 'u';
    process.env.TURN_CREDENTIAL = 'p';
    process.env.TURN_URL_TLS = 'turns:relay.example:5349';

    const res = await request(iceApp()).get('/api/health/ice-config')
      .set('Authorization', `Bearer ${token(owner._id)}`);
    const urls = res.body.iceServers.flatMap((s: { urls: string | string[] }) => Array.isArray(s.urls) ? s.urls : [s.urls]);
    expect(urls).toContain('turn:relay.example:3478');
    expect(urls).toContain('turns:relay.example:5349');
  });

  it('self-hosted TURN_SECRET + TURN_HOST reaches the live ICE endpoint with HMAC credentials', async () => {
    process.env.TURN_SECRET = 'shared-secret';
    process.env.TURN_HOST = 'turn.selfhosted.example';

    const res = await request(iceApp()).get('/api/health/ice-config')
      .set('Authorization', `Bearer ${token(owner._id)}`);
    const turn = res.body.iceServers.find((s: { urls: string | string[] }) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.some((u: string) => u.startsWith('turn:turn.selfhosted.example:'));
    });
    expect(res.status).toBe(200);
    expect(turn).toEqual(expect.objectContaining({ username: expect.any(String), credential: expect.any(String) }));
    expect(turn.username).toContain(`${owner._id}`);
  });

  it('enforces relay only when TURN actually exists', async () => {
    process.env.FORCE_TURN = 'true';
    process.env.TURN_URL = 'turn:relay.example:3478';
    process.env.TURN_USERNAME = 'u';
    process.env.TURN_CREDENTIAL = 'p';

    const res = await request(iceApp()).get('/api/health/ice-config')
      .set('Authorization', `Bearer ${token(owner._id)}`);
    expect(res.body.iceTransportPolicy).toBe('relay');
    expect(res.body.warning).toBeUndefined();
  });

  it('falls back to all and warns when FORCE_TURN has no relay behind it', async () => {
    process.env.FORCE_TURN = 'true';
    delete process.env.TURN_URL;
    delete process.env.TURN_USERNAME;
    delete process.env.TURN_CREDENTIAL;

    const res = await request(iceApp()).get('/api/health/ice-config')
      .set('Authorization', `Bearer ${token(owner._id)}`);
    // Relay'e zorlamak TUM baglantilari keserdi; urun geri duser ve SOYLER.
    expect(res.body.iceTransportPolicy).toBe('all');
    expect(String(res.body.warning)).toContain('FORCE_TURN');
  });

  it('requires authentication', async () => {
    const res = await request(iceApp()).get('/api/health/ice-config');
    expect(res.status).toBe(401);
  });
});
