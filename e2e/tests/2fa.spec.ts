// e2e/tests/2fa.spec.ts — Sprint 63: 2FA (TOTP) E2E
// Akışlar: 2FA aktifleştirme API, geçersiz OTP reddi, durum ucu,
// 2FA deaktifleştirme, 2FA açık kullanıcının girişi, OTP kaba kuvvet sınırı.
//
// ── HER TEST KENDİ İSTEMCİ ADRESİNDEN ─────────────────────────────────────
// `twoFactor` sınırı IP başına 5 dakikada 5 istektir ve TÜM /api/2fa rotalarınca
// (ve /api/step-up/password) paylaşılır; E2E sunucusu üretim değerini korur.
// Paket tek IP'den (127.0.0.1) koştuğu için bu bütçe global setup'ın 2FA
// fikstürüyle ve dosyadaki her testle PAYLAŞILIYORDU. Ölçüldü (taze sunucu,
// chromium, tek işçi): setup 2, ilk test 2, ikinci testin kurulumu 1 harcadı;
// sonra her /api/2fa çağrısı 429 döndü. Geçersiz OTP, parolasız disable ve
// kaba kuvvet testleri o 429 ile GEÇİYORDU — sunucu isteklerini hiç
// değerlendirmeden. Üstelik ilk iki test 429'da ATLANIYORDU.
//
// Sınır GEVŞETİLMEZ. Bütçeye dokunan her test kendi geri döngü adresinden
// (127.x.y.z, gerçek bir soket adresi — başlık sahteciliği değil) bağlanır ve
// üretim boyutunda TAZE bir bütçe alır (helpers/clientAddress.ts). Bu yüzden
// hiçbir test 429'u "ölçülemedi" diye kabul etmez; beklenmeyen 429 başarısızlıktır.

import { test, expect, withCsrf } from '../helpers/apiTest';
import type { APIRequestContext } from '../helpers/apiTest';
import { getTokens } from '../helpers/bridge';
import { requestFromOwnAddress } from '../helpers/clientAddress';
import { STEP_UP_HEADER, stepUpGrant } from '../helpers/stepUp';
import { totpCode, wrongTotpCodes } from '../helpers/totp';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const INVALID_CODE = 'Invalid code. Check your authenticator app.';

/** CSRF ve step-up davranışı `request` fikstürüyle AYNI, ama kendi adresinden. */
function ownAddressClient() {
  const own = requestFromOwnAddress();
  return { ...own, request: withCsrf(own.request) };
}

test.describe('2FA (TOTP) Akışları', () => {
  let tokens: ReturnType<typeof getTokens>;

  test.beforeAll(() => {
    tokens = getTokens();
  });

  // ── Kurulum adımları ──────────────────────────────────────────────────────

  test('2FA setup başlatılabiliyor — secret döndürülüyor', async () => {
    const { request } = ownAddressClient();
    const res = await request.post(`${BASE_URL}/api/2fa/setup`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    // alice'in 2FA'sı hiçbir spec'te açılmaz (yanlış kodlar onu açamaz):
    // kurulum HER ZAMAN yeni bir bekleyen secret döndürmelidir.
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json() as { secret?: string; otpauthUrl?: string; qrCode?: string };
    expect(body.secret).toMatch(/^[A-Z2-7]{16,}$/);
    expect(body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(body.otpauthUrl).toContain(`secret=${body.secret}`);
    expect(body.qrCode).toMatch(/^data:image\//);
  });

  test('geçersiz OTP ile 2FA aktifleştirme reddediliyor', async () => {
    const { request } = ownAddressClient();
    const auth = { Authorization: `Bearer ${tokens.alice}` };
    const setup = await request.post(`${BASE_URL}/api/2fa/setup`, { headers: auth });
    expect(setup.status(), await setup.text()).toBe(200);
    const { secret } = await setup.json() as { secret: string };

    // Ürün `code` alanını okur. Eski test `{ token }` gönderiyordu ve yanıt
    // "code required" idi — kod HİÇ değerlendirilmiyordu. Kod, kabul penceresinin
    // (±1 adım) dışında olduğu hesaplanmış GERÇEKTEN yanlış bir koddur.
    const [wrong] = wrongTotpCodes(secret, 1);
    const verify = await request.post(`${BASE_URL}/api/2fa/verify`, {
      headers: { ...auth, 'Content-Type': 'application/json' },
      data: JSON.stringify({ code: wrong }),
    });
    expect(verify.status(), await verify.text()).toBe(400);
    expect(await verify.json()).toMatchObject({ error: INVALID_CODE });

    const status = await request.get(`${BASE_URL}/api/2fa/status`, { headers: auth });
    expect(status.status()).toBe(200);
    expect(await status.json(), 'yanlış kod 2FA\'yı açmamalı').toMatchObject({ enabled: false });
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
    // Durum ucu `GET /api/2fa/status`'tur (Ayarlar → Güvenlik bunu okur;
    // security-tab-live.spec). Eski test `/api/me`'de `twoFactorEnabled`
    // arıyordu; `/api/me` bu alanı HİÇ döndürmez, koşullu iddia hiç çalışmazdı.
    const res = await request.get(`${BASE_URL}/api/2fa/status`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { enabled?: unknown; backupRemaining?: unknown };
    expect(body.enabled, 'alice\'in 2FA\'sı kapalıdır').toBe(false);
    expect(body.backupRemaining).toBe(0);
  });

  test('2FA disable — parola olmadan reddediliyor', async () => {
    const { request } = ownAddressClient();
    const res = await request.post(`${BASE_URL}/api/2fa/disable`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({}),
    });
    // Kapatma PAROLA ister (routes/twoFactor.ts). Eski `>= 400` beklentisi,
    // paylaşılan bütçe dolunca gelen 429 ile de geçiyordu.
    expect(res.status(), await res.text()).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'password required' });
  });

  // ── Login akışında 2FA gerektiren kullanıcı ──────────────────────────────

  test('2FA aktif kullanıcı için login sadece token döndürmemeli', async ({ request }) => {
    // global.setup.ts 2FA ACIK bir kullanici SAGLAR ve kimligini tokens.json
    // icine yazar (harici bir ortamda BRIDGE_E2E_2FA_USER / _PASS ile de
    // verilebilir). Fikstur yoksa test ATLANMAZ: kurulumun "SKIP 2FA fiksturu"
    // uyarisi bu testin basarisizlik nedenidir.
    const seeded = (getTokens() as { twoFactor?: { username: string; password: string } }).twoFactor;
    const twoFaUser = process.env.BRIDGE_E2E_2FA_USER ?? seeded?.username;
    const twoFaPass = process.env.BRIDGE_E2E_2FA_PASS ?? seeded?.password;
    expect(twoFaUser && twoFaPass, '2FA fikstur kullanicisi yok — global setup ciktisindaki "SKIP 2FA fiksturu" uyarisina bakin').toBeTruthy();

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

  test('2FA OTP brute-force koruması — hızlı yanlış denemeler 429 ile kesilir', async () => {
    // Ürün sözleşmesi: `twoFactor` sınırı IP başına 5 dk'da 5 istek. Taze bir
    // adresten TAM sayım: kurulum (1) + dört yanlış kod (2–5) DEĞERLENDİRİLİR ve
    // 400 alır; altıncı istek 429'dur — ve yedinci istekteki DOĞRU kod bile 429
    // alır: sınır kodu değerlendirmeden keser, deneme sürdürülemez. Eskiden bu
    // test paylaşılan bütçe zaten dolu olduğu için ilk istekte 429 alıyordu ve
    // `{ token }` gönderdiği için hiçbir kod değerlendirilmiyordu.
    const { request: own } = requestFromOwnAddress();
    const request = withCsrf(own);
    const bearer = tokens.bob;
    // Kanıt ÖNCEDEN alınır (giriş ucu, 2FA bütçesi değil): adım-yukarı reddi de
    // bu bütçeden sayılır ve sayımı bozardı. Fikstür sarmalayıcısının otomatik
    // yeniden denemesi bu yüzden kapatılır.
    const grant = await stepUpGrant(own as unknown as APIRequestContext, bearer, 'account-security');
    expect(grant, 'bob için adım-yukarı kanıtı alınamadı').toBeTruthy();
    const auth = { Authorization: `Bearer ${bearer}`, [STEP_UP_HEADER]: grant!, 'x-e2e-no-step-up': '1' };
    const json = { ...auth, 'Content-Type': 'application/json' };

    const setup = await request.post(`${BASE_URL}/api/2fa/setup`, { headers: auth });
    expect(setup.status(), await setup.text()).toBe(200);
    expect(setup.headers()['x-ratelimit-limit'], 'E2E üretim bütçesini ölçer').toBe('5');
    expect(setup.headers()['x-ratelimit-remaining'], 'adres kendi taze bütçesine sahip').toBe('4');
    const { secret } = await setup.json() as { secret: string };

    const wrong = wrongTotpCodes(secret, 5);
    const statuses: number[] = [];
    for (const code of wrong.slice(0, 4)) {
      const res = await request.post(`${BASE_URL}/api/2fa/verify`, { headers: json, data: JSON.stringify({ code }) });
      statuses.push(res.status());
      expect(res.status(), `yanlış kod ${code}: ${await res.text()}`).toBe(400);
      expect(await res.json()).toMatchObject({ error: INVALID_CODE });
    }
    const cut = await request.post(`${BASE_URL}/api/2fa/verify`, { headers: json, data: JSON.stringify({ code: wrong[4] }) });
    statuses.push(cut.status());
    expect(cut.status(), `durumlar: ${statuses.join(',')}`).toBe(429);
    expect(Number(cut.headers()['retry-after'])).toBeGreaterThan(0);

    const correct = await request.post(`${BASE_URL}/api/2fa/verify`, { headers: json, data: JSON.stringify({ code: totpCode(secret) }) });
    expect(correct.status(), 'sınır aşıldıktan sonra doğru kod da kesilir').toBe(429);

    const status = await request.get(`${BASE_URL}/api/2fa/status`, { headers: { Authorization: `Bearer ${bearer}` } });
    expect(await status.json(), 'hiçbir deneme 2FA\'yı açmadı').toMatchObject({ enabled: false });
  });
});
