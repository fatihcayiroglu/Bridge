// server/tests/health-probe-ratelimit-exemption.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// CANLILIK YOKLAMASI BAĞIMLILIĞA BAĞLI OLAMAZ
// ════════════════════════════════════════════════════════════════════════════
//
// ── ÖLÇÜLEN KUSUR (scripts/dependency-chaos.cjs) ──────────────────────────
// Redis konteyneri durdurulduğunda `/api/health/live` **503** döndü.
import type { Request, Response, NextFunction } from 'express';
// Canlılık rotasının kendisi koşulsuz 200'dür (routes/health.ts); 503 küresel
// `/api` hız sınırından geliyordu: yapılandırılmış Redis otoritesi
// erişilemez olunca sınırlayıcı KAPALI BAŞARISIZ olup isteği reddeder.
//
// Sıradan API trafiği için bu DOĞRUDUR — aksi hâlde saldırgan Redis'i
// düşürüp tüm kotaları atlatabilirdi. CANLILIK için ise yıkıcıdır:
//
//     Redis kesintisi → /health/live 503 → orkestratör konteyneri ÖLDÜRÜR
//     → yeniden başlatma Redis'i onarmaz → filo çapında yeniden başlatma
//     döngüsü → GEÇİCİ bir bağımlılık arızası TAM kesintiye dönüşür.
//
// Kaos betiği CI'da koşmaz; bu dosya aynı değişmezi normal süitte sabitler.
//
// SINIR: hazırlık (`/health/ready`) bağımlılıklara göre 503 dönmeye DEVAM
// etmelidir — o davranış kasıtlıdır ve kendi mantığından gelir. Burada
// ölçülen tek şey, sağlık yoklamalarının SINIRLAYICI tarafından
// reddedilmemesidir.

process.env.JWT_SECRET      = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET  = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV        = 'test';
process.env.ALLOWED_ORIGINS = 'http://localhost:3000';

// Hız sınırlayıcı, "yapılandırılmış otorite erişilemez" hâlini taklit eder:
// HER isteği 503 ile reddeder. Sağlık yoklamaları bu katmana HİÇ ulaşmamalı.
const limiterCalls: string[] = [];
jest.mock('../middleware/rateLimit', () => {
  const actual = jest.requireActual('../middleware/rateLimit');
  return {
    ...actual,
    rateLimit: () => (req: { path: string }, res: {
      status: (c: number) => { json: (b: unknown) => unknown };
    }) => {
      limiterCalls.push(req.path);
      res.status(503).json({ error: 'Rate limit service temporarily unavailable' });
    },
  };
});

import request from 'supertest';
import { createApp } from '../app/createApp';

describe('orchestrator health probes bypass the dependency-backed rate limiter', () => {
  beforeEach(() => { limiterCalls.length = 0; });

  it('serves liveness while the rate-limit authority is refusing everything', async () => {
    const { app } = createApp();
    app.get('/api/health/live', (_req: Request, res: Response) => {
      res.json({ status: 'ok', check: 'liveness' });
    });

    const res = await request(app).get('/api/health/live');

    // ASIL İDDİA: 503 DEĞİL. Aksi hâlde orkestratör süreci öldürür.
    expect(res.status).toBe(200);
    expect(res.body.check).toBe('liveness');
    expect(limiterCalls).not.toContain('/health/live');
  });

  it('serves readiness without the limiter intercepting it', async () => {
    // Hazırlık YİNE 503 dönebilir — ama KENDİ mantığından, sınırlayıcıdan
    // değil. Sınırlayıcı araya girerse gövde `check: 'readiness'` taşımaz ve
    // operatör arızayı yanlış teşhis eder.
    const { app } = createApp();
    app.get('/api/health/ready', (_req: Request, res: Response) => {
      res.status(503).json({ status: 'error', check: 'readiness' });
    });

    const res = await request(app).get('/api/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.check).toBe('readiness');
    expect(res.body.error).toBeUndefined();
    expect(limiterCalls).not.toContain('/health/ready');
  });

  it('still rate-limits ordinary API traffic (the exemption is not a hole)', async () => {
    // Muafiyet DAR olmalı: sıradan uçlar kapalı başarısız olmayı sürdürmeli,
    // yoksa Redis'i düşürmek tüm kotaları atlatmanın yolu olurdu.
    const { app } = createApp();
    app.get('/api/messages', (_req: Request, res: Response) => { res.json({ ok: true }); });

    const res = await request(app).get('/api/messages');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Rate limit service temporarily unavailable');
    expect(limiterCalls).toContain('/messages');
  });

  it('does not exempt paths that merely look like health probes', async () => {
    // `/health/live-metrics` sağlık yoklaması DEĞİLDİR; tam eşleşme kullanılır
    // ki önek benzerliği muafiyet kazanmasın.
    const { app } = createApp();
    app.get('/api/health/live-metrics', (_req: Request, res: Response) => { res.json({ ok: true }); });

    const res = await request(app).get('/api/health/live-metrics');

    expect(res.status).toBe(503);
    expect(limiterCalls).toContain('/health/live-metrics');
  });
});
