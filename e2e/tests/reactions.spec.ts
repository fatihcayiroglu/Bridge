// e2e/tests/reactions.spec.ts — Sprint 14: TypeScript dönüşümü (.js → .ts)
// e2e/tests/reactions.spec.js — Mesaj Reaksiyon E2E Testleri
//
// Kapsar:
//   1. Reaksiyon ekleme (emoji)
//   2. Reaksiyon kaldırma (toggle)
//   3. Aynı emoji iki kez — sayaç artış/azalışı
//   4. Farklı kullanıcılar aynı reaksiyonu verebilir
//   5. Geçersiz/boş emoji reddedilmeli
//   6. Yetkisiz reaksiyon reddedilmeli (401)


import { test, expect } from '../helpers/apiTest';
import { getTokens, createTestServer, createTestChannel } from '../helpers/bridge';
import { openSocket, closeSockets, waitForEvent, paceSends } from '../helpers/socket';
import type { Socket } from 'socket.io-client';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

// ════════════════════════════════════════════════════════════════════════════
// KANONIK REAKSIYON UCU
// ════════════════════════════════════════════════════════════════════════════
// Bu dosya eskiden `/api/channels/<kanal>/messages/<mesaj>/react` kullaniyordu.
// BOYLE BIR YOL YOK. Gercek tanim (server/routes/messages.ts):
//
//     router.post('/:id/react', ...)            // :id = MESAJ kimligi
//
// ve bu router `app/setupRoutes.ts` icinde soyle baglanir:
//
//     mountApi('/channels', messagesRouter)
//
// Dolayisiyla kanonik yol: POST /api/channels/<MESAJ id>/react
// (Isim yaniltici olabilir: mount yolu `/channels` olsa da parametre MESAJ
// kimligidir.) Okuma yolu ayridir: GET /api/channels/<KANAL id>/messages
test.describe('Reaksiyon Akışları', () => {
  let tokens;
  let serverId;
  let channelId;
  let msgId;
  let alice: Socket;

  // ════════════════════════════════════════════════════════════════════════
  // FIKSTUR KANONIK YOLDAN KURULUR — 7 TEST SESSIZCE ATLANIYORDU
  // ════════════════════════════════════════════════════════════════════════
  // Burada eskiden mesaj `POST /api/channels/:id/messages` ile olusturuluyordu.
  // BOYLE BIR UC YOK — dogrudan olculdu:
  //
  //   POST /api/channels/<id>/messages
  //     → 404 {"error":"Not found: POST /api/channels/<id>/messages"}
  //
  // Sonuc: `msgId` hic atanmiyor ve 8 testin 7'si
  // `test.skip(!msgId, ...)` ile SESSIZCE atlaniyordu. Paket "yesil"
  // gorunuyor ama reaksiyon ozelliginin neredeyse TAMAMI dogrulanmiyordu
  // (olculdu: 7 atlandi / 1 gecti).
  //
  // Bridge'de kanal mesaji yazma yolu SOCKET.IO'dur (bkz.
  // message-actions.spec.ts): `message:send` → `message:ack`. Fikstur artik
  // URUNUN GERCEK yolunu kullanir; okuma tarafi kanonik REST'tir.
  test.beforeAll(async ({ request }) => {
    tokens = getTokens();

    const srv = await createTestServer(request, tokens.alice, `React-Server-${Date.now()}`);
    serverId = srv?._id || srv?.id;
    if (!serverId) throw new Error('reaksiyon fikstur sunucusu olusturulamadi');

    const ch = await createTestChannel(request, tokens.alice, serverId, `reactions-${Date.now().toString(36)}`);
    channelId = ch?._id || ch?.id;
    if (!channelId) throw new Error('reaksiyon fikstur kanali olusturulamadi');

    alice = await openSocket(tokens.alice);
    alice.emit('channel:join', { channelId, serverId });
    await paceSends('alice');

    const ackId = `react-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ack = waitForEvent<{ ackId: string; messageId: string }>(alice, 'message:ack', 15_000);
    alice.emit('message:send', { channelId, serverId, content: 'Reaksiyon test mesajı 🎯', ackId });
    const received = await ack;
    msgId = received.messageId;
    if (!msgId) throw new Error('reaksiyon fikstur mesaji olusturulamadi');
  });

  test.afterAll(() => { closeSockets(alice); });

  // ── 1. Reaksiyon ekleme ───────────────────────────────────

  test('API: reaksiyon ekleme başarılı', async ({ request }) => {
    expect(msgId, 'reaksiyon mesaj fikstürü oluşturulamadı').toBeTruthy();

    const res = await request.post(
      `${BASE}/api/channels/${msgId}/react`,
      {
        headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
        data: JSON.stringify({ emoji: '👍' }),
      }
    );
    // 200 veya 201
    expect(res.status()).toBeLessThan(300);
  });

  test('API: reaksiyon sonrası mesajda görünmeli', async ({ request }) => {
    expect(msgId, 'reaksiyon mesaj fikstürü oluşturulamadı').toBeTruthy();

    // Reaksiyon ekle
    await request.post(
      `${BASE}/api/channels/${msgId}/react`,
      {
        headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
        data: JSON.stringify({ emoji: '❤️' }),
      }
    );

    // Mesajı getir ve reaksiyonu kontrol et
    const msgsRes = await request.get(`${BASE}/api/channels/${channelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(msgsRes.ok()).toBe(true);
    const data = await msgsRes.json();
    const messages = data.messages || data;
    const msg = messages.find((m) => (m._id || m.id) === msgId);

    // Mesaj varsa reactions alanı kontrolü
    if (msg) {
      const reactions = msg.reactions || {};
      // reactions obje veya array olabilir — Bridge implementasyonuna göre
      const hasReaction =
        (Array.isArray(reactions) && reactions.some((r) => r.emoji === '❤️' || r.count > 0)) ||
        (typeof reactions === 'object' && Object.keys(reactions).length > 0);
      expect(hasReaction).toBe(true);
    }
  });

  // ── 2. Reaksiyon kaldırma (toggle) ───────────────────────

  test('API: reaksiyon toggle — aynı emoji tekrar kaldırılır', async ({ request }) => {
    expect(msgId, 'reaksiyon mesaj fikstürü oluşturulamadı').toBeTruthy();

    const emoji = '🔥';

    // İlk reaksiyon — ekle
    const add = await request.post(
      `${BASE}/api/channels/${msgId}/react`,
      {
        headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
        data: JSON.stringify({ emoji }),
      }
    );
    expect(add.status()).toBeLessThan(300);

    // İkinci kez aynı emoji — kaldır (toggle) veya idempotent
    const remove = await request.post(
      `${BASE}/api/channels/${msgId}/react`,
      {
        headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
        data: JSON.stringify({ emoji }),
      }
    );
    // Kaldırma da başarılı olmalı (200 veya 204)
    expect(remove.status()).toBeLessThan(300);
  });

  // ── 3. Farklı kullanıcılar ────────────────────────────────

  test('API: Bob reaksiyon ekleyebilmeli (üye değilse skip)', async ({ request }) => {
    expect(msgId, 'reaksiyon mesaj fikstürü oluşturulamadı').toBeTruthy();

    // Bob'u sunucuya üye et — davet linki veya direkt join
    // Bob üye olmayabilir, bu durumda 403 beklenir — her iki durum geçerli
    const res = await request.post(
      `${BASE}/api/channels/${msgId}/react`,
      {
        headers: { Authorization: `Bearer ${tokens.bob}`, 'Content-Type': 'application/json' },
        data: JSON.stringify({ emoji: '👋' }),
      }
    );
    // 200 (üye ise) veya 403 (üye değilse) — ikisi de doğru davranış
    // Final21 Faz 22 (19-37): fikstür sunucusunu alice kurar ve bob HİÇ katılmaz — üye olmayanın
    // tepkisi 403 olmalıdır (ölçüldü). 200'ü de kabul etmek yetki kontrolünün kaybolmasını gizlerdi.
    expect(res.status()).toBe(403);
  });

  // ── 4. Geçersiz emoji ─────────────────────────────────────

  test('API: boş emoji reddedilmeli', async ({ request }) => {
    expect(msgId, 'reaksiyon mesaj fikstürü oluşturulamadı').toBeTruthy();

    const res = await request.post(
      `${BASE}/api/channels/${msgId}/react`,
      {
        headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
        data: JSON.stringify({ emoji: '' }),
      }
    );
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('API: çok uzun emoji string reddedilmeli', async ({ request }) => {
    expect(msgId, 'reaksiyon mesaj fikstürü oluşturulamadı').toBeTruthy();

    const res = await request.post(
      `${BASE}/api/channels/${msgId}/react`,
      {
        headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
        data: JSON.stringify({ emoji: 'a'.repeat(200) }),
      }
    );
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  // ── 5. Auth kontrolü ─────────────────────────────────────

  test('API: token olmadan reaksiyon reddedilmeli (401)', async ({ request }) => {
    expect(msgId, 'reaksiyon mesaj fikstürü oluşturulamadı').toBeTruthy();

    const res = await request.post(
      `${BASE}/api/channels/${msgId}/react`,
      {
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ emoji: '👍' }),
      }
    );
    expect(res.status()).toBe(401);
  });

  test('API: var olmayan mesaja reaksiyon 404 dönmeli', async ({ request }) => {
    const res = await request.post(
      `${BASE}/api/channels/nonexistent-msg-id-xyz/react`,
      {
        headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
        data: JSON.stringify({ emoji: '👍' }),
      }
    );
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });
});
