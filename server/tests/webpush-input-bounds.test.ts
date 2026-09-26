// server/tests/webpush-input-bounds.test.ts
// FAZ G11 — WEB PUSH ABONELİK YAPISI / UZUNLUK SINIRLARI.
//
// BULUNAN KUSUR: `POST /api/webpush/subscribe` `endpoint` ve `keys` alanlarını
// SINIRSIZ string olarak kabul edip doğrudan veritabanına yazıyordu. Kimliği
// doğrulanmış bir saldırgan megabaytlık değerlerle depolamayı şişirebilirdi.
// Ayrıca `endpoint`in gerçekten bir push URL'si olduğu hiç doğrulanmıyordu.
//
// Gerçek boyutlar küçüktür (endpoint ~200-500, p256dh ~88, auth ~24), bu yüzden
// sınırlar cömert ama sonlu; şema https ile kısıtlı.
//
// NOT: `WEB_PUSH = CONFIG_REQUIRED` olarak KALIR — bu test yalnızca girdi
// sınırlarını ölçer, yetenek etkinleştirmez. VAPID üretilmez.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import type { RequestBody } from './helpers/httpDoubles';
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
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');

import webpushRouter from '../routes/webpush';

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/webpush', webpushRouter);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

const USER = 'push-user';
const tok = () => jwt.sign({ id: USER, username: USER, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const VALID = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abcdef123456',
  keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) },
};

const subscribe = (body: RequestBody) =>
  request(app).post('/api/webpush/subscribe').set('Authorization', `Bearer ${tok()}`).send(body);

describe('web push abonelik — girdi sınırları', () => {
  it('POZİTİF KONTROL: geçerli abonelik KABUL edilir', async () => {
    // Bu kontrol olmadan aşağıdaki redler, uç her şeyi reddetse de geçerdi.
    const res = await subscribe(VALID);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('AŞIRI UZUN endpoint REDDEDİLİR', async () => {
    const res = await subscribe({ ...VALID, endpoint: 'https://x.test/' + 'a'.repeat(5000) });

    expect(res.status).toBe(400);
  });

  it('AŞIRI UZUN anahtarlar REDDEDİLİR', async () => {
    const res = await subscribe({ ...VALID, keys: { p256dh: 'B'.repeat(5000), auth: 'A'.repeat(22) } });

    expect(res.status).toBe(400);
  });

  it('https OLMAYAN endpoint REDDEDİLİR', async () => {
    expect((await subscribe({ ...VALID, endpoint: 'http://fcm.test/gonder' })).status).toBe(400);
    expect((await subscribe({ ...VALID, endpoint: 'javascript:alert(1)' })).status).toBe(400);
    expect((await subscribe({ ...VALID, endpoint: 'data:text/plain,x' })).status).toBe(400);
  });

  it('URL OLMAYAN endpoint REDDEDİLİR', async () => {
    const res = await subscribe({ ...VALID, endpoint: 'bu-bir-url-degil' });

    expect(res.status).toBe(400);
  });

  it('eksik alanlar REDDEDİLİR (fail-closed)', async () => {
    expect((await subscribe({ endpoint: VALID.endpoint })).status).toBe(400);
    expect((await subscribe({ keys: VALID.keys })).status).toBe(400);
    expect((await subscribe({})).status).toBe(400);
  });

  it('kimliksiz istek reddedilir (401)', async () => {
    const res = await request(app).post('/api/webpush/subscribe').send(VALID);

    expect(res.status).toBe(401);
  });
});
