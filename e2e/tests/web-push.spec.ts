// e2e/tests/web-push.spec.ts — Sprint 14: TypeScript dönüşümü (.js → .ts)
// e2e/tests/web-push.spec.js — Web Push / VAPID E2E Testleri
//
// Kapsar:
//   1. VAPID public key endpoint'i (/api/webpush/vapid-public-key)
//   2. Abonelik oluşturma — POST /api/webpush/subscribe
//   3. Abonelik silme — DELETE /api/webpush/unsubscribe
//   4. Test push — POST /api/webpush/test
//   5. Auth kontrolleri (401)
//   6. Geçersiz abonelik payload'ları (400)
//
// NOT: Gerçek push mesajı göndermek tarayıcının push altyapısına bağlıdır.
// Bu testler sunucu tarafı endpoint'lerini doğrular.


import { test, expect } from '@playwright/test';
import { getTokens } from '../helpers/bridge';

const BASE = process.env.BASE_URL || 'http://localhost:3000';

test.describe('Web Push / VAPID', () => {
  let tokens;

  test.beforeAll(() => {
    tokens = getTokens();
  });

  // ── 1. VAPID public key ───────────────────────────────────

  test('GET /api/webpush/vapid-public-key — 200 veya 503 (yapılandırılmamış)', async ({ request }) => {
    const res = await request.get(`${BASE}/api/webpush/vapid-public-key`);

    // Auth gerektirmez
    expect([200, 503]).toContain(res.status());

    if (res.status() === 200) {
      const data = await res.json();
      expect(data.publicKey).toBeTruthy();
      // VAPID public key base64url formatında olmalı (~87 karakter)
      expect(data.publicKey.length).toBeGreaterThan(40);
    }
  });

  test('GET /api/webpush/vapid-public-key — 503 ise hata mesajı içermeli', async ({ request }) => {
    const res = await request.get(`${BASE}/api/webpush/vapid-public-key`);

    if (res.status() === 503) {
      const data = await res.json();
      expect(data.error).toBeTruthy();
    }
  });

  // ── 2. Abonelik oluşturma ─────────────────────────────────

  test('POST /api/webpush/subscribe — geçerli payload ile 200', async ({ request }) => {
    // Mock subscription payload (gerçek SW olmadan)
    const mockSub = {
      endpoint: `https://fcm.googleapis.com/fcm/send/e2e-test-${Date.now()}`,
      keys: {
        p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtFBuCCSTBnJJ-A7EPMgWCn4yXqXbcyq5fSMlTGHKMUkqIWBiEUmgQrWp4Xj8Y',
        auth:   'tBHItJI5svbpez7KI4CCXg',
      },
    };

    const res = await request.post(`${BASE}/api/webpush/subscribe`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify(mockSub),
    });

    // 200 (başarılı) — VAPID yapılandırılmamış olsa bile endpoint kaydı yapılır
    // 503 (VAPID eksik ama bazı implementasyonlarda yine kayıt yapılır) — kabul edilebilir
    expect(res.status()).not.toBe(401);
    expect(res.status()).not.toBe(500);
    expect([200, 201, 503]).toContain(res.status());
  });

  test('POST /api/webpush/subscribe — endpoint olmadan 400', async ({ request }) => {
    const res = await request.post(`${BASE}/api/webpush/subscribe`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ keys: { p256dh: 'xxx', auth: 'yyy' } }),
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/webpush/subscribe — keys olmadan 400', async ({ request }) => {
    const res = await request.post(`${BASE}/api/webpush/subscribe`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ endpoint: 'https://example.com/push/test' }),
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/webpush/subscribe — auth olmadan 401', async ({ request }) => {
    const res = await request.post(`${BASE}/api/webpush/subscribe`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({
        endpoint: 'https://example.com/push',
        keys: { p256dh: 'xxx', auth: 'yyy' },
      }),
    });
    expect(res.status()).toBe(401);
  });

  // ── 3. Abonelik silme ─────────────────────────────────────

  test('DELETE /api/webpush/unsubscribe — var olan endpoint silinebilmeli', async ({ request }) => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-delete-${Date.now()}`;

    // Önce subscribe
    await request.post(`${BASE}/api/webpush/subscribe`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({
        endpoint,
        keys: {
          p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtFBuCCSTBnJJ-A7EPMgWCn4yXqXbcyq5fSMlTGHKMUkqIWBiEUmgQrWp4Xj8Y',
          auth:   'tBHItJI5svbpez7KI4CCXg',
        },
      }),
    });

    // Sil
    const res = await request.delete(`${BASE}/api/webpush/unsubscribe`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ endpoint }),
    });

    expect(res.status()).toBeLessThan(300);
  });

  test('DELETE /api/webpush/unsubscribe — olmayan endpoint — 200 (idempotent)', async ({ request }) => {
    const res = await request.delete(`${BASE}/api/webpush/unsubscribe`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ endpoint: 'https://nonexistent.example/push/xyz' }),
    });
    // İdempotent — 200 veya 204 dönmeli, 500 olmamalı
    expect(res.status()).not.toBe(500);
    expect(res.status()).toBeLessThan(300);
  });

  test('DELETE /api/webpush/unsubscribe — auth olmadan 401', async ({ request }) => {
    const res = await request.delete(`${BASE}/api/webpush/unsubscribe`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ endpoint: 'https://example.com/push' }),
    });
    expect(res.status()).toBe(401);
  });

  // ── 4. Test push ──────────────────────────────────────────

  test('POST /api/webpush/test — VAPID yapılandırılmamışsa 503', async ({ request }) => {
    const vapidRes = await request.get(`${BASE}/api/webpush/vapid-public-key`);

    const res = await request.post(`${BASE}/api/webpush/test`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ message: 'E2E test push' }),
    });

    if (vapidRes.status() === 503) {
      // VAPID yok — 503 bekleniyor
      expect(res.status()).toBe(503);
    } else {
      // VAPID var ama abonelik yok — 404 bekleniyor
      // (ya da başarılı ise 200)
      expect([200, 404, 503]).toContain(res.status());
    }
  });

  test('POST /api/webpush/test — auth olmadan 401', async ({ request }) => {
    const res = await request.post(`${BASE}/api/webpush/test`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ message: 'test' }),
    });
    expect(res.status()).toBe(401);
  });
});
