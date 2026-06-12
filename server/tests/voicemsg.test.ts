// server/tests/voicemsg.test.ts
// Sprint 73: storageAdapter mock eklendi — CDN entegrasyonu testi
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

jest.mock('form-data', () => {
  return jest.fn().mockImplementation(() => ({
    append:     jest.fn(),
    getHeaders: jest.fn().mockReturnValue({ 'content-type': 'multipart/form-data; boundary=test' }),
  }));
});

// storageAdapter mock — local davranışını simüle eder
jest.mock('../lib/storageAdapter', () => ({
  getStorageAdapter: jest.fn(() => ({
    uploadFile: jest.fn(async (localPath: string, key: string) => ({
      url:      `/uploads/${require('path').basename(localPath)}`,
      key:      null,
      provider: 'local' as const,
    })),
    deleteFile:   jest.fn(async () => {}),
    keyFromUrl:   jest.fn((url: string) => require('path').basename(url)),
    listFiles:    jest.fn(async () => []),
    healthCheck:  jest.fn(async () => true),
  })),
}));

import request from 'supertest';
import express from 'express';
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import voicemsgRouter from '../routes/voicemsg';
import { getStorageAdapter } from '../lib/storageAdapter';

function buildApp() {
  const app = express();
  app.set('io', null);
  app.use(express.json());
  app.use('/api/voice-messages', authMiddleware, voicemsgRouter);
  return app;
}
function tok(uid, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

// Gerçek bir .webm dosyası oluştur (multer filesize kontrolü için)
const TEMP_DIR  = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-vm-test-'));
const FAKE_WEBM = path.join(TEMP_DIR, 'test.webm');
fs.writeFileSync(FAKE_WEBM, Buffer.alloc(512, 0x00)); // 512 byte dummy

afterAll(() => {
  try { fs.rmSync(TEMP_DIR, { recursive: true }); } catch {}
});

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

    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;

    // Her test öncesi mock'ları temizle
    jest.clearAllMocks();
  });

  describe('GET /api/voice-messages/:vmId/transcript', () => {
    it('mevcut olmayan mesaj için 404 döner', async () => {
      const res = await request(app)
        .get(`/api/voice-messages/${uuidv4()}/transcript`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect([404, 403]).toContain(res.status);
    });

    it('kimlik doğrulamasız 401 döner', async () => {
      const res = await request(app).get(`/api/voice-messages/${uuidv4()}/transcript`);
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/voice-messages — upload', () => {
    it('dosya olmadan 400 döner', async () => {
      const res = await request(app)
        .post('/api/voice-messages')
        .set('Authorization', `Bearer ${ownerToken}`)
        .field('channelId', channelId)
        .field('serverId', serverId);
      expect([400, 422]).toContain(res.status);
    });

    it('kimlik doğrulamasız 401 döner', async () => {
      const res = await request(app)
        .post('/api/voice-messages')
        .send({ channelId, serverId });
      expect(res.status).toBe(401);
    });

    it('channelId eksikse 400 döner', async () => {
      const res = await request(app)
        .post('/api/voice-messages')
        .set('Authorization', `Bearer ${ownerToken}`)
        .field('serverId', serverId);
      expect([400, 422]).toContain(res.status);
    });

    it('sunucu üyesi olmayan kullanıcı 403 alır', async () => {
      const outsiderId = uuidv4();
      await db.users.insert({ _id: outsiderId, username: 'outsider', displayName: 'Outsider', tokenVersion: 0 });
      const res = await request(app)
        .post('/api/voice-messages')
        .set('Authorization', `Bearer ${tok(outsiderId)}`)
        .field('channelId', channelId)
        .field('serverId', serverId)
        .attach('audio', FAKE_WEBM, { contentType: 'audio/webm' });
      expect(res.status).toBe(403);
    });

    it('başarılı yüklemede storageAdapter.uploadFile çağrılır', async () => {
      const mockStore = getStorageAdapter();
      const res = await request(app)
        .post('/api/voice-messages')
        .set('Authorization', `Bearer ${ownerToken}`)
        .field('channelId', channelId)
        .field('serverId', serverId)
        .attach('audio', FAKE_WEBM, { contentType: 'audio/webm' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.msg.fileUrl).toMatch(/^\/uploads\//);
      expect(mockStore.uploadFile).toHaveBeenCalledTimes(1);
      // key formatı kontrol: uploads/<filename>
      const [, cdnKey] = (mockStore.uploadFile as jest.Mock).mock.calls[0];
      expect(cdnKey).toMatch(/^uploads\/vm_/);
    });
  });
});
