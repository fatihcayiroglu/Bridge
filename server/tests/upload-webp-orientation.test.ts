// server/tests/upload-webp-orientation.test.ts — WEBP_CONVERT with the REAL encoder.
//
// The WebP re-encode drops every EXIF field, including the display orientation a
// phone writes instead of rotating the pixels. Without applying it first, a
// portrait photo was stored sideways (P7 B3 keeps the orientation through
// metadata minimisation; the conversion threw it away again). This suite runs
// the real upload route with the real `sharp`: the stored WebP must carry the
// rotated pixels and no EXIF at all.

import os from 'os';
import path from 'path';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import sharp from 'sharp';
import { IDENTIFYING, containsAnyIdentifying, identifyingTiff, jpegSegment, noiseJpeg, withJpegSegments } from './helpers/imageFixtures';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-upload-webp-orient-'));
process.env.NODE_ENV = 'test';
process.env.BRIDGE_UPLOAD_ROOT = ROOT;
process.env.MAX_FILE_SIZE_MB = '8';
process.env.WEBP_CONVERT = 'true';

// The router loads sharp lazily (`await import('sharp')`). Other suites replace it
// with a VIRTUAL mock (sharp is an optional dependency); Jest caches how a module
// name resolves from a given file across the test files of one worker, so letting
// routes/upload.ts resolve the real package here would make those later mocks
// miss (measured: upload-webp-conversion then ran against the real encoder).
// Supplying the real module through the same kind of mock keeps that path alike.
jest.mock('sharp', () => jest.requireActual('sharp'), { virtual: true });

const mockUploadFile = jest.fn(async (_p: string, key: string) => ({ url: `/public/${key}`, key: null, provider: 'local' }));

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const value = String(req.headers.authorization || '');
    if (!value.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    req.user = { id: value.slice(7) || 'u1', username: 'tester' };
    next();
  },
}));
jest.mock('../middleware/rateLimit', () => ({ limits: { upload: () => (_r: any, _s: any, n: any) => n(), uploadChunk: () => (_r: any, _s: any, n: any) => n() } }));
jest.mock('../lib/adminAuthority', () => ({ isDatabaseAdmin: jest.fn(async () => false), databaseAdminOnly: (_r: any, _s: any, n: any) => n() }));
jest.mock('../lib/contentScanner', () => ({ scanFile: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../lib/svgSanitizer', () => ({ sanitizeSvgFile: jest.fn().mockResolvedValue({ safe: true }) }));
jest.mock('../lib/storageAdapter', () => ({
  getStorageAdapter: () => ({ uploadFile: mockUploadFile, deleteFile: jest.fn() }),
  getPrivateStorageAdapter: () => ({ uploadFile: mockUploadFile, deleteFile: jest.fn() }),
  getProvider: () => 'local',
  getPrivateStorageProvider: () => 'local',
}));
jest.mock('../db/postgres', () => ({ db: { _pool: { query: async () => ({ rows: [{ referenced: false }] }) } } }));
jest.mock('../db/repositories', () => ({ Boosts: { getHighestActiveTierForUser: async () => 3 } }));
jest.mock('../db/loader', () => ({
  __esModule: true,
  default: { uploads: { insert: jest.fn().mockResolvedValue({ _id: 'row' }), findOne: async () => null, remove: jest.fn() } },
}));

const router = require('../routes/upload').default;
const app = express();
app.use('/api/upload', router);
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status || 500).json({ error: err.message }));

afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

const exifApp1 = (orientation: number) =>
  jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), identifyingTiff(orientation)]));

describe('WEBP_CONVERT keeps how a photo looks (real encoder)', () => {
  it('a portrait phone photo (EXIF orientation 6) is stored upright, with no EXIF left', async () => {
    // 8×4 pixels as stored by the sensor; orientation 6 = display rotated 90° clockwise → 4×8.
    const photo = withJpegSegments(await noiseJpeg(8, 4), [exifApp1(6)]);
    expect(containsAnyIdentifying(photo).length).toBeGreaterThan(0); // the fixture really carries it

    const res = await request(app).post('/api/upload').set('Authorization', 'Bearer u1')
      .attach('file', photo, { filename: 'portrait.jpg', contentType: 'image/jpeg' }).expect(200);
    expect(res.body.fileType).toBe('image/webp');

    const stored = fs.readFileSync((mockUploadFile.mock.calls.at(-1) as any[])[0]);
    const meta = await sharp(stored).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([4, 8]);
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(containsAnyIdentifying(stored)).toEqual([]);
    expect(stored.includes(IDENTIFYING.make)).toBe(false);
  });

  it('a photo without orientation keeps its dimensions', async () => {
    const res = await request(app).post('/api/upload').set('Authorization', 'Bearer u1')
      .attach('file', await noiseJpeg(8, 4), { filename: 'landscape.jpg', contentType: 'image/jpeg' }).expect(200);
    expect(res.body.fileType).toBe('image/webp');
    const meta = await sharp(fs.readFileSync((mockUploadFile.mock.calls.at(-1) as any[])[0])).metadata();
    expect([meta.width, meta.height]).toEqual([8, 4]);
  });
});
