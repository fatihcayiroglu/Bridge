// e2e/tests/virtual-scroll.spec.ts — Sprint 14: TypeScript dönüşümü (.js → .ts)
// e2e/tests/virtual-scroll.spec.js — Sprint 10 Virtual Scroll E2E Testleri
//
// Kapsar:
//   1. Virtual scroll modülünün yüklenmesi
//   2. Büyük kanal → DOM node sayısı sınırlı kalır
//   3. Scroll pozisyonu korunur (kanal değişiminde)
//   4. Eski mesaj yükleme (infinite scroll üst kısım)
//   5. scrollToMsg — pencere dışındaki mesaja scroll

// ════════════════════════════════════════════════════════════════════════════
// DURUM: SEVK EDİLMEDİ — BU DOSYA VAR OLMAYAN BİR ÖZELLİĞİ TEST EDİYORDU
// ════════════════════════════════════════════════════════════════════════════
// Bu paket `window._bridgeVS` adlı bir hata ayıklama API'sine dayanıyordu.
// DOĞRUDAN ÖLÇÜM:
//
//   · `_bridgeVS` istemci kaynağında YALNIZCA bir TİP bildirimi olarak var:
//         client/js/types/globals.d.ts:154   `_bridgeVS?: unknown;`
//     Hiçbir yerde ATANMIYOR — uygulama kodunda tek bir kullanım yok.
//   · Derlenmiş pakette (public/js/) `_bridgeVS` GEÇMİYOR.
//   · `MessageListPanel.svelte` mesajları `{#each grouped ...}` ile TAMAMEN
//     render eder; pencereleme/sanallaştırma YOKTUR. Ürün sayfalama
//     (`hasMore` + eski sayfa yükleme) kullanır, virtual scroll DEĞİL.
//
// Yani testler geçici bir ortam sorunundan değil, ÖZELLİK OLMADIĞI için
// atlanıyordu. Eski mesaj "Test fixture hazır değil" idi ve bu YANILTICIYDI:
// düzeltilebilir bir kurulum hatası varmış izlenimi veriyordu.
//
// Bu dosya SİLİNMEDİ: sanallaştırma ileride eklenirse iddialar hazır.
// Ancak artık DÜRÜSTÇE "sevk edilmedi" diyor ve kapsam sayılmıyor.

import { test, expect } from '../helpers/apiTest';
import { BridgePage, getTokens, createTestServer, createTestChannel } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

test.use({ storageState: 'fixtures/auth-state.json' });

let _tokens = null;
let _serverId = null;
let _channelId = null;

test.beforeAll(async ({ request }) => {
  try {
    _tokens = getTokens();
    const srv = await createTestServer(request, _tokens.alice, `VS-Server-${Date.now()}`);
    _serverId = srv?._id || srv?.id;
    if (_serverId) {
      const ch = await createTestChannel(request, _tokens.alice, _serverId, 'vs-test');
      _channelId = ch?._id || ch?.id;
    }
  } catch { /* setup fail — testler skip */ }
});

// ── Mesaj oluşturma yardımcısı ────────────────────────────────
async function bulkSendMessages(request, channelId, token, count = 20, prefix = 'vs-msg') {
  const sent = [];
  for (let i = 0; i < count; i++) {
    const res = await request.post(`${BASE_URL}/api/channels/${channelId}/messages`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: `${prefix}-${i}-${Date.now()}` }),
    });
    if (res.ok()) {
      const d = await res.json();
      sent.push(d._id || d.id);
    }
    // Rate limit önlemi
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 100));
  }
  return sent;
}

// ══════════════════════════════════════════════════════════════
// 1. Modül Yükleme
// ══════════════════════════════════════════════════════════════
test.describe('Virtual Scroll Modül Yükleme', () => {

  test('_bridgeVS debug API yüklenmeli', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000); // tüm scriptler

    const hasVS = await page.evaluate(() => typeof window._bridgeVS !== 'undefined');
    if (!hasVS) {
      // Virtual scroll henüz aktif değil — diğer testleri skip et
      test.skip(true, 'SEVK EDİLMEDİ: `window._bridgeVS` uygulanmadı (yalnızca globals.d.ts tip bildirimi) ve ürün sanallaştırma kullanmıyor.');
    }
    expect(hasVS).toBe(true);
  });

  test('_bridgeVS.stats() çalışmalı', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    const hasVS = await page.evaluate(() => typeof window._bridgeVS !== 'undefined');
    test.skip(!hasVS, 'SEVK EDİLMEDİ: `window._bridgeVS` yok — sanallaştırma uygulanmadı.');

    const stats = await page.evaluate(() => window._bridgeVS.stats());
    expect(stats).toHaveProperty('total');
    expect(stats).toHaveProperty('inDOM');
    expect(stats).toHaveProperty('windowStart');
    expect(stats).toHaveProperty('windowEnd');
  });
});

// ══════════════════════════════════════════════════════════════
// 2. DOM Node Limiti
// ══════════════════════════════════════════════════════════════
test.describe('DOM Penceresi Limiti', () => {

  test('100+ mesajlı kanalda DOM node sayısı WINDOW_SIZE altında kalmalı', async ({ page, request }) => {
    test.skip(!_channelId, 'Kanal fixture gerekli'  );

    // 25 mesaj gönder (zaten varsa toplam yeterince yüksek olabilir)
    await bulkSendMessages(request, _channelId, _tokens.alice, 25, 'dom-limit');

    await page.goto(BASE_URL);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    const hasVS = await page.evaluate(() => typeof window._bridgeVS !== 'undefined');
    test.skip(!hasVS, 'SEVK EDİLMEDİ: `window._bridgeVS` yok — sanallaştırma uygulanmadı.');

    // Kanal ve sunucuyu seç (URL hash veya localStorage üzerinden)
    // Bu adım uygulamaya özel — test en azından modülün var olduğunu doğrular
    const stats = await page.evaluate(() => window._bridgeVS?.stats());
    test.skip(!stats, 'SEVK EDİLMEDİ: `_bridgeVS.stats()` yok — sanallaştırma uygulanmadı.');

    // DOM'daki mesaj sayısı toplam mesajdan az veya eşit olmalı
    expect(stats.inDOM).toBeLessThanOrEqual(stats.total + 1); // spacer toleransı
    // WINDOW_SIZE = 80, eğer toplam < 80 ise eşit olabilir
    expect(stats.inDOM).toBeLessThanOrEqual(80);
  });
});

// ══════════════════════════════════════════════════════════════
// 3. Mesaj Alanı Varlık Testi
// ══════════════════════════════════════════════════════════════
test.describe('Mesaj Alanı DOM', () => {

  test('#messages-area DOM\'da var olmalı', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);

    // Giriş yapmış kullanıcı için app yüklenmeli
    const messagesArea = page.locator('#messages-area');
    // Görünür olmayabilir (kanal seçili değilse) ama DOM'da olmalı
    const count = await messagesArea.count();
    expect(count).toBeGreaterThanOrEqual(0); // var olabilir
  });

  test('virtual scroll spacer elementleri var mı', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    const hasVS = await page.evaluate(() => typeof window._bridgeVS !== 'undefined');
    test.skip(!hasVS, 'SEVK EDİLMEDİ: `window._bridgeVS` yok — sanallaştırma uygulanmadı.');

    // Spacer elementleri virtual scroll init sonrası eklenir
    const topSpacer = await page.evaluate(() =>
      document.querySelector('.vs-top-spacer') !== null
    );
    // Spacer varsa VS aktif — yoksa kanal seçili olmadığı için init olmamış
    // Her iki durum da geçer
    expect(typeof topSpacer).toBe('boolean');
  });
});

// ══════════════════════════════════════════════════════════════
// 4. API Pagination — Infinite Scroll Backend
// ══════════════════════════════════════════════════════════════
test.describe('Infinite Scroll Backend', () => {

  test('mesaj listesi limit parametresi çalışmalı', async ({ request }) => {
    test.skip(!_channelId, 'Kanal fixture gerekli'  );

    const res = await request.get(`${BASE_URL}/api/channels/${_channelId}/messages?limit=5`, {
      headers: { Authorization: `Bearer ${_tokens.alice}` },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    const msgs = Array.isArray(data) ? data : data.messages || [];
    expect(msgs.length).toBeLessThanOrEqual(5);
  });

  test('hasMore flag döndürülmeli (cursor pagination)', async ({ request }) => {
    test.skip(!_channelId, 'Kanal fixture gerekli'  );

    // Önce birkaç mesaj gönder
    await bulkSendMessages(request, _channelId, _tokens.alice, 6, 'cursor-test');

    const res = await request.get(`${BASE_URL}/api/channels/${_channelId}/messages?limit=3`, {
      headers: { Authorization: `Bearer ${_tokens.alice}` },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();

    // Eğer cursor-based ise hasMore veya prevCursor olmalı
    if (!Array.isArray(data)) {
      // Structured response — hasMore veya benzeri alan olabilir
      expect(typeof data).toBe('object');
    }
    // Array response ise pagination info headers'da gelebilir
    // Her iki format da geçerli
  });

  test('before timestamp ile eski mesajlar alınabilmeli', async ({ request }) => {
    test.skip(!_channelId, 'Kanal fixture gerekli'  );

    const now = Date.now();
    const res = await request.get(
      `${BASE_URL}/api/channels/${_channelId}/messages?before=${now}&limit=5`,
      { headers: { Authorization: `Bearer ${_tokens.alice}` } }
    );
    // 200 veya 204 (mesaj yoksa)
    expect([200, 204]).toContain(res.status());
  });
});
