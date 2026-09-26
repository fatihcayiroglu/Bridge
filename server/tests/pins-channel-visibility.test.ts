// server/tests/pins-channel-visibility.test.ts
// FAZ J-SONRASI — `pins.ts` UÇLARINDA KANAL GÖRÜNÜRLÜĞÜ.
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR (canlı üründe ölçüldü, testte değil)
// ════════════════════════════════════════════════════════════════════════════
// Son canlı denetimde aynı özel kanal (`gizli-oda`), aynı kullanıcı (üye B,
// VIEW_CHANNELS YOK) için kardeş uçlar AYRIŞTI:
//
//   GET /api/channels/:cid/messages -> 403   (doğru)
//   GET /api/channels/:cid/pinned   -> 403   (doğru)
//   GET /api/channels/:cid/pins     -> 200   <-- AÇIK
//   GET /api/channels/:cid/files    -> 200   <-- AÇIK
//
// `routes/pins.ts` içindeki iki uç YALNIZCA `Members.findOne(user, serverId)`
// denetliyordu. Sunucunun sıradan bir üyesi, GÖREMEDİĞİ özel kanalların
// sabitlenmiş mesajlarını ve dosya listesini okuyabiliyordu.
//
// BOŞ DİZİ GÜVENLİK KANITI DEĞİLDİR: canlı kanalda sabitlenmiş mesaj olmadığı
// için sızıntı görünmüyordu. Bu test bu yüzden GERÇEK İÇERİK yerleştirir ve
// metnin gövdede GEÇMEDİĞİNİ doğrular.
//
// AYNI KUSUR AİLESİ: Faz D (search), Faz F (ai/semantic), Faz G4 (pinned/
// history), Faz J (channel_permissions mağaza ayrımı).
// İlke: AYNI VERİYE GİDEN HER YOL AYNI DENETİMİ UYGULAMAK ZORUNDADIR.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();

jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (
    req: { headers: { authorization?: string }; user?: unknown },
    res: { status: (c: number) => { json: (b: unknown) => unknown } },
    next: () => void,
  ) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    try { req.user = jwt.verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!'); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  },
  verifyToken: (t: string) => { try { return require('jsonwebtoken').verify(t, 'test-jwt-secret-long-enough-32chars!!'); } catch { return null; } },
}));

jest.mock('../lib/redisAdapter', () => ({
  ...jest.requireActual('../lib/redisAdapter'),
  cache: {
    // Gercek adaptorde MEVCUT (lib/redisAdapter.ts) — mock'ta eksikti ve
    // `invalidateChannelMessages` her cagrida sessizce TypeError firlatiyordu.
    invalidatePattern: jest.fn().mockResolvedValue(undefined), get: async () => null, set: async () => undefined, del: async () => undefined },
}));

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');

import pinsRouter from '../routes/pins';

const app = express();
app.use(express.json());
app.use('/api/channels', pinsRouter);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

const tok = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const MEMBER     = 'uye-P';
const OUTSIDER   = 'yabanci-P';
const SRV        = 'srv-P';
const PUBLIC_CH  = 'pch-acik';
const PRIVATE_CH = 'pch-gizli';

const VIEW_CHANNELS = 1 << 0;
const GIZLI_PIN   = 'GIZLI-SABITLENMIS-PIN-98765';
const GIZLI_DOSYA = 'GIZLI-DOSYA-ADI-98765.pdf';
const ACIK_PIN    = 'acik sabitlenmis pin';
const ACIK_DOSYA  = 'acik-dosya.pdf';

beforeAll(async () => {
  await mockDb.users.insert({ _id: MEMBER, username: MEMBER, displayName: 'Uye' });
  await mockDb.users.insert({ _id: OUTSIDER, username: OUTSIDER, displayName: 'Yabanci' });
  await mockDb.servers.insert({ _id: SRV, name: 'P', ownerId: 'sahip-P', createdAt: 1 });
  await mockDb.members.insert({ userId: MEMBER, serverId: SRV, roles: [], joinedAt: 1 });

  await mockDb.channels.insert({ _id: PUBLIC_CH,  serverId: SRV, name: 'genel', type: 'text', createdAt: 1 });
  await mockDb.channels.insert({ _id: PRIVATE_CH, serverId: SRV, name: 'gizli', type: 'text', createdAt: 1 });

  // Ozel kanal: herkes icin VIEW_CHANNELS reddi.
  await mockDb.channelOverrides.insert({
    _id: 'ovr-pin-1', channelId: PRIVATE_CH, targetType: 'everyone', targetId: SRV,
    allow: 0, deny: VIEW_CHANNELS, position: 0,
  });

  await mockDb.messages.insert({
    _id: 'pin-acik', channelId: PUBLIC_CH, serverId: SRV, userId: MEMBER,
    content: ACIK_PIN, type: 'normal', reactions: {}, pinned: true, createdAt: 1000,
  });
  await mockDb.messages.insert({
    _id: 'pin-gizli', channelId: PRIVATE_CH, serverId: SRV, userId: 'baskasi',
    content: GIZLI_PIN, type: 'normal', reactions: {}, pinned: true, createdAt: 2000,
  });
  await mockDb.messages.insert({
    _id: 'dosya-acik', channelId: PUBLIC_CH, serverId: SRV, userId: MEMBER,
    content: ACIK_DOSYA, type: 'file', reactions: {}, createdAt: 1100,
  });
  await mockDb.messages.insert({
    _id: 'dosya-gizli', channelId: PRIVATE_CH, serverId: SRV, userId: 'baskasi',
    content: GIZLI_DOSYA, type: 'file', reactions: {}, createdAt: 2100,
  });
});

const pins  = (ch: string, who = MEMBER) =>
  request(app).get(`/api/channels/${ch}/pins`).set('Authorization', `Bearer ${tok(who)}`);
const files = (ch: string, who = MEMBER) =>
  request(app).get(`/api/channels/${ch}/files`).set('Authorization', `Bearer ${tok(who)}`);

// ════════════════════════════════════════════════════════════════════════════
describe('GET /:cid/pins — kanal görünürlüğü', () => {
  it('POZİTİF KONTROL: görünür kanalın sabitlenmişleri DÖNER', async () => {
    const res = await pins(PUBLIC_CH);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(ACIK_PIN);
  });

  it('GÖRÜNMEYEN kanalın sabitlenmişleri REDDEDİLİR', async () => {
    const res = await pins(PRIVATE_CH);

    expect(res.status).toBe(403);
  });

  it('görünmeyen kanalın sabitlenmiş METNİ gövdede GEÇMEZ', async () => {
    const res = await pins(PRIVATE_CH);

    expect(JSON.stringify(res.body)).not.toContain(GIZLI_PIN);
  });

  it('sunucu ÜYESİ OLMAYAN reddedilir', async () => {
    const res = await pins(PUBLIC_CH, OUTSIDER);

    expect(res.status).toBe(403);
  });
});

describe('GET /:cid/files — kanal görünürlüğü', () => {
  it('POZİTİF KONTROL: görünür kanalın dosyaları DÖNER', async () => {
    const res = await files(PUBLIC_CH);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(ACIK_DOSYA);
  });

  it('GÖRÜNMEYEN kanalın dosyaları REDDEDİLİR', async () => {
    const res = await files(PRIVATE_CH);

    expect(res.status).toBe(403);
  });

  it('görünmeyen kanalın DOSYA ADI gövdede GEÇMEZ', async () => {
    const res = await files(PRIVATE_CH);

    expect(JSON.stringify(res.body)).not.toContain(GIZLI_DOSYA);
  });

  it('sunucu ÜYESİ OLMAYAN reddedilir', async () => {
    const res = await files(PUBLIC_CH, OUTSIDER);

    expect(res.status).toBe(403);
  });
});
