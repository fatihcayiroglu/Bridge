// server/tests/messages-read-anchor-header.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// `X-Bridge-First-Unread-Id` — OKUMA ÇAPASI SÖZLEŞMESİ
// ════════════════════════════════════════════════════════════════════════════
//
// İstemci mesaj listesini bu başlığa göre konumlandırır
// (`MessageLoader.svelte` → `setFirstUnreadAnchor`). Ölçülmemiş üç dal vardı
// ve üçü de kullanıcıya doğrudan yansır:
//
//   1. Çapa ÇÖZÜLÜRSE başlık yazılır  → liste ilk okunmamışa atlar.
//   2. Çapa YOKSA başlık YAZILMAZ     → liste en alta düşer (doğru davranış).
//   3. Çapa çözümü PATLARSA           → istek BAŞARILI olmaya devam eder,
//      yalnız başlık yazılmaz. Mesaj listesini okuma-durumu deposundaki bir
//      arıza yüzünden 500'e düşürmek, okunabilir bir sohbeti erişilemez
//      yapardı; bu yüzden hata YUTULUR ama SESSİZ değildir (uyarı loglanır).

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

import { Messages, Notifications } from '../db/repositories';
import messagesRouter from '../routes/messages';

const app = express();
app.use(express.json());
app.use('/api/channels', messagesRouter);
app.use('/api/messages', messagesRouter);

const tok = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const USER = 'anchor-user';
const SRV  = 'srv-A';
const CH   = 'ach-1';

beforeAll(async () => {
  await mockDb.users.insert({ _id: USER, username: USER, displayName: 'Anchor' });
  await mockDb.servers.insert({ _id: SRV, name: 'A', ownerId: 'sahip-A', createdAt: 1 });
  await mockDb.members.insert({ userId: USER, serverId: SRV, roles: [], joinedAt: 1 });
  await mockDb.channels.insert({ _id: CH, serverId: SRV, name: 'genel', type: 'text', createdAt: 1 });
  await mockDb.messages.insert({
    _id: 'amsg-1', channelId: CH, serverId: SRV, userId: 'baskasi',
    content: 'ilk', type: 'normal', reactions: {}, createdAt: 1000,
  });
  await mockDb.messages.insert({
    _id: 'amsg-2', channelId: CH, serverId: SRV, userId: 'baskasi',
    content: 'ikinci', type: 'normal', reactions: {}, createdAt: 2000,
  });
});

afterEach(() => { jest.restoreAllMocks(); });

const list = () => request(app)
  .get(`/api/channels/${CH}/messages?limit=50`)
  .set('Authorization', `Bearer ${tok(USER)}`);

describe('GET /:cid/messages — okuma çapası başlığı', () => {
  it('okuma konumu YOKKEN başlık yazılmaz (ilk ziyaret temel oluşturur)', async () => {
    jest.spyOn(Notifications, 'findChannelReadPosition' as never)
      .mockResolvedValue(null as never);

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.headers['x-bridge-first-unread-id']).toBeUndefined();
  });

  it('ilk okunmamış mesaj çözülünce başlık YAZILIR', async () => {
    jest.spyOn(Notifications, 'findChannelReadPosition' as never)
      .mockResolvedValue({ lastReadAt: 1000, lastReadMessageId: 'amsg-1' } as never);
    jest.spyOn(Messages, 'findFirstUnreadAfter' as never)
      .mockResolvedValue({ _id: 'amsg-2' } as never);

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.headers['x-bridge-first-unread-id']).toBe('amsg-2');
  });

  it('okunmamış kalmadıysa başlık yazılmaz', async () => {
    jest.spyOn(Notifications, 'findChannelReadPosition' as never)
      .mockResolvedValue({ lastReadAt: 2000, lastReadMessageId: 'amsg-2' } as never);
    jest.spyOn(Messages, 'findFirstUnreadAfter' as never)
      .mockResolvedValue(null as never);

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.headers['x-bridge-first-unread-id']).toBeUndefined();
  });

  it('bozuk okuma konumu (geçersiz zaman damgası) çapa üretmez', async () => {
    jest.spyOn(Notifications, 'findChannelReadPosition' as never)
      .mockResolvedValue({ lastReadAt: Number.NaN, lastReadMessageId: 'amsg-1' } as never);

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.headers['x-bridge-first-unread-id']).toBeUndefined();
  });

  it('çapa çözümü PATLARSA istek yine BAŞARILI olur, başlık yazılmaz', async () => {
    // En önemli dal: okuma-durumu deposundaki bir arıza sohbeti erişilemez
    // YAPMAMALIDIR.
    jest.spyOn(Notifications, 'findChannelReadPosition' as never)
      .mockRejectedValue(new Error('read-state store down') as never);

    const res = await list();

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.messages ?? res.body)).toBe(true);
    expect(res.headers['x-bridge-first-unread-id']).toBeUndefined();
  });
});
