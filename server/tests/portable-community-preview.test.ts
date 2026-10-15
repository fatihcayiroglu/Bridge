// P7 C3: real Express route contract for an owner-only READ-ONLY
// community structure preview; no apply endpoint or DB writes are allowed.
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../routes/discover', () => ({ invalidateMemberCount: jest.fn(async () => {}) }));
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import serversRouter from '../routes/servers';
import { buildPortableCommunityStructure } from '../lib/portableCommunity';
import { stepUpHeader } from './helpers/stepUp';

const db = require('../db/loader') as import('./helpers/mockDb').MockDb;
const TARGET = 'c3-target', OWNER = 'c3-owner', STRANGER = 'c3-stranger';
const token = (id: string) => jwt.sign({ id, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
const app = () => {
  const instance = express();
  instance.use(express.json({ limit: '512kb' }));
  instance.use('/api/servers', serversRouter);
  return instance;
};
const source = () => buildPortableCommunityStructure(
  { _id: 'source-server', name: 'Source Server' },
  [{ _id: 'source-cat', name: 'General', position: 1, collapsed: false }],
  [{ _id: 'source-channel', name: 'Welcome', type: 'text', topic: '', categoryId: 'source-cat', order: 1 }],
  [{ _id: 'source-role', name: 'Moderator', permissions: 0, position: 0 }],
  '2026-10-11T12:00:00.000Z',
);
function preview(userId: string, body: string | object, scope: 'account-security' | 'sensitive-export' | null = null) {
  const q = request(app()).post(`/api/servers/${TARGET}/portable-import/preview`)
    .set('Authorization', `Bearer ${token(userId)}`);
  return (scope ? q.set(stepUpHeader(userId, scope)) : q).send(body);
}
async function snapshot() {
  return {
    servers: await db.servers.find({}),
    channels: await db.channels.find({}),
    categories: await db.channelCategories.find({}),
    roles: await db.roles.find({}),
    members: await db.members.find({}),
  };
}

beforeEach(async () => {
  db._reset();
  for (const id of [OWNER, STRANGER]) {
    await db.users.insert({ _id: id, username: id, password: 'hash', tokenVersion: 0 });
  }
  await db.servers.insert({ _id: TARGET, ownerId: OWNER, name: 'Destination' });
  await db.channelCategories.insert({ _id: 'target-cat', serverId: TARGET, name: 'General', position: 2 });
  await db.channels.insert({ _id: 'target-channel', serverId: TARGET, type: 'text', name: 'Welcome', order: 1 });
  await db.roles.insert({ _id: 'target-role', serverId: TARGET, name: 'Moderator', permissions: 0, position: 1 });
  await db.members.insert({ _id: 'membership-stranger', serverId: TARGET, userId: STRANGER, roles: [] });
});

describe('POST /api/servers/:sid/portable-import/preview', () => {
  it('blocks anonymous and nonowner requests before looking at source data', async () => {
    const anon = await request(app()).post(`/api/servers/${TARGET}/portable-import/preview`)
      .send({ document: source(), targetServerId: TARGET });
    expect(anon.status).toBe(401);
    const stranger = await preview(STRANGER, { document: source(), targetServerId: TARGET }, 'account-security');
    expect(stranger.status).toBe(403);
    expect(JSON.stringify(stranger.body)).not.toContain('Moderator');
  });

  it('requires the import-specific fresh account-security proof', async () => {
    const absent = await preview(OWNER, { document: source(), targetServerId: TARGET });
    expect(absent.status).toBe(403);
    expect(absent.body).toMatchObject({ error: 'STEP_UP_REQUIRED', scope: 'account-security' });
    const wrong = await preview(OWNER, { document: source(), targetServerId: TARGET }, 'sensitive-export');
    expect(wrong.status).toBe(403);
    expect(wrong.body.reasons).toContain('step_up_scope_mismatch');
  });

  it('rejects route/target mismatch, extra keys and damaged documents without writes', async () => {
    const original = await snapshot();
    const mismatch = await preview(OWNER, { document: source(), targetServerId: 'other-server' }, 'account-security');
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe('PORTABLE_COMMUNITY_TARGET_CHANGED');
    const extra = await preview(OWNER, { document: source(), targetServerId: TARGET, mode: 'apply' }, 'account-security');
    expect(extra.status).toBe(400);
    const corrupted = structuredClone(source());
    corrupted.channels[0].name = 'tampered';
    const invalid = await preview(OWNER, { document: corrupted, targetServerId: TARGET }, 'account-security');
    expect(invalid.status).toBe(422);
    expect(invalid.body.code).toBe('PORTABLE_COMMUNITY_INVALID');
    expect(await snapshot()).toEqual(original);
  });

  it('reports conservative target-name conflicts and never mutates destination', async () => {
    const original = await snapshot();
    const res = await preview(OWNER, { document: source(), targetServerId: TARGET }, 'account-security');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body).toMatchObject({
      mode: 'read-only', writesPerformed: false, importSupported: false,
      source: { serverId: 'source-server', counts: { categories: 1, roles: 1, channels: 1 } },
      target: { serverId: TARGET, counts: { categories: 1, roles: 1, channels: 1 } },
      conflicts: { total: 3, truncated: false },
    });
    expect(res.body.conflicts.items.map((x: { kind: string }) => x.kind).sort()).toEqual(['category', 'channel', 'role']);
    expect(res.body.blockers).toContain('IMPORT_NOT_IMPLEMENTED');
    expect(res.body.blockers).toContain('SOURCE_AUTHENTICITY_NOT_VERIFIED');
    expect(JSON.stringify(res.body)).not.toContain('membership-stranger');
    expect(await snapshot()).toEqual(original);
  });

  it('rejects missing targets and unavailable destination data without pretending to import', async () => {
    const missing = await request(app()).post('/api/servers/no-such-server/portable-import/preview')
      .set('Authorization', `Bearer ${token(OWNER)}`).set(stepUpHeader(OWNER, 'account-security'))
      .send({ document: source(), targetServerId: 'no-such-server' });
    expect(missing.status).toBe(404);
    await db.channels.insert({ _id: 'broken', serverId: TARGET, type: 'text', name: 123 });
    const fail = await preview(OWNER, { document: source(), targetServerId: TARGET }, 'account-security');
    expect(fail.status).toBe(503);
    expect(fail.body.code).toBe('PORTABLE_COMMUNITY_PREVIEW_UNAVAILABLE');
  });
});
