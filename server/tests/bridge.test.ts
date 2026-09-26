'use strict';

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV = 'test';

import { createMockDb, makeUser, makeServer, makeChannel } from './helpers/mockDb';
let db = createMockDb();
jest.mock('../db/index', () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb(); });
jest.mock('../db/loader', () => require('../db/index'));

const mockResolvePermissions = jest.fn();
jest.mock('../lib/permissions', () => ({
  PERMS: { VIEW_CHANNELS: 1 << 0, MANAGE_CHANNELS: 1 << 1, ADMINISTRATOR: 1 << 30 },
  hasPermission: (perms: number, flag: number) => (perms & (1 << 30)) !== 0 || (perms & flag) !== 0,
  resolvePermissions: (...args: unknown[]) => mockResolvePermissions(...args),
}));

jest.mock('../middleware/rateLimit', () => ({
  limits: { write: () => (_req: any, _res: any, next: () => void) => next() },
}));

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const jwt = require('jsonwebtoken');
import bridgeRouter from '../routes/bridge';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bridges', bridgeRouter);
  return app;
}
function tok(uid: string) {
  return jwt.sign({ id: uid, username: 'owner', displayName: 'Owner', v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

const MANAGE = (1 << 0) | (1 << 1);
let ownerId: string;
let sourceServerId: string;
let targetServerId: string;
let sourceChannelId: string;
let targetChannelId: string;
let ownerToken: string;

beforeEach(async () => {
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
  Object.assign(require('../db/index'), db);
  jest.clearAllMocks();

  ownerId = uuidv4();
  sourceServerId = uuidv4();
  targetServerId = uuidv4();
  sourceChannelId = uuidv4();
  targetChannelId = uuidv4();
  ownerToken = tok(ownerId);

  await db.users.insert(makeUser({ _id: ownerId, username: 'owner', tokenVersion: 0 }));
  await db.servers.insert(makeServer(ownerId, { _id: sourceServerId }));
  await db.servers.insert(makeServer(ownerId, { _id: targetServerId }));
  await db.channels.insert(makeChannel(sourceServerId, { _id: sourceChannelId }));
  await db.channels.insert(makeChannel(targetServerId, { _id: targetChannelId }));
  mockResolvePermissions.mockResolvedValue(MANAGE);
});

describe('Channel Bridge — tenant and permission authority', () => {
  it('creates a bridge only after both channel/server pairs resolve', async () => {
    const res = await request(buildApp())
      .post('/api/bridges')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sourceChannelId, targetChannelId, sourceServerId, targetServerId, label: 'safe' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      sourceChannelId, targetChannelId, sourceServerId, targetServerId, active: true,
    }));
    expect(mockResolvePermissions).toHaveBeenCalledWith(ownerId, sourceServerId, sourceChannelId);
    expect(mockResolvePermissions).toHaveBeenCalledWith(ownerId, targetServerId, targetChannelId);
  });

  it('rejects a self-bridge after canonicalizing mixed-type channel identifiers', async () => {
    const canonical = '12345';
    const res = await request(buildApp())
      .post('/api/bridges')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sourceChannelId: 12345, targetChannelId: canonical, sourceServerId, targetServerId });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/itself/i);
    expect(mockResolvePermissions).not.toHaveBeenCalled();
  });

  it('rejects blank identifiers instead of turning them into repository lookups', async () => {
    const res = await request(buildApp())
      .post('/api/bridges')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sourceChannelId: '   ', targetChannelId, sourceServerId, targetServerId });

    expect(res.status).toBe(400);
    expect(await db.channelBridges.find({})).toHaveLength(0);
  });

  it('rejects a client-supplied target server that does not own the target channel', async () => {
    const res = await request(buildApp())
      .post('/api/bridges')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sourceChannelId, targetChannelId, sourceServerId, targetServerId: sourceServerId });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mismatch/i);
    expect(await db.channelBridges.find({})).toHaveLength(0);
  });

  it('requires manage+view permission independently on the target endpoint', async () => {
    mockResolvePermissions.mockImplementation(async (_uid: string, sid: string) => sid === sourceServerId ? MANAGE : (1 << 0));
    const res = await request(buildApp())
      .post('/api/bridges')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sourceChannelId, targetChannelId, sourceServerId, targetServerId });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/target/i);
  });

  it('GET does not leak bridge metadata for a channel whose VIEW permission is revoked', async () => {
    await db.channelBridges.insert({
      _id: 'bridge1', sourceChannelId, sourceServerId, targetChannelId, targetServerId, active: true,
    });
    mockResolvePermissions.mockResolvedValue(0);

    const res = await request(buildApp())
      .get(`/api/bridges?channelId=${sourceChannelId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(403);
    expect(res.body).not.toEqual(expect.arrayContaining([expect.objectContaining({ _id: 'bridge1' })]));
  });

  it('DELETE fails closed when a legacy bridge row has a corrupt endpoint tenant', async () => {
    await db.channelBridges.insert({
      _id: 'bridge-corrupt',
      sourceChannelId, sourceServerId,
      targetChannelId, targetServerId: sourceServerId, // wrong tenant claim
      active: true,
    });

    const res = await request(buildApp())
      .delete('/api/bridges/bridge-corrupt')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(409);
    expect((await db.channelBridges.findOne({ _id: 'bridge-corrupt' }))?.active).toBe(true);
  });

  it('DELETE may be authorized from either valid endpoint, but never from neither', async () => {
    await db.channelBridges.insert({
      _id: 'bridge2', sourceChannelId, sourceServerId, targetChannelId, targetServerId, active: true,
    });
    mockResolvePermissions.mockImplementation(async (_uid: string, sid: string) => sid === targetServerId ? MANAGE : 0);

    const ok = await request(buildApp())
      .delete('/api/bridges/bridge2')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(ok.status).toBe(200);
    expect((await db.channelBridges.findOne({ _id: 'bridge2' }))?.active).toBe(false);
  });
});
