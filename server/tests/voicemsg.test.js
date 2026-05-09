// server/tests/voiceMessages.test.js
// Note: voicemsg.js — ses mesajı yükleme (multer) + transkripsiyon
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

// voicemsg.js uses form-data for transcription
jest.mock('form-data', () => {
  return jest.fn().mockImplementation(() => ({
    append:     jest.fn(),
    getHeaders: jest.fn().mockReturnValue({ 'content-type': 'multipart/form-data; boundary=test' }),
  }));
});

const request = require('supertest');
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { v4: uuidv4 } = require('uuid');
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
const { authMiddleware } = require('../middleware/auth');
const voicemsgRouter = require('../routes/voicemsg');

function buildApp() {
  const app = express();
  app.set('io', null); // explicit null — no global leak, routes guard with if (io)
  app.use(express.json());
  app.use('/api/voice-messages', authMiddleware, voicemsgRouter);
  return app;
}
function tok(uid, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Voice Messages Routes', () => {
  let app, ownerId, serverId, channelId;
  let ownerToken;

  beforeEach(async () => {
    db._reset?.();
    app       = buildApp();
    ownerId   = uuidv4();
    serverId  = uuidv4();
    channelId = uuidv4();
    ownerToken = tok(ownerId);

    await db.users.insert({ _id: ownerId, username: 'owner', displayName: 'Owner', tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'TestServer', ownerId });
    await db.members.insert({ userId: ownerId, serverId, roles: [] });
    await db.channels.insert({ _id: channelId, serverId, name: 'general', type: 'text' });

    // No AI keys in test env
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  describe('GET /api/voice-messages/:msgId', () => {
    it('returns 404 for nonexistent voice message', async () => {
      const res = await request(app)
        .get(`/api/voice-messages/${uuidv4()}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect([404, 403]).toContain(res.status);
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app).get(`/api/voice-messages/${uuidv4()}`);
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/voice-messages — upload', () => {
    it('returns 400 when no file is provided', async () => {
      const res = await request(app)
        .post('/api/voice-messages')
        .set('Authorization', `Bearer ${ownerToken}`)
        .field('channelId', channelId)
        .field('serverId', serverId);
      expect([400, 422]).toContain(res.status);
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app)
        .post('/api/voice-messages')
        .send({ channelId, serverId });
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/voice-messages/:msgId', () => {
    it('returns 404 for nonexistent message', async () => {
      const res = await request(app)
        .delete(`/api/voice-messages/${uuidv4()}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect([404, 403]).toContain(res.status);
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app).delete(`/api/voice-messages/${uuidv4()}`);
      expect(res.status).toBe(401);
    });
  });
});
