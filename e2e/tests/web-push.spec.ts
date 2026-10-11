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


import { test, expect } from '../helpers/apiTest';
import { getTokens } from '../helpers/bridge';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test.describe('Web Push / VAPID', () => {
  let tokens;

  test.beforeAll(() => {
    tokens = getTokens();
  });

  // ── 1. VAPID public key ───────────────────────────────────

  // E2E sunucusu web push'u AÇIKÇA yapılandırmadan koşar (scripts/e2e-server.js:
  // VAPID_* boş). Eskiden ortamdan ne gelirse kabul ediliyordu ve her dal `if` içindeydi;
  // hangi yolun ölçüldüğü belli değildi. Yapılandırılmış yol (anahtar dönmesi) sunucu
  // birim testlerinde kanıtlanır: server/tests/webpush.test.ts.
  test('GET /api/webpush/vapid-public-key — kimlik istemez; VAPID yokken 503', async ({ request }) => {
    const res = await request.get(`${BASE}/api/webpush/vapid-public-key`);
    expect(res.status(), await res.text()).toBe(503);
  });

  test('GET /api/webpush/vapid-public-key — 503 yanıtı nedenini söyler', async ({ request }) => {
    const res = await request.get(`${BASE}/api/webpush/vapid-public-key`);
    expect(res.status()).toBe(503);
    expect(await res.json()).toEqual({ error: 'Web push not configured' });
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
    // Final21 Faz 22 (19-37): abonelik VAPID yapılandırmasından BAĞIMSIZ kaydedilir (ölçüldü 200 {ok:true}).
    expect(res.status()).toBe(200);
    expect((await res.json()).ok).toBe(true);
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
    const res = await request.post(`${BASE}/api/webpush/test`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ message: 'E2E test push' }),
    });

    // E2E sunucusunda VAPID yok (yukarıya bakın): gönderim denenmeden 503.
    expect(res.status(), await res.text()).toBe(503);
    expect(await res.json()).toEqual({ error: 'Web push not configured' });
  });

  test('POST /api/webpush/test — auth olmadan 401', async ({ request }) => {
    const res = await request.post(`${BASE}/api/webpush/test`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ message: 'test' }),
    });
    expect(res.status()).toBe(401);
  });
});
