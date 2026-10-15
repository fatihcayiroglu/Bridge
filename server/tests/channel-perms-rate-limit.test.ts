// server/tests/channel-perms-rate-limit.test.ts
//
// Channel permission overrides decide who can read which channel. Their routes
// carry two per-user rate limits (helpers.ts): 30 writes and 60 reads per
// minute. Every other channel-permission suite replaces `express-rate-limit`
// with a pass-through, so these limits had never run in a test. Here the REAL
// limiter is mounted in front of the real router and the tests pin:
//   - writes stop at 30 per user per minute, and the refused write changes
//     nothing (no override row, no audit record);
//   - the write budget is ONE budget across every write route (single PUT,
//     DELETE, batch, import, bulk-sync), not 30 per route;
//   - reads stop at 60 and have their own budget, independent of writes;
//   - the key is the authenticated user, not the IP: another account behind
//     the same address keeps its own budget;
//   - unauthenticated requests are refused by auth before the limiter and do
//     not spend anyone's budget.
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/permCache', () => ({ invalidatePerms: jest.fn() }));
jest.mock('../lib/permissions', () => {
  const actual = jest.requireActual('../lib/permissions');
  return {
    ...actual,
    resolvePermissions: jest.fn().mockResolvedValue(actual.PERMS.MANAGE_CHANNELS),
    hasPermission: jest.fn().mockReturnValue(true),
  };
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { Router } from 'express';

const SID = 'rl-server';
const CID = 'rl-channel';
const ROLE = 'rl-role';
const ALICE = 'rl-alice';
const BOB = 'rl-bob';
const BASE = `/api/servers/${SID}/channels/${CID}/permissions`;
const WRITE_LIMIT = 30;
const READ_LIMIT = 60;

const bearer = (id: string) => `Bearer ${jwt.sign({ id, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`;

let app: express.Express;
let db: ReturnType<typeof import('./helpers/mockDb').createMockDb>;
let Auth: typeof import('../db/repositories').Auth;

// The limiters are module-level instances with an in-memory store; a fresh
// module graph per test gives each test a fresh minute.
beforeEach(async () => {
  jest.resetModules();
  db = require('../db/loader');
  Auth = require('../db/repositories').Auth;
  const router = require('../routes/channelPerms').default as Router;
  app = express();
  app.use(express.json());
  app.use('/api/servers/:sid/channels/:cid/permissions', router);
  await db.users.insert({ _id: ALICE, username: 'alice', tokenVersion: 0 });
  await db.users.insert({ _id: BOB, username: 'bob', tokenVersion: 0 });
  await db.servers.insert({ _id: SID, name: 'Limits', ownerId: ALICE });
  await db.channels.insert({ _id: CID, serverId: SID, name: 'general', type: 'text' });
  await db.channels.insert({ _id: 'rl-other', serverId: SID, name: 'other', type: 'text' });
  await db.roles.insert({ _id: ROLE, serverId: SID, name: 'Member', permissions: 0, position: 1 });
});

const putOverride = (who: string, allow: number) =>
  request(app).put(`${BASE}/${ROLE}`).set('Authorization', bearer(who)).send({ allow, deny: 0 });
const readOverrides = (who: string) => request(app).get(BASE).set('Authorization', bearer(who));
const auditCount = async () => (await Auth.auditLogsFind({ serverId: SID }) as unknown[]).length;
const overrideRow = async () => (await db.channelPermissions.findOne({ channelId: CID, roleId: ROLE })) as { allow?: number } | null;

describe('channel permission write limit (real limiter)', () => {
  it('allows 30 writes per user per minute; the 31st is refused with 429 and changes nothing', async () => {
    for (let i = 1; i <= WRITE_LIMIT; i++) {
      const res = await putOverride(ALICE, i % 2 ? 1 : 2);
      expect(res.status).toBe(200);
    }
    const auditsBefore = await auditCount();
    const rowBefore = await overrideRow();
    expect(rowBefore?.allow).toBe(2);

    const refused = await putOverride(ALICE, 4);
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: 'Çok fazla yazma isteği. Lütfen bir dakika bekleyin.' });
    expect(refused.headers.ratelimit).toMatch(/limit=30, remaining=0/);
    expect(refused.headers['ratelimit-policy']).toBe('30;w=60');
    expect((await overrideRow())?.allow).toBe(2);
    expect(await auditCount()).toBe(auditsBefore);
  });

  it('is one budget across every write route, not 30 per route', async () => {
    const writes = [
      () => request(app).put(`${BASE}/${ROLE}`).set('Authorization', bearer(ALICE)).send({ allow: 1, deny: 0 }),
      () => request(app).delete(`${BASE}/${ROLE}`).set('Authorization', bearer(ALICE)),
      () => request(app).put(`${BASE}/batch`).set('Authorization', bearer(ALICE)).send({ overrides: [{ roleId: ROLE, allow: 1, deny: 0 }] }),
      () => request(app).post(`${BASE}/import`).set('Authorization', bearer(ALICE)).send({ overrides: [] }),
      () => request(app).post(`${BASE}/bulk-sync`).set('Authorization', bearer(ALICE)).send({ targetChannelIds: ['rl-other'] }),
    ];
    for (let i = 0; i < WRITE_LIMIT; i++) {
      const res = await writes[i % writes.length]!();
      expect(res.status).not.toBe(429);
    }
    for (const write of writes) expect((await write()).status).toBe(429);
  });

  it('is keyed by account, not address: another user behind the same IP keeps a full budget', async () => {
    for (let i = 0; i < WRITE_LIMIT; i++) await putOverride(ALICE, 1);
    expect((await putOverride(ALICE, 1)).status).toBe(429);

    const bob = await putOverride(BOB, 8);
    expect(bob.status).toBe(200);
    expect(bob.headers.ratelimit).toMatch(/limit=30, remaining=29/);
    expect((await overrideRow())?.allow).toBe(8);
  });

  it('unauthenticated requests are refused by auth first and spend no budget', async () => {
    for (let i = 0; i < WRITE_LIMIT + 5; i++) {
      const res = await request(app).put(`${BASE}/${ROLE}`).send({ allow: 1, deny: 0 });
      expect(res.status).toBe(401);
      expect(res.headers.ratelimit).toBeUndefined();
    }
    const first = await putOverride(ALICE, 1);
    expect(first.status).toBe(200);
    expect(first.headers.ratelimit).toMatch(/limit=30, remaining=29/);
  });
});

describe('channel permission read limit (real limiter)', () => {
  it('allows 60 reads per user per minute, then 429, independently of the write budget', async () => {
    for (let i = 0; i < WRITE_LIMIT; i++) await putOverride(ALICE, 1);
    expect((await putOverride(ALICE, 1)).status).toBe(429);

    const reads = [
      () => readOverrides(ALICE),
      () => request(app).get(`${BASE}/explain/me`).set('Authorization', bearer(ALICE)),
      () => request(app).get(`${BASE}/inheritance/${ROLE}`).set('Authorization', bearer(ALICE)),
      () => request(app).get(`${BASE}/export`).set('Authorization', bearer(ALICE)),
    ];
    for (let i = 0; i < READ_LIMIT; i++) {
      const res = await reads[i % reads.length]!();
      expect(res.status).toBe(200);
    }
    const refused = await readOverrides(ALICE);
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: 'Çok fazla istek. Lütfen bir dakika bekleyin.' });
    expect(refused.headers['ratelimit-policy']).toBe('60;w=60');

    // Bob's reads and writes are untouched by Alice's exhausted budgets.
    expect((await readOverrides(BOB)).status).toBe(200);
    expect((await putOverride(BOB, 1)).status).toBe(200);
  });
});
