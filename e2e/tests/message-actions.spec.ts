// e2e/tests/message-actions.spec.ts — Mesaj aksiyonları, KANONİK Socket.IO yolu.
//
// Bridge'de kanal mesajı gönderimi REST DEĞİLDİR. Üretimde tek yazma yolu Socket.IO'dur:
//   message:send   → message:ack (gönderene) + message:new (kanal odasına)
//   message:reply  → aynı, replyToId ile
//   message:edit   → message:edited
//   message:delete → message:deleted
//   message:react  → message:reaction
// `POST /api/channels/:id/messages` diye bir uç YOKTUR ve eklenmemelidir.
// Okuma yolu REST'tir: GET /api/channels/:cid/messages
//
// DOĞRULAMA STRATEJİSİ
// Yazma tarafı her zaman gerçek socket event'iyle yapılır (üretim yolu).
// Etki doğrulaması ise kanonik REST okuma yolundan okunur. Bunun nedeni
// `channel:join`in ack'siz olmasıdır: oda üyeliği asenkron kurulur ve
// istemciye onay dönmez, dolayısıyla yayın olayına dayanan doğrulama
// yarışa açıktır. Yayının kendisi ayrı ve tek bir testte kanıtlanır.

import { test, expect } from '../helpers/apiTest';
import { getTokens, createTestServer, createTestChannel, joinServer } from '../helpers/bridge';
import { openSocket, waitForEvent, closeSockets, paceSends, attachSendDiagnostics, joinChannelConfirmed } from '../helpers/socket';
import type { Socket } from 'socket.io-client';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

type Msg = {
  _id: string;
  content?: string;
  deletedAt?: number;
  deletedBy?: string;
  replyTo?: { _id: string; displayName?: string; content?: string };
  type?: string;
  fileName?: string;
  fileUrl?: string;
  reactions?: Record<string, string[]> | string;
};

test.describe('Mesaj Aksiyonları — kanonik Socket.IO akışı', () => {
  let tokens: ReturnType<typeof getTokens>;
  let serverId = '';
  let channelId = '';
  let alice: Socket;

  // ══════════════════════════════════════════════════════════════════════════
  // NEDEN TAZE KIMLIK
  // ══════════════════════════════════════════════════════════════════════════
  // Bu paket ham soket uzerinden `message:ack` bekler (15 sn). Paket TEK BASINA
  // 8/8 geciyor; TAM kosumda `edit` ve `reaction` testleri zaman asimina
  // ugruyordu — cunku paketin tamami alice'i paylasiyor ve `workers: 2` ile
  // diger agir spec'ler ayni anda ayni kimlikle calisiyor.
  //
  // Iddia ZAYIFLATILMAZ ve zaman asimi UZATILMAZ; sahibi olan kimlik AYRILIR.
  let ownerToken = '';

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();
    // MEVCUT kimlik yeniden kullanilir; yeni hesap ACILMAZ.
    // `MAX_REG_PER_HOUR` (varsayilan 3) gercek bir kotuye kullanim
    // korumasidir ve testler onu tuketmemelidir. Yalitim, her spec'in KENDI
    // tek kullanimlik sunucu/kanalini olusturmasiyla saglanir.
    ownerToken = tokens.media1;

    const server = await createTestServer(request, ownerToken, `MsgActions ${Date.now()}`);
    expect(server, 'test sunucusu oluşturulamadı').toBeTruthy();
    serverId = server._id || server.id;

    const channel = await createTestChannel(request, ownerToken, serverId, 'aksiyonlar');
    expect(channel, 'test kanalı oluşturulamadı').toBeTruthy();
    channelId = channel._id || channel.id;

    alice = await openSocket(ownerToken);
    attachSendDiagnostics(alice, 'alice');
  });

  test.afterAll(() => {
    closeSockets(alice);
  });

  /** Kanonik REST okuma yolu. */
  async function readMessages(
    request: import('@playwright/test').APIRequestContext,
    token = ownerToken,
  ): Promise<Msg[]> {
    const res = await request.get(`${BASE_URL}/api/channels/${channelId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    return Array.isArray(body) ? body : (body.messages ?? []);
  }

  /** message:send gönderir ve gönderene özel message:ack'i bekler. */
  async function sendMessage(content: string): Promise<{ ackId: string; messageId: string }> {
    await paceSends('alice');
    const ackId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ack = waitForEvent<{ ackId: string; messageId: string }>(alice, 'message:ack', 15_000, (a) => a?.ackId === ackId);
    alice.emit('message:send', { channelId, serverId, content, ackId });
    const received = await ack;
    expect(received.ackId).toBe(ackId);
    expect(received.messageId).toBeTruthy();
    return received;
  }

  /** Bir koşul sağlanana kadar kanonik okuma yolunu yoklar. */
  async function waitFor<T>(
    fn: () => Promise<T | null | undefined | false>,
    timeoutMs = 10_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      last = await fn();
      if (last) return last as T;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('Koşul zaman aşımına uğradı');
  }

  test('send — message:send kalıcı mesaj oluşturur ve message:ack döner', async ({ request }) => {
    const content = `E2E gönderim ${Date.now()}`;
    const { messageId } = await sendMessage(content);

    const found = await waitFor(async () =>
      (await readMessages(request)).find((m) => m._id === messageId));
    expect(found.content).toBe(content);
  });

  test('send — aynı ackId tekrarı EN FAZLA bir mesaj kalıcılaştırır (idempotency)', async ({ request }) => {
    const ackId = `e2e-dup-${Date.now()}`;
    const content = `E2E idempotent ${Date.now()}`;

    await paceSends('alice');
    const first = waitForEvent<{ messageId: string }>(alice, 'message:ack', 15_000);
    alice.emit('message:send', { channelId, serverId, content, ackId });
    const a = await first;

    await paceSends('alice');
    const second = waitForEvent<{ messageId: string }>(alice, 'message:ack', 15_000);
    alice.emit('message:send', { channelId, serverId, content, ackId });
    const b = await second;

    // Aynı ackId → aynı kanonik mesaj, ikinci bir kayıt DEĞİL.
    expect(b.messageId).toBe(a.messageId);
    expect((await readMessages(request)).filter((m) => m.content === content)).toHaveLength(1);
  });

  test('reply — message:reply replyToId taşıyan ayrı bir mesaj üretir', async ({ request }) => {
    const parent = await sendMessage(`E2E yanıtlanacak ${Date.now()}`);

    const ackId = `e2e-reply-${Date.now()}`;
    const content = `E2E yanıt ${Date.now()}`;
    await paceSends('alice');
    const ack = waitForEvent<{ messageId: string }>(alice, 'message:ack', 15_000);
    alice.emit('message:reply', { channelId, serverId, content, ackId, replyToId: parent.messageId });
    const replyAck = await ack;

    expect(replyAck.messageId).not.toBe(parent.messageId);
    const reply = await waitFor(async () =>
      (await readMessages(request)).find((m) => m._id === replyAck.messageId));
    expect(reply.content).toBe(content);
    // Kalıcı şema replyToId DEĞİL, replyTo önizleme nesnesi tutar.
    expect(reply.replyTo?._id).toBe(parent.messageId);
  });

  test('edit — message:edit kalıcı içeriği günceller', async ({ request }) => {
    const { messageId } = await sendMessage(`E2E düzenlenecek ${Date.now()}`);
    const yeni = `E2E düzenlendi ${Date.now()}`;

    alice.emit('message:edit', { messageId, channelId, content: yeni });

    const edited = await waitFor(async () => {
      const m = (await readMessages(request)).find((x) => x._id === messageId);
      return m && m.content === yeni ? m : null;
    });
    expect(edited.content).toBe(yeni);
  });

  test('reaction — message:react kalıcı reaksiyon yazar', async ({ request }) => {
    const { messageId } = await sendMessage(`E2E reaksiyon ${Date.now()}`);

    alice.emit('message:react', { messageId, channelId, emoji: '👍' });

    const reacted = await waitFor(async () => {
      const m = (await readMessages(request)).find((x) => x._id === messageId);
      if (!m?.reactions) return null;
      const r = typeof m.reactions === 'string'
        ? JSON.parse(m.reactions) as Record<string, string[]>
        : m.reactions;
      return r['👍']?.length ? r : null;
    });
    expect(Object.keys(reacted)).toContain('👍');
  });

  // KANONİK SÖZLEŞME (Final21 Faz 16): silinmiş satır DENETİM durumudur, içerik değildir.
  // Canlı yayın mesajı kaldırır; yeniden yükleme de AYNI hikâyeyi anlatmalıdır, yani liste
  // onu artık DÖNDÜRMEZ. (Faz 16 öncesi liste "[Mesaj silindi]" satırını geri getiriyordu —
  // her dilde Türkçe.) Bu test eski sözleşmeyi bekliyordu ve Faz 16'dan beri KIRMIZIYDI
  // (Final21 Faz 19, 19-24). Kalıcı soft-delete + içerik temizliği sunucu tarafında
  // ölçülür (server/tests/deleteMessageCascade.test.ts,
  // tests/pg-integration/message-content-format.pgtest.ts).
  test('delete — message:delete yayınlanır ve mesaj yeniden yüklemede de GERİ GELMEZ', async ({ request }) => {
    await joinChannelConfirmed(alice, channelId, serverId);
    const kept = await sendMessage(`E2E kalacak ${Date.now()}`);
    const { messageId } = await sendMessage(`E2E silinecek ${Date.now()}`);
    await waitFor(async () => {
      const list = await readMessages(request);
      return list.some((m) => m._id === messageId) && list.some((m) => m._id === kept.messageId);
    });

    const announced = waitForEvent<{ id: string }>(alice, 'message:deleted', 10_000, (d) => d?.id === messageId);
    alice.emit('message:delete', { messageId, channelId });
    expect((await announced).id).toBe(messageId);

    // Önbellek YAYINDAN ÖNCE düşürülür: yayından sonraki İLK okuma zaten doğru olmalı.
    const after = await readMessages(request);
    expect(after.find((m) => m._id === messageId), 'silinen mesaj yeniden yüklemede geri geldi').toBeUndefined();
    // Pozitif kontrol: okuma gerçek; silinmeyen komşu mesaj hâlâ listede.
    expect(after.some((m) => m._id === kept.messageId)).toBe(true);
    expect(JSON.stringify(after)).not.toContain('[Mesaj silindi]');
  });

  test('yayın — ÜYE OLMAYAN oturum channel:join sonrası bile message:new ALMAZ', async () => {
    // Negatif kontrol: bob henüz sunucu üyesi değil. channel:join üyelik +
    // kanal görünürlüğü şart koşar, dolayısıyla odaya hiç girememeli.
    const outsider = await openSocket(tokens.bob);
    try {
      outsider.emit('channel:join', channelId);
      await new Promise((r) => setTimeout(r, 1_000));

      let leaked = false;
      outsider.on('message:new', () => { leaked = true; });

      await sendMessage(`E2E sızıntı kontrolü ${Date.now()}`);
      await new Promise((r) => setTimeout(r, 1_000));

      expect(leaked, 'üye olmayan oturuma kanal mesajı sızdı').toBe(false);
    } finally {
      closeSockets(outsider);
    }
  });

  test('yayın — ÜYE olan ikinci oturum message:new alır', async ({ request }) => {
    expect(await joinServer(request, ownerToken, tokens.bob, serverId),
      'bob sunucuya katılamadı').toBe(true);

    const bob = await openSocket(tokens.bob);
    try {
      // channel:join ack'siz ve asenkron; oda üyeliği kurulana kadar
      // gönderimi tekrarlayarak yayını bekle.
      const content = `E2E yayın ${Date.now()}`;
      const got = await new Promise<boolean>((resolve) => {
        const deadline = Date.now() + 20_000;
        let done = false;
        bob.on('message:new', (m: Msg) => {
          if (m?.content === content && !done) { done = true; resolve(true); }
        });
        const tick = async () => {
          if (done) return;
          if (Date.now() > deadline) return resolve(false);
          bob.emit('channel:join', channelId);
          await new Promise((r) => setTimeout(r, 600));
          if (done) return;
          alice.emit('message:send', {
            channelId, serverId, content, ackId: `e2e-bc-${Date.now()}`,
          });
          setTimeout(tick, 1_200);
        };
        void tick();
      });
      expect(got, 'üye olan oturuma message:new ulaşmadı').toBe(true);
    } finally {
      closeSockets(bob);
    }
  });
});
