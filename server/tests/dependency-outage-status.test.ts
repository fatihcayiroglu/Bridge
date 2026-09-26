// server/tests/dependency-outage-status.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GEÇİCİ BAĞIMLILIK ARIZASI 503'TÜR, 500 DEĞİL
// ════════════════════════════════════════════════════════════════════════════
// v1.124'te canlı trafik altında PostgreSQL durduruldu. Bridge doğru
// davrandı — kesinti bitince süreç yeniden başlatılmadan KENDİLİĞİNDEN
// toparlandı — ama 91 isteğin tamamına **HTTP 500** döndü.
import type { Request, Response, NextFunction } from 'express';
//
// Fark istemciye yansır:
//   500 = "sunucuda bir kusur var"      → tekrar denenmez, kalıcı arıza gibi
//   503 = "geçici olarak hizmet yok"    → tekrar denenebilir; outbox kuyruğu,
//                                          mobil istemci ve ara katmanlar
//                                          doğru davranır
//
// Hız sınırlayıcı Redis yolunda bu ayrımı ZATEN doğru yapıyordu
// (503 "Rate limit service temporarily unavailable"); veritabanı yolu geri
// kalmıştı.
//
// Bu paket iki şeyi birden kilitler: bağlantı arızası 503'e dönüşür, ama
// GERÇEK kusurlar 500 olarak kalır. İkincisi olmadan düzeltme, her hatayı
// "geçici" gibi göstererek asıl kusurları gizlerdi.
process.env.NODE_ENV = 'test';

import type { Server } from 'http';
import express from 'express';
import request from 'supertest';

import { errorHandler, type HttpError } from '../middleware/errorHandler';

// TEK sunucu: supertest her `request(app)` cagrisinda kapatilmayan bir TCP
// sunucusu acar ve paket asili kalir (tests/README-timeouts.md).
let server: Server;
let nextError: HttpError = Object.assign(new Error('bos'), {});

beforeAll(done => {
  const app = express();
  app.get('/boom', (_req: Request, _res: Response, next: NextFunction) => next(nextError));
  app.use(errorHandler);
  server = app.listen(0, done);
});

afterAll(done => { server.close(done); });

function failWith(message: string, extra: Partial<HttpError> = {}) {
  nextError = Object.assign(new Error(message), extra);
  return request(server).get('/boom');
}

describe('bağlantı sınıfı arızalar 503 döner', () => {
  it.each([
    ['ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5432'],
    ['ECONNRESET', 'read ECONNRESET'],
    ['ETIMEDOUT', 'connect ETIMEDOUT'],
    ['57P01 (admin_shutdown)', 'terminating connection due to administrator command'],
    ['08006 (connection_failure)', 'connection failure'],
  ])('%s → 503', async (_label, message) => {
    const code = _label.split(' ')[0];
    const res = await failWith(message, { code });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Service temporarily unavailable');
    // Istemciye NE ZAMAN tekrar denemesi gerektigi soylenir.
    expect(res.headers['retry-after']).toBe('5');
  });

  it('mesajdan tanınan kapanma da 503 döner (kod olmasa bile)', async () => {
    const res = await failWith('Connection terminated unexpectedly');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
  });

  it('veritabanı başlatılırken gelen istek de 503 döner', async () => {
    const res = await failWith('the database system is starting up');
    expect(res.status).toBe(503);
  });
});

describe('gerçek kusurlar 500 olarak KALIR', () => {
  // Bu grup, duzeltmenin fazla genis olmadigini kanitlar. Her hatayi
  // "gecici" saymak, kalici kusurlari gizleyip tekrar denemeye yol acardi.
  it.each([
    ['tanımsız değer okuma', "Cannot read properties of undefined (reading 'id')"],
    ['kısıt ihlali', 'duplicate key value violates unique constraint "users_pkey"'],
    ['sözdizimi hatası', 'syntax error at or near "SELECT"'],
    ['bilinmeyen kolon', '[pgCollection] Unknown column name: "nope"'],
  ])('%s → 500', async (_label, message) => {
    const res = await failWith(message);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it('kısıt ihlali kodu (23505) 503 SAYILMAZ', async () => {
    const res = await failWith('duplicate key', { code: '23505' });
    expect(res.status).toBe(500);
  });
});

describe('açıkça belirtilmiş durum kodu her zaman kazanır', () => {
  it('403 bağlantı hatası gibi görünse bile 403 kalır', async () => {
    const res = await failWith('ECONNREFUSED', { status: 403, code: 'ECONNREFUSED', expose: true });
    expect(res.status).toBe(403);
  });

  it('404 korunur ve mesajı sızdırılmaz biçimde döner', async () => {
    const res = await failWith('yok', { status: 404, expose: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('yok');
  });
});

describe('hiçbir yanıt iç detay sızdırmaz', () => {
  it('yığın izi veya SQL metni gövdede görünmez', async () => {
    const err = Object.assign(new Error('SELECT * FROM users WHERE id=1 failed'), {
      stack: 'Error: boom\n    at Object.<anonymous> (/app/server/db.js:42:11)',
    });
    nextError = err;
    const res = await request(server).get('/boom');

    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/SELECT .* FROM/i);
    expect(body).not.toMatch(/at\s+\w+.*:\d+:\d+/);
    expect(res.body.error).toBe('Internal server error');
  });
});
