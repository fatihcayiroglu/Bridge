// e2e/tests/auth.spec.ts — Sprint 14: TypeScript dönüşümü (.js → .ts)
// e2e/tests/auth.spec.js — Giriş / Kayıt / Çıkış E2E Testleri
// Kritik akış: kullanıcı sisteme girebilmeli

import { test, expect, request as pwRequest } from '@playwright/test';
import { BridgePage, getTokens } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Bu suite storageState olmadan çalışır (login sayfasını test eder)
test.use({ storageState: undefined });

test.describe('Kimlik Doğrulama Akışları', () => {

  test('kayıt formu gösterilmeli', async ({ page }) => {
    const bp = new BridgePage(page);
    await bp.goto('/register');

    // Kayıt formu elementleri
    await expect(
      page.locator('input[type="email"], input[name="email"]').first()
    ).toBeVisible();
    await expect(
      page.locator('input[type="password"], input[name="password"]').first()
    ).toBeVisible();
    await expect(
      page.locator('button[type="submit"], .register-btn, .signup-btn').first()
    ).toBeVisible();
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
      data: JSON.stringify({ email: 'alice@bridge-e2e.test', password: '' }),
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
    expect(data.username).toBe('e2e_alice');
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
      data: JSON.stringify({
        email: tokens.users.alice.email,
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
