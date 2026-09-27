// server/tests/unread-inbox.test.ts
// FAZ D / BİLDİRİMLER — OKUNMAMIŞ ÖZETİ (GELEN KUTUSU VERİSİ).
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// `unread_counts` tablosu zaten DOLUYORDU (lib/notifications.ts:97
// `incrementUnread`) ama okuma ucu YOKTU. Bu uç kanonik tabloyu okur; İKİNCİ
// bir okunmamış sistemi kurulmaz.
//
// ── GÜVENLİK ───────────────────────────────────────────────────────────────
// Sayaçlar `(userId, channelId)` ile tutulur; kullanıcı bir kanalı görme
// yetkisini SONRADAN kaybetmiş olabilir. Ham liste, göremediği kanalların
// VARLIĞINI ve mesaj HACMİNİ ele verirdi — Search'te kapatılan sızıntının
// aynısı. Her kanal için VIEW_CHANNELS çözümlenir; reddedilen ELENİR.

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
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: {
    messages: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    general: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  },
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');

import prefsRouter from '../routes/notificationPrefs';

const app = express();
app.use(express.json());
app.use('/api/notification-prefs', prefsRouter);

const tok = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const USER    = 'kullanici-1';
const SRV     = 'srv-1';
const OPEN_CH = 'ch-acik';
const HIDDEN_CH = 'ch-gizli';
const GHOST_CH  = 'ch-silinmis';   // sayaç var, kanal satırı YOK

const VIEW_CHANNELS = 1 << 0;

beforeAll(async () => {
  await mockDb.users.insert({ _id: USER, username: USER, displayName: 'K' });
  await mockDb.servers.insert({ _id: SRV, name: 'S', ownerId: 'sahip', createdAt: 1 });
  // roles JSONB → GERÇEK dizi (üretim şekli)
  await mockDb.members.insert({ userId: USER, serverId: SRV, roles: [], joinedAt: 1 });

  await mockDb.channels.insert({ _id: OPEN_CH,   serverId: SRV, name: 'acik',  type: 'text', createdAt: 1 });
  await mockDb.channels.insert({ _id: HIDDEN_CH, serverId: SRV, name: 'gizli', type: 'text', createdAt: 1 });

  // Gizli kanal: @everyone için VIEW_CHANNELS REDDEDİLİR.
  await mockDb.channelOverrides.insert({
    _id: 'ovr-gizli', channelId: HIDDEN_CH, targetType: 'everyone', targetId: SRV,
    allow: 0, deny: VIEW_CHANNELS, position: 0,
  });

  await mockDb.unreadCounts.insert({ userId: USER, channelId: OPEN_CH,   count: 3, createdAt: 1, updatedAt: 1 });
  await mockDb.unreadCounts.insert({ userId: USER, channelId: HIDDEN_CH, count: 7, createdAt: 1, updatedAt: 1 });
  await mockDb.unreadCounts.insert({ userId: USER, channelId: GHOST_CH,  count: 5, createdAt: 1, updatedAt: 1 });
  await mockDb.unreadCounts.insert({ userId: USER, channelId: 'ch-sifir', count: 0, createdAt: 1, updatedAt: 1 });
  // BAŞKA kullanıcının sayacı — asla dönmemeli.
  await mockDb.unreadCounts.insert({ userId: 'baskasi', channelId: OPEN_CH, count: 99, createdAt: 1, updatedAt: 1 });
});

const unread = (user: string) =>
  request(app).get('/api/notification-prefs/unread').set('Authorization', `Bearer ${tok(user)}`);

describe('D — okunmamış özeti', () => {
  it('kimliksiz istek 401', async () => {
    const res = await request(app).get('/api/notification-prefs/unread');

    expect(res.status).toBe(401);
  });

  it('POZİTİF KONTROL: görünür kanalın sayacı DÖNER', async () => {
    const res = await unread(USER);

    expect(res.status).toBe(200);
    const open = (res.body.channels as Array<{ channelId: string; count: number }>)
      .find(c => c.channelId === OPEN_CH);
    expect(open).toBeDefined();
    expect(open!.count).toBe(3);
  });

  it('GÜVENLİK: VIEW_CHANNELS reddedilen kanal ÖZETTE YOK', async () => {
    const res = await unread(USER);

    const ids = (res.body.channels as Array<{ channelId: string }>).map(c => c.channelId);
    expect(ids).not.toContain(HIDDEN_CH);
  });

  it('GÜVENLİK: gizli kanalın SAYISI toplamı şişirmez (hacim sızmaz)', async () => {
    const res = await unread(USER);

    // Yalnız görünür kanal (3) sayılmalı; 7 eklenirse hacim ele verilir.
    expect(res.body.total).toBe(3);
    expect(JSON.stringify(res.body)).not.toContain('7');
  });

  it('GÜVENLİK: silinmiş/çözülemeyen kanal ELENİR (fail-closed)', async () => {
    const res = await unread(USER);

    const ids = (res.body.channels as Array<{ channelId: string }>).map(c => c.channelId);
    expect(ids).not.toContain(GHOST_CH);
  });

  it('sıfır sayaçlı kanal listelenmez', async () => {
    const res = await unread(USER);

    const ids = (res.body.channels as Array<{ channelId: string }>).map(c => c.channelId);
    expect(ids).not.toContain('ch-sifir');
  });

  it('GÜVENLİK: BAŞKA kullanıcının sayacı dönmez (kendi kapsamı)', async () => {
    const res = await unread(USER);

    // Başkasının 99'u ne listede ne toplamda olmalı.
    expect(res.body.total).toBe(3);
    expect(JSON.stringify(res.body)).not.toContain('99');
  });

  it('hiç okunmamışı olmayan kullanıcı boş özet alır', async () => {
    const res = await unread('bos-kullanici');

    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual([]);
    expect(res.body.total).toBe(0);
  });
});
