// server/tests/shared-ip-rate-limit.test.ts
//
// PAYLAŞILAN IP — YAN HASAR KORUMASI
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK ZAYIFLIK
// ════════════════════════════════════════════════════════════════════════════
// `combined` modu her iki anahtarı da AYNI `max` değeriyle ölçüyordu:
import { makeJwtUser } from './helpers/userDoubles';
import type { Request, Response, NextFunction } from 'express';
//
//     const count = Math.max(ipCount, userCount);
//     if (count > max) → 429
//
// Sonuç: kimliği doğrulanmış TEK bir kullanıcı, paylaşılan IP kovasını
// tüketip AYNI NAT arkasındaki İLGİSİZ kullanıcıları kilitleyebiliyordu.
//
// GERÇEK SENARYO: `csrf` sınırı 5 dakikada 20'dir ve `combined` modda
// çalışır. Bir ofis / yurt / üniversite NAT'i arkasındaki 20 kullanıcı
// uygulamayı açtığında 20 jeton üretilir; 21. MEŞRU kullanıcı 429 alır.
// Aynı sınıf `servers` (10/dk), `search` ve `friends` uçlarında da geçerli.
//
// ── ÇÖZÜM (IP KORUMASI KALDIRILMADI) ──────────────────────────────────────
// Kimliği doğrulanmış isteklerde IP anahtarı geniş bir ACİL DURUM TAVANI
// olur (varsayılan 20×); gerçek kota KULLANICI anahtarındadır. Kimliği
// doğrulanmamış isteklerde IP tavanı AYNEN sıkı kalır.

import request from 'supertest';
import express from 'express';
import { rateLimit } from '../middleware/rateLimit';

/** Sahte kimlik enjekte eden uygulama — her istek bir kullanıcı taşıyabilir. */
function makeApp(max: number, mode: 'combined' | 'ip' | 'user', keyPrefix: string) {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const uid = String(req.headers['x-test-user'] ?? '');
    if (uid) req.user = makeJwtUser(uid);
    next();
  });
  app.use(rateLimit(max, 60_000, keyPrefix, { mode }));
  app.get('/', (_req: Request, res: Response) => { res.json({ ok: true }); });
  return app;
}

/** Aynı IP'den, farklı kullanıcı kimlikleriyle N istek at. */
async function hit(app: express.Express, user: string, times: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < times; i++) {
    const res = await request(app).get('/').set('x-test-user', user);
    out.push(res.status);
  }
  return out;
}

describe('paylaşılan IP — kimliği doğrulanmış kullanıcılar birbirini kilitlemez', () => {
  it('bir kullanıcı kotasını tüketse bile KOMŞU kullanıcı etkilenmez', async () => {
    // KANITLAR   : kota kullanıcı başınadır; IP yalnızca acil durum tavanıdır.
    // KANITLAMAZ : dağıtık (çok düğümlü) sayaç tutarlılığını.
    const MAX = 3;
    const app = makeApp(MAX, 'combined', `shared-${Date.now()}-a`);

    // Kullanıcı A kendi kotasını AŞAR.
    const a = await hit(app, 'user-A', MAX + 2);
    expect(a.slice(0, MAX)).toEqual(Array(MAX).fill(200));
    expect(a[a.length - 1]).toBe(429);

    // Kullanıcı B AYNI IP'den gelir ve ETKİLENMEMELİDİR.
    const b = await hit(app, 'user-B', MAX);
    expect(b)
      .toEqual(Array(MAX).fill(200));
  });

  it('IP tavanı KALDIRILMADI — kaçak trafik hâlâ yakalanır', async () => {
    // Koruma gevşetilmedi: yeterince çok istek IP tavanını da aşar.
    // Varsayılan çarpan 20× olduğundan tavan = max * 20.
    const MAX = 2;
    const app = makeApp(MAX, 'combined', `shared-${Date.now()}-b`);

    let sawBlock = false;
    // Her istek FARKLI kullanıcı: kullanıcı kotası asla dolmaz, yalnızca IP.
    for (let i = 0; i < MAX * 20 + 5; i++) {
      const res = await request(app).get('/').set('x-test-user', `u-${i}`);
      if (res.status === 429) { sawBlock = true; break; }
    }
    expect(sawBlock)
      .toBe(true);
  });

  it('KİMLİĞİ DOĞRULANMAMIŞ istekte IP tavanı SIKI kalır', async () => {
    // Giriş/kayıt gibi uçlarda kimlik yoktur; orada IP tek savunmadır ve
    // gevşetilmemelidir.
    const MAX = 3;
    const app = makeApp(MAX, 'combined', `shared-${Date.now()}-c`);

    const codes: number[] = [];
    for (let i = 0; i < MAX + 2; i++) {
      const res = await request(app).get('/');   // x-test-user YOK
      codes.push(res.status);
    }
    expect(codes.slice(0, MAX)).toEqual(Array(MAX).fill(200));
    expect(codes[codes.length - 1])
      .toBe(429);
  });

  it('kimlikli komşuların trafiği KİMLİKSİZ isteğin IP kotasını tüketmez — ama anonim tavan sıkı kalır', async () => {
    // Final21 Faz 11 (F21-11-04): kimlikli istekler anonim istekle AYNI IP
    // sayacına yazılıyordu. Meşgul bir NAT'ta giriş/kayıt gibi kimliksiz uçlar,
    // kimse anonim trafik göndermeden 429 alıyordu (e2e'de ölçüldü: 401 yerine 429).
    const MAX = 3;
    const app = makeApp(MAX, 'combined', `shared-${Date.now()}-anon`);
    for (let u = 0; u < 4; u++) await hit(app, `neighbour-${u}`, MAX);   // 12 kimlikli istek > MAX

    const codes: number[] = [];
    for (let i = 0; i < MAX + 1; i++) codes.push((await request(app).get('/')).status);
    expect(codes.slice(0, MAX)).toEqual(Array(MAX).fill(200));
    expect(codes[MAX]).toBe(429);
  });

  it('`user` modu davranışı DEĞİŞMEDİ', async () => {
    // Kişisel kota uçları (upload, messages, react …) zaten kullanıcı
    // bazlıydı; bu değişiklik onları etkilememeli.
    const MAX = 2;
    const app = makeApp(MAX, 'user', `shared-${Date.now()}-d`);

    const a = await hit(app, 'solo-A', MAX + 1);
    expect(a[a.length - 1]).toBe(429);
    const b = await hit(app, 'solo-B', MAX);
    expect(b).toEqual(Array(MAX).fill(200));
  });

  it('`ip` modu davranışı DEĞİŞMEDİ — kimlik doğrulanmamış uçlar korunur', async () => {
    const MAX = 2;
    const app = makeApp(MAX, 'ip', `shared-${Date.now()}-e`);

    // Farklı kullanıcılar bile olsa IP tek kovadır — login/register böyle olmalı.
    const codes: number[] = [];
    for (let i = 0; i < MAX + 1; i++) {
      const res = await request(app).get('/').set('x-test-user', `x-${i}`);
      codes.push(res.status);
    }
    expect(codes[codes.length - 1])
      .toBe(429);
  });

  it('429 yanıtı Retry-After taşır', async () => {
    // Sessiz düşüş yerine açık sinyal: istemci ne zaman tekrar deneyeceğini bilmeli.
    const MAX = 1;
    const app = makeApp(MAX, 'ip', `shared-${Date.now()}-f`);
    await request(app).get('/');
    const blocked = await request(app).get('/');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeTruthy();
  });
});
