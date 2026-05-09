// server/tests/bridge.test.js
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

// Mock roles module used by bridge.js
jest.mock('../routes/roles', () => ({
  getMemberPerms: jest.fn(),
  hasPermission:  jest.fn(),
  PERMS: { MANAGE_CHANNELS: 2, ADMINISTRATOR: 1 << 30 },
}));

const request = require('supertest');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
const { authMiddleware } = require('../middleware/auth');
const bridgeRouter = require('../routes/bridge');
const roles   = require('../routes/roles');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bridges', authMiddleware, bridgeRouter);
  return app;
}
function tok(uid, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Channel Bridge Routes', () => {
  let app, ownerId, serverId1, serverId2, channelId1, channelId2;
  let ownerToken;

  beforeEach(async () => {
    db._reset?.();
    app      = buildApp();
    ownerId  = uuidv4();
    serverId1 = uuidv4();
    serverId2 = uuidv4();
    channelId1 = uuidv4();
    channelId2 = uuidv4();
    ownerToken = tok(ownerId);

    await db.users.insert({ _id: ownerId, username: 'owner', displayName: 'Owner', tokenVersion: 0 });

    // Default: owner has MANAGE_CHANNELS in both servers
    roles.getMemberPerms.mockResolvedValue(2); // MANAGE_CHANNELS bitmask
    roles.hasPermission.mockReturnValue(true);
  });

  describe('POST /api/bridges — create bridge', () => {
    it('creates a bridge between two channels', async () => {
      const res = await request(app)
        .post('/api/bridges')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ sourceChannelId: channelId1, targetChannelId: channelId2, sourceServerId: serverId1, targetServerId: serverId2 });
      expect(res.status).toBe(200);
      expect(res.body.sourceChannelId).toBe(channelId1);
      expect(res.body.targetChannelId).toBe(channelId2);
      expect(res.body.active).toBe(true);
    });

    it('returns 409 if bridge already exists', async () => {
      await db.channelBridges.insert({ _id: uuidv4(), sourceChannelId: channelId1, targetChannelId: channelId2, active: true });
      const res = await request(app)
        .post('/api/bridges')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ sourceChannelId: channelId1, targetChannelId: channelId2, sourceServerId: serverId1, targetServerId: serverId2 });
      expect(res.status).toBe(409);
    });

    it('returns 400 when bridging channel to itself', async () => {
      const res = await request(app)
        .post('/api/bridges')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ sourceChannelId: channelId1, targetChannelId: channelId1, sourceServerId: serverId1, targetServerId: serverId2 });
      expect(res.status).toBe(400);
    });

    it('returns 400 when required fields missing', async () => {
      const res = await request(app)
        .post('/api/bridges')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ sourceChannelId: channelId1 });
      expect(res.status).toBe(400);
    });

    it('returns 403 when user lacks permission', async () => {
      roles.hasPermission.mockReturnValue(false);
      const res = await request(app)
        .post('/api/bridges')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ sourceChannelId: channelId1, targetChannelId: channelId2, sourceServerId: serverId1, targetServerId: serverId2 });
      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app).post('/api/bridges').send({});
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/bridges?channelId=xxx', () => {
    beforeEach(async () => {
      await db.channelBridges.insert({ _id: uuidv4(), sourceChannelId: channelId1, targetChannelId: channelId2, active: true });
    });

    it('returns bridges for a channel', async () => {
      const res = await request(app)
        .get(`/api/bridges?channelId=${channelId1}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('returns 400 when channelId is missing', async () => {
      const res = await request(app)
        .get('/api/bridges')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(400);
    });
  });
});
