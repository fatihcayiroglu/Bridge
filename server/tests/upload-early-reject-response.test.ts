// server/tests/upload-early-reject-response.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ERKEN REDDEDİLEN YÜKLEME, OKUNABİLİR BİR 403 DÖNMELİ
// ════════════════════════════════════════════════════════════════════════════
// Yükleme rotaları yetkilendirmeyi bilerek Multer'DAN ÖNCE yapar — yetkisiz
// bir istek diske geçici dosya bile yazamamalıdır. Bu doğru bir karardır ve
// DEĞİŞTİRİLMEMELİDİR.
import type { Request, Response, NextFunction } from 'express';
//
// ── ÖLÇÜLEN ARIZA ──────────────────────────────────────────────────────────
// İstek gövdesi HÂLÂ AKARKEN yanıt yazılınca Node, okunmamış istek verisi
// kaldığı için soketi YOK EDER. İstemcinin gördüğü şey `403` değil
// `ECONNRESET` olur. Yani doğru çalışan bir güvenlik kontrolü, kullanıcıya
// "ağ hatası" gibi görünüyordu; supertest'te de dört test bu yüzden
// `read ECONNRESET` ile düşüyordu.
//
// Doğrudan ölçüldü (aynı istek, üç strateji):
//     düz 403                     -> ERR read ECONNRESET
//     req.resume() + hemen 403    -> ERR read ECONNRESET
//     req.resume() + 'end' sonra  -> status 403        <-- doğru
//
// Bu dosya `respondDiscardingBody` sözleşmesini kilitler. Yardımcı yeniden
// "hemen yanıtla"ya dönerse burası kırmızı olur.

process.env.NODE_ENV = 'test';

import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { respondDiscardingBody } from '../lib/httpRequestDrain';

const request = require('supertest');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-drain-'));
const FILE = path.join(TMP, 'payload.bin');
// Tek TCP segmentine sığmayacak kadar büyük: gövde gerçekten "akıyor" olsun.
fs.writeFileSync(FILE, Buffer.alloc(512 * 1024, 7));

afterAll(() => { try { fs.rmSync(TMP, { recursive: true }); } catch { /* yok */ } });

function appWith(handler: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  // Terminal handler gövdeyi TÜKETİR (üretimde bu işi Multer yapar). Aksi
  // hâlde kontrol testi de okunmamış gövde yüzünden ECONNRESET alırdı ve
  // "her şey resetleniyor" ile "erken red resetliyor" ayırt edilemezdi.
  app.post('/u', handler, (req: Request, res: Response) => {
    if (req.complete) { res.json({ reached: true }); return; }
    req.resume();
    req.on('end', () => res.json({ reached: true }));
  });
  return app;
}

describe('respondDiscardingBody — erken red', () => {
  it('gövde akarken bile istemci 403 GÖVDESİNİ alır (ECONNRESET değil)', async () => {
    const app = appWith(async (req: Request, res: Response) => {
      // Gerçek rotalardaki gibi: yetki çözümü asenkron.
      await new Promise(r => setImmediate(r));
      respondDiscardingBody(req, res, 403, { error: 'Missing permission: MANAGE_SERVER' });
    });

    const res = await request(app)
      .post('/u')
      .attach('file', FILE, { contentType: 'application/octet-stream' })
      .field('name', 'test');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Missing permission: MANAGE_SERVER');
  });

  it('sonraki middleware ÇALIŞMAZ — yani Multer hiç devreye girmez', async () => {
    // En önemli iddia: gövdeyi akıtmak "isteği kabul etmek" DEĞİLDİR.
    // Baytlar düşürülür, zincir ilerlemez, diske hiçbir şey yazılmaz.
    const app = appWith((req: Request, res: Response) => {
      respondDiscardingBody(req, res, 403, { error: 'nope' });
    });

    const res = await request(app)
      .post('/u')
      .attach('file', FILE, { contentType: 'application/octet-stream' });

    expect(res.status).toBe(403);
    expect(res.body.reached).toBeUndefined();
  });

  it('gövdesi zaten tamamlanmış istekte de doğru çalışır', async () => {
    // Ayrım: yardımcı yalnızca "akan gövde" durumunda değil, sıradan
    // JSON isteklerinde de aynı yanıtı vermeli.
    const app = appWith((req: Request, res: Response) => {
      respondDiscardingBody(req, res, 403, { error: 'nope' });
    });

    const res = await request(app).post('/u').send({ a: 1 });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('nope');
  });

  it('YANLIŞ POZİTİF KONTROLÜ: yardımcı çağrılmazsa zincir ilerler', async () => {
    // Yukarıdaki iddialar, handler her şeyi reddetseydi de geçerdi.
    const app = appWith((_req: unknown, _res: unknown, next: () => void) => next());

    const res = await request(app)
      .post('/u')
      .attach('file', FILE, { contentType: 'application/octet-stream' });

    expect(res.status).toBe(200);
    expect(res.body.reached).toBe(true);
  });
});
