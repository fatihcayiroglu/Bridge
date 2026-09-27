// e2e/tests/server-menu-capabilities.spec.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SUNUCU MENÜSÜ — YAPILMIŞ YETENEKLER GERÇEKTEN ERİŞİLEBİLİR Mİ?
// ════════════════════════════════════════════════════════════════════════════
//
// ── KAPATILAN GERÇEK KUSUR (Final21, Faz 4) ────────────────────────────────
// `ServerMenu.svelte` "yalnız GERÇEK yetenekler gösterilir" sözleşmesini
// uyguluyor ve bu doğru bir tasarım. Ama bir öğe ESKİMİŞ bir ölçüme dayanarak
// dışarıda bırakılmıştı:
//
//     "Bildirim Ayarları — DORMANT. `notification-prefs` üretim girdisinden
//      (app.ts) erişilemiyor; kayıt hiç oluşmuyor."
//
// Bu not artık doğru değildi. `app.ts:217` shim'i ithal ediyor, shim paneli
// açılışta mount ediyor ve `showNotificationPrefsPanel` kaydını yapıyor.
//
// Bedeli somuttu: SUNUCUYU SESSİZE ALMAK — `POST /api/notification-prefs`
// (`serverId` + `level: 'mute'`) ile sunucuda TAM DESTEKLİ olduğu hâlde —
// istemcide hiçbir yerden erişilemiyordu. Faz 4 sürtünme ölçümünde bu
// yolculuk "kurtarma adımı" olarak, yani ERİŞİLEMEZ olarak kaydedilmişti.
//
// Bu dosya iki şeyi birden kilitler:
//   1. Panel üretim girdisinden GERÇEKTEN mount ediliyor (kök DOM'da var).
//   2. Menü o yeteneği KULLANICIYA AÇIYOR.
//
// Biri bozulursa test düşer — "yapıldı ama erişilemiyor" durumu bir daha
// sessizce oluşamaz.

import { test, expect } from '../helpers/apiTest';
import { getTokens, createTestServer, createTestChannel, apiRequest } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

let serverId = '';
let channelName = '';

test.beforeAll(async ({ request }) => {
  const token = getTokens().alice;
  const stamp = Date.now().toString(36);

  const srv = await createTestServer(request, token, `SMC ${stamp}`);
  serverId = srv?._id || srv?.id || '';
  if (serverId) {
    channelName = `smc-${stamp}`;
    const ch = await createTestChannel(request, token, serverId, channelName, 'text');
    if (ch?._id || ch?.id) return;
    channelName = '';
  }

  // Hız sınırı: mevcut sunucu yeniden kullanılır (fikstür kurmak için
  // ürünün kötüye-kullanım korumasını zorlamak DOĞRU olmaz).
  const listed = await apiRequest(request, 'GET', '/api/servers', undefined, token);
  if (!listed.ok()) return;
  const body = await listed.json();
  const servers: Array<Record<string, unknown>> = Array.isArray(body)
    ? body : Array.isArray(body?.servers) ? body.servers : [];
  for (const candidate of servers.slice(0, 5)) {
    const id = String(candidate._id ?? candidate.id ?? '');
    if (!id) continue;
    const chRes = await apiRequest(request, 'GET', `/api/servers/${id}/channels`, undefined, token);
    if (!chRes.ok()) continue;
    const chBody = await chRes.json();
    const channels: Array<Record<string, unknown>> = Array.isArray(chBody)
      ? chBody : Array.isArray(chBody?.channels) ? chBody.channels : [];
    const text = channels.find((c) => c.type === 'text' && typeof c.name === 'string');
    if (text) { serverId = id; channelName = String(text.name); return; }
  }
});

test.describe('sunucu menüsü — yetenek erişilebilirliği', () => {
  test('bildirim tercihleri paneli üretim girdisinden MOUNT edilir', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toBeVisible({ timeout: 45_000 });
    await page.waitForTimeout(3_000);

    // Shim (`notification-prefs-svelte.ts`) paneli mount ederken bu kökü
    // oluşturur. Kök yoksa kayıt da yoktur ve menü öğesi ölü satır olurdu.
    await expect(page.locator('#notification-prefs-root')).toHaveCount(1);
  });

  test('sunucu menüsü BİLDİRİM AYARLARINI kullanıcıya açar', async ({ page }) => {
    test.skip(!serverId || !channelName, 'sunucu/kanal fikstürü kurulamadı (hız sınırı)');

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toBeVisible({ timeout: 45_000 });
    await page.waitForTimeout(1_500);

    // Karşılama sihirbazı açıksa tıklamaları yutar — kullanıcı gibi kapat.
    const close = page.locator('.ow-close').first();
    if (await close.count()) { await close.click(); await page.waitForTimeout(600); }

    await page.locator('.server-rail, #server-list').first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator(`.server-icon[data-id="${serverId}"]`).first().click({ timeout: 25_000 });
    await page.locator(`[aria-label="Kanal: ${channelName}"]`).first().click({ timeout: 25_000 });
    await page.locator('#msg-input').waitFor({ state: 'visible', timeout: 25_000 });

    await page.locator('[data-bridge-action="openServerMenu"], #server-header-btn')
      .first().click({ timeout: 20_000 });

    const notif = page.locator('[role="menuitem"]').filter({ hasText: /Bildirim/i }).first();
    await expect(
      notif,
      'sunucu menüsünde "Bildirim ayarları" yok — sunucuyu sessize almak yine erişilemez',
    ).toBeVisible({ timeout: 10_000 });

    // Öğe ÖLÜ SATIR olmamalı: tıklayınca panel gerçekten açılmalı.
    await notif.click();
    await expect(page.locator('.np-panel, #notification-prefs-root [role="dialog"]').first())
      .toBeVisible({ timeout: 15_000 });
  });
});
