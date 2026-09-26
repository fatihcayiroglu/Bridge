// e2e/tests/offline-queue.spec.ts — Sprint 14: TypeScript dönüşümü (.js → .ts)
// e2e/tests/offline-queue.spec.js — Sprint 10 Offline Kuyruk E2E Testleri
//
// Kapsar:
//   1. Socket kopukken mesaj kuyruğa alınır
//   2. Reconnect sonrası kuyruk flush edilir
//   3. Kuyruk badge gösterilir / kaldırılır
//   4. SW outbox API testi (Background Sync yapısı)
//   5. /api/messages endpoint reconnect senaryosu

import { test, expect } from '../helpers/apiTest';
import { BridgePage, getTokens, createTestServer, createTestChannel } from '../helpers/bridge';
import { openSocket, waitForEvent, closeSockets, paceSends } from '../helpers/socket';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

// Bu testler auth gerektirir
test.use({ storageState: 'fixtures/auth-state.json' });

// ── Yardımcı ──────────────────────────────────────────────────
let _sharedServer  = null;
let _sharedChannel = null;
let _tokens        = null;

test.beforeAll(async ({ request }) => {
  try {
    _tokens = getTokens();
    _sharedServer  = await createTestServer(request, _tokens.alice, `Offline-Queue-Server-${Date.now()}`);
    if (_sharedServer?._id || _sharedServer?.id) {
      const sid = _sharedServer._id || _sharedServer.id;
      _sharedChannel = await createTestChannel(request, _tokens.alice, sid, 'offline-test');
    }
  } catch { /* setup başarısız — testler skip edilir */ }
});

// ══════════════════════════════════════════════════════════════
// 1. API Seviyesi — Mesaj persistence
// ══════════════════════════════════════════════════════════════
test.describe('Mesaj Kalıcılığı (API)', () => {

  test('mesaj gönderilince veritabanına kaydedilmeli', async ({ request }) => {
    test.skip(true, 'GEÇERSİZ MİMARİ: REST gönderim ucu yok; yerini alan kanonik kapsam → tests/message-actions.spec.ts (kalıcılık + ackId idempotency)');
    test.skip(!_sharedChannel, 'Test fixture hazır değil'  );
    const chId = _sharedChannel._id || _sharedChannel.id;
    const content = `persistence-test-${Date.now()}`;

    const sendRes = await request.post(`${BASE_URL}/api/channels/${chId}/messages`, {
      headers: { Authorization: `Bearer ${_tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content }),
    });
    expect(sendRes.ok()).toBe(true);

    // Hemen listeyi çek — mesaj orada olmalı
    const listRes = await request.get(`${BASE_URL}/api/channels/${chId}/messages?limit=10`, {
      headers: { Authorization: `Bearer ${_tokens.alice}` },
    });
    expect(listRes.ok()).toBe(true);
    const data = await listRes.json();
    const messages = Array.isArray(data) ? data : data.messages || [];
    const found = messages.some(m => (m.content || '').includes(content));
    expect(found).toBe(true);
  });

  test('mesaj silindikten sonra listede gözükmemeli', async ({ request }) => {
    test.skip(true, 'GEÇERSİZ MİMARİ: REST gönderim ucu yok; yerini alan kanonik kapsam → tests/message-actions.spec.ts (message:delete kalıcı kaldırma)');
    test.skip(!_sharedChannel, 'Test fixture hazır değil'  );
    const chId = _sharedChannel._id || _sharedChannel.id;
    const content = `delete-test-${Date.now()}`;

    const sendRes = await request.post(`${BASE_URL}/api/channels/${chId}/messages`, {
      headers: { Authorization: `Bearer ${_tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content }),
    });
    expect(sendRes.ok()).toBe(true);
    const sent = await sendRes.json();
    const msgId = sent._id || sent.id || sent.message?._id;
    test.skip(!msgId, 'Mesaj fixture gerekli'  );

    // Sil
    const delRes = await request.delete(`${BASE_URL}/api/messages/${msgId}`, {
      headers: { Authorization: `Bearer ${_tokens.alice}` },
    });
    // 200 veya 204
    expect(delRes.status()).toBeLessThan(300);

    // Listede olmamalı
    const listRes = await request.get(`${BASE_URL}/api/channels/${chId}/messages?limit=50`, {
      headers: { Authorization: `Bearer ${_tokens.alice}` },
    });
    const data = await listRes.json();
    const messages = Array.isArray(data) ? data : data.messages || [];
    const found = messages.some(m => m._id === msgId || m.id === msgId);
    expect(found).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// 2. UI: Offline Queue Badge
// ══════════════════════════════════════════════════════════════
// Final21 Faz 19 (19-26): buradaki iki test Sprint 10'un `window._flushPendingQueue` /
// `window._enqueueOfflineMessage` globallerini arıyordu. Svelte istemcisinde bunlar YOK (kalıcı
// outbox: MessageInputPanel + outbox-store); testler "Test fixture hazır değil" diye HER koşumda
// atlanıyordu ve ikincisinin son iddiası (`badge.or(body)` görünür) zaten BOŞTU. Çevrimdışı
// gönderimin uçtan uca doğruluğu hiçbir tarayıcı testinde ölçülmüyordu. Yerine SON DURUM testi:
test.describe('Offline Queue UI', () => {
  test('çevrimdışı gönderilen mesaj KUYRUKTA kalır, bağlantı dönünce TAM BİR KEZ teslim edilir', async ({ page, context, request }) => {
    test.setTimeout(120_000);
    const sid = _sharedServer?._id || _sharedServer?.id;
    const chId = _sharedChannel?._id || _sharedChannel?.id;
    expect(sid && chId, 'offline-queue fikstürü kurulamadı').toBeTruthy();

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator(`.server-icon[data-id="${sid}"]`).first().click({ timeout: 20_000 });
    await page.locator('[aria-label="Kanal: offline-test"]').first().click({ timeout: 15_000 });
    const input = page.locator('#msg-input');
    await expect(input).toBeVisible({ timeout: 15_000 });

    await context.setOffline(true);
    const body = `offline-kuyruk-${Date.now().toString(36)}`;
    await input.fill(body);
    await page.keyboard.press('Enter');
    const bubble = page.locator('.msg').filter({ hasText: body });
    await expect(bubble.first()).toBeVisible({ timeout: 10_000 });
    // Ağ yokken teslim EDİLMİŞ sayılamaz (ack gelemez).
    await page.waitForTimeout(3_000);
    await expect(bubble.first()).not.toHaveAttribute('data-delivery-state', 'sent');

    await context.setOffline(false);
    await expect(bubble.first()).toHaveAttribute('data-delivery-state', 'sent', { timeout: 60_000 });

    // SON DURUM: sunucuda TAM BİR kopya, arayüzde TEK balon (yeniden oynatma çiftlemez).
    const res = await request.get(`${BASE_URL}/api/channels/${chId}/messages?limit=50`, {
      headers: { Authorization: `Bearer ${_tokens.alice}` },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    const stored = (Array.isArray(data) ? data : data.messages || []).filter((m) => m.content === body);
    expect(stored, 'çevrimdışı mesaj sunucuda tam bir kez olmalı').toHaveLength(1);
    await expect(bubble).toHaveCount(1);
  });
});

// ══════════════════════════════════════════════════════════════
// 3. Service Worker / Outbox (API Düzeyi)
// ══════════════════════════════════════════════════════════════
test.describe('Service Worker Outbox', () => {

  test('sw.js erişilebilir olmalı', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/sw.js`);
    expect([200, 304]).toContain(res.status());
  });

  test('sw.js outbox kelimesini içermeli', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/sw.js`);
    test.skip(!res.ok(), 'Test fixture hazır değil'  );
    const body = await res.text();
    expect(body).toContain('outbox');
  });

  test('manifest.json erişilebilir olmalı (PWA desteği)', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/manifest.json`);
    // Final21 Faz 22 (19-37): ürün manifest'i SUNAR (ölçüldü 200); 404'ü kabul etmek PWA manifest'inin
    // kaybolmasını görünmez yapardı.
    expect(res.status()).toBe(200);
    if (res.ok()) {
      const body = await res.json();
      expect(body).toHaveProperty('name');
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 4. Reconnect Sonrası Mesaj Sync
// ══════════════════════════════════════════════════════════════
test.describe('Reconnect Mesaj Sync', () => {

  test('kanal yükleme endpoint limit parametresi kabul etmeli', async ({ request }) => {
    test.skip(!_sharedChannel, 'Test fixture hazır değil'  );
    const chId = _sharedChannel._id || _sharedChannel.id;

    const res = await request.get(`${BASE_URL}/api/channels/${chId}/messages?limit=10`, {
      headers: { Authorization: `Bearer ${_tokens.alice}` },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json();
    const messages = Array.isArray(data) ? data : data.messages || [];
    expect(messages.length).toBeLessThanOrEqual(10);
  });

  // Final21 Faz 19 (19-26): bu test kanal BOŞ olduğu için her koşumda atlanıyordu (REST gönderim
  // ucu yok) ve koşsa bile yalnızca "200 ya da 204" diyordu. Artık kendi mesajlarını KANONİK yoldan
  // (socket message:send + ack) üretir ve anahtar-küme imlecinin SON DURUMUNU doğrular.
  test('before cursor parametresi çalışmalı (pagination)', async ({ request }) => {
    const sid = _sharedServer?._id || _sharedServer?.id;
    const chId = _sharedChannel?._id || _sharedChannel?.id;
    expect(sid && chId, 'offline-queue fikstürü kurulamadı').toBeTruthy();
    const headers = { Authorization: `Bearer ${_tokens.alice}` };

    const sock = await openSocket(_tokens.alice);
    const tag = `sayfa-${Date.now().toString(36)}`;
    const ids: string[] = [];
    try {
      for (let i = 1; i <= 3; i++) {
        await paceSends('alice');
        const ackId = `${tag}-${i}`;
        const ack = waitForEvent<{ ackId: string; messageId: string }>(sock, 'message:ack', 15_000, (a) => a?.ackId === ackId);
        sock.emit('message:send', { channelId: chId, serverId: sid, content: `${tag} #${i}`, ackId });
        ids.push((await ack).messageId);
      }
    } finally {
      closeSockets(sock);
    }

    const first = await (await request.get(`${BASE_URL}/api/channels/${chId}/messages?limit=2`, { headers })).json();
    expect(first.messages.map((m) => m._id)).toEqual([ids[1], ids[2]]);   // en yeni 2, eskiden→yeniye
    expect(first.hasMore).toBe(true);
    expect(first.prevCursor).toBeTruthy();

    const older = await request.get(`${BASE_URL}/api/channels/${chId}/messages?limit=2&cursor=${encodeURIComponent(first.prevCursor)}`, { headers });
    expect(older.status()).toBe(200);
    const olderIds = (await older.json()).messages.map((m) => m._id);
    expect(olderIds).toContain(ids[0]);                                    // bir önceki sayfa
    expect(olderIds.some((id) => id === ids[1] || id === ids[2])).toBe(false);   // çakışma YOK
  });
});
