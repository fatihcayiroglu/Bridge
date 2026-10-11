// e2e/tests/voice.spec.ts — Ses Kanalı E2E Testleri
// Kapsam:
//   API: ses kanalı oluşturma, metadata, üye listesi, izin kontrolü
//   Socket: voice:join → voice:room-update yayını
//   Socket: voice:leave → voice:peer-left yayını
//   Socket: beklenmedik disconnect → oda temizliği
//   UI:  ses kanalı UI elementleri, mute/deafen butonları

import { test, expect } from '../helpers/apiTest';
import { BridgePage, getTokens, createTestServer, joinServer } from '../helpers/bridge';
import { userIdOf } from '../helpers/prune-fixtures';
import { openSocket, waitForEvent, closeSockets } from '../helpers/socket';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

test.describe('Ses Kanalı Akışları', () => {
  let tokens: { alice: string; bob: string; carol: string };
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

  // ── REST ses uçları ──────────────────────────────────────
  // `POST /api/channels/:id/voice-state` ve `GET /api/channels/:id/voice-members`
  // OpenAPI'de bu yolla yayımlanır. Router üretimde `/servers` altına bağlıydı;
  // aşağıdaki dört test 404 alıyor ve `< 500` / `>= 401` ile GEÇİYORDU — uçlar
  // hiç ölçülmüyordu (server/tests/voice-route-mount-contract.test.ts). Silme
  // testi ise `DELETE /api/channels/:id` ile MESAJ silme rotasına gidiyordu.

  test('API: ses kanalına yetkisiz bağlanılamaz', async ({ request }) => {
    expect(voiceChannelId, 'ses kanalı fikstürü eksik').toBeTruthy();
    const url = `${BASE_URL}/api/channels/${voiceChannelId}/voice-state`;
    const data = JSON.stringify({ selfMute: false, selfDeaf: false });
    const anon = await request.post(url, { headers: { 'Content-Type': 'application/json' }, data });
    expect(anon.status(), `oturumsuz: ${await anon.text()}`).toBe(401);
    // carol bu sunucunun üyesi değildir.
    const outsider = await request.post(url, {
      headers: { Authorization: `Bearer ${tokens.carol}`, 'Content-Type': 'application/json' }, data,
    });
    expect(outsider.status(), `üye olmayan: ${await outsider.text()}`).toBe(403);
    const roster = await request.get(`${BASE_URL}/api/channels/${voiceChannelId}/voice-members`, {
      headers: { Authorization: `Bearer ${tokens.carol}` },
    });
    expect(roster.status(), 'üye olmayan ses listesini okuyamaz').toBe(403);
  });

  test('API: ses durumu güncellenebilir (mute/deafen)', async ({ request }) => {
    expect(voiceChannelId && testServerId, 'ses fikstürü eksik').toBeTruthy();
    const url = `${BASE_URL}/api/channels/${voiceChannelId}/voice-state`;
    const headers = { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' };
    const data = JSON.stringify({ selfMute: true, selfDeaf: false });
    // Odada olmayan kullanıcı durum yayamaz.
    const notInRoom = await request.post(url, { headers, data });
    expect(notInRoom.status(), await notInRoom.text()).toBe(409);

    const alice = await openSocket(tokens.alice);
    const bob = await openSocket(tokens.bob);
    try {
      await joinVoice(alice);
      await joinVoice(bob);
      const aliceId = userIdOf(tokens.alice);
      const seen = waitForEvent<{ channelId?: string; userId?: string; selfMute?: boolean; selfDeaf?: boolean }>(
        bob, 'voice:state-update', 10_000, (e) => e?.channelId === voiceChannelId && e?.userId === aliceId,
      );
      const res = await request.post(url, { headers, data });
      expect(res.status(), await res.text()).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(await seen, 'odadaki üye durumu almalı').toMatchObject({ selfMute: true, selfDeaf: false });
    } finally { closeSockets(alice, bob); }
  });

  test('API: ses kanalı üye listesi alınabilir', async ({ request }) => {
    expect(voiceChannelId && testServerId, 'ses fikstürü eksik').toBeTruthy();
    const alice = await openSocket(tokens.alice);
    try {
      await joinVoice(alice);
      const res = await request.get(`${BASE_URL}/api/channels/${voiceChannelId}/voice-members`, {
        headers: { Authorization: `Bearer ${tokens.bob}` },
      });
      expect(res.status(), await res.text()).toBe(200);
      const peers = await res.json() as Array<{ userId?: string; socketId?: string }>;
      expect(Array.isArray(peers)).toBe(true);
      expect(peers.find((p) => p.socketId === alice.id), 'odaya katılan alice listede olmalı')
        .toMatchObject({ userId: userIdOf(tokens.alice) });
    } finally { closeSockets(alice); }
  });

  test('API: ses kanalı yetkisiz silinemez; geçersiz kimlik 5xx vermez', async ({ request }) => {
    expect(voiceChannelId && testServerId, 'ses fikstürü eksik').toBeTruthy();
    const channels = `${BASE_URL}/api/servers/${testServerId}/channels`;
    // bob sunucu üyesidir ama kanal yönetme izni yoktur.
    const byMember = await request.delete(`${channels}/${voiceChannelId}`, {
      headers: { Authorization: `Bearer ${tokens.bob}` },
    });
    expect(byMember.status(), await byMember.text()).toBe(403);
    const list = await request.get(channels, { headers: { Authorization: `Bearer ${tokens.alice}` } });
    expect(list.status()).toBe(200);
    const all = await list.json() as Array<{ _id?: string; id?: string }>;
    expect(all.some((c) => (c._id ?? c.id) === voiceChannelId), 'reddedilen silme kanalı kaldırmamalı').toBe(true);

    const unknown = await request.delete(`${channels}/gecersiz-id`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(unknown.status(), await unknown.text()).toBe(404);
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
      // The room state Bob sees must drop Alice too, not just the peer-left signal.
      const updated = waitForEvent<{ channelId: string; peers: Array<{ socketId: string }> }>(
        bob, 'voice:room-update', 15_000,
        e => e?.channelId === voiceChannelId && e.peers?.every(p => p.socketId !== alice.id) === true,
      );
      alice.emit('voice:leave', { channelId: voiceChannelId, serverId: testServerId });
      const event = await received;
      expect(event.socketId).toBe(alice.id);
      const state = await updated;
      expect(state.peers.some(p => p.socketId === bob.id)).toBe(true);
      expect(state.peers.some(p => p.socketId === alice.id)).toBe(false);
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

  // Fail-closed admission (from #147): a signed-in person who is not a member
  // of the server is refused, never silently ignored. carol is the fixture
  // that belongs to no server (global.setup.ts).
  test('Socket: sunucu üyesi olmayan kullanıcı voice:join-rejected FORBIDDEN alır', async () => {
    expect(voiceChannelId && testServerId, 'ses fikstürü eksik').toBeTruthy();
    const outsider = await openSocket(tokens.carol);
    try {
      const refused = waitForEvent<{ channelId: string; code: string }>(
        outsider, 'voice:join-rejected', 15_000, e => e?.channelId === voiceChannelId,
      );
      outsider.emit('voice:join', { channelId: voiceChannelId, serverId: testServerId });
      expect((await refused).code).toBe('FORBIDDEN');
    } finally { closeSockets(outsider); }
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
