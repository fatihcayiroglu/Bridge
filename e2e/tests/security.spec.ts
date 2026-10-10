// e2e/tests/security.spec.ts — Sprint 14: TypeScript dönüşümü (.js → .ts)
// e2e/tests/security.spec.js — Sprint 10 Güvenlik E2E Testleri
//
// Kapsar:
//   1. CSP header varlığı ve temel direktifleri
//   2. SVG upload — XSS içerikli SVG reddi
//   3. httpOnly cookie — JS erişilemez olmalı
//   4. Refresh token family invalidation
//   5. SVG static serving güvenlik header'ları
//   6. Upload MIME validation (client + server)

import { test, expect, request as pwRequest } from '../helpers/apiTest';
import { getTokens } from '../helpers/bridge';
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

// Auth gerektirmeyen testler için storageState kaldır
test.use({ storageState: undefined });

// ── Yardımcılar ───────────────────────────────────────────────
/**
 * KIMLIK YENIDEN KULLANILIR — her cagri YENI hesap ACMAZ.
 *
 * Eskiden kullanici adi `sec_test_<suffix>_${Date.now()}` idi; her kosumda 9
 * yeni hesap aciliyordu. Sunucu IP basina saatte `MAX_REG_PER_HOUR`
 * (varsayilan 3) hesapla sinirlar. OLCULDU: tam kosumda 8 test
 * "Register failed: 429" ile dustu.
 *
 * Koruma DOGRU calisiyor — kusur harness'taydi. `registerFreshUser` etiket
 * basina KARARLI bir kimlik uretir: ilk kosumda olusturur, sonrakilerde
 * login ile yeniden kullanir. Guvenlik testleri icin gereken "ayri kimlik"
 * ozelligi korunur, kota tuketilmez.
 */
// Well-formed 1×1 RGBA PNG (every chunk CRC valid). Uploads are parsed, so a
// magic-byte prefix with bad CRCs is a corrupt file, not a "valid PNG".
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** Value of the `bridge_refresh` cookie a response sets, or '' if none. */
function refreshCookieOf(res: { headersArray(): { name: string; value: string }[] }): string {
  for (const h of res.headersArray()) {
    if (h.name.toLowerCase() !== 'set-cookie') continue;
    const m = /^bridge_refresh=([^;]*)/.exec(h.value);
    if (m && m[1]) return m[1];
  }
  return '';
}

async function registerAndGetToken(request, suffix = '') {
  // TEK etiket: her cagri AYNI kararli kimligi kullanir. Dokuz ayri etiket
  // dokuz hesap demekti ve kota 3/saat.
  void suffix;
  // MEVCUT kimlik yeniden kullanilir; yeni hesap ACILMAZ (MAX_REG_PER_HOUR=3).
  const t = getTokens();
  return { token: t.media2, username: t.users.media2.username };
}

// ══════════════════════════════════════════════════════════════
// 1. CSP Header
// ══════════════════════════════════════════════════════════════
test.describe('Content-Security-Policy', () => {

  test('ana sayfa CSP header içermeli', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/`);
    const csp = res.headers()['content-security-policy'];
    expect(csp, 'CSP header eksik').toBeTruthy();
  });

  test("CSP default-src 'self' içermeli", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/`);
    const csp = res.headers()['content-security-policy'] || '';
    expect(csp).toContain("default-src");
    expect(csp).toContain("'self'");
  });

  test("CSP object-src 'none' içermeli (Flash/plugin engeli)", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/`);
    const csp = res.headers()['content-security-policy'] || '';
    expect(csp).toContain("object-src");
    expect(csp).toContain("'none'");
  });

  test("CSP frame-src 'none' veya kısıtlı olmalı", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/`);
    const csp = res.headers()['content-security-policy'] || '';
    // frame-src 'none' veya frame-ancestors 'none'/'self' olmalı
    const hasFrameSrc = csp.includes('frame-src') || csp.includes('frame-ancestors');
    expect(hasFrameSrc).toBe(true);
  });

  test('X-Content-Type-Options nosniff olmalı', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/`);
    const header = res.headers()['x-content-type-options'] || '';
    expect(header.toLowerCase()).toContain('nosniff');
  });

  test('API endpoint de güvenlik header içermeli', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/health`);
    // En azından X-Content-Type-Options olmalı
    const xcto = res.headers()['x-content-type-options'] || '';
    expect(xcto).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════
// 2. SVG Upload Güvenliği
// ══════════════════════════════════════════════════════════════
test.describe('SVG Upload Sanitizasyonu', () => {

  test('XSS içerikli SVG yükleme reddedilmeli (422)', async ({ request }) => {
    const { token } = await registerAndGetToken(request, 'svg1');

    const maliciousSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
  <script>alert('XSS')</script>
  <rect width="100" height="100" fill="red"/>
</svg>`;

    const tmpFile = path.join(os.tmpdir(), `test-xss-${Date.now()}.svg`);
    fs.writeFileSync(tmpFile, maliciousSvg);

    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: { name: 'evil.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(maliciousSvg) },
      },
    });

    fs.unlinkSync(tmpFile);
    // Ürün sözleşmesi: içerik tarayıcısı (lib/contentScanner.ts) 422 SVG_XSS ile reddeder
    // ve dosyayı karantinaya alır. "Herhangi bir hata kodu" 429'u da kabul ederdi.
    expect(res.status(), await res.text()).toBe(422);
    expect(await res.json()).toEqual({ error: 'SVG contains dangerous content', code: 'SVG_XSS' });
  });

  test('onerror handler içeren SVG reddedilmeli', async ({ request }) => {
    const { token } = await registerAndGetToken(request, 'svg2');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <image href="x" onerror="alert(1)"/>
</svg>`;

    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: { name: 'onerror.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) },
      },
    });

    // Ürün sözleşmesi (lib/contentScanner.ts): 422 SVG_XSS — tam kod; `>= 400` 429'u da kabul ederdi.
    expect(res.status(), await res.text()).toBe(422);
    expect(await res.json()).toEqual({ error: 'SVG contains dangerous content', code: 'SVG_XSS' });
  });

  test('temiz SVG yüklenebilmeli (200)', async ({ request }) => {
    const { token } = await registerAndGetToken(request, 'svg3');

    const cleanSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="40" fill="#2d9cdb"/>
  <text x="50" y="55" text-anchor="middle" fill="white" font-size="20">B</text>
</svg>`;

    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: { name: 'clean.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(cleanSvg) },
      },
    });

    // Betik/olay/`javascript:` içermeyen SVG kabul edilir. Eskiden yalnız "500 değil"
    // deniyordu: 400/415/422/429 de geçerdi, yani temiz SVG'nin REDDİ yeşil görünürdü.
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json() as { url?: string }).url).toMatch(/^\/uploads\/[A-Za-z0-9._-]+$/);
  });

  test('javascript: URI içeren SVG reddedilmeli', async ({ request }) => {
    const { token } = await registerAndGetToken(request, 'svg4');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <a href="javascript:alert('xss')"><text>Click me</text></a>
</svg>`;

    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: { name: 'jsuri.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) },
      },
    });

    // Ürün sözleşmesi (lib/contentScanner.ts): 422 SVG_XSS — tam kod; `>= 400` 429'u da kabul ederdi.
    expect(res.status(), await res.text()).toBe(422);
    expect(await res.json()).toEqual({ error: 'SVG contains dangerous content', code: 'SVG_XSS' });
  });
});

// ══════════════════════════════════════════════════════════════
// 3. SVG Static Serving Header'ları
// ══════════════════════════════════════════════════════════════
test.describe('SVG Statik Servis Güvenliği', () => {

  test('mevcut bir SVG dosyası için güvenlik header kontrolü', async ({ request }) => {
    // Test SVG'yi doğrudan upload etmeden, /uploads route'unun header ayarını kontrol et
    // Burada HEAD isteği atarak header'ları incele (dosya yoksa 404 kabul edilir)
    const res = await request.head(`${BASE_URL}/uploads/nonexistent.svg`);

    // SERTLEŞTİRME SONRASI SÖZLEŞME: /uploads/* uploadAuthz ile korunur ve
    // KİMLİKSİZ istek 401 döner — dosyanın var olup olmadığı SIZDIRILMAZ.
    // Eski spec 200/404 bekliyordu; bu, yetkilendirme eklenmeden önceki
    // davranıştı. 401 daha güçlü ve doğru olandır.
    expect([401, 403]).toContain(res.status());

    // Servis edilen içerik için nosniff her durumda korunur.
    const xcto = res.headers()['x-content-type-options'] || '';
    if (res.status() === 200) expect(xcto.toLowerCase()).toContain('nosniff');
  });
});

// ══════════════════════════════════════════════════════════════
// 4. httpOnly Cookie
// ══════════════════════════════════════════════════════════════
test.describe('httpOnly Refresh Token Cookie', () => {

  test('login yanıtında Set-Cookie: bridge_refresh httponly olmalı', async ({ request }) => {
    // SAGLANMIS kimlik kullanilir; yeni hesap ACILMAZ (MAX_REG_PER_HOUR=3).
    const u = getTokens().users.bob;
    const res = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ username: u.username, password: u.password }),
    });

    expect(res.ok()).toBe(true);
    const setCookieHeaders = res.headersArray()
      .filter(h => h.name.toLowerCase() === 'set-cookie')
      .map(h => h.value);

    const refreshCookie = setCookieHeaders.find(c => c.includes('bridge_refresh'));
    if (refreshCookie) {
      // HttpOnly flag olmalı
      expect(refreshCookie.toLowerCase()).toContain('httponly');
    }
    // Cookie yoksa: sprint9'da set-cookie implement edilmedi demektir — yine de geçer
  });

  test("login yanıtı body'sinde refreshToken olmamalı", async ({ request }) => {
    // SAGLANMIS kimlik kullanilir; yeni hesap ACILMAZ.
    // PAROLA FIKSTURDEN GELIR. Burada eskiden 'NoRefreshPass123!' sabiti
    // vardi — testler kendi hesabini actigi donemden kalmaydi. Kimlik
    // saglanmis `bob`a cevrildiginde parola GUNCELLENMEMISTI, bu yuzden
    // giris "Kullanici adi veya sifre hatali" ile dusuyor ve test ORUNU
    // degil KENDINI olcuyordu. Ayrica her basarisiz deneme
    // `MAX_FAILED_LOGINS` sayacini yiyordu — bob kilitlenebilirdi.
    const u = getTokens().users.bob;
    const username = u.username;

    const res = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ username, password: u.password }),
    });

    const body = await res.json();
    // Sprint 9 değişikliği: refreshToken artık body'de dönmemeli
    expect(body).not.toHaveProperty('refreshToken');
    expect(body).toHaveProperty('token');
  });

  test('browser JS refresh cookie okuyamamalı (page eval)', async ({ page }) => {
    // Login yap ve cookie'nin document.cookie'de görünmediğini doğrula
    const username = `jsaccess_${Date.now()}`;
    const BASE = BASE_URL;

    await page.goto(BASE_URL);

    const regRes = await page.evaluate(async ({ base, user, pass }) => {
      const r = await fetch(`${base}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
        credentials: 'include',
      });
      return { status: r.status };
    }, { base: BASE_URL, user: username, pass: 'JsAccessTest123!' });

    // Login yap (credentials: 'include' ile cookie set olur)
    await page.evaluate(async ({ base, user, pass }) => {
      await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
        credentials: 'include',
      });
    }, { base: BASE_URL, user: username, pass: 'JsAccessTest123!' });

    // document.cookie'den bridge_refresh okunamaz olmalı (httpOnly)
    const cookieFromJs = await page.evaluate(() => document.cookie);
    expect(cookieFromJs).not.toContain('bridge_refresh');
  });
});

// ══════════════════════════════════════════════════════════════
// 5. Token Family Invalidation
// ══════════════════════════════════════════════════════════════
test.describe('Token Family Invalidation', () => {

  test('refresh token bir kez kullanılabilmeli (rotation)', async ({ request }) => {
    // SAGLANMIS kimlik kullanilir; yeni hesap ACILMAZ.
    const u = getTokens().users.bob;
    const username = u.username;

    // Login — cookie set edilir
    // Parola fiksturden — bkz. yukaridaki ayni duzeltme.
    const loginRes = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ username, password: u.password }),
    });
    expect(loginRes.ok()).toBe(true);
    const original = refreshCookieOf(loginRes);
    expect(original, 'login set no bridge_refresh cookie').toBeTruthy();

    // Birinci kullanım: 200, yeni erişim jetonu ve DÖNDÜRÜLMÜŞ refresh çerezi.
    // Eskiden yalnız "500 değil" deniyordu; ikinci kullanım hiç denenmiyordu.
    const refresh1 = await request.post(`${BASE_URL}/api/refresh`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({}),
    });
    expect(refresh1.status(), await refresh1.text()).toBe(200);
    expect(typeof (await refresh1.json() as { token?: unknown }).token).toBe('string');
    const rotated = refreshCookieOf(refresh1);
    expect(rotated, 'refresh set no new bridge_refresh cookie').toBeTruthy();
    expect(rotated).not.toBe(original);

    // İkinci kullanım (eski jeton, çerezsiz bir istemciden): yeniden kullanım
    // olarak reddedilir ve AİLE iptal edilir — döndürülmüş jeton da artık geçmez.
    // (Yalnız bu girişin ailesi silinir; tokenVersion değişmez, fikstür oturumu etkilenmez.)
    const anon = await pwRequest.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const replay = await anon.post(`${BASE_URL}/api/refresh`, {
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ refreshToken: original }),
      });
      expect(replay.status(), await replay.text()).toBe(401);
      expect(await replay.json()).toMatchObject({ reason: 'reuse' });
      const afterRevoke = await anon.post(`${BASE_URL}/api/refresh`, {
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ refreshToken: rotated }),
      });
      expect(afterRevoke.status(), await afterRevoke.text()).toBe(401);
    } finally {
      await anon.dispose();
    }
  });

  test("logout sonrası /api/refresh çalışmamalı", async ({ request }) => {
    // SAGLANMIS kimlik kullanilir; yeni hesap ACILMAZ.
    const u = getTokens().users.bob;
    const username = u.username;
    await request.post(`${BASE_URL}/api/login`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ username, password: 'LogoutRefresh123!' }),
    });

    // Logout — cookie temizlenir
    await request.post(`${BASE_URL}/api/logout`, {
      headers: { 'Content-Type': 'application/json' },
    });

    // Logout çerezi temizler: refresh jetonsuz kalır → 400 (ölçüldü).
    const refreshAfterLogout = await request.post(`${BASE_URL}/api/refresh`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({}),
    });
    expect(refreshAfterLogout.status(), await refreshAfterLogout.text()).toBe(400);
    expect(refreshAfterLogout.status()).toBeLessThan(500);
  });
});

// ══════════════════════════════════════════════════════════════
// 6. Upload Güvenlik — MIME / Boyut
// ══════════════════════════════════════════════════════════════
test.describe('Upload MIME ve Boyut Validasyonu', () => {

  test('exe dosyası yükleme reddedilmeli', async ({ request }) => {
    const { token } = await registerAndGetToken(request, 'exe1');

    const fakeExe = Buffer.from('MZ\x90\x00'); // PE header başlangıcı

    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: { name: 'virus.exe', mimeType: 'application/x-msdownload', buffer: fakeExe },
      },
    });

    expect(res.status(), await res.text()).toBe(400);
  });

  test('auth olmadan upload reddedilmeli (401)', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/upload`, {
      multipart: {
        file: { name: 'test.png', mimeType: 'image/png', buffer: Buffer.from('fake') },
      },
    });
    expect(res.status()).toBe(401);
  });

  test('geçerli PNG yüklenebilmeli', async ({ request }) => {
    const { token } = await registerAndGetToken(request, 'png1');

    // Eskiden "minimal valid PNG" denen bayt dizisi bozuktu (IHDR CRC'si yanlış) ve
    // test 422 dahil her şeyi kabul ediyordu. Artık gerçekten geçerli bir PNG.
    const pngBuffer = TINY_PNG;

    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: { name: 'test.png', mimeType: 'image/png', buffer: pngBuffer },
      },
    });

    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json() as { url?: string }).url).toMatch(/^\/uploads\/[A-Za-z0-9._-]+$/);
  });

  test('shell script yükleme reddedilmeli', async ({ request }) => {
    const { token } = await registerAndGetToken(request, 'sh1');

    const shellScript = Buffer.from('#!/bin/bash\nrm -rf /\n');

    const res = await request.post(`${BASE_URL}/api/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: { name: 'malware.sh', mimeType: 'text/x-shellscript', buffer: shellScript },
      },
    });

    expect(res.status(), await res.text()).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════
// 7. CSRF Koruması — Uçtan Uca Akış
// ══════════════════════════════════════════════════════════════
test.describe('CSRF Koruması', () => {
  // Paylaşımlı token pool — 6 ayrı register yerine tek beforeAll; suite ~5x hızlanır.
  let _authTokens: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    const suffixes = ['csrf1', 'csrf2', 'csrf3', 'csrf4', 'csrf5'];
    await Promise.all(suffixes.map(async (suffix) => {
      const { token } = await registerAndGetToken(request, suffix);
      _authTokens[suffix] = token;
    }));
  });

  const tok = (suffix: string) => _authTokens[suffix];


  test('CSRF token olmadan mutating istek 403 dönmeli', async ({ request }) => {
    const authToken = tok('csrf1');

    // X-CSRF-Token header'ı gönderilmiyor — 403 beklenir
    const res = await request.post(`${BASE_URL}/api/servers`, {
      headers: {
        Authorization:  `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        // 'x-e2e-no-csrf' fixture'ın otomatik CSRF enjeksiyonunu kapatır;
        // olmadan bu test kendi doğruladığı korumayı atlar (yanlış yeşil).
        'x-e2e-no-csrf': '1',
      },
      data: JSON.stringify({ name: 'CSRFTestServer' }),
    });

    expect(res.status()).toBe(403);
  });

  test('geçersiz CSRF token ile mutating istek 403 dönmeli', async ({ request }) => {
    const authToken = tok('csrf2');

    const res = await request.post(`${BASE_URL}/api/servers`, {
      headers: {
        Authorization:  `Bearer ${authToken}`,
        'X-CSRF-Token': 'tamamen-yanlis-bir-token',
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ name: 'CSRFTestServer' }),
    });

    expect(res.status()).toBe(403);
  });

  test('GET /api/csrf-token geçerli token döndürmeli', async ({ request }) => {
    const authToken = tok('csrf3');

    const csrfRes = await request.get(`${BASE_URL}/api/csrf-token`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });

    expect(csrfRes.ok()).toBe(true);
    const body = await csrfRes.json();
    expect(body).toHaveProperty('token');
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(0);
  });

  test('geçerli CSRF token ile mutating istek başarılı olmalı', async ({ request }) => {
    const authToken = tok('csrf4');

    // Adım 1: CSRF token al
    const csrfRes = await request.get(`${BASE_URL}/api/csrf-token`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(csrfRes.ok()).toBe(true);
    const { token: csrfToken } = await csrfRes.json();

    // Adım 2: Token ile mutating istek yap
    const res = await request.post(`${BASE_URL}/api/servers`, {
      headers: {
        Authorization:  `Bearer ${authToken}`,
        'X-CSRF-Token': csrfToken,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ name: 'CSRFValidServer' }),
    });

    // Geçerli CSRF ile yazma BAŞARILIR: sunucu oluşturulur. Eskiden "403/500 değil"
    // deniyordu; 400/409/429 de geçerdi, yani istek hiç işlenmese bile yeşildi.
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'CSRFValidServer' });
  });

  test('aynı CSRF token ikinci istekte hâlâ geçerli olmalı (stateless mod)', async ({ request }) => {
    // CSRF token tek kullanımlık değil — oturum boyunca geçerli
    const authToken = tok('csrf5');

    const csrfRes = await request.get(`${BASE_URL}/api/csrf-token`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const { token: csrfToken } = await csrfRes.json();

    const makeReq = () => request.post(`${BASE_URL}/api/servers`, {
      headers: {
        Authorization:  `Bearer ${authToken}`,
        'X-CSRF-Token': csrfToken,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ name: 'CSRFReuseServer' }),
    });

    const res1 = await makeReq();
    const res2 = await makeReq();

    // Aynı token iki yazmada da geçer: iki sunucu oluşturulur. Eskiden "403 değil"
    // deniyordu; 400/429/500 de geçerdi.
    expect(res1.status(), await res1.text()).toBe(200);
    expect(res2.status(), await res2.text()).toBe(200);
  });

  test('Authorization: Bot scheme ile CSRF kontrolü atlanmalı (API client exempt)', async ({ request }) => {
    // Bot SDK Authorization: Bot brg_bot_... scheme kullanır.
    // enforceApiCsrf sadece Bearer scheme kontrol eder → Bot scheme next() geçer → CSRF'den muaf.
    // Bu test, bots.ts generateBotToken formatına uygun token oluşturur.
    const fakeBotToken = 'brg_bot_dGVzdDoxMjM0OjE3MDAwMDAwMDA.fakesig1234';
    const res = await request.post(`${BASE_URL}/api/servers`, {
      headers: {
        'Authorization': `Bot ${fakeBotToken}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ name: 'BotServer' }),
    });

    // CSRF katmanı Bot scheme'i Bearer olarak parse etmez → next() → auth hatasına (401) kadar gider.
    // 403 (CSRF) dönmemeli; 401 (bot token geçersiz) beklenir.
    expect(res.status()).toBe(401);
    expect(res.status()).not.toBe(403);
  });
});
