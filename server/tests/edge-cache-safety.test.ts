// server/tests/edge-cache-safety.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ÖZEL API YANITLARI ÖNBELLEKLENEMEZ — CDN'İN ARKASINDA KRİTİK
// ════════════════════════════════════════════════════════════════════════════
// Bridge internete Cloudflare'in arkasında çıkacak. Ölçüldü: `/api/*`
// yanıtları HİÇBİR `Cache-Control` başlığı taşımıyordu.
//
import type { Request, Response, NextFunction } from 'express';
// Tek başına bir açık değildi, ama bir önbellek katmanının arkasında gerçek
// bir risk olur: başlık yoksa ara katmanlar sezgisel önbellekleme yapabilir
// ve KİMLİĞİ DOĞRULANMIŞ bir yanıt başka bir kullanıcıya servis edilebilir.
//
// Cloudflare tarafında "cache bypass" kuralı yazmak doğrudur ve
// `docs/CLOUDFLARE-PRODUCTION.md` bunu tarif eder — ama güvenlik TEK bir dış
// yapılandırmaya bırakılamaz. Yanlış yazılmış ya da sonradan değiştirilmiş
// bir edge kuralı sessizce özel veri sızdırırdı. Kaynak kendi
// önbelleklenebilirliğini kendisi beyan eder.
process.env.NODE_ENV = 'test';

import type { Server } from 'http';
import express from 'express';
import request from 'supertest';

import { securityHeaders } from '../lib/security';

let server: Server;

beforeAll(done => {
  const app = express();
  app.use(securityHeaders);
  app.get('/api/servers', (_req: Request, res: Response) => { res.json([{ _id: 'gizli' }]); });
  app.get('/api/health', (_req: Request, res: Response) => { res.json({ status: 'ok' }); });
  app.get('/dist/app.abc123.js', (_req: Request, res: Response) => { res.type('js').send('// immutable'); });
  app.get('/uploads/x.png', (_req: Request, res: Response) => { res.type('png').send('binary'); });
  server = app.listen(0, done);
});

afterAll(done => { server.close(done); });

describe('/api/* önbelleklenemez olarak işaretlenir', () => {
  it('kimlik doğrulanabilir API yanıtı no-store taşır', async () => {
    const res = await request(server).get('/api/servers');

    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['cache-control']).toContain('private');
    // Paylasimli onbellekler kimlige gore ayirt etmelidir.
    expect(res.headers['vary']).toContain('Authorization');
    expect(res.headers['vary']).toContain('Cookie');
  });

  it('sağlık ucu da önbelleklenmez — canlı bağımlılık durumu bildirir', async () => {
    // Onbeleklenmis bir 200, Redis/PostgreSQL kesintisinde operatoru
    // yaniltirdi: sistem saglikli gorunurken aslinda hizmet veremiyor olurdu.
    const res = await request(server).get('/api/health');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('hiçbir /api yanıtı `public` olarak işaretlenmez', async () => {
    for (const path of ['/api/servers', '/api/health']) {
      const res = await request(server).get(path);
      expect(res.headers['cache-control']).not.toMatch(/public/i);
    }
  });
});

describe('statik varlıklar BİLEREK kapsam dışıdır', () => {
  it('hashlenmiş varlığa no-store DAYATILMAZ', async () => {
    // Bunlarin uzun omurlu onbeleklenmesi ISTENIR; aksi halde her dagitimda
    // tum istemciler tum paketi yeniden indirir.
    const res = await request(server).get('/dist/app.abc123.js');
    expect(res.headers['cache-control'] ?? '').not.toContain('no-store');
  });

  it('yükleme yoluna no-store DAYATILMAZ', async () => {
    const res = await request(server).get('/uploads/x.png');
    expect(res.headers['cache-control'] ?? '').not.toContain('no-store');
  });
});

describe('mevcut güvenlik başlıkları korunur', () => {
  it('temel başlıklar hâlâ gönderilir', async () => {
    const res = await request(server).get('/api/servers');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    // Sesli sohbet icin `self` gereklidir — bos allowlist sesi kirardi.
    expect(res.headers['permissions-policy']).toContain('microphone=(self)');
  });
});
