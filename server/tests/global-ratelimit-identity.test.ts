// server/tests/global-ratelimit-identity.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// KÜRESEL /api HIZ SINIRI KİMLİĞİ GÖRMELİ — GERÇEK createApp BAĞLANTISIYLA
// ════════════════════════════════════════════════════════════════════════════
//
// ── KAPATILAN KUSUR (Final21 Faz 11 — F21-11-04) ────────────────────────────
// `createApp` küresel sınırlayıcıyı `/api` altına HER rotadan ÖNCE bağlar;
// `authMiddleware` rota bazındadır. Sınırlayıcı çalıştığında `req.user` yoktu,
// yani `combined` mod her isteği IP anahtarına (tavan = max) yazıyordu.
// `rateLimit.ts`in paylaşılan NAT adaleti (kimlikli trafikte IP tavanı
// `max * RL_SHARED_IP_FACTOR`, gerçek kota kullanıcı başına) bu sınırlayıcıda
// HİÇ devreye girmiyordu.
//
// Ayrık bir Bridge örneğinde ÖLÇÜLDÜ (tools/global-limit-shared-ip-repro.mjs):
//   kimlikli /api/me yanıtı: `X-RateLimit-Policy: 200;w=60;mode=combined;keys=1`
//   aynı IP'den 5 kullanıcı × 42 istek (kullanıcı kotasının %21'i):
//     194 × 200, 11 × 429, ardından 5 × 403 — IP 10 dk OTOMATİK BANLANDI.
//
// `shared-ip-fairness.test.ts` bunu göremedi: sahte kimlik ara katmanını
// sınırlayıcıdan ÖNCE bağlıyor. Bu dosya ÜRÜNÜN KENDİ bağlantısını kullanır.
//
// Güvenlik sınırı: kimlik yalnızca İMZASI DOĞRULANAN erişim jetonundan alınır;
// sahte imza ve medya jetonu anonim sayılır ve IP tavanı aynen `max` kalır.

process.env.JWT_SECRET      = 'test-jwt-secret-global-identityx'.padEnd(64, 'x');
process.env.REFRESH_SECRET  = 'test-refresh-secret-global-identity'.padEnd(64, 'y');
process.env.NODE_ENV        = 'test';
process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
process.env.RL_GLOBAL_MAX   = '5';
delete process.env.REDIS_URL;

import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../app/createApp';
import { _resetRateLimitStoreForTest } from '../middleware/rateLimit';

const access = (id: string) => jwt.sign({ id, username: id, v: 0 }, process.env.JWT_SECRET as string, { expiresIn: '15m' });

function appWithProbe() {
  const { app } = createApp();
  app.get('/api/probe', (_req: Request, res: Response) => { res.json({ ok: true }); });
  return app;
}

async function hit(app: ReturnType<typeof appWithProbe>, token: string | null, n: number) {
  const statuses: number[] = [];
  let policy = '';
  for (let i = 0; i < n; i++) {
    const req = request(app).get('/api/probe');
    if (token) req.set('Authorization', `Bearer ${token}`);
    const res = await req;
    statuses.push(res.status);
    policy = String(res.headers['x-ratelimit-policy'] ?? policy);
  }
  return { ok: statuses.filter((s) => s === 200).length, limited: statuses.filter((s) => s === 429).length, policy };
}

describe('global /api rate limit sees the verified identity (real createApp wiring)', () => {
  beforeEach(() => _resetRateLimitStoreForTest());

  it('counts an authenticated request against the user AND the shared-IP ceiling', async () => {
    const app = appWithProbe();
    const r = await hit(app, access('user-a'), 1);
    expect(r.ok).toBe(1);
    expect(r.policy).toContain('keys=2');
  });

  it('lets several authenticated users behind ONE IP each use their own quota', async () => {
    const app = appWithProbe();
    // 3 kullanıcı × 4 istek = 12 istek > max (5); her kullanıcı kendi kotasının altında.
    let ok = 0;
    let limited = 0;
    for (let round = 0; round < 4; round++) {
      for (const id of ['user-a', 'user-b', 'user-c']) {
        const r = await hit(app, access(id), 1);
        ok += r.ok;
        limited += r.limited;
      }
    }
    expect({ ok, limited }).toEqual({ ok: 12, limited: 0 });
  });

  it('busy authenticated neighbours do not lock the anonymous path (login page) on the same IP', async () => {
    // e2e'de ÖLÇÜLDÜ: kimlikli trafik paylaşılan IP sayacını 200'ün üstüne taşıdı;
    // aynı IP'den gelen kimliksiz `GET /api/servers` 401 yerine 429 aldı. Gerçek
    // dünyada bu, meşgul bir ofis NAT'ında giriş sayfasının `/api/login` isteğidir.
    const app = appWithProbe();
    for (let round = 0; round < 4; round++) {
      for (const id of ['user-a', 'user-b', 'user-c']) await hit(app, access(id), 1);
    }
    const anon = await hit(app, null, 1);
    expect({ ok: anon.ok, limited: anon.limited }).toEqual({ ok: 1, limited: 0 });
  });

  it('still enforces the per-user quota', async () => {
    const app = appWithProbe();
    const r = await hit(app, access('user-a'), 7);
    expect({ ok: r.ok, limited: r.limited }).toEqual({ ok: 5, limited: 2 });
  });

  it('keeps anonymous traffic on the strict IP ceiling', async () => {
    const app = appWithProbe();
    const r = await hit(app, null, 7);
    expect({ ok: r.ok, limited: r.limited }).toEqual({ ok: 5, limited: 2 });
    expect(r.policy).toContain('keys=1');
  });

  it('treats a forged signature as anonymous — a fake identity cannot buy the shared-IP ceiling', async () => {
    const app = appWithProbe();
    let ok = 0;
    let limited = 0;
    for (let i = 0; i < 7; i++) {
      const forged = jwt.sign({ id: `forged-${i}`, username: 'x', v: 0 }, 'not-the-server-secret'.padEnd(64, 'z'));
      const r = await hit(app, forged, 1);
      ok += r.ok;
      limited += r.limited;
    }
    expect({ ok, limited }).toEqual({ ok: 5, limited: 2 });
  });

  it('treats a media-purpose token as anonymous', async () => {
    const app = appWithProbe();
    let ok = 0;
    let limited = 0;
    for (let i = 0; i < 7; i++) {
      const media = jwt.sign({ id: `media-${i}`, username: 'x', v: 0, purpose: 'media' }, process.env.JWT_SECRET as string);
      const r = await hit(app, media, 1);
      ok += r.ok;
      limited += r.limited;
    }
    expect({ ok, limited }).toEqual({ ok: 5, limited: 2 });
  });
});
