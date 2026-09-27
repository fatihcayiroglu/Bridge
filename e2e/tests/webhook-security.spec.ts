// e2e/tests/webhook-security.spec.ts
//
// GİDEN WEBHOOK GÜVENLİĞİ — ÜRÜN UCUNDA SSRF VE YETKİ
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN AYRI BİR E2E DOSYASI VAR
// ════════════════════════════════════════════════════════════════════════════
// `server/tests/ssrf-outbound.test.ts` adres sınıflandırmasını ve `fetchT`
// davranışını doğrudan test eder. Bu dosya ise ÜRÜN UCUNU sürer: rota
// gerçekten o denetimi ÇAĞIRIYOR mu, ve yetki kontrolü doğru mu?
// Kütüphane doğru olup rota onu çağırmazsa paket yine yeşil görünürdü.
//
// ÖLÇÜLEN AÇIK (düzeltilmeden önce, gerçek API):
//     POST /api/servers/:sid/outgoing-webhooks
//       url = http://[::ffff:127.0.0.1]:5433/  →  201 OLUŞTURULDU
//       url = http://[::ffff:10.0.0.5]/        →  201 OLUŞTURULDU
//       url = http://[64:ff9b::7f00:1]/        →  201 OLUŞTURULDU
//     düz yazımları (127.0.0.1 / 10.0.0.5) doğru şekilde 400 dönüyordu.

import { test, expect } from '../helpers/apiTest';
import { getTokens, createTestServer, joinServer } from '../helpers/bridge';
import { getCsrf } from '../helpers/csrf';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test.describe('giden webhook güvenliği', () => {
  let tokens: ReturnType<typeof getTokens>;
  let serverId = '';
  let csrfAlice = '';

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();
    const srv = await createTestServer(request, tokens.alice, `WH ${Date.now()}`);
    serverId = String((srv as { _id?: string })?._id ?? '');
    expect(serverId, 'webhook test sunucusu oluşturulamadı').toBeTruthy();
    await joinServer(request, tokens.alice, tokens.bob, serverId);
    csrfAlice = await getCsrf(request, tokens.alice);
  });

  function createWebhook(
    request: import('@playwright/test').APIRequestContext,
    token: string, csrf: string, url: string,
  ) {
    return request.post(`${BASE}/api/servers/${serverId}/outgoing-webhooks`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
      },
      data: JSON.stringify({ name: `wh-${Date.now()}`, url, events: ['message:new'] }),
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SSRF — iç hedefler reddedilir
  // ══════════════════════════════════════════════════════════════════════════

  const ssrfTargets: Array<[string, string]> = [
    ['loopback',                'http://127.0.0.1:5433/'],
    ['localhost adı',           'http://localhost:5433/'],
    ['bulut metadata',          'http://169.254.169.254/latest/meta-data/'],
    ['iç ağ 10/8',              'http://10.0.0.5/admin'],
    ['IPv6 loopback',           'http://[::1]:6379/'],
    // ── Aşağıdakiler DÜZELTMEDEN ÖNCE 201 dönüyordu ──────────────────────
    ['IPv4-mapped loopback',    'http://[::ffff:127.0.0.1]:5433/'],
    ['IPv4-mapped (hex)',       'http://[::ffff:7f00:1]:5433/'],
    ['IPv4-mapped iç ağ',       'http://[::ffff:10.0.0.5]/'],
    ['NAT64 loopback',          'http://[64:ff9b::7f00:1]/'],
    ['6to4 loopback',           'http://[2002:7f00:1::]/'],
    ['belirsiz adres',          'http://[::]/'],
    // Protokol kaçışı
    ['file protokolü',          'file:///etc/passwd'],
  ];

  for (const [label, url] of ssrfTargets) {
    test(`SSRF — ${label} REDDEDİLİR`, async ({ request }) => {
      // KANITLAR    : rota adres denetimini gerçekten çağırıyor.
      // KANITLAMAZ  : DNS yeniden bağlama (rebinding) senaryosunu — bu,
      //               bağlantı anında `lib/fetch.ts` tarafından ele alınır.
      const res = await createWebhook(request, tokens.alice, csrfAlice, url);
      expect({ url, status: res.status() }).toEqual({ url, status: 400 });
    });
  }

  test('meşru genel adres KABUL EDİLİR — kural körü körüne engellemiyor', async ({ request }) => {
    // Bu olmadan yukarıdaki testler "her şeyi reddet" ile de geçerdi.
    const res = await createWebhook(request, tokens.alice, csrfAlice, 'https://example.com/hook');
    expect(res.status()).toBe(201);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // YETKİ — webhook yönetimi MANAGE_SERVER ister
  // ══════════════════════════════════════════════════════════════════════════

  test('SIRADAN ÜYE webhook oluşturamaz', async ({ request }) => {
    const csrfBob = await getCsrf(request, tokens.bob);
    const res = await createWebhook(request, tokens.bob, csrfBob, 'https://example.com/hook');
    expect([401, 403]).toContain(res.status());
  });

  test('ÜYE OLMAYAN kullanıcı webhook oluşturamaz', async ({ request }) => {
    const csrfCarol = await getCsrf(request, tokens.carol);
    const res = await createWebhook(request, tokens.carol, csrfCarol, 'https://example.com/hook');
    expect([401, 403, 404]).toContain(res.status());
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TESLİMAT — durum kaydı çökmemeli
  // ══════════════════════════════════════════════════════════════════════════

  test('teslimat denemesi 500 ÜRETMEZ — durum sütunları yazılabilir', async ({ request }) => {
    // ÖLÇÜLEN KUSUR: `fireOutgoingWebhook` sonucu kaydederken
    //   [pgCollection] Unknown column name: "consecutiveFailures"
    // hatası veriyordu. `outgoing_webhooks` tablosunda `consecutiveFailures`,
    // `lastFailedAt` ve `lastError` sütunları YOKTU ama kod HEM başarı HEM
    // hata dalında bunları yazıyordu. Sonuç: her teslimat denemesi 500.
    //
    // ETKİSİ yalnızca gürültü değildi: 10 ardışık hatadan sonra otomatik
    // DEVRE DIŞI bırakma hiç çalışmıyordu ve `lastStatus` hiç kalıcı olmuyordu.
    const created = await createWebhook(request, tokens.alice, csrfAlice, 'https://example.com/hook');
    expect(created.status()).toBe(201);
    const wh = await created.json() as { _id?: string };
    expect(wh._id, 'webhook kimliği dönmedi').toBeTruthy();

    const fired = await request.post(
      `${BASE}/api/servers/${serverId}/outgoing-webhooks/${wh._id}/test`,
      {
        headers: {
          Authorization: `Bearer ${tokens.alice}`,
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfAlice,
        },
        data: '{}',
      },
    );
    // Uzak uç ne dönerse dönsün, BİZİM tarafımız çökmemeli.
    expect(fired.status(), 'teslimat durum kaydı hâlâ çöküyor').not.toBe(500);
  });
});
