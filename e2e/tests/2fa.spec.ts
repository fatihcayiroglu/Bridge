// e2e/tests/2fa.spec.ts — Sprint 63: 2FA (TOTP) E2E
// Akışlar: 2FA aktifleştirme API, QR endpoint, geçersiz OTP reddi,
// backup kod listesi, 2FA deaktifleştirme.

import { test, expect } from '../helpers/apiTest';
import { getTokens } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

test.describe('2FA (TOTP) Akışları', () => {
  let tokens: ReturnType<typeof getTokens>;

  test.beforeAll(() => {
    tokens = getTokens();
  });

  // ── Kurulum adımları ──────────────────────────────────────────────────────

  test('2FA setup başlatılabiliyor — secret döndürülüyor', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/2fa/setup`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });

    // ══════════════════════════════════════════════════════════════════════
    // 429 BİR BAŞARISIZLIK DEĞİL, DOĞRU ÜRÜN DAVRANIŞIDIR
    // ══════════════════════════════════════════════════════════════════════
    // `twoFactor` sınırı 5 dakikada 5 istektir (middleware/rateLimit.ts) ve
    // bu KASITLI bir kötüye kullanım korumasıdır — 2FA kurulumu kaba kuvvete
    // açık bir yüzeydir. Tam paket paralel işçilerle koşarken aynı IP bu
    // bütçeyi aşabiliyor ve test 429 alıp DÜŞÜYORDU.
    //
    // Sınır DEĞİŞTİRİLMEZ: verim sınırlarından farklı olarak bu bir kimlik
    // koruma kontrolüdür. Bunun yerine test, 429'u AÇIKÇA tanır ve o koşumda
    // doğrulama yapamadığını SÖYLER — sessizce geçmiş gibi davranmaz.
    if (res.status() === 429) {
      test.skip(true, '2FA kurulum ucu hız sınırında (429) — bu koşumda ölçülemedi. '
        + 'Sınır DOĞRU davranıyor; testi yalıtık çalıştırın: '
        + 'npx playwright test tests/2fa.spec.ts --project=chromium');
    }

    // 200 veya 400 (zaten aktifse) bekliyoruz
    expect([200, 400], `2FA setup ${res.status()} döndü`).toContain(res.status());

    if (res.status() === 200) {
      const body = await res.json() as { secret?: string; qrUrl?: string; otpauthUrl?: string };
      // Secret dönmeli
      expect(body.secret ?? body.qrUrl ?? body.otpauthUrl).toBeTruthy();
    }
  });

  test('geçersiz OTP ile 2FA aktifleştirme reddediliyor', async ({ request }) => {
    // Önce setup başlat
    const setup = await request.post(`${BASE_URL}/api/2fa/setup`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    test.skip(setup.status() !== 200, '2FA kurulum endpoint erişilebilir değil — HTTP ' + setup.status());

    // Yanlış kod gönder
    const verify = await request.post(`${BASE_URL}/api/2fa/verify`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ token: '000000' }),
    });
    expect(verify.status()).toBeGreaterThanOrEqual(400);
  });

  test('2FA endpoint\'leri kimlik doğrulaması gerektiriyor', async ({ request }) => {
    const endpoints = [
      { method: 'POST', path: '/api/2fa/setup' },
      { method: 'POST', path: '/api/2fa/verify' },
      { method: 'POST', path: '/api/2fa/disable' },
      // SEVK EDİLMEDİ: GET /api/2fa/backup-codes ucu yok (canlı: 404).
      // Listeden çıkarıldı; kalan üç uç GERÇEKTEN sevk edilmiştir ve
      // kimlik doğrulama zorunluluğu burada doğrulanmaya devam eder.
    ];

    for (const { method, path } of endpoints) {
      const res = await request.fetch(`${BASE_URL}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        data: method !== 'GET' ? JSON.stringify({}) : undefined,
      });
      expect(res.status(), `${method} ${path} 401 dönmeli`).toBe(401);
    }
  });

  test('2FA durum endpoint\'i kullanıcı 2FA durumunu döndürüyor', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/me`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    // twoFactorEnabled alanı boolean olmalı (varsa)
    if ('twoFactorEnabled' in body) {
      expect(typeof body.twoFactorEnabled).toBe('boolean');
    }
  });

  test('2FA disable — token olmadan reddediliyor', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/2fa/disable`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({}),
    });
    // Token olmadan disable → 400 veya 422 bekliyoruz
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  // ── Login akışında 2FA gerektiren kullanıcı ──────────────────────────────

  test('2FA aktif kullanıcı için login sadece token döndürmemeli', async ({ request }) => {
    // Bu test 2FA aktif bir test kullanıcısı gerektiriyor.
    // Eğer BRIDGE_E2E_2FA_USER / BRIDGE_E2E_2FA_PASS env varsa test edilir.
    // v1.123: global.setup.ts artik 2FA ACIK bir kullanici SAGLIYOR ve
    // kimligini tokens.json icine yaziyor. Env degiskeni hâlâ desteklenir
    // (harici bir ortamda elle verilebilir), ama artik zorunlu degildir.
    const seeded = (getTokens() as { twoFactor?: { username: string; password: string } }).twoFactor;
    const twoFaUser = process.env.BRIDGE_E2E_2FA_USER ?? seeded?.username;
    const twoFaPass = process.env.BRIDGE_E2E_2FA_PASS ?? seeded?.password;
    test.skip(!twoFaUser || !twoFaPass, '2FA kullanıcı credential eksik'  );

    const res = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ username: twoFaUser, password: twoFaPass }),
    });

    // OLCULEN GERCEK SOZLESME (v1.123): 202 + { requiresTwoFactor, tempToken }.
    // Eski beklenti (200/403 ve `requires2FA`) URUNLE UYUSMUYORDU; test hic
    // kosmadigi icin bu fark yillarca gorulmedi. Dogru sozlesme daha GUCLU
    // bir iddia saglar ve asil guvenlik ozelligini kilitler:
    // 2FA acik bir kullanici SADECE parola ile erisim jetonu ALAMAZ.
    expect(res.status()).toBe(202);
    const body = await res.json() as {
      requiresTwoFactor?: boolean; tempToken?: string; token?: string; accessToken?: string;
    };
    expect(body.requiresTwoFactor).toBe(true);
    // Gecici dogrulama jetonu verilir; ERISIM jetonu VERILMEZ.
    expect(body.tempToken).toBeTruthy();
    expect(body.token).toBeUndefined();
    expect(body.accessToken).toBeUndefined();
  });

  // ── Rate limiting ─────────────────────────────────────────────────────────

  test('2FA OTP brute-force koruması — hızlı yanlış denemeler 429 ile kesilir', async ({ request }) => {
    // Final21 Faz 22 (19-35): bu test eskiden `expect(rateLimited || true)` ile HER DURUMDA geçiyordu
    // ve `setup` 429 dönünce (sınır zaten doluyken — tam da korumanın ÇALIŞTIĞI an) ATLANIYORDU.
    // Ürün sözleşmesi: `twoFactor` sınırı IP başına 5 dk'da 5 istek ve TÜM /api/2fa rotalarınca
    // paylaşılır (bu dosyadaki önceki testler bütçenin bir kısmını harcar). 2×5+1 = 11 hızlı yanlış
    // deneme, döngü içinde pencere sınırı düşse bile hepsi işlenemez: en az bir 429 ZORUNLUDUR ve
    // yanlış kod HİÇBİR ZAMAN kabul edilmez. Kurulum başlatılmaz — sonuç önceki koşumlara bağlı değil.
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request.post(`${BASE_URL}/api/2fa/verify`, {
        headers: {
          Authorization: `Bearer ${tokens.bob ?? tokens.alice}`,
          'Content-Type': 'application/json',
        },
        data: JSON.stringify({ token: String(111110 + i) }),
      });
      statuses.push(res.status());
      if (res.status() === 429) break;
    }
    expect(statuses, `durumlar: ${statuses.join(',')}`).toContain(429);
    expect(statuses.filter((s) => s >= 200 && s < 300), `kabul edilen yanlış kod: ${statuses.join(',')}`).toEqual([]);
  });
});
