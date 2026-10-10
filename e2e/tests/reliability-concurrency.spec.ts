// e2e/tests/reliability-concurrency.spec.ts
//
// GÜVENİLİRLİK / EŞ ZAMANLILIK — FAZ 7
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR — REAKSİYONLARDA KAYIP GÜNCELLEME
// ════════════════════════════════════════════════════════════════════════════
// `POST /api/channels/:messageId/react` reaksiyonu OKU-DEĞİŞTİR-YAZ ile
// güncelliyordu:
//     const msg = await Messages.findById(id);
//     const reactions = msg.reactions ?? {};
//     ...ekle/çıkar...
//     await Messages.update(id, { reactions });
//
// İki istek AYNI ANDA gelirse ikisi de AYNI başlangıç durumunu okur ve SON
// YAZAN kazanır. DOĞRUDAN ÖLÇÜLDÜ — iki farklı kullanıcı, iki farklı emoji:
//     istek durumları : 200, 200
//     son durum       : {"❤️":[bob]}     ← alice'in 👍 KAYBOLDU
//     hayatta kalan   : 1/2
//
// Bu, kullanıcının GÖRDÜĞÜ bir veri kaybıdır: reaksiyon bir an görünür,
// sonra sessizce kaybolur. Çözüm: değişim TEK bir SQL ifadesinde yapılır
// (`MessageRepository.toggleReactionAtomic`), okuma ile yazma arasında
// pencere kalmaz. Atomik yolu desteklemeyen adaptörlerde eski yol korunur.

import { test, expect } from '../helpers/apiTest';
import { getTokens, createTestServer, createTestChannel, joinServer } from '../helpers/bridge';
import { openSocket, closeSockets, waitForEvent, paceSends } from '../helpers/socket';
import { getCsrf } from '../helpers/csrf';
import type { Socket } from 'socket.io-client';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test.describe('güvenilirlik ve eş zamanlılık', () => {
  let tokens: ReturnType<typeof getTokens>;
  let serverId = '';
  let channelId = '';
  let aliceSock: Socket;
  let aliceHdr: Record<string, string>;
  let bobHdr: Record<string, string>;

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();
    const srv = await createTestServer(request, tokens.alice, `Rel ${Date.now()}`);
    serverId = String((srv as { _id?: string })?._id ?? '');
    const ch = await createTestChannel(request, tokens.alice, serverId, `rl-${Date.now().toString(36)}`, 'text');
    channelId = String((ch as { _id?: string })?._id ?? '');
    expect(serverId && channelId, 'fikstür kurulamadı').toBeTruthy();
    expect(await joinServer(request, tokens.alice, tokens.bob, serverId), 'bob katılamadı').toBe(true);

    aliceHdr = {
      Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json',
      'X-CSRF-Token': await getCsrf(request, tokens.alice),
    };
    bobHdr = {
      Authorization: `Bearer ${tokens.bob}`, 'Content-Type': 'application/json',
      'X-CSRF-Token': await getCsrf(request, tokens.bob),
    };

    aliceSock = await openSocket(tokens.alice);
    aliceSock.emit('channel:join', { channelId, serverId });
    await new Promise(r => setTimeout(r, 500));
  });

  test.afterAll(() => { closeSockets(aliceSock); });

  async function sendMessage(content: string): Promise<string> {
    await paceSends('alice');
    const ackId = `rel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ack = waitForEvent<{ messageId: string }>(aliceSock, 'message:ack', 15_000);
    aliceSock.emit('message:send', { channelId, serverId, content, ackId });
    const got = await ack;
    expect(got.messageId, 'mesaj oluşturulamadı').toBeTruthy();
    return got.messageId;
  }

  async function readReactions(
    request: import('@playwright/test').APIRequestContext, messageId: string,
  ): Promise<Record<string, string[]>> {
    const res = await request.get(`${BASE}/api/channels/${channelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    const body = await res.json().catch(() => ({})) as { messages?: unknown[] } | unknown[];
    const arr = (Array.isArray(body) ? body : (body as { messages?: unknown[] }).messages ?? []) as Array<{ _id?: string; reactions?: Record<string, string[]> }>;
    return arr.find(m => m._id === messageId)?.reactions ?? {};
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1. EŞ ZAMANLI REAKSİYON — kayıp güncelleme
  // ══════════════════════════════════════════════════════════════════════════

  test('EŞ ZAMANLI iki reaksiyon KAYBOLMAZ', async ({ request }) => {
    // KANITLAR    : değişim atomiktir; son yazan diğerini ezmiyor.
    // KANITLAMAZ  : çok düğümlü (Redis/cluster) kurulumda davranışı.
    const messageId = await sendMessage(`yaris-${Date.now().toString(36)}`);

    const [r1, r2] = await Promise.all([
      request.post(`${BASE}/api/channels/${messageId}/react`, {
        headers: aliceHdr, data: JSON.stringify({ emoji: '👍' }),
      }),
      request.post(`${BASE}/api/channels/${messageId}/react`, {
        headers: bobHdr, data: JSON.stringify({ emoji: '❤️' }),
      }),
    ]);
    expect(r1.status()).toBe(200);
    expect(r2.status()).toBe(200);

    await new Promise(r => setTimeout(r, 900));
    const reactions = await readReactions(request, messageId);
    // HER İKİ emoji de hayatta olmalı — düzeltmeden önce yalnızca biri kalıyordu.
    expect(reactions['👍'], 'KAYIP GÜNCELLEME: alice reaksiyonu silindi').toBeTruthy();
    expect(reactions['❤️'], 'KAYIP GÜNCELLEME: bob reaksiyonu silindi').toBeTruthy();
    expect(Object.keys(reactions).length, 'beklenen iki reaksiyon yok').toBe(2);
  });

  test('AYNI kullanıcı AYNI emoji ile iki kez — toggle davranışı korunur', async ({ request }) => {
    // Atomik yol eklenirken toggle anlamı bozulmamalı: ekle → kaldır → ekle.
    const messageId = await sendMessage(`toggle-${Date.now().toString(36)}`);

    const add = await request.post(`${BASE}/api/channels/${messageId}/react`, {
      headers: aliceHdr, data: JSON.stringify({ emoji: '🎯' }),
    });
    expect(add.status()).toBe(200);
    expect((await add.json() as { reactions?: Record<string, string[]> }).reactions?.['🎯'],
      'ekleme çalışmadı').toBeTruthy();

    const remove = await request.post(`${BASE}/api/channels/${messageId}/react`, {
      headers: aliceHdr, data: JSON.stringify({ emoji: '🎯' }),
    });
    expect(remove.status()).toBe(200);
    expect((await remove.json() as { reactions?: Record<string, string[]> }).reactions?.['🎯'],
      'ikinci tıklama kaldırmadı').toBeFalsy();

    const again = await request.post(`${BASE}/api/channels/${messageId}/react`, {
      headers: aliceHdr, data: JSON.stringify({ emoji: '🎯' }),
    });
    expect(again.status()).toBe(200);
    expect((await again.json() as { reactions?: Record<string, string[]> }).reactions?.['🎯'],
      'üçüncü tıklama geri eklemedi').toBeTruthy();
  });

  test('AYNI emoji, İKİ kullanıcı — ikisi de listede kalır', async ({ request }) => {
    // Aynı anahtar altındaki dizi de yarışa açıktı.
    const messageId = await sendMessage(`ortak-${Date.now().toString(36)}`);

    const [r1, r2] = await Promise.all([
      request.post(`${BASE}/api/channels/${messageId}/react`, {
        headers: aliceHdr, data: JSON.stringify({ emoji: '🔥' }),
      }),
      request.post(`${BASE}/api/channels/${messageId}/react`, {
        headers: bobHdr, data: JSON.stringify({ emoji: '🔥' }),
      }),
    ]);
    expect(r1.status()).toBe(200);
    expect(r2.status()).toBe(200);

    await new Promise(r => setTimeout(r, 900));
    const reactions = await readReactions(request, messageId);
    expect(reactions['🔥']?.length, 'aynı emoji altında bir kullanıcı kayboldu').toBe(2);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. YİNELENEN İSTEK (idempotency)
  // ══════════════════════════════════════════════════════════════════════════

  test('AYNI ackId ile iki gönderim TEK mesaj üretir', async ({ request }) => {
    // KANITLAR    : yeniden deneme/çift tıklama yinelenen mesaj yaratmıyor.
    const needle = `ack-${Date.now().toString(36)}`;
    const ackId = `dup-${Date.now()}`;

    await paceSends('alice');
    const first = waitForEvent<{ messageId: string }>(aliceSock, 'message:ack', 10_000).catch(() => null);
    aliceSock.emit('message:send', { channelId, serverId, content: needle, ackId });
    await first;

    await paceSends('alice');
    const second = waitForEvent<{ messageId: string }>(aliceSock, 'message:ack', 6_000).catch(() => null);
    aliceSock.emit('message:send', { channelId, serverId, content: needle, ackId });
    await second;

    await new Promise(r => setTimeout(r, 1_500));
    const res = await request.get(`${BASE}/api/channels/${channelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    const body = await res.json().catch(() => ({})) as { messages?: unknown[] } | unknown[];
    const arr = (Array.isArray(body) ? body : (body as { messages?: unknown[] }).messages ?? []) as Array<{ content?: string }>;
    const count = arr.filter(m => String(m.content ?? '').includes(needle)).length;
    expect(count, 'aynı ackId yinelenen mesaj üretti').toBe(1);
  });

  test('AYNI davet iki kez kullanılamaz', async ({ request }) => {
    // KANITLAR    : çift tıklama ikinci bir üyelik satırı yaratmıyor.
    const inv = await request.post(`${BASE}/api/servers/invites`, {
      headers: aliceHdr, data: JSON.stringify({ serverId }),
    });
    expect(inv.status()).toBeLessThan(300);
    const { code } = await inv.json() as { code?: string };
    expect(code).toBeTruthy();

    const useHdr = {
      Authorization: `Bearer ${tokens.media1}`, 'Content-Type': 'application/json',
      'X-CSRF-Token': await getCsrf(request, tokens.media1),
    };
    const firstUse = await request.post(`${BASE}/api/servers/invites/${code}/use`, {
      headers: useHdr, data: '{}',
    });
    const secondUse = await request.post(`${BASE}/api/servers/invites/${code}/use`, {
      headers: useHdr, data: '{}',
    });
    // İlki başarılı ya da zaten üye; İKİNCİSİ kesinlikle başarısız olmalı.
    // Tam sözleşme: üyelik zaten var → 400 'Already a member' (servers/invites.ts).
    expect(secondUse.status(), `aynı davet iki kez kullanıldı: ${await secondUse.text()}`).toBe(400);
    expect(await secondUse.json()).toMatchObject({ error: 'Already a member' });
    // Final21 Faz 22 (19-37): sunucu bu koşumda kurulur ve media1 üye DEĞİLDİR — ilk kullanım 200.
    expect(firstUse.status()).toBe(200);
  });
});
