// server/tests/pins.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import pinsRouter from '../routes/pins';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/channels', authMiddleware, pinsRouter);
  return app;
}
function tok(uid: string) { return jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Pins Routes', () => {
  let app: express.Express;
  let ownerId: string;
  let memberId: string;
  let strangerId: string;
  let serverId: string;
  let channelId: string;
  let memberToken: string;
  let strangerToken: string;
  let pinnedMsgId: string;
  let unpinnedMsgId: string;

  beforeEach(async () => {
    db._reset?.();
    app       = buildApp();
    ownerId   = uuidv4();
    memberId  = uuidv4();
    strangerId = uuidv4();
    serverId  = uuidv4();
    channelId = uuidv4();
    memberToken  = tok(memberId);
    strangerToken = tok(strangerId);

    await db.users.insert({ _id: ownerId,    username: 'owner',    displayName: 'Owner',    tokenVersion: 0 });
    await db.users.insert({ _id: memberId,   username: 'member',   displayName: 'Member',   tokenVersion: 0 });
    await db.users.insert({ _id: strangerId, username: 'stranger', displayName: 'Stranger', tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'S', ownerId });
    await db.members.insert({ userId: ownerId,  serverId, roles: [] });
    await db.members.insert({ userId: memberId, serverId, roles: [] });
    await db.channels.insert({ _id: channelId, serverId, name: 'general', type: 'text' });

    pinnedMsgId   = uuidv4();
    unpinnedMsgId = uuidv4();
    await db.messages.insert({ _id: pinnedMsgId,   channelId, userId: ownerId,  content: 'Pinned!',   pinned: true,  createdAt: Date.now() - 2000 });
    await db.messages.insert({ _id: unpinnedMsgId, channelId, userId: memberId, content: 'Not pinned', pinned: false, createdAt: Date.now() - 1000 });
  });

  describe('GET /api/channels/:cid/pins', () => {
    it('returns pinned messages for member', async () => {
      const res = await request(app)
        .get(`/api/channels/${channelId}/pins`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const ids = res.body.map((m: Record<string, unknown>) => m._id);
      expect(ids).toContain(pinnedMsgId);
      expect(ids).not.toContain(unpinnedMsgId);
    });

    it('rejects unsafe file-history pagination before it reaches the repository', async () => {
      for (const query of ['limit=-1', 'limit=1.5', 'limit=9007199254740992', 'before=-1', 'before=1.5', 'before=9007199254740992']) {
        const res = await request(app)
          .get(`/api/channels/${channelId}/files?${query}`)
          .set('Authorization', `Bearer ${memberToken}`);
        expect(res.status).toBe(400);
      }
    });

    it('returns 403 for non-member', async () => {
      const res = await request(app)
        .get(`/api/channels/${channelId}/pins`)
        .set('Authorization', `Bearer ${strangerToken}`);
      expect([403, 404]).toContain(res.status);
    });

    it('returns 404 for nonexistent channel', async () => {
      const res = await request(app)
        .get(`/api/channels/${uuidv4()}/pins`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(404);
    });
  });

  // The HTTP pins router is read-only. Pin mutations are covered by the
  // authenticated message socket handler in messages-edit.test.ts.

  describe('GET /api/channels/:cid/files', () => {
    beforeEach(async () => {
      await db.messages.insert({ _id: uuidv4(), channelId, userId: ownerId, type: 'file', content: '', fileUrl: '/uploads/test.pdf', createdAt: Date.now() });
    });

    it('returns file messages for member', async () => {
      const res = await request(app)
        .get(`/api/channels/${channelId}/files`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns 403 for non-member', async () => {
      const res = await request(app)
        .get(`/api/channels/${channelId}/files`)
        .set('Authorization', `Bearer ${strangerToken}`);
      expect([403, 404]).toContain(res.status);
    });
  });

  it('rejects unauthenticated', async () => {
    const res = await request(app).get(`/api/channels/${channelId}/pins`);
    expect(res.status).toBe(401);
  });
});
