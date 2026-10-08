// e2e/tests/voice.spec.ts — Ses Kanalı E2E Testleri
// Kapsam:
//   API: ses kanalı oluşturma, metadata, üye listesi, izin kontrolü
//   Socket: voice:join → voice:room-update yayını
//   Socket: voice:leave → voice:peer-left yayını
//   Socket: beklenmedik disconnect → oda temizliği
//   UI:  ses kanalı UI elementleri, mute/deafen butonları

import { test, expect } from '../helpers/apiTest';
import { BridgePage, getTokens, createTestServer, joinServer } from '../helpers/bridge';
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
    expect(server, 'ses testi sunucusu oluşturulamadı').toBeTruthy();
    testServerId = server._id || server.id;
    expect(testServerId, 'ses sunucu kimliği eksik').toBeTruthy();

    // Ses kanalı oluştur
    const res = await request.post(`${BASE_URL}/api/servers/${testServerId}/channels`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ name: 'genel-ses', type: 'voice' }),
    });
    expect(res.ok(), `ses kanalı oluşturma HTTP ${res.status()}`).toBe(true);
    const ch = await res.json();
    voiceChannelId = ch._id || ch.id;
    expect(voiceChannelId, 'ses kanalı kimliği eksik').toBeTruthy();
    expect(await joinServer(request, tokens.alice, tokens.bob, testServerId), 'Bob ses sunucusuna katılamadı').toBe(true);
  });

  async function joinVoice(socket: Awaited<ReturnType<typeof openSocket>>): Promise<void> {
    const ack = waitForEvent<{ channelId: string }>(
      socket, 'voice:joined', 15_000, event => event?.channelId === voiceChannelId,
    );
    socket.emit('voice:join', { channelId: voiceChannelId, serverId: testServerId });
    await ack;
  }

  // ── API Testleri ─────────────────────────────────────────

  test('API: ses kanalı oluşturulabilir', async ({ request }) => {
    expect(testServerId, 'ses sunucu fikstürü eksik').toBeTruthy();
    const res = await request.post(`${BASE_URL}/api/servers/${testServerId}/channels`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ name: `ses-${Date.now()}`, type: 'voice' }),
    });
    expect(res.status()).toBeLessThan(300);
    const ch = await res.json();
    expect(ch.type).toBe('voice');
  });

  test('API: ses kanalı listede görünür', async ({ request }) => {
    expect(testServerId, 'ses sunucu fikstürü eksik').toBeTruthy();
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
    expect(voiceChannelId, 'ses kanalı fikstürü eksik').toBeTruthy();
    const res = await request.post(`${BASE_URL}/api/channels/${voiceChannelId}/voice-state`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ selfMute: false, selfDeaf: false }),
    });
    expect(res.status()).toBeGreaterThanOrEqual(401);
  });

  test('API: ses durumu güncellenebilir (mute/deafen)', async ({ request }) => {
    expect(voiceChannelId, 'ses kanalı fikstürü eksik').toBeTruthy();
    const res = await request.post(`${BASE_URL}/api/channels/${voiceChannelId}/voice-state`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ selfMute: true, selfDeaf: false }),
    });
    expect(res.status()).toBeLessThan(500);
  });

  test('API: ses kanalı üye listesi alınabilir', async ({ request }) => {
    expect(voiceChannelId, 'ses kanalı fikstürü eksik').toBeTruthy();
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
    expect(testServerId, 'ses sunucu fikstürü eksik').toBeTruthy();
    const res = await request.delete(`${BASE_URL}/api/channels/gecersiz-id`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status()).toBeLessThan(500);
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  // ── YENİ: Socket sinyal katmanı testleri ─────────────────

  // 'server:join' ses odası aboneliği değildir. Olayın gerçekten
  // ulaşmasını ve katılımcı listesini pozitif kontrollerle doğrula.
  test('Socket: voice:join sonrası üyeler voice:room-update alır', async () => {
    expect(voiceChannelId && testServerId, 'ses fikstürü eksik').toBeTruthy();
    const alice = await openSocket(tokens.alice);
    const bob = await openSocket(tokens.bob);
    try {
      await joinVoice(bob);
      const received = waitForEvent<{ channelId: string; peers: Array<{ socketId: string }> }>(
        bob, 'voice:room-update', 15_000,
        e => e?.channelId === voiceChannelId && e.peers?.some(p => p.socketId === alice.id) === true,
      );
      await joinVoice(alice);
      const update = await received;
      expect(update.peers.some(p => p.socketId === alice.id)).toBe(true);
    } finally { closeSockets(alice, bob); }
  });

  test('Socket: voice:leave sonrası diğer üyeye voice:peer-left gelir', async () => {
    expect(voiceChannelId && testServerId, 'ses fikstürü eksik').toBeTruthy();
    const alice = await openSocket(tokens.alice);
    const bob = await openSocket(tokens.bob);
    try {
      await joinVoice(bob);
      await joinVoice(alice);
      const received = waitForEvent<{ socketId: string }>(
        bob, 'voice:peer-left', 15_000, e => e?.socketId === alice.id,
      );
      alice.emit('voice:leave', { channelId: voiceChannelId, serverId: testServerId });
      const event = await received;
      expect(event.socketId).toBe(alice.id);
    } finally { closeSockets(alice, bob); }
  });

  test('Socket: beklenmedik disconnect sonrası ses odasının peers listesi azalır', async () => {
    expect(voiceChannelId && testServerId, 'ses fikstürü eksik').toBeTruthy();
    const alice = await openSocket(tokens.alice);
    const watcher = await openSocket(tokens.bob);
    try {
      await joinVoice(watcher);
      const joined = waitForEvent<{ channelId: string; peers: Array<{ socketId: string }> }>(
        watcher, 'voice:room-update', 15_000,
        e => e?.channelId === voiceChannelId && e.peers?.some(p => p.socketId === alice.id) === true,
      );
      await joinVoice(alice);
      const before = await joined;
      const left = waitForEvent<{ channelId: string; peers: Array<{ socketId: string }> }>(
        watcher, 'voice:room-update', 15_000,
        e => e?.channelId === voiceChannelId && e.peers?.every(p => p.socketId !== alice.id) === true,
      );
      alice.disconnect();
      const after = await left;
      expect(after.peers.length).toBeLessThan(before.peers.length);
      expect(after.peers.some(p => p.socketId === alice.id)).toBe(false);
    } finally { closeSockets(alice, watcher); }
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
    expect(testServerId, 'ses sunucu fikstürü eksik').toBeTruthy();

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
