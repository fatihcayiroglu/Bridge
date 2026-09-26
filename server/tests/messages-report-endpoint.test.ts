// server/tests/messages-report-endpoint.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// POST /api/messages/:id/report — VARLIK ORAKÜLÜ OLMAMALI
// ════════════════════════════════════════════════════════════════════════════
//
// Bu uç, `routes/messages.ts` içinde ÖLÇÜLMEMİŞ en büyük bloktu. Taşıdığı
// güvenlik özelliği inceliklidir ve testsiz kolayca kaybolur:
//
//   · Var olmayan mesaj                         → 404
//   · Var olan ama GÖRÜLEMEYEN kanaldaki mesaj  → AYNI 404
//
// İki durumun ayrışması (ör. 403 vs 404) uç noktayı bir VARLIK ORAKÜLÜNE
// çevirir: saldırgan, göremediği bir kanaldaki mesaj kimliklerini yanıt
// koduna bakarak sayabilir. Ayrıca:
//
//   · Geçersiz sebep / çok uzun detay            → 400 (doğrulama)
//   · Kendi mesajını raporlama                   → 400
//   · Aynı raporun tekrarı                       → 200 (yeni kayıt yok)
//   · İlk rapor                                  → 201

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();

jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: Request & { user?: unknown }, res: Response, next: NextFunction) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const jwtLib = require('jsonwebtoken');
    try { req.user = jwtLib.verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!'); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  },
  verifyToken: (t: string) => {
    try { return require('jsonwebtoken').verify(t, 'test-jwt-secret-long-enough-32chars!!'); } catch { return null; }
  },
}));

jest.mock('../lib/redisAdapter', () => ({
  ...jest.requireActual('../lib/redisAdapter'),
  cache: {
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
    get: async () => null, set: async () => undefined, del: async () => undefined,
  },
}));

import request from 'supertest';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
const jwt = require('jsonwebtoken');

import messagesRouter from '../routes/messages';

const app = express();
app.use(express.json());
app.use('/api/channels', messagesRouter);
app.use('/api/messages', messagesRouter);
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) =>
  res.status(err.status ?? 500).json({ error: err.message }));

const tok = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const REPORTER = 'rap-eden';
const AUTHOR   = 'rap-yazar';
const SRV      = 'srv-R';
const OPEN_CH  = 'rch-acik';
const HIDDEN_CH = 'rch-gizli';
const VIEW_CHANNELS = 1 << 0;

const HIDDEN_TEXT = 'GIZLI-KANAL-METNI-RAPOR';

beforeAll(async () => {
  await mockDb.users.insert({ _id: REPORTER, username: REPORTER, displayName: 'Raporcu' });
  await mockDb.users.insert({ _id: AUTHOR, username: AUTHOR, displayName: 'Yazar' });
  await mockDb.servers.insert({ _id: SRV, name: 'R', ownerId: 'sahip-R', createdAt: 1 });
  await mockDb.members.insert({ userId: REPORTER, serverId: SRV, roles: [], joinedAt: 1 });

  await mockDb.channels.insert({ _id: OPEN_CH, serverId: SRV, name: 'genel', type: 'text', createdAt: 1 });
  await mockDb.channels.insert({ _id: HIDDEN_CH, serverId: SRV, name: 'gizli', type: 'text', createdAt: 1 });

  await mockDb.channelOverrides.insert({
    _id: 'ovr-report-1', channelId: HIDDEN_CH, targetType: 'everyone', targetId: SRV,
    allow: 0, deny: VIEW_CHANNELS, position: 0,
  });

  await mockDb.messages.insert({
    _id: 'rmsg-acik', channelId: OPEN_CH, serverId: SRV, userId: AUTHOR,
    content: 'açık kanal mesajı', type: 'normal', reactions: {}, createdAt: 1000,
  });
  await mockDb.messages.insert({
    _id: 'rmsg-gizli', channelId: HIDDEN_CH, serverId: SRV, userId: AUTHOR,
    content: HIDDEN_TEXT, type: 'normal', reactions: {}, createdAt: 2000,
  });
  await mockDb.messages.insert({
    _id: 'rmsg-kendi', channelId: OPEN_CH, serverId: SRV, userId: REPORTER,
    content: 'kendi mesajım', type: 'normal', reactions: {}, createdAt: 3000,
  });
  await mockDb.messages.insert({
    _id: 'rmsg-silinmis', channelId: OPEN_CH, serverId: SRV, userId: AUTHOR,
    content: 'silinmiş', type: 'normal', reactions: {}, createdAt: 4000, deletedAt: 5000,
  });
});

function report(id: string, body: Record<string, unknown> = { reason: 'spam' }) {
  return request(app)
    .post(`/api/messages/${id}/report`)
    .set('Authorization', `Bearer ${tok(REPORTER)}`)
    .send(body);
}

describe('POST /:id/report — doğrulama', () => {
  it('bilinmeyen sebep REDDEDİLİR', async () => {
    const res = await report('rmsg-acik', { reason: 'bilinmeyen-sebep' });
    expect(res.status).toBe(400);
  });

  it('sebep eksikse REDDEDİLİR', async () => {
    const res = await report('rmsg-acik', {});
    expect(res.status).toBe(400);
  });

  it('500 karakterden uzun detay REDDEDİLİR', async () => {
    const res = await report('rmsg-acik', { reason: 'spam', detail: 'x'.repeat(501) });
    expect(res.status).toBe(400);
  });

  it('kendi mesajını raporlamak REDDEDİLİR', async () => {
    const res = await report('rmsg-kendi');
    expect(res.status).toBe(400);
  });
});

describe('POST /:id/report — VARLIK ORAKÜLÜ DEĞİLDİR', () => {
  it('var olmayan mesaj 404 döner', async () => {
    const res = await report('rmsg-yok');
    expect(res.status).toBe(404);
  });

  it('silinmiş mesaj da AYNI 404 döner', async () => {
    const res = await report('rmsg-silinmis');
    expect(res.status).toBe(404);
  });

  it('GÖRÜLEMEYEN kanaldaki mesaj da AYNI 404 döner (403 DEĞİL)', async () => {
    const res = await report('rmsg-gizli');
    // 403 dönmek, mesajın VAR OLDUĞUNU söylerdi.
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(HIDDEN_TEXT);
  });

  it('üç durumun yanıt gövdesi de AYIRT EDİLEMEZ', async () => {
    const [missing, deleted, hidden] = await Promise.all([
      report('rmsg-yok'), report('rmsg-silinmis'), report('rmsg-gizli'),
    ]);
    expect(deleted.body).toEqual(missing.body);
    expect(hidden.body).toEqual(missing.body);
  });
});

describe('POST /:id/report — kayıt', () => {
  it('ilk rapor 201 ile oluşturulur', async () => {
    const res = await report('rmsg-acik', { reason: 'harassment', detail: 'sebep' });
    expect(res.status).toBe(201);
    expect(res.body.reported).toBe(true);
    expect(res.body.created).toBe(true);
    expect(typeof res.body.id).toBe('string');
  });

  it('aynı raporun tekrarı YENİ kayıt açmaz (200)', async () => {
    const again = await report('rmsg-acik', { reason: 'harassment', detail: 'sebep' });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
  });
});
