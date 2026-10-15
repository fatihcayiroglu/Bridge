// server/tests/server-join-raid-answers.test.ts
//
// POST /api/servers/:sid/join during a raid. The join library and the raid
// protection are unit-tested with each other mocked; the HTTP answers the
// route gives a client during a raid had never run. Here the real router, JWT
// auth, join library, raid protection and repositories run on the mock DB:
//   - while a strict server is locked down, a join answers 429 RAID_LOCKDOWN
//     with Retry-After (whole seconds, rounded up), the lockdown end and the
//     level, and creates no membership;
//   - a real surge of unique accounts into a strict server: the joins up to
//     the limit succeed, the first one over it locks the server down (durable
//     `raidLockdownUntil`) and is refused, and so is every later one;
//   - when the shared raid counter is unavailable, an eligible join is refused
//     fail-closed with 503 RAID_PROTECTION_UNAVAILABLE and Retry-After: 1;
//   - a balanced server in raid mode still admits joins (it holds young
//     accounts instead of refusing them).
// Only the rate limiter is replaced, so that a burst of joins measures the
// raid protection and not the per-route limit.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV = 'test';

jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));
jest.mock('../routes/discover', () => ({ invalidateMemberCount: jest.fn(async () => {}) }));

let db: MockDb;
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../db/index', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});

import request from 'supertest';
import express from 'express';
import serversRouter from '../routes/servers';
import { cache } from '../lib/redisAdapter';
import { RAID_POLICIES, _resetRaidProtectionForTests } from '../lib/raidProtection';
import type { MockDb } from './helpers/mockDb';

const jwt = require('jsonwebtoken');
const tok = (uid: string) => jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

let app: express.Express;
const SID = 'srv-raid';
const OWNER = 'user-owner';

const join = (userId: string) =>
  request(app).post(`/api/servers/${SID}/join`).set('Authorization', `Bearer ${tok(userId)}`).send({});
const isMember = async (userId: string) => (await db.members.find({ userId, serverId: SID })).length === 1;
const serverRow = async () => (await db.servers.findOne({ _id: SID })) as Record<string, unknown>;

async function addUsers(n: number, prefix: string): Promise<string[]> {
  const { makeUser } = require('./helpers/mockDb');
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${prefix}-${i}`;
    await db.users.insert(makeUser({ _id: id, username: id }));
    ids.push(id);
  }
  return ids;
}

beforeEach(async () => {
  const { createMockDb, makeUser } = require('./helpers/mockDb');
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);
  _resetRaidProtectionForTests();

  await db.users.insert(makeUser({ _id: OWNER, username: 'owner' }));
  await db.servers.insert({
    _id: SID, name: 'Raided', ownerId: OWNER, discoverable: true, raidMitigationLevel: 'strict', createdAt: Date.now(),
  });
  await db.members.insert({ userId: OWNER, serverId: SID, roles: [], joinedAt: Date.now() });

  app = express();
  app.use(express.json());
  app.use('/api/servers', serversRouter);
});
afterEach(() => { jest.restoreAllMocks(); });

describe('POST /api/servers/:sid/join during a raid', () => {
  it('while a strict server is locked down, a join is refused with 429, Retry-After and the lockdown end', async () => {
    const [joiner] = await addUsers(1, 'late');
    const lockdownUntil = Date.now() + 90_500;
    await db.servers.update({ _id: SID }, { $set: { raidLockdownUntil: lockdownUntil } });

    const res = await join(joiner!);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      error: 'RAID_LOCKDOWN', retryAfterMs: expect.any(Number), lockdownUntil, level: 'strict',
    });
    expect(res.body.retryAfterMs).toBeGreaterThan(80_000);
    expect(res.body.retryAfterMs).toBeLessThanOrEqual(90_500);
    expect(res.headers['retry-after']).toBe(String(Math.ceil(res.body.retryAfterMs / 1000)));
    expect(await isMember(joiner!)).toBe(false);
  });

  it('a surge of unique accounts: joins up to the limit succeed, the first over it locks the server down, and later ones are refused', async () => {
    const limit = RAID_POLICIES.strict.maxUniqueAccounts;
    const accounts = await addUsers(limit + 2, 'raider');

    for (const id of accounts.slice(0, limit)) expect((await join(id)).status).toBe(200);
    expect((await serverRow()).raidLockdownUntil ?? null).toBeNull();

    const crossing = await join(accounts[limit]!);
    expect(crossing.status).toBe(429);
    expect(crossing.body).toMatchObject({ error: 'RAID_LOCKDOWN', level: 'strict' });
    const persisted = Number((await serverRow()).raidLockdownUntil);
    expect(persisted).toBe(crossing.body.lockdownUntil);
    expect(persisted).toBeGreaterThan(Date.now());

    const after = await join(accounts[limit + 1]!);
    expect(after.status).toBe(429);
    expect(after.body.lockdownUntil).toBe(persisted);

    for (const id of accounts.slice(0, limit)) expect(await isMember(id)).toBe(true);
    expect(await isMember(accounts[limit]!)).toBe(false);
    expect(await isMember(accounts[limit + 1]!)).toBe(false);
  });

  it('when the shared raid counter is unavailable, an eligible join is refused fail-closed with 503 and Retry-After: 1', async () => {
    const [joiner] = await addUsers(1, 'outage');
    jest.spyOn(cache, 'claimCooldown').mockRejectedValue(new Error('redis unavailable'));

    const res = await join(joiner!);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'RAID_PROTECTION_UNAVAILABLE', retryAfterMs: 1000 });
    expect(res.headers['retry-after']).toBe('1');
    expect(await isMember(joiner!)).toBe(false);
  });

  it('a balanced server in raid mode still admits a join (it holds young accounts instead)', async () => {
    const [joiner] = await addUsers(1, 'balanced');
    await db.servers.update({ _id: SID }, { $set: { raidMitigationLevel: 'balanced', raidLockdownUntil: Date.now() + 60_000 } });

    const res = await join(joiner!);
    expect(res.status).toBe(200);
    expect(await isMember(joiner!)).toBe(true);
  });
});
