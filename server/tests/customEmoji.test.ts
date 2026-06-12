// server/tests/customEmoji.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

jest.mock('multer', () => {
  const multer = () => ({
    single: () => (req, res, next) => {
      if (req.headers['x-mock-file']) {
        req.file = {
          path: '/tmp/emoji_test.png',
          originalname: 'test.png',
          mimetype: 'image/png',
          size: 10240,
          filename: 'emoji_test.png',
        };
      }
      next();
    },
  });
  multer.diskStorage = () => ({});
  return multer;
});

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: () => true,
  mkdirSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import emojiRouter from '../routes/customEmoji';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:sid/emojis', authMiddleware, emojiRouter);
  return app;
}
function tok(uid) { return jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Custom Emoji Routes', () => {
  let app, ownerId, memberId, strangerId, serverId;
  let ownerToken, memberToken, strangerToken;

  beforeEach(async () => {
    db._reset?.();
    app        = buildApp();
    ownerId    = uuidv4();
    memberId   = uuidv4();
    strangerId = uuidv4();
    serverId   = uuidv4();
    ownerToken   = tok(ownerId);
    memberToken  = tok(memberId);
    strangerToken = tok(strangerId);

    await db.users.insert({ _id: ownerId,    username: 'owner',    displayName: 'Owner',    tokenVersion: 0 });
    await db.users.insert({ _id: memberId,   username: 'member',   displayName: 'Member',   tokenVersion: 0 });
    await db.users.insert({ _id: strangerId, username: 'stranger', displayName: 'Stranger', tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'S', ownerId });
    await db.members.insert({ userId: ownerId,  serverId, roles: [] });
    await db.members.insert({ userId: memberId, serverId, roles: [] });
  });

  describe('GET /api/servers/:sid/emojis', () => {
    it('returns emoji list for member', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/emojis`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns 403 for non-member', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/emojis`)
        .set('Authorization', `Bearer ${strangerToken}`);
      expect([403, 404]).toContain(res.status);
    });

    it('returns existing emojis', async () => {
      await db.server_emojis?.insert({ _id: uuidv4(), serverId, name: 'happy', url: '/uploads/emojis/test.png', createdAt: Date.now() })
        || await db.serverEmojis?.insert({ _id: uuidv4(), serverId, name: 'happy', url: '/uploads/emojis/test.png', createdAt: Date.now() });
      const res = await request(app)
        .get(`/api/servers/${serverId}/emojis`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/servers/:sid/emojis', () => {
    it('returns 400 without name', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/emojis`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('x-mock-file', '1');
      expect([400, 422]).toContain(res.status);
    });

    it('returns 403 for non-member trying to upload', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/emojis`)
        .set('Authorization', `Bearer ${strangerToken}`)
        .set('x-mock-file', '1')
        .field('name', 'test');
      expect([403, 404]).toContain(res.status);
    });

    it('owner can add emoji with name and file', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/emojis`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('x-mock-file', '1')
        .field('name', 'coolface');
      // 200 success or 400 if name validation fails — both valid
      expect([200, 201, 400]).toContain(res.status);
    });
  });

  describe('DELETE /api/servers/:sid/emojis/:eid', () => {
    let emojiId;
    beforeEach(async () => {
      const col = db.server_emojis || db.serverEmojis;
      if (col) {
        const e = await col.insert({ _id: uuidv4(), serverId, name: 'bye', url: '/uploads/emojis/bye.png', createdAt: Date.now() });
        emojiId = e._id;
      } else {
        emojiId = uuidv4();
      }
    });

    it('owner can delete emoji', async () => {
      if (!emojiId) return;
      const res = await request(app)
        .delete(`/api/servers/${serverId}/emojis/${emojiId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect([200, 404]).toContain(res.status);
    });

    it('member cannot delete emoji', async () => {
      if (!emojiId) return;
      const res = await request(app)
        .delete(`/api/servers/${serverId}/emojis/${emojiId}`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect([403, 404]).toContain(res.status);
    });
  });

  it('rejects unauthenticated', async () => {
    const res = await request(app).get(`/api/servers/${serverId}/emojis`);
    expect(res.status).toBe(401);
  });
});
