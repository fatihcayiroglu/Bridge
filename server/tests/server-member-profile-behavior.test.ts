process.env.NODE_ENV = 'test';

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TINY_PNG } from './helpers/tinyImages';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-member-profile-'));
const PROFILE_DIR = path.join(TEST_ROOT, 'member-profiles');
fs.mkdirSync(PROFILE_DIR, { recursive: true });

const mockServersFindById = jest.fn();
const mockMembersFindOne = jest.fn();
const mockMembersUpdate = jest.fn();
const mockMagic = jest.fn();
const mockLiveRef = jest.fn();
const mockSharpToFile = jest.fn();
const mockLogger = { error: jest.fn() };

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => { req.user = { id: 'u1' }; next(); },
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: {
    messages: () => (_req: any, _res: any, next: any) => next(),
    upload: () => (_req: any, _res: any, next: any) => next(),
  },
}));
jest.mock('../db/repositories', () => ({
  Members: {
    findOne: (...a: any[]) => mockMembersFindOne(...a),
    update: (...a: any[]) => mockMembersUpdate(...a),
  },
  Servers: { findById: (...a: any[]) => mockServersFindById(...a) },
}));
jest.mock('../db/loader', () => ({ __esModule: true, default: { _pool: { tag: 'pool' } } }));
jest.mock('../lib/logger', () => mockLogger);
jest.mock('../lib/uploadReferenceSafety', () => ({ hasLiveUploadReference: (...a: any[]) => mockLiveRef(...a) }));
jest.mock('../lib/uploadFileSafety', () => ({
  canonicalExtensionForMime: (mime: string) => ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' } as any)[mime] ?? null,
  checkMagicBytes: (...a: any[]) => mockMagic(...a),
}));
jest.mock('../lib/runtimePaths', () => ({ uploadDir: (...parts: string[]) => path.join(TEST_ROOT, ...parts) }));
jest.mock('../lib/httpRequestDrain', () => ({
  respondDiscardingBody: (_req: any, res: any, status: number, body: any) => res.status(status).json(body),
}));
jest.mock('uuid', () => ({ v4: jest.fn()
  .mockReturnValueOnce('upload-1').mockReturnValueOnce('dest-1')
  .mockReturnValueOnce('upload-2').mockReturnValueOnce('dest-2')
  .mockReturnValueOnce('upload-3').mockReturnValueOnce('dest-3')
  .mockReturnValueOnce('upload-4').mockReturnValueOnce('dest-4')
  .mockReturnValueOnce('upload-5').mockReturnValueOnce('dest-5')
  .mockReturnValueOnce('upload-6').mockReturnValueOnce('dest-6')
  .mockReturnValueOnce('upload-7').mockReturnValueOnce('dest-7')
  .mockReturnValueOnce('upload-8').mockReturnValueOnce('dest-8')
  .mockReturnValue('stable-id') }));
jest.mock('sharp', () => ({
  __esModule: true,
  default: (src: string) => ({
    resize: (_w: number, _h?: number, _opts?: any) => ({
      toFile: async (dest: string) => mockSharpToFile(src, dest),
    }),
  }),
}));

import profileRouter from '../routes/serverMemberProfile';

const app = express();
app.use(express.json());
app.use('/api/servers/:serverId', profileRouter);
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err?.message || 'error' }));

function tinyPng(): Buffer {
  return TINY_PNG; // P7 B3: a real image — uploads are walked for metadata
}

function upload(url: string, mime = 'image/png') {
  return request(app).post(url).attach('file', tinyPng(), { filename: 'evil.html', contentType: mime });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockServersFindById.mockResolvedValue({ _id: 's1' });
  mockMembersFindOne.mockResolvedValue({
    userId: 'u1', serverId: 's1', displayName: 'Fallback', avatarUrl: '/global.png',
    serverProfile: {},
  });
  mockMembersUpdate.mockResolvedValue(undefined);
  mockMagic.mockReturnValue(true);
  mockLiveRef.mockResolvedValue(false);
  mockSharpToFile.mockImplementation(async (_src: string, dest: string) => { fs.writeFileSync(dest, Buffer.from('webp')); });
});

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('GET/PUT member profile', () => {
  test('GET returns 404 for missing server and 403 for non-member', async () => {
    mockServersFindById.mockResolvedValueOnce(null);
    expect((await request(app).get('/api/servers/s1/members/me/profile')).status).toBe(404);
    mockMembersFindOne.mockResolvedValueOnce(null);
    expect((await request(app).get('/api/servers/s1/members/me/profile')).status).toBe(403);
  });

  test('GET applies safe defaults and global avatar/display fallbacks', async () => {
    const r = await request(app).get('/api/servers/s1/members/me/profile');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      serverId: 's1', userId: 'u1', nickname: 'Fallback', bio: '', pronouns: '',
      bannerColor: '#2d9cdb', avatarUrl: '/global.png', bannerUrl: null, updatedAt: null,
    });
  });

  test('GET prefers server-specific fields', async () => {
    mockMembersFindOne.mockResolvedValueOnce({
      userId: 'u1', serverId: 's1', displayName: 'Fallback', avatarUrl: '/global.png',
      serverProfile: { nickname: 'Nick', bio: 'Bio', pronouns: 'they', bannerColor: '#aabbcc', avatarUrl: '/server.png', bannerUrl: '/banner.png', updatedAt: 5 },
    });
    const r = await request(app).get('/api/servers/s1/members/me/profile');
    expect(r.body).toEqual(expect.objectContaining({ nickname: 'Nick', bio: 'Bio', pronouns: 'they', bannerColor: '#aabbcc', avatarUrl: '/server.png', bannerUrl: '/banner.png', updatedAt: 5 }));
  });

  test('PUT returns 404/403 before mutating', async () => {
    mockServersFindById.mockResolvedValueOnce(null);
    expect((await request(app).put('/api/servers/s1/members/me/profile').send({ nickname: 'x' })).status).toBe(404);
    mockMembersFindOne.mockResolvedValueOnce(null);
    expect((await request(app).put('/api/servers/s1/members/me/profile').send({ nickname: 'x' })).status).toBe(403);
    expect(mockMembersUpdate).not.toHaveBeenCalled();
  });

  test('PUT rejects direct avatar/banner ownership injection', async () => {
    for (const body of [{ avatarUrl: 'https://attacker/x' }, { bannerUrl: '/uploads/other' }]) {
      const r = await request(app).put('/api/servers/s1/members/me/profile').send(body);
      expect(r.status).toBe(400);
    }
    expect(mockMembersUpdate).not.toHaveBeenCalled();
  });

  test('PUT trims/caps strings, validates color and preserves upload-owned fields', async () => {
    mockMembersFindOne.mockResolvedValueOnce({
      userId: 'u1', serverId: 's1',
      serverProfile: { avatarUrl: '/a.webp', bannerUrl: '/b.webp', custom: 'keep' },
    });
    const r = await request(app).put('/api/servers/s1/members/me/profile').send({
      nickname: `  ${'n'.repeat(50)}  `,
      bio: ` ${'b'.repeat(220)} `,
      pronouns: 123,
      bannerColor: 'red',
    });
    expect(r.status).toBe(200);
    expect(r.body.nickname).toHaveLength(32);
    expect(r.body.bio).toHaveLength(190);
    expect(r.body.pronouns).toBe('');
    expect(r.body.bannerColor).toBe('#2d9cdb');
    expect(r.body.avatarUrl).toBe('/a.webp');
    expect(r.body.bannerUrl).toBe('/b.webp');
    expect(mockMembersUpdate).toHaveBeenCalledWith('u1', 's1', { serverProfile: expect.objectContaining({ custom: 'keep', avatarUrl: '/a.webp', bannerUrl: '/b.webp' }) });
  });

  test('PUT accepts canonical hex colors', async () => {
    const r = await request(app).put('/api/servers/s1/members/me/profile').send({ bannerColor: '#Aa00fF' });
    expect(r.status).toBe(200);
    expect(r.body.bannerColor).toBe('#Aa00fF');
  });
});

describe('avatar upload authority and cleanup', () => {
  test('membership is checked before multipart write', async () => {
    mockMembersFindOne.mockResolvedValueOnce(null);
    const before = new Set(fs.readdirSync(PROFILE_DIR));
    const r = await upload('/api/servers/s1/members/me/avatar');
    expect(r.status).toBe(403);
    expect(new Set(fs.readdirSync(PROFILE_DIR))).toEqual(before);
  });

  test('missing file and unsupported MIME are rejected', async () => {
    expect((await request(app).post('/api/servers/s1/members/me/avatar')).status).toBe(400);
    const bad = await upload('/api/servers/s1/members/me/avatar', 'text/html');
    expect(bad.status).toBe(500);
    expect(mockMembersUpdate).not.toHaveBeenCalled();
  });

  test('magic mismatch deletes staged file and rejects content spoofing', async () => {
    mockMagic.mockReturnValueOnce(false);
    const r = await upload('/api/servers/s1/members/me/avatar');
    expect(r.status).toBe(400);
    expect(mockMembersUpdate).not.toHaveBeenCalled();
  });

  test('second membership read failure is propagated after staged-file cleanup', async () => {
    mockMembersFindOne.mockResolvedValueOnce({ userId: 'u1', serverId: 's1' }).mockRejectedValueOnce(new Error('membership db down'));
    const r = await upload('/api/servers/s1/members/me/avatar');
    expect(r.status).toBe(500);
    expect(r.body.error).toContain('membership db down');
  });

  test('stale membership between auth gate and commit returns 403', async () => {
    mockMembersFindOne.mockResolvedValueOnce({ userId: 'u1', serverId: 's1' }).mockResolvedValueOnce(null);
    expect((await upload('/api/servers/s1/members/me/avatar')).status).toBe(403);
    expect(mockMembersUpdate).not.toHaveBeenCalled();
  });

  test('image-processing failure cleans staging/destination and avoids DB ownership', async () => {
    mockSharpToFile.mockRejectedValueOnce(new Error('sharp fail'));
    const r = await upload('/api/servers/s1/members/me/avatar');
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('Image processing failed');
    expect(mockMembersUpdate).not.toHaveBeenCalled();
  });

  test('DB commit failure removes unowned new asset', async () => {
    mockMembersUpdate.mockRejectedValueOnce(new Error('db write failed'));
    const r = await upload('/api/servers/s1/members/me/avatar');
    expect(r.status).toBe(500);
    expect(r.body.error).toContain('db write failed');
  });

  test('successful avatar commit deletes unreferenced old local asset', async () => {
    const old = path.join(PROFILE_DIR, 'old-avatar.webp');
    fs.writeFileSync(old, 'old');
    mockMembersFindOne
      .mockResolvedValueOnce({ userId: 'u1', serverId: 's1', serverProfile: { avatarUrl: '/uploads/member-profiles/old-avatar.webp' } })
      .mockResolvedValueOnce({ userId: 'u1', serverId: 's1', serverProfile: { avatarUrl: '/uploads/member-profiles/old-avatar.webp' } });
    const r = await upload('/api/servers/s1/members/me/avatar');
    expect(r.status).toBe(200);
    expect(r.body.avatarUrl).toMatch(/^\/uploads\/member-profiles\/mp_av_.*\.webp$/);
    expect(fs.existsSync(old)).toBe(false);
    expect(mockLiveRef).toHaveBeenCalledWith(expect.anything(), 'uploads/member-profiles/old-avatar.webp');
  });

  test('shared old asset is retained and non-member-profile URLs are ignored', async () => {
    const old = path.join(PROFILE_DIR, 'shared.webp');
    fs.writeFileSync(old, 'old');
    mockLiveRef.mockResolvedValueOnce(true);
    mockMembersFindOne
      .mockResolvedValueOnce({ userId: 'u1', serverId: 's1', serverProfile: { avatarUrl: '/uploads/member-profiles/shared.webp' } })
      .mockResolvedValueOnce({ userId: 'u1', serverId: 's1', serverProfile: { avatarUrl: '/uploads/member-profiles/shared.webp' } });
    expect((await upload('/api/servers/s1/members/me/avatar')).status).toBe(200);
    expect(fs.existsSync(old)).toBe(true);

    mockMembersFindOne
      .mockResolvedValueOnce({ userId: 'u1', serverId: 's1', serverProfile: { avatarUrl: 'https://cdn.example/a.webp' } })
      .mockResolvedValueOnce({ userId: 'u1', serverId: 's1', serverProfile: { avatarUrl: 'https://cdn.example/a.webp' } });
    expect((await upload('/api/servers/s1/members/me/avatar')).status).toBe(200);
  });

  test('cleanup DB uncertainty fails closed on physical deletion and is observable', async () => {
    const old = path.join(PROFILE_DIR, 'uncertain.webp');
    fs.writeFileSync(old, 'old');
    mockLiveRef.mockRejectedValueOnce(new Error('reference db down'));
    mockMembersFindOne
      .mockResolvedValueOnce({ userId: 'u1', serverId: 's1', serverProfile: { avatarUrl: '/uploads/member-profiles/uncertain.webp' } })
      .mockResolvedValueOnce({ userId: 'u1', serverId: 's1', serverProfile: { avatarUrl: '/uploads/member-profiles/uncertain.webp' } });
    expect((await upload('/api/servers/s1/members/me/avatar')).status).toBe(200);
    expect(fs.existsSync(old)).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'member_profile.cleanup_failed' }), expect.any(String));
  });
});

describe('banner upload branches', () => {
  test('magic mismatch and processing failure reject banner', async () => {
    mockMagic.mockReturnValueOnce(false);
    expect((await upload('/api/servers/s1/members/me/banner')).status).toBe(400);
    mockSharpToFile.mockRejectedValueOnce(new Error('sharp'));
    expect((await upload('/api/servers/s1/members/me/banner')).status).toBe(500);
  });

  test('stale membership and DB update failure fail without committed ownership', async () => {
    mockMembersFindOne.mockResolvedValueOnce({ userId: 'u1', serverId: 's1' }).mockResolvedValueOnce(null);
    expect((await upload('/api/servers/s1/members/me/banner')).status).toBe(403);

    mockMembersFindOne.mockResolvedValue({ userId: 'u1', serverId: 's1', serverProfile: {} });
    mockMembersUpdate.mockRejectedValueOnce(new Error('db'));
    expect((await upload('/api/servers/s1/members/me/banner')).status).toBe(500);
  });

  test('successful banner preserves shared old object and returns canonical URL', async () => {
    const old = path.join(PROFILE_DIR, 'banner-old.webp');
    fs.writeFileSync(old, 'old');
    mockLiveRef.mockResolvedValueOnce(true);
    mockMembersFindOne.mockResolvedValue({ userId: 'u1', serverId: 's1', serverProfile: { bannerUrl: '/uploads/member-profiles/banner-old.webp' } });
    const r = await upload('/api/servers/s1/members/me/banner');
    expect(r.status).toBe(200);
    expect(r.body.bannerUrl).toMatch(/^\/uploads\/member-profiles\/mp_bn_.*\.webp$/);
    expect(fs.existsSync(old)).toBe(true);
  });
});
