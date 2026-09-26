// server/tests/webpush-subscription-scope.test.ts
// FAZ D / WEB PUSH — ABONELİK SAHİPLİK KAPSAMI.
//
// ════════════════════════════════════════════════════════════════════════════
// DÜZELTİLEN GERÇEK SORUN
// ════════════════════════════════════════════════════════════════════════════
// `DELETE /api/webpush/unsubscribe` aboneliği YALNIZCA `endpoint` ile
// siliyordu ve `push_subscriptions.endpoint` sütunu TÜM kullanıcılar arasında
// UNIQUE'tir. Yani başka bir kullanıcının push endpoint'ini ele geçiren
// (paylaşılan cihaz, log, istemci depolaması) kimliği doğrulanmış herhangi
// biri, o kullanıcının aboneliğini silip bildirimlerini kesebiliyordu.
// Handler çağıranın kimliğini (`_u`) hiç okumuyordu bile.
//
// Kural: `container A + resource B` biçimindeki her işlemde B'nin A'ya ait
// olduğu KANITLANMALIDIR — kimlik yuvalanması aidiyet kanıtlamaz.
//
// NOT: `subscribe` içindeki sahiplik DEVRİ aynı gerçek PushSubscription için
// kasıtlıdır: endpoint + anahtarlar eşleşirse paylaşılan tarayıcıda yeni oturum
// aboneliği devralır. Yalnız endpoint bilgisi devralmak için yeterli değildir.

process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

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
  limits: { write: () => (_req: unknown, _res: unknown, next: () => void) => next() },
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');

import webpushRouter from '../routes/webpush';
import { requireDoc } from './helpers/mockDb';

const app = express();
app.use(express.json());
app.use('/api/webpush', webpushRouter);

const tok = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const ALICE = 'alice-1';
const MALLORY = 'mallory-1';
const ALICE_ENDPOINT = 'https://push.example/gizli-uc-nokta-alice';

const KEYS = { p256dh: 'p256dh-degeri', auth: 'auth-degeri' };

beforeEach(async () => {
  mockDb._reset?.();
  await mockDb.pushSubscriptions.insert({
    _id: 'sub-alice', userId: ALICE, endpoint: ALICE_ENDPOINT,
    keys: KEYS, createdAt: 1,
  });
});

const unsubscribe = (user: string, endpoint: string) =>
  request(app).delete('/api/webpush/unsubscribe')
    .set('Authorization', `Bearer ${tok(user)}`)
    .send({ endpoint });

const subCount = async () => (await mockDb.pushSubscriptions.find({ endpoint: ALICE_ENDPOINT })).length;

describe('WEB PUSH — abonelik silme kapsamı', () => {
  it('POZİTİF KONTROL: sahibi KENDİ aboneliğini silebilir', async () => {
    expect(await subCount()).toBe(1);

    const res = await unsubscribe(ALICE, ALICE_ENDPOINT);

    expect(res.status).toBe(200);
    expect(await subCount()).toBe(0);
  });

  it('GÜVENLİK: BAŞKASI endpoint’i bilse de aboneliği SİLEMEZ', async () => {
    const res = await unsubscribe(MALLORY, ALICE_ENDPOINT);

    // Uç sessizce başarı döner (varlık sızdırmaz) ama satır DURUR.
    expect(res.status).toBe(200);
    expect(await subCount()).toBe(1);
  });

  it('GÜVENLİK: silme sonrası Alice’in aboneliği hâlâ ONA aittir', async () => {
    await unsubscribe(MALLORY, ALICE_ENDPOINT);

    const row = await requireDoc(mockDb.pushSubscriptions, { endpoint: ALICE_ENDPOINT });
    expect(row.userId).toBe(ALICE);
  });

  it('kimliksiz istek reddedilir', async () => {
    const res = await request(app).delete('/api/webpush/unsubscribe').send({ endpoint: ALICE_ENDPOINT });

    expect(res.status).toBe(401);
    expect(await subCount()).toBe(1);
  });

  it('endpoint verilmezse hiçbir şey silinmez', async () => {
    const res = await request(app).delete('/api/webpush/unsubscribe')
      .set('Authorization', `Bearer ${tok(ALICE)}`).send({});

    expect(res.status).toBe(200);
    expect(await subCount()).toBe(1);
  });

  it('bilinmeyen endpoint güvenle ele alınır', async () => {
    const res = await unsubscribe(ALICE, 'https://push.example/hic-boyle-yok');

    expect(res.status).toBe(200);
    expect(await subCount()).toBe(1);
  });
});

describe('WEB PUSH — abonelik oluşturma sözleşmesi', () => {
  it('POZİTİF KONTROL: geçerli abonelik çağırana kaydedilir', async () => {
    const res = await request(app).post('/api/webpush/subscribe')
      .set('Authorization', `Bearer ${tok(MALLORY)}`)
      .send({ endpoint: 'https://push.example/mallory', keys: KEYS });

    expect(res.status).toBe(200);
    const row = await requireDoc(mockDb.pushSubscriptions, { endpoint: 'https://push.example/mallory' });
    expect(row.userId).toBe(MALLORY);
  });

  it('eksik anahtarlar 400 ile reddedilir', async () => {
    const res = await request(app).post('/api/webpush/subscribe')
      .set('Authorization', `Bearer ${tok(ALICE)}`)
      .send({ endpoint: 'https://push.example/eksik' });

    expect(res.status).toBe(400);
  });

  it('aynı tarayıcıda oturum değişince abonelik DEVREDİLİR (kasıtlı)', async () => {
    // Push endpoint'i tarayıcı başınadır; yeni oturum sahibi almalıdır.
    await request(app).post('/api/webpush/subscribe')
      .set('Authorization', `Bearer ${tok(MALLORY)}`)
      .send({ endpoint: ALICE_ENDPOINT, keys: KEYS })
      .expect(200);

    const row = await requireDoc(mockDb.pushSubscriptions, { endpoint: ALICE_ENDPOINT });
    expect(row.userId).toBe(MALLORY);
    expect(await subCount()).toBe(1);   // çoğaltılmaz
  });

  it('GÜVENLİK: yalnız endpoint bilgisi farklı anahtarlarla sahiplik devralamaz', async () => {
    await request(app).post('/api/webpush/subscribe')
      .set('Authorization', `Bearer ${tok(MALLORY)}`)
      .send({ endpoint: ALICE_ENDPOINT, keys: { p256dh: 'baska-p256dh', auth: 'baska-auth' } })
      .expect(409);

    const row = await requireDoc(mockDb.pushSubscriptions, { endpoint: ALICE_ENDPOINT });
    expect(row.userId).toBe(ALICE);
  });
});
