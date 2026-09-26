// server/tests/messages-channel-visibility.test.ts
// FAZ G4 — MESAJ UÇLARINDA KANAL GÖRÜNÜRLÜĞÜ.
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR
// ════════════════════════════════════════════════════════════════════════════
// `routes/messages.ts` içindeki `requireChannelMembership` YALNIZCA sunucu
// üyeliğini doğrular. Ana mesaj listesi (`GET /:cid/messages`) bunun üstüne
// ayrıca `VIEW_CHANNELS` denetimi yapıyordu — ancak iki kardeş uç ATLANMIŞTI:
//
//   · `GET /api/channels/:cid/pinned`     → sabitlenmiş mesajların TAM içeriği
//   · `GET /api/messages/:id/history`     → düzenleme geçmişi + güncel içerik
//
// İkisi de, sunucunun sıradan bir üyesine, GÖREMEDİĞİ özel kanalların METNİNİ
// veriyordu. Aynı kusur sınıfı Faz D (search), Faz F (ai/semantic) ve şimdi
// burada görüldü: "sunucu üyeliği ≠ kanal görünürlüğü".

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

// Onbellek kapali: `requireChannelMembership` kanali 60sn onbellege alir;
// testler her seferinde GERCEK yolu olcmeli.
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

import messagesRouter from '../routes/messages';

const app = express();
app.use(express.json());
app.use('/api/channels', messagesRouter);
app.use('/api/messages', messagesRouter);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

const tok = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const MEMBER = 'uye-M';
const SRV    = 'srv-M';
const PUBLIC_CH  = 'mch-acik';
const PRIVATE_CH = 'mch-gizli';

const VIEW_CHANNELS = 1 << 0;
const GIZLI_METIN = 'GIZLI-SABITLENMIS-ICERIK-12345';
const ACIK_METIN  = 'acik sabitlenmis icerik';

beforeAll(async () => {
  await mockDb.users.insert({ _id: MEMBER, username: MEMBER, displayName: 'Uye' });
  await mockDb.servers.insert({ _id: SRV, name: 'M', ownerId: 'sahip-M', createdAt: 1 });
  await mockDb.members.insert({ userId: MEMBER, serverId: SRV, roles: [], joinedAt: 1 });

  await mockDb.channels.insert({ _id: PUBLIC_CH,  serverId: SRV, name: 'genel', type: 'text', createdAt: 1 });
  await mockDb.channels.insert({ _id: PRIVATE_CH, serverId: SRV, name: 'gizli', type: 'text', createdAt: 1 });

  await mockDb.channelOverrides.insert({
    _id: 'ovr-msg-1', channelId: PRIVATE_CH, targetType: 'everyone', targetId: SRV,
    allow: 0, deny: VIEW_CHANNELS, position: 0,
  });

  await mockDb.messages.insert({
    _id: 'msg-acik', channelId: PUBLIC_CH, serverId: SRV, userId: MEMBER,
    content: ACIK_METIN, type: 'normal', reactions: {}, pinned: 1,
    editHistory: [{ content: 'eski acik', editedAt: 5 }], createdAt: 1000,
  });
  await mockDb.messages.insert({
    _id: 'msg-gizli', channelId: PRIVATE_CH, serverId: SRV, userId: 'baskasi',
    content: GIZLI_METIN, type: 'normal', reactions: {}, pinned: 1,
    editHistory: [{ content: 'ESKI-GIZLI-SURUM', editedAt: 5 }], createdAt: 2000,
  });
});

const pinned  = (ch: string) => request(app).get(`/api/channels/${ch}/pinned`).set('Authorization', `Bearer ${tok(MEMBER)}`);
const history = (id: string) => request(app).get(`/api/messages/${id}/history`).set('Authorization', `Bearer ${tok(MEMBER)}`);

// ════════════════════════════════════════════════════════════════════════════
describe('GET /:cid/pinned — kanal görünürlüğü', () => {
  it('POZİTİF KONTROL: görünür kanalın sabitlenmişleri DÖNER', async () => {
    const res = await pinned(PUBLIC_CH);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(ACIK_METIN);
  });

  it('GÖRÜNMEYEN kanalın sabitlenmişleri REDDEDİLİR', async () => {
    const res = await pinned(PRIVATE_CH);

    expect(res.status).toBe(403);
  });

  it('görünmeyen kanalın METNİ gövdede geçmez', async () => {
    const res = await pinned(PRIVATE_CH);

    expect(JSON.stringify(res.body)).not.toContain(GIZLI_METIN);
  });
});

describe('GET /messages/:id/history — kanal görünürlüğü', () => {
  it('POZİTİF KONTROL: görünür kanaldaki mesajın geçmişi DÖNER', async () => {
    const res = await history('msg-acik');

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('eski acik');
  });

  it('GÖRÜNMEYEN kanaldaki mesajın geçmişi REDDEDİLİR', async () => {
    const res = await history('msg-gizli');

    expect(res.status).toBe(403);
  });

  it('görünmeyen mesajın ESKİ SÜRÜMÜ ve güncel içeriği sızmaz', async () => {
    const res = await history('msg-gizli');

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('ESKI-GIZLI-SURUM');
    expect(raw).not.toContain(GIZLI_METIN);
  });

  it('var olmayan mesaj 404 döner (403 ile karıştırılmaz)', async () => {
    const res = await history('yok-boyle-mesaj');

    expect(res.status).toBe(404);
  });
});
