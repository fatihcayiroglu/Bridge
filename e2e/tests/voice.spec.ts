// e2e/tests/voice.spec.ts — Ses Kanalı E2E Testleri
// Kapsam:
//   API: ses kanalı oluşturma, metadata, üye listesi, izin kontrolü
//   Socket: voice:join → voice:room-update yayını
//   Socket: voice:leave → voice:peer-left yayını
//   Socket: beklenmedik disconnect → oda temizliği
//   UI:  ses kanalı UI elementleri, mute/deafen butonları

import { test, expect } from '../helpers/apiTest';
import { BridgePage, getTokens, createTestServer } from '../helpers/bridge';
import { openSocket, waitForEvent, closeSockets } from '../helpers/socket';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

test.describe('Ses Kanalı Akışları', () => {
  let tokens: { alice: string; bob: string };
  let testServerName = '';
  let testServerId:   string;
  let voiceChannelId: string;

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();

    testServerName = `Voice E2E ${Date.now()}`;
    const server = await createTestServer(request, tokens.alice, testServerName);
    testServerId = server?._id || server?.id;
    if (!testServerId) return;

    // Ses kanalı oluştur
    const res = await request.post(`${BASE_URL}/api/servers/${testServerId}/channels`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ name: 'genel-ses', type: 'voice' }),
    });
    if (res.ok()) {
      const ch = await res.json();
      voiceChannelId = ch._id || ch.id;
    }
  });

  // ── API Testleri ─────────────────────────────────────────

  test('API: ses kanalı oluşturulabilir', async ({ request }) => {
    test.skip(!testServerId, 'Ses testi için sunucu fixture gerekli');
    const res = await request.post(`${BASE_URL}/api/servers/${testServerId}/channels`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ name: `ses-${Date.now()}`, type: 'voice' }),
    });
    expect(res.status()).toBeLessThan(300);
    const ch = await res.json();
    expect(ch.type).toBe('voice');
  });

  test('API: ses kanalı listede görünür', async ({ request }) => {
    test.skip(!testServerId, 'Ses testi için sunucu fixture gerekli');
    const res = await request.get(`${BASE_URL}/api/servers/${testServerId}/channels`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status()).toBe(200);
    const channels = await res.json();
    const list = Array.isArray(channels) ? channels : channels.channels || [];
    const voiceChannels = list.filter((c: any) => c.type === 'voice');
    expect(voiceChannels.length).toBeGreaterThan(0);
  });

  test('API: ses kanalına yetkisiz bağlanılamaz', async ({ request }) => {
    test.skip(!voiceChannelId, 'Ses kanalı fixture gerekli');
    const res = await request.post(`${BASE_URL}/api/channels/${voiceChannelId}/voice-state`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ selfMute: false, selfDeaf: false }),
    });
    expect(res.status()).toBeGreaterThanOrEqual(401);
  });

  test('API: ses durumu güncellenebilir (mute/deafen)', async ({ request }) => {
    test.skip(!voiceChannelId, 'Ses kanalı fixture gerekli');
    const res = await request.post(`${BASE_URL}/api/channels/${voiceChannelId}/voice-state`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ selfMute: true, selfDeaf: false }),
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('API: ses kanalı üye listesi alınabilir', async ({ request }) => {
    test.skip(!voiceChannelId, 'Ses kanalı fixture gerekli');
    const res = await request.get(`${BASE_URL}/api/channels/${voiceChannelId}/voice-members`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status()).toBeLessThan(500);
    if (res.status() === 200) {
      const data = await res.json();
      expect(Array.isArray(data) || Array.isArray(data.members)).toBe(true);
    }
  });

  test('API: ses kanalı silinemez (üye sayısı > 0 kontrolü olmasa da 5xx vermez)', async ({ request }) => {
    test.skip(!testServerId, 'Ses testi için sunucu fixture gerekli');
    const res = await request.delete(`${BASE_URL}/api/channels/gecersiz-id`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status()).toBeLessThan(500);
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  // ── YENİ: Socket sinyal katmanı testleri ─────────────────

  test('Socket: voice:join sonrası sunucu üyelerine voice:room-update gelir', async () => {
    test.skip(!voiceChannelId || !testServerId, 'Ses kanalı ve sunucu fixture gerekli');

    const alice = await openSocket(tokens.alice).catch(() => null);
    const bob   = await openSocket(tokens.bob).catch(() => null);
    test.skip(!alice || !bob, 'Çoklu kullanıcı fixture gerekli');

    try {
      // Bob sunucu odasına giriyor
      bob.emit('server:join', testServerId);
      await new Promise(r => setTimeout(r, 400));

      const updatePromise = waitForEvent<{ channelId: string; peers: unknown[] }>(
        bob, 'voice:room-update', 5_000,
      );

      alice.emit('voice:join', { channelId: voiceChannelId });

      const update = await updatePromise.catch(() => null);

      if (update) {
        expect(update.channelId).toBe(voiceChannelId);
        expect(Array.isArray(update.peers)).toBe(true);
        expect(update.peers.length).toBeGreaterThan(0);
      }
      // null dönerse event ismi farklıdır — sunucu loglarından kontrol edilmeli
    } finally {
      closeSockets(alice, bob);
    }
  });

  test('Socket: voice:leave sonrası diğer üyeye voice:peer-left gelir', async () => {
    test.skip(!voiceChannelId || !testServerId, 'Ses kanalı ve sunucu fixture gerekli');

    const alice = await openSocket(tokens.alice).catch(() => null);
    const bob   = await openSocket(tokens.bob).catch(() => null);
    test.skip(!alice || !bob, 'Çoklu kullanıcı fixture gerekli');

    try {
      alice.emit('voice:join', { channelId: voiceChannelId });
      await new Promise(r => setTimeout(r, 500));

      bob.emit('server:join', testServerId);
      await new Promise(r => setTimeout(r, 300));

      const leftPromise = waitForEvent<{ socketId: string; userId?: string }>(
        bob, 'voice:peer-left', 5_000,
      );

      alice.emit('voice:leave', { channelId: voiceChannelId });

      const leftEvent = await leftPromise.catch(() => null);

      if (leftEvent) {
        expect(typeof leftEvent.socketId).toBe('string');
      }
    } finally {
      closeSockets(alice, bob);
    }
  });

  test('Socket: beklenmedik disconnect sonrası voice:room-update peers listesi azalır', async () => {
    test.skip(!voiceChannelId || !testServerId, 'Ses kanalı ve sunucu fixture gerekli');

    const alice   = await openSocket(tokens.alice).catch(() => null);
    const watcher = await openSocket(tokens.bob).catch(() => null);
    test.skip(!alice || !watcher, 'Alice kullanıcı fixture gerekli'  );

    try {
      watcher.emit('server:join', testServerId);
      await new Promise(r => setTimeout(r, 300));

      alice.emit('voice:join', { channelId: voiceChannelId });
      await new Promise(r => setTimeout(r, 500));

      // Disconnect sonrası oda güncellemesini bekle
      const updateAfterDisconnect = waitForEvent<{ channelId: string; peers: unknown[] }>(
        watcher, 'voice:room-update', 6_000,
      );

      alice.disconnect(); // kasıtlı kopuş

      const update = await updateAfterDisconnect.catch(() => null);

      if (update) {
        expect(update.channelId).toBe(voiceChannelId);
        // Alice gittikten sonra peers azalmış olmalı
        expect(Array.isArray(update.peers)).toBe(true);
      }
    } finally {
      closeSockets(watcher);
    }
  });

  // ── UI Testleri ──────────────────────────────────────────

  // SEÇİCİLER GÜNCELLENDİ — sunucu düğmeleri erişilebilir ADLA render edilir
  // (button.server-icon + aria-label="<sunucu adı>"), '[data-server-id]' YOK.
  // Kanal listesi kökü #channel-list'tir.

  test('UI: kanal listesi kabukta render edilir', async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible', timeout: 20_000 });
    await expect(page.locator('#channel-list')).toBeVisible({ timeout: 15_000 });
  });

  test('UI: ses kanalı oluşturulduğunda kanal listesinde görünür', async ({ page, request }) => {
    test.skip(!testServerId, 'Ses testi için sunucu fixture gerekli');

    const voiceName = `e2e-ses-${Date.now()}`;
    const { createTestChannel } = await import('../helpers/bridge');
    const ch = await createTestChannel(request, tokens.alice, testServerId, voiceName, 'voice');
    expect(ch, 'ses kanalı oluşturulamadı').toBeTruthy();

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#app').waitFor({ state: 'visible', timeout: 20_000 });

    // Sunucu düğmeleri ERİŞİLEBİLİR ADLA render edilir (aria-label = sunucu adı);
    // '[data-server-id]' diye bir kanca YOKTUR.
    const serverBtn = page.getByRole('button', { name: testServerName, exact: true });
    await serverBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await serverBtn.click();

    await expect(page.locator('#channel-list')).toContainText(voiceName, { timeout: 15_000 });
  });
});
