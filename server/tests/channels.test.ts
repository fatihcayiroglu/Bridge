// server/tests/channels.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import channelsRouter from '../routes/channels';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:sid/channels', authMiddleware, channelsRouter);
  return app;
}
function tok(uid) { return jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Channels Routes', () => {
  let app, ownerId, memberId, serverId, ownerToken, memberToken;

  beforeEach(async () => {
    db._reset?.();
    app       = buildApp();
    ownerId   = uuidv4();
    memberId  = uuidv4();
    serverId  = uuidv4();
    ownerToken  = tok(ownerId);
    memberToken = tok(memberId);

    await db.users.insert({ _id: ownerId,  username: 'owner',  displayName: 'Owner',  tokenVersion: 0 });
    await db.users.insert({ _id: memberId, username: 'member', displayName: 'Member', tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'S1', ownerId });
    await db.members.insert({ userId: ownerId,  serverId, roles: [] });
    await db.members.insert({ userId: memberId, serverId, roles: [] });
    // Seed one channel
    await db.channels.insert({ _id: uuidv4(), serverId, name: 'general', type: 'text', order: 0, createdAt: Date.now() });
  });

  describe('GET /api/servers/:sid/channels', () => {
    it('returns channel list for member', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/channels`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('returns 403 for non-member', async () => {
      const stranger = uuidv4();
      await db.users.insert({ _id: stranger, username: 's', displayName: 'S', tokenVersion: 0 });
      const res = await request(app)
        .get(`/api/servers/${serverId}/channels`)
        .set('Authorization', `Bearer ${tok(stranger)}`);
      expect([403, 404]).toContain(res.status);
    });
  });

  describe('POST /api/servers/:sid/channels', () => {
    it('owner can create text channel', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/channels`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'new-channel', type: 'text' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('_id');
      expect(res.body.name).toBe('new-channel');
    });

    it('owner can create voice channel', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/channels`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Voice', type: 'voice' });
      expect(res.status).toBe(200);
      expect(res.body.type).toBe('voice');
    });

    it('owner can create stage channel', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/channels`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Stage', type: 'stage' });
      expect(res.status).toBe(200);
      expect(res.body.type).toBe('stage');
    });

    it('rejects non-owner creating channel', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/channels`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ name: 'hack', type: 'text' });
      expect(res.status).toBe(403);
    });

    it('rejects missing name', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/channels`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ type: 'text' });
      expect(res.status).toBe(400);
    });

    it('rejects invalid type', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/channels`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'bad', type: 'invalid_type' });
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/servers/:sid/channels/:cid', () => {
    let channelId;
    beforeEach(async () => {
      const ch = await db.channels.insert({ _id: uuidv4(), serverId, name: 'edit-me', type: 'text', order: 1, createdAt: Date.now() });
      channelId = ch._id;
    });

    it('owner can rename channel', async () => {
      const res = await request(app)
        .patch(`/api/servers/${serverId}/channels/${channelId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'renamed' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('renamed');
    });

    it('member cannot rename channel', async () => {
      const res = await request(app)
        .patch(`/api/servers/${serverId}/channels/${channelId}`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ name: 'hacked' });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/servers/:sid/channels/:cid', () => {
    let channelId;
    beforeEach(async () => {
      const ch = await db.channels.insert({ _id: uuidv4(), serverId, name: 'bye', type: 'text', order: 2, createdAt: Date.now() });
      channelId = ch._id;
    });

    it('owner can delete channel', async () => {
      const res = await request(app)
        .delete(`/api/servers/${serverId}/channels/${channelId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
    });

    it('member cannot delete channel', async () => {
      const res = await request(app)
        .delete(`/api/servers/${serverId}/channels/${channelId}`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
    });
  });

  it('rejects unauthenticated', async () => {
    const res = await request(app).get(`/api/servers/${serverId}/channels`);
    expect(res.status).toBe(401);
  });
});
