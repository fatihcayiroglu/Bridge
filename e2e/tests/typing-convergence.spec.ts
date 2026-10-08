// e2e/tests/typing-convergence.spec.ts
//
// ════════════════════════════════════════════════════════════════════════════
// FAZ 5 — "YAZIYOR…" GÖSTERGESİ: KULLANICININ GÖRDÜĞÜ NİHAİ DURUM
// ════════════════════════════════════════════════════════════════════════════
//
// ── NEDEN AYRI BİR DOSYA ────────────────────────────────────────────────────
// `realtime-torture.spec.ts` içindeki T8 fırtınası, KABLO ÜZERİNDEKİ son
// olayın `typing: true` olabildiğini ölçtü ve bunu bir kusur saydı. ÜRÜNÜ
// okuyunca bunun YANLIŞ KAPSAMDA bir ölçüm olduğu görüldü:
//
//     client/js/core/MessageLoader.svelte:299
//     // Emniyet: stop event'i kaybolursa gösterge takılı kalmasın.
//     typingTimers.set(userId, setTimeout(..., 8000));
//
// Yani ürün tam olarak bu senaryoya karşı ZATEN savunmalı: `typing:stop`
// kaybolsa bile gösterge 8 saniyede kendini temizler. Kullanıcı hiçbir zaman
// sonsuza dek "Bob yazıyor…" görmez.
//
// Doğru soru "kabloda son olay neydi?" değil, ŞUDUR:
//
//     Kullanıcının EKRANINDA "yazıyor…" SINIRLI bir süre içinde kayboluyor mu?
//
// Bu dosya onu ölçer — varsaymaz. `typing:stop` KASITLI OLARAK HİÇ
// gönderilmez (en kötü durum determinist biçimde üretilir) ve göstergenin
// kendi kendine temizlenmesi BEKLENİR.

import { test, expect } from '../helpers/apiTest';
import { getTokens, createTestServer, createTestChannel, joinServer } from '../helpers/bridge';
import { openSocket, closeSockets, joinChannelConfirmed } from '../helpers/socket';
import type { Socket } from 'socket.io-client';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

// ── BÜTÇE — KOŞUMDAN ÖNCE ───────────────────────────────────────────────────
// Ürünün kendi emniyet süresi 8000 ms'tir. Bütçe, o süreye olay gecikmesi ve
// tarayıcı zamanlayıcı sapması için makul bir pay eklenerek ÖNCEDEN belirlendi.
// Sonuç görüldükten sonra OYNATILMADI.
const STALE_BUDGET_MS = 12_000;

const T = getTokens();
let serverId = '';
let channelId = '';
let channelName = '';
let fixtureError = '';

test.beforeAll(async ({ request }) => {
  const stamp = Date.now().toString(36);
  try {
    const srv = await createTestServer(request, T.alice, `TY ${stamp}`);
    serverId = String(srv?._id ?? srv?.id ?? '');
    if (!serverId) { fixtureError = 'sunucu olusturulamadi (hiz siniri)'; return; }
    channelName = `ty-${stamp}`;
    const ch = await createTestChannel(request, T.alice, serverId, channelName, 'text');
    channelId = String(ch?._id ?? ch?.id ?? '');
    if (!channelId) { fixtureError = 'kanal olusturulamadi'; return; }
    if (!(await joinServer(request, T.alice, T.bob, serverId))) {
      fixtureError = 'bob sunucuya katilamadi';
    }
  } catch (err) {
    fixtureError = `fikstur istisnasi: ${(err as Error).message}`;
  }
});

test('yaziyor gostergesi SINIRLI surede temizlenir (stop olayi hic gelmese bile)', async ({ page }) => {
  expect(fixtureError, `fikstür kurulamadı: ${fixtureError}`).toBe('');
  test.setTimeout(3 * 60_000);

  const sockets: Socket[] = [];
  try {
    // ── Alice tarayıcıda kanalı izliyor ───────────────────────────────────
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toBeVisible({ timeout: 45_000 });
    await page.waitForTimeout(1_500);

    const wizardClose = page.locator('.ow-close').first();
    if (await wizardClose.count()) { await wizardClose.click(); await page.waitForTimeout(500); }

    await page.locator(`.server-icon[data-id="${serverId}"]`).first().click({ timeout: 30_000 });
    await page.locator(`[aria-label="Kanal: ${channelName}"]`).first().click({ timeout: 30_000 });
    await page.locator('#msg-input').waitFor({ state: 'visible', timeout: 30_000 });

    // ── Bob yazmaya başlar ve ASLA durmaz ─────────────────────────────────
    // Determinist en kötü durum: `typing:stop` HİÇ gönderilmez. Kusurlu bir
    // istemcide gösterge sonsuza dek takılı kalırdı.
    const bob = await openSocket(T.bob);
    sockets.push(bob);
    await joinChannelConfirmed(bob, channelId, serverId);
    bob.emit('typing:start', { channelId });

    const bar = page.locator('#typing-bar');
    await expect(bar, 'Bob yaziyor ama gosterge hic cikmadi').toBeVisible({ timeout: 15_000 });

    // ── Ölçüm: gösterge ne kadar sürede kendini temizliyor? ───────────────
    const t0 = Date.now();
    await expect(
      bar,
      `"yaziyor..." gostergesi ${STALE_BUDGET_MS}ms icinde temizlenmedi — `
      + 'stop olayi kaybolursa kullanicida TAKILI kalir',
    ).toBeHidden({ timeout: STALE_BUDGET_MS });
    const staleMs = Date.now() - t0;

    // eslint-disable-next-line no-console
    console.log(`  yaziyor gostergesi bayat penceresi: ${staleMs}ms (butce <= ${STALE_BUDGET_MS}ms)`);
    expect(staleMs).toBeLessThanOrEqual(STALE_BUDGET_MS);
  } finally {
    closeSockets(...sockets);
  }
});
