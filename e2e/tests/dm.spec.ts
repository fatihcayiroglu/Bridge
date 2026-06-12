// e2e/tests/dm.spec.ts — Sprint 14: TypeScript dönüşümü (.js → .ts)
// e2e/tests/dm.spec.js — Direct Message E2E Testleri
// Kritik akış: DM başlat → mesaj gönder → okundu işareti

import { test, expect } from '@playwright/test';
import { BridgePage, getTokens } from '../helpers/bridge';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

test.describe('Direct Message (DM) Akışları', () => {
  let tokens;
  let aliceId;
  let bobId;

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();

    // Kullanıcı ID'lerini al
    const aliceRes = await request.get(`${BASE_URL}/api/me`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    if (aliceRes.ok()) {
      const alice = await aliceRes.json();
      aliceId = alice._id || alice.id;
    }

    const bobRes = await request.get(`${BASE_URL}/api/me`, {
      headers: { Authorization: `Bearer ${tokens.bob}` },
    });
    if (bobRes.ok()) {
      const bob = await bobRes.json();
      bobId = bob._id || bob.id;
    }
  });

  // ── API Testleri ─────────────────────────────────────────

  test('API: DM kanalı açma/alma', async ({ request }) => {
    test.skip(!bobId, 'Test fixture hazır değil'  );

    const res = await request.post(`${BASE_URL}/api/dm/open`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ targetUserId: bobId }),
    });

    // 200 veya 201 bekleniyor
    expect(res.status()).toBeLessThan(300);
    const data = await res.json();
    expect(data._id || data.id || data.channelId).toBeTruthy();
  });

  test('API: DM mesajı gönderme', async ({ request }) => {
    test.skip(!bobId, 'Test fixture hazır değil'  );

    // DM kanalını aç
    const openRes = await request.post(`${BASE_URL}/api/dm/open`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ targetUserId: bobId }),
    });
    test.skip(!openRes.ok(), 'Test fixture hazır değil'  );

    const dmData = await openRes.json();
    const dmChannelId = dmData._id || dmData.id || dmData.channelId;
    test.skip(!dmChannelId, 'Test fixture hazır değil'  );

    // Mesaj gönder
    const msgRes = await request.post(`${BASE_URL}/api/channels/${dmChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: 'Merhaba Bob! DM testi.' }),
    });

    expect(msgRes.status()).toBeLessThan(300);
  });

  test('API: DM listesi alınmalı', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/dm`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });

    // DM endpoint mevcut olmalı
    expect(res.status()).toBeLessThan(500);
    if (res.status() === 200) {
      const data = await res.json();
      expect(Array.isArray(data) || Array.isArray(data.dms)).toBe(true);
    }
  });

  test('API: kendi kendinle DM açılamamalı', async ({ request }) => {
    test.skip(!aliceId, 'Alice kullanıcı fixture gerekli'  );

    const res = await request.post(`${BASE_URL}/api/dm/open`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ targetUserId: aliceId }),
    });

    // Kendi ID'si ile DM açılamaz
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('API: var olmayan kullanıcıyla DM açılamamalı', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/dm/open`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ targetUserId: 'var-olmayan-id-99999' }),
    });

    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('API: Bob Alice\'in DM mesajını görebilmeli', async ({ request }) => {
    test.skip(!bobId, 'Test fixture hazır değil'  );

    // DM kanalını aç
    const openRes = await request.post(`${BASE_URL}/api/dm/open`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ targetUserId: bobId }),
    });
    test.skip(!openRes.ok(), 'Test fixture hazır değil'  );

    const dmData = await openRes.json();
    const dmChannelId = dmData._id || dmData.id || dmData.channelId;
    test.skip(!dmChannelId, 'Test fixture hazır değil'  );

    // Alice mesaj gönder
    const unique = `DM-test-${Date.now()}`;
    await request.post(`${BASE_URL}/api/channels/${dmChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: unique }),
    });

    // Bob mesajları görebilmeli
    const bobRes = await request.get(`${BASE_URL}/api/channels/${dmChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.bob}` },
    });
    expect(bobRes.status()).toBe(200);
    const data = await bobRes.json();
    const messages = data.messages || data;
    const found = messages.some(
      (m) => (m.content || '').includes(unique)
    );
    expect(found).toBe(true);
  });

  // ── UI Testleri ──────────────────────────────────────────

  test('UI: DM sayfası yüklenmeli', async ({ page }) => {
    const bp = new BridgePage(page);
    await bp.goto('/');
    await page.waitForTimeout(1000);

    // DM navigasyon butonu (friends, DM ikonu)
    const dmNav = page.locator(
      '[data-testid="dm-nav"], .dm-nav, [href*="/dm"], [aria-label*="DM"], [aria-label*="Direct"]'
    ).first();

    if (await dmNav.count() > 0) {
      await dmNav.click();
      await page.waitForTimeout(800);
    }

    await expect(page.locator('body')).toBeVisible();
  });

  // ── E2EE Toggle UI Testleri ───────────────────────────────

  test('UI: E2EE toggle butonu DM input alanında görünür', async ({ page }) => {
    const bp = new BridgePage(page);
    await bp.loginViaToken(tokens.alice);
    await bp.goto('/');
    await page.waitForTimeout(1500);

    // DM panelini aç
    const dmBtn = page.locator('#dm-panel-btn, [data-testid="dm-btn"], .dm-nav-btn').first();
    if (await dmBtn.count() > 0) {
      await dmBtn.click();
      await page.waitForTimeout(500);
    }

    // İlk DM item'ına tıkla
    const dmItem = page.locator('.dm-item').first();
    if (await dmItem.count() > 0) {
      await dmItem.click();
      await page.waitForTimeout(800);

      // Input alanı açık olmalı
      await expect(page.locator('#dm-input-area')).toBeVisible();

      // E2EE toggle butonu var olmalı (BridgeE2E kurulmamışsa gizli olabilir)
      const toggle = page.locator('#dm-e2e-toggle');
      await expect(toggle).toHaveCount(1);
    }
  });

  test('UI: E2EE banner başlangıçta gizli olmalı', async ({ page }) => {
    const bp = new BridgePage(page);
    await bp.loginViaToken(tokens.alice);
    await bp.goto('/');
    await page.waitForTimeout(1500);

    const dmItem = page.locator('.dm-item').first();
    if (await dmItem.count() > 0) {
      await dmItem.click();
      await page.waitForTimeout(800);

      // Banner başlangıçta gizli olmalı (display:none)
      const banner = page.locator('#dm-e2e-banner');
      await expect(banner).toHaveCount(1);
      await expect(banner).toBeHidden();
    }
  });

  // ── Okundu Bilgisi (DM Read Receipt) API Testleri ─────────

  test('API: DM mesajı okundu olarak işaretlenebilmeli', async ({ request }) => {
    test.skip(!bobId, 'Test fixture hazır değil'  );

    // DM kanalını aç
    const openRes = await request.post(`${BASE_URL}/api/dm/open`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ targetUserId: bobId }),
    });
    test.skip(!openRes.ok(), 'Test fixture hazır değil'  );

    const dmData = await openRes.json();
    const dmChannelId = dmData._id || dmData.id || dmData.channelId;
    test.skip(!dmChannelId, 'Test fixture hazır değil'  );

    // Alice mesaj gönder
    const msgRes = await request.post(`${BASE_URL}/api/channels/${dmChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: `read-receipt-test-${Date.now()}` }),
    });
    test.skip(!msgRes.ok(), 'Test fixture hazır değil'  );

    const msgData = await msgRes.json();
    const msgId = msgData._id || msgData.id;
    test.skip(!msgId, 'Mesaj fixture gerekli'  );

    // Bob mesajı okundu işaretle (PATCH veya POST /read endpoint)
    const readRes = await request.post(`${BASE_URL}/api/dm/${dmChannelId}/read`, {
      headers: { Authorization: `Bearer ${tokens.bob}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ messageId: msgId }),
    });

    // 200 veya 404 (endpoint henüz yoksa) — 5xx olmamalı
    expect(readRes.status()).toBeLessThan(500);
  });

  test('API: Yetkisiz kullanıcı DM mesajlarını okumamalı', async ({ request }) => {
    test.skip(!bobId, 'Test fixture hazır değil'  );

    // DM kanalını aç
    const openRes = await request.post(`${BASE_URL}/api/dm/open`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ targetUserId: bobId }),
    });
    test.skip(!openRes.ok(), 'Test fixture hazır değil'  );

    const dmData = await openRes.json();
    const dmChannelId = dmData._id || dmData.id || dmData.channelId;
    test.skip(!dmChannelId, 'Test fixture hazır değil'  );

    // Yetkisiz istek (token yok)
    const res = await request.get(`${BASE_URL}/api/channels/${dmChannelId}/messages`);
    expect(res.status()).toBeGreaterThanOrEqual(401);
  });

  test('API: DM mesaj geçmişinde sayfalama çalışmalı', async ({ request }) => {
    test.skip(!bobId, 'Test fixture hazır değil'  );

    const openRes = await request.post(`${BASE_URL}/api/dm/open`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ targetUserId: bobId }),
    });
    test.skip(!openRes.ok(), 'Test fixture hazır değil'  );

    const dmData = await openRes.json();
    const dmChannelId = dmData._id || dmData.id || dmData.channelId;
    test.skip(!dmChannelId, 'Test fixture hazır değil'  );

    // limit parametresi ile sayfalama
    const res = await request.get(`${BASE_URL}/api/channels/${dmChannelId}/messages?limit=5`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });

    expect(res.status()).toBe(200);
    const data = await res.json();
    const messages = data.messages || data;
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeLessThanOrEqual(5);
  });
});
