// server/tests/channel-expiry-route.test.ts
//
// P7 D2: HTTP mapping of PUT /api/servers/:sid/channels/:cid/expiry. The
// locking, owner check and lifetime rules live in lib/channelExpiryConfig.ts
// and are proven against real PostgreSQL (channel-expiry-config.pgtest.ts);
// here: request validation, visibility, every refusal code and failures.
process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/permCache', () => ({ invalidatePerms: jest.fn() }));
const mockSetExpiry = jest.fn();
jest.mock('../lib/channelExpiryConfig', () => ({
  ...jest.requireActual('../lib/channelExpiryConfig'),
  setChannelExpiry: (...args: unknown[]) => mockSetExpiry(...args),
}));

import request from 'supertest';
import express from 'express';
const db  = require('../db/loader');
const jwt = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import channelsRouter from '../routes/servers/channels';

const OWNER = 'owner-1';
const OUTSIDER = 'outsider-1';
const SERVER = 'srv-1';
const CHANNEL = 'ch-1';
const tok = (uid: string) => jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/servers/:sid/channels', authMiddleware, channelsRouter);
  return a;
}
const put = (uid: string, body: unknown, cid = CHANNEL) =>
  request(app()).put(`/api/servers/${SERVER}/channels/${cid}/expiry`).set('Authorization', `Bearer ${tok(uid)}`).send(body as object);

beforeEach(async () => {
  db._reset?.();
  mockSetExpiry.mockReset();
  db._pool = {};
  for (const id of [OWNER, OUTSIDER]) await db.users.insert({ _id: id, username: id, displayName: id, tokenVersion: 0 });
  await db.servers.insert({ _id: SERVER, name: 'S', ownerId: OWNER });
  await db.members.insert({ userId: OWNER, serverId: SERVER, roles: [] });
  await db.channels.insert({ _id: CHANNEL, serverId: SERVER, name: 'c', type: 'text', order: 0, createdAt: 1 });
});
afterEach(() => { delete db._pool; });

describe('PUT /:cid/expiry', () => {
  it('requires expiresAt in the body', async () => {
    const res = await put(OWNER, {});
    expect(res.status).toBe(400);
    expect(mockSetExpiry).not.toHaveBeenCalled();
  });

  it('answers 503 without PostgreSQL', async () => {
    delete db._pool;
    expect((await put(OWNER, { expiresAt: null })).status).toBe(503);
  });

  it('hides unknown channels and channels the caller cannot view as 404', async () => {
    expect((await put(OWNER, { expiresAt: null }, 'missing')).status).toBe(404);
    expect((await put(OUTSIDER, { expiresAt: null })).status).toBe(404);
    expect(mockSetExpiry).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 404], ['forbidden', 403], ['invalid_request', 400],
    ['outside_window', 422], ['version_conflict', 409], ['last_permanent_channel', 409],
  ])('maps %s to %i with a stable code', async (reason, status) => {
    mockSetExpiry.mockResolvedValueOnce({ ok: false, reason });
    const res = await put(OWNER, { expiresAt: Date.now() + 3_600_000, expectedVersion: 1 });
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(reason.toUpperCase());
  });

  it('passes the request through and returns the stored expiry', async () => {
    const expiresAt = Date.now() + 3_600_000;
    mockSetExpiry.mockResolvedValueOnce({ ok: true, expiresAt, expiryVersion: 2 });
    const res = await put(OWNER, { expiresAt, expectedVersion: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ channelId: CHANNEL, expiresAt, expiryVersion: 2 });
    expect(mockSetExpiry).toHaveBeenCalledWith(db._pool, {
      serverId: SERVER, channelId: CHANNEL, actorId: OWNER, expiresAt, expectedVersion: 1,
    });
  });

  it('answers 500 without detail when the change fails', async () => {
    mockSetExpiry.mockRejectedValueOnce(new Error('db exploded: secret detail'));
    const res = await put(OWNER, { expiresAt: null });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});
