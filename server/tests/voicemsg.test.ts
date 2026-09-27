// server/tests/voicemsg.test.ts
// Sprint 73: storageAdapter mock eklendi — CDN entegrasyonu testi
process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());


// storageAdapter mock — local davranışını simüle eder
const makeMockPrivateStore = () => ({
  uploadFile: jest.fn(async (localPath: string, key: string) => ({
    url:      `/uploads/${require('path').basename(localPath)}`,
    key:      null,
    provider: 'local' as const,
  })),
  deleteFile:   jest.fn(async () => {}),
  keyFromUrl:   jest.fn((url: string) => require('path').basename(url)),
  listFiles:    jest.fn(async () => []),
  healthCheck:  jest.fn(async () => true),
});
const mockPrivateStore = makeMockPrivateStore();
jest.mock('../lib/storageAdapter', () => ({
  getPrivateStorageAdapter: jest.fn(() => mockPrivateStore),
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
import { getPrivateStorageAdapter } from '../lib/storageAdapter';
import { PERMS } from '../lib/permissions';

import { uploadRoot } from '../lib/runtimePaths';
function buildApp() {
  const app = express();
  app.set('io', null);
  app.use(express.json());
  app.use('/api/voice-messages', authMiddleware, voicemsgRouter);
  return app;
}
function tok(uid: string, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

// Gerçek bir .webm dosyası oluştur (multer filesize kontrolü için)
const TEMP_DIR  = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-vm-test-'));
const FAKE_WEBM = path.join(TEMP_DIR, 'test.webm');
fs.writeFileSync(FAKE_WEBM, Buffer.alloc(512, 0x00)); // 512 byte dummy

afterAll(() => {
  try { fs.rmSync(TEMP_DIR, { recursive: true }); } catch {}
});

afterEach(() => {
  const mockStore = getPrivateStorageAdapter() as unknown as { uploadFile: jest.Mock };
  for (const [localPath] of mockStore.uploadFile.mock?.calls ?? []) {
    try {
      const resolved = path.resolve(String(localPath));
      const uploadsRoot = path.resolve(uploadRoot()) + path.sep;
      if (resolved.startsWith(uploadsRoot) && path.basename(resolved).startsWith('vm_')) fs.unlinkSync(resolved);
    } catch {}
  }
});

describe('Voice Messages Routes', () => {
  let app: express.Express;
  let ownerId: string;
  let serverId: string;
  let channelId: string;
  let ownerToken: string;

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

    it('kanalı artık göremeyen üye transcript alamaz', async () => {
      const viewerId = uuidv4();
      await db.users.insert({ _id: viewerId, username: 'viewer', displayName: 'Viewer', tokenVersion: 0 });
      await db.members.insert({ userId: viewerId, serverId, roles: [] });
      await db.channelOverrides.insert({
        _id: uuidv4(), channelId, targetType: 'user', targetId: viewerId,
        allow: 0, deny: PERMS.VIEW_CHANNELS, position: 0,
      });
      const vmId = uuidv4();
      await db.voiceMessages.insert({
        _id: vmId, channelId, serverId, userId: ownerId,
        url: '/uploads/vm-private.webm', transcript: 'private transcript', createdAt: Date.now(),
      });

      const res = await request(app)
        .get(`/api/voice-messages/${vmId}/transcript`)
        .set('Authorization', `Bearer ${tok(viewerId)}`);
      expect(res.status).toBe(403);
      expect(res.body.transcript).toBeUndefined();
    });

    it('READ_HISTORY izni olmayan üye transcript alamaz', async () => {
      const viewerId = uuidv4();
      const roleId = uuidv4();
      await db.users.insert({ _id: viewerId, username: 'viewer2', displayName: 'Viewer2', tokenVersion: 0 });
      await db.roles.insert({ _id: roleId, serverId, name: 'no-history', position: 1, permissions: PERMS.VIEW_CHANNELS });
      await db.members.insert({ userId: viewerId, serverId, roles: [roleId] });
      const vmId = uuidv4();
      await db.voiceMessages.insert({
        _id: vmId, channelId, serverId, userId: ownerId,
        url: '/uploads/vm-private.webm', transcript: 'private transcript', createdAt: Date.now(),
      });

      const res = await request(app)
        .get(`/api/voice-messages/${vmId}/transcript`)
        .set('Authorization', `Bearer ${tok(viewerId)}`);
      expect(res.status).toBe(403);
      expect(res.body.transcript).toBeUndefined();
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

    it("client channelId/serverId eşleşmesini uydurursa upload storage'a ulaşmaz", async () => {
      const otherServerId = uuidv4();
      await db.servers.insert({ _id: otherServerId, name: 'Other', ownerId });
      await db.members.insert({ userId: ownerId, serverId: otherServerId, roles: [] });
      const mockStore = getPrivateStorageAdapter();

      const res = await request(app)
        .post('/api/voice-messages')
        .set('Authorization', `Bearer ${ownerToken}`)
        .field('channelId', channelId)
        .field('serverId', otherServerId)
        .attach('audio', FAKE_WEBM, { contentType: 'audio/webm' });

      expect(res.status).toBe(403);
      expect(mockStore.uploadFile).not.toHaveBeenCalled();
    });

    it('private kanalı göremeyen üye voice-message persist edemez', async () => {
      const memberId = uuidv4();
      await db.users.insert({ _id: memberId, username: 'member', displayName: 'Member', tokenVersion: 0 });
      await db.members.insert({ userId: memberId, serverId, roles: [] });
      await db.channelOverrides.insert({
        _id: uuidv4(), channelId, targetType: 'user', targetId: memberId,
        allow: 0, deny: PERMS.VIEW_CHANNELS, position: 0,
      });
      const mockStore = getPrivateStorageAdapter();

      const res = await request(app)
        .post('/api/voice-messages')
        .set('Authorization', `Bearer ${tok(memberId)}`)
        .field('channelId', channelId)
        .field('serverId', serverId)
        .attach('audio', FAKE_WEBM, { contentType: 'audio/webm' });

      expect(res.status).toBe(403);
      expect(mockStore.uploadFile).not.toHaveBeenCalled();
      expect(await db.voiceMessages.count({ channelId })).toBe(0);
    });

    it('ATTACH_FILES izni olmayan üye voice-message persist edemez', async () => {
      const memberId = uuidv4();
      const roleId = uuidv4();
      await db.users.insert({ _id: memberId, username: 'noattach', displayName: 'No Attach', tokenVersion: 0 });
      await db.roles.insert({
        _id: roleId, serverId, name: 'no-attach', position: 1,
        permissions: PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES | PERMS.READ_HISTORY,
      });
      await db.members.insert({ userId: memberId, serverId, roles: [roleId] });
      const mockStore = getPrivateStorageAdapter();

      const res = await request(app)
        .post('/api/voice-messages')
        .set('Authorization', `Bearer ${tok(memberId)}`)
        .field('channelId', channelId)
        .field('serverId', serverId)
        .attach('audio', FAKE_WEBM, { contentType: 'audio/webm' });

      expect(res.status).toBe(403);
      expect(mockStore.uploadFile).not.toHaveBeenCalled();
    });

    it('başarılı yüklemede storageAdapter.uploadFile çağrılır', async () => {
      const mockStore = getPrivateStorageAdapter();
      (getPrivateStorageAdapter as jest.Mock).mockReturnValue(mockStore);
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
