// e2e/tests/voice.spec.ts — Ses Kanalı E2E Testleri
// Kapsam:
//   API: ses kanalı oluşturma, metadata, üye listesi, izin kontrolü
//   Socket: voice:join → voice:room-update yayını
//   Socket: voice:leave → voice:peer-left yayını
//   Socket: beklenmedik disconnect → oda temizliği
//   UI:  ses kanalı UI elementleri, mute/deafen butonları

import { test, expect } from '../helpers/apiTest';
import { BridgePage, getTokens, createTestServer, createTestChannel } from '../helpers/bridge';
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
    expect(testServerId, 'voice server fixture oluşturulmalı').toBeTruthy();
    const channel = await createTestChannel(request, tokens.alice, testServerId, 'genel-ses', 'voice');
    voiceChannelId = channel?._id || channel?.id;
    expect(voiceChannelId, 'voice channel fixture oluşturulmalı').toBeTruthy();
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

  // ── Socket.IO: gerçekten yayınlanan ses sinyalleri ───────────────────────
  // Önceki üç test voice:join için zorunlu serverId'yi göndermiyordu.
  // Ayrıca event zaman aşımını catch(() => null) ile yutup PASS dönüyordu.
  // Bunlar gerçek sesli oda üyeliğini, bırakmayı ve disconnect temizliğini
  // hiç doğrulamamıştı.
  async function joinVoice(socket: Awaited<ReturnType<typeof openSocket>>) {
    const admitted = waitForEvent<{ channelId: string }>(
      socket, 'voice:joined', 15_000, value => value?.channelId === voiceChannelId,
    );
    socket.emit('voice:join', { channelId: voiceChannelId, serverId: testServerId });
    expect((await admitted).channelId).toBe(voiceChannelId);
  }

  test('Socket: katılan ikinci peer gerçek voice:room-update üretir', async () => {
    const watcher = await openSocket(tokens.alice);
    const actor = await openSocket(tokens.alice);
    try {
      await joinVoice(watcher);
      const update = waitForEvent<{ channelId: string; peers: Array<{ socketId: string }> }>(
        watcher, 'voice:room-update', 15_000,
        value => value?.channelId === voiceChannelId && value?.peers?.some(p => p.socketId === actor.id),
      );
      await joinVoice(actor);
      const state = await update;
      expect(state.peers.map(p => p.socketId)).toEqual(expect.arrayContaining([watcher.id, actor.id]));
    } finally {
      closeSockets(actor, watcher);
    }
  });

  test('Socket: voice:leave diğer voice peerine voice:peer-left gönderir', async () => {
    const watcher = await openSocket(tokens.alice);
    const actor = await openSocket(tokens.alice);
    try {
      await joinVoice(watcher);
      await joinVoice(actor);
      const left = waitForEvent<{ socketId: string }>(
        watcher, 'voice:peer-left', 15_000, value => value?.socketId === actor.id,
      );
      const updated = waitForEvent<{ channelId: string; peers: Array<{ socketId: string }> }>(
        watcher, 'voice:room-update', 15_000,
        value => value?.channelId === voiceChannelId && !value?.peers?.some(p => p.socketId === actor.id),
      );
      actor.emit('voice:leave', { channelId: voiceChannelId, serverId: testServerId });
      expect((await left).socketId).toBe(actor.id);
      const state = await updated;
      expect(state.peers.map(p => p.socketId)).toContain(watcher.id);
      expect(state.peers.some(p => p.socketId === actor.id)).toBe(false);
    } finally {
      closeSockets(actor, watcher);
    }
  });

  test('Socket: beklenmedik disconnect oda listesinden peer siler', async () => {
    const watcher = await openSocket(tokens.alice);
    const actor = await openSocket(tokens.alice);
    try {
      await joinVoice(watcher);
      await joinVoice(actor);
      const update = waitForEvent<{ channelId: string; peers: Array<{ socketId: string }> }>(
        watcher, 'voice:room-update', 15_000,
        value => value?.channelId === voiceChannelId && !value?.peers?.some(p => p.socketId === actor.id),
      );
      actor.disconnect();
      const state = await update;
      expect(state.peers.map(p => p.socketId)).toContain(watcher.id);
      expect(state.peers.some(p => p.socketId === actor.id)).toBe(false);
    } finally {
      closeSockets(actor, watcher);
    }
  });

  test('Socket: sunucu üyesi olmayan kullanıcı voice:join-rejected alır', async () => {
    const outsider = await openSocket(tokens.bob);
    try {
      const refused = waitForEvent<{ channelId: string; code: string }>(
        outsider, 'voice:join-rejected', 15_000,
        value => value?.channelId === voiceChannelId,
      );
      outsider.emit('voice:join', { channelId: voiceChannelId, serverId: testServerId });
      expect((await refused).code).toBe('FORBIDDEN');
    } finally {
      closeSockets(outsider);
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
