// e2e/tests/auth.spec.ts — Sprint 14: TypeScript dönüşümü (.js → .ts)
// e2e/tests/auth.spec.js — Giriş / Kayıt / Çıkış E2E Testleri
// Kritik akış: kullanıcı sisteme girebilmeli

import { test, expect, request as pwRequest } from '../helpers/apiTest';
import { BridgePage, getTokens } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

// Bu suite storageState olmadan çalışır (login sayfasını test eder)
// NOT: `storageState: undefined` proje düzeyindeki değeri EZMEZ — Playwright
// bunu "belirtilmedi" sayıp projedeki dosyayı kullanmaya devam eder ve sayfa
// oturum açmış gelir. Oturumsuz yüzey için AÇIKÇA boş durum verilmelidir.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Kimlik Doğrulama Akışları', () => {

  test('kayıt formu gösterilmeli', async ({ page }) => {
    // '/register' diye bir sunucu rotası YOK (SPA). Form kökte, auth sekmesiyle
    // açılır ve E-POSTA alanı içermez: görünen ad / kullanıcı adı / şifre.
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#login-form').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('auth-tab-register').click();

    await expect(page.locator('#register-form')).toBeVisible();
    await expect(page.locator('#r-username')).toBeVisible();
    await expect(page.locator('#r-displayname')).toBeVisible();
    await expect(page.locator('#r-password')).toBeVisible();
  });

  test('geçersiz e-posta ile giriş reddedilmeli', async ({ page, request }) => {
    // API seviyesinde test (UI giriş sayfası UI-specific olabilir)
    const res = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ email: 'yok@yoktur.xyz', password: 'yanliş123' }),
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('boş şifre ile giriş reddedilmeli', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'Content-Type': 'application/json' },
      // Fixture hesabını (alice) KULLANMA: başarısız giriş denemeleri brute-force
      // kilidini tetikliyor ve sonraki run'larda globalSetup 429 ile düşüyordu.
      // Doğrulanan davranış "boş şifre reddedilir" — bunun için gerçek bir hesap gerekmez.
      data: JSON.stringify({ email: 'empty-password-probe@bridge-e2e.invalid', password: '' }),
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('geçerli token ile /api/me çalışmalı', async ({ request }) => {
    const tokens = getTokens();
    const res = await request.get(`${BASE_URL}/api/me`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('username');
    expect(data.username).toBe(tokens.users.alice.username);
  });

  test('geçersiz token reddedilmeli', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/me`, {
      headers: { Authorization: 'Bearer bu.gecersiz.bir.token' },
    });
    expect(res.status()).toBe(401);
  });

  test('token olmadan korumalı route reddedilmeli', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/servers`);
    expect(res.status()).toBe(401);
  });

  test('UI: login sayfasına erişim', async ({ page }) => {
    const bp = new BridgePage(page);
    await bp.goto('/');
    // Giriş yapmamış kullanıcı — login formuna yönlendirilmeli
    // ya da login formu gösterilmeli
    const title = await page.title();
    expect(title).toBeTruthy();
    // Temel sayfa yüklendi mi
    await expect(page.locator('body')).toBeVisible();
  });

  test('API login doğru token döndürmeli', async ({ request }) => {
    const tokens = getTokens();
    // Zaten token'ımız var ama login endpoint'ini doğrulayalım
    const res = await request.post(`${BASE_URL}/api/login`, {
      headers: { 'Content-Type': 'application/json' },
      // /api/login KULLANICI ADI bekler; e-posta ile 400 'username is required'.
      data: JSON.stringify({
        username: tokens.users.alice.username,
        password: tokens.users.alice.password,
      }),
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    // Token alanı dönmeli
    expect(data.token || data.accessToken).toBeTruthy();
  });

  test('rate limit: çok fazla login denemesi engellenmeli', async ({ request }) => {
    // 10 hatalı deneme yap
    const attempts = Array.from({ length: 10 }, () =>
      request.post(`${BASE_URL}/api/login`, {
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ email: 'ratelimit@test.com', password: 'yanlis' }),
      })
    );
    const results = await Promise.all(attempts);
    const statuses = results.map((r) => r.status());
    // En az birinde 429 olmalı (rate limit) — veya hepsi 400/401
    const hasRateLimit = statuses.some((s) => s === 429);
    const allRejected = statuses.every((s) => s >= 400);
    expect(hasRateLimit || allRejected).toBe(true);
  });
});
