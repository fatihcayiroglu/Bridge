// server/tests/health-schema-readiness.test.ts
//
// P5 SH-01 — a node whose schema is behind the release is NOT ready.
//
// Measured on 956a96e: a fresh PostgreSQL + `NODE_ENV=production node
// server/dist/index.js` (the image's own command) answered /api/health/ready
// with 200 while all 75 versioned migrations were pending and the federation
// queue, AP follows, OAuth tokens and boosts tables did not exist. Boot now
// applies the chain; with BRIDGE_AUTO_MIGRATE=false readiness must say 503
// until an operator runs `migrate-postgres up`, and recover without a restart.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';

import request from 'supertest';
import express from 'express';

const pending = jest.fn(async (): Promise<number> => 0);
jest.mock('../db/postgres/versionedMigrations', () => ({ countPendingMigrations: () => pending() }));
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  return createMockDb({ withPgPool: true });
});
jest.mock('../socket', () => ({ getSocketStats: () => ({}) }));
jest.mock('../socket/handlers/mediasoup', () => ({ isSFUReady: () => false }));
jest.mock('../socket/handlers/mediasoup/workers', () => ({ getWorkerStats: async () => ({ workers: 0, healthy: 0 }) }));
jest.mock('../lib/storageAdapter', () => ({
  getStorageAdapter: () => ({ healthCheck: async () => true }),
  getPrivateStorageAdapter: () => ({ healthCheck: async () => true }),
  getProvider: () => 'local',
  getPrivateStorageProvider: () => 'local',
}));
jest.mock('../lib/turnConfig', () => ({
  getTurnStatus: () => ({ turn: false, provider: 'none', warning: null }),
  getRtcIceConfig: () => ({ iceServers: [] }),
}));
jest.mock('../lib/redisAdapter', () => ({ healthCheck: async () => ({ redis: false, mode: 'in-memory' }) }));

import healthRouter from '../routes/health';

function app() {
  const a = express();
  a.use('/api/health', healthRouter);
  return a;
}

const previousRedis = process.env.REDIS_URL;
beforeAll(() => { delete process.env.REDIS_URL; });
afterAll(() => { if (previousRedis !== undefined) process.env.REDIS_URL = previousRedis; });
beforeEach(() => pending.mockReset());

describe('GET /api/health/ready — the migration chain is part of readiness (P5 SH-01)', () => {
  it('is ready when no versioned migration is pending', async () => {
    pending.mockResolvedValue(0);
    const res = await request(app()).get('/api/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', check: 'readiness' });
  });

  it('is NOT ready while migrations are pending, names "schema" only in the log, and recovers without a restart', async () => {
    const logger = require('../lib/logger').default;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      pending.mockResolvedValue(75);
      // A clock whose digits contain "75": the body's `ts` is a timestamp, so
      // the disclosure check below must never be satisfied or broken by it
      // (it once matched /75/ through `ts` and failed intermittently).
      jest.spyOn(Date, 'now').mockReturnValue(1790873756193);
      const res = await request(app()).get('/api/health/ready');
      expect(res.status).toBe(503);
      // Nothing about the cause is disclosed: exactly the generic fields, and
      // none of them (the clock aside) names the schema or the pending count.
      expect(Object.keys(res.body).sort()).toEqual(['check', 'db', 'status', 'ts', 'version']);
      expect(res.body).toMatchObject({ status: 'error', check: 'readiness' });
      const { ts: _clock, ...disclosed } = res.body as Record<string, unknown>;
      expect(JSON.stringify(disclosed)).not.toMatch(/migration|schema|75/i);
      (Date.now as jest.Mock).mockRestore();
      const failed = warn.mock.calls.filter(c => (c[0] as { event?: string })?.event === 'health.readiness_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0][0]).toMatchObject({ dependency: 'schema', reason: '75 versioned migrations pending' });

      // An operator runs `migrate-postgres up`; the next probe sees a complete chain.
      pending.mockResolvedValue(0);
      expect((await request(app()).get('/api/health/ready')).status).toBe(200);
    } finally {
      warn.mockRestore();
    }
  });

  it('treats a failing schema check as not ready rather than ready', async () => {
    pending.mockRejectedValue(Object.assign(new Error('permission denied for table schema_migrations'), { code: '42501' }));
    expect((await request(app()).get('/api/health/ready')).status).toBe(503);
  });
});
