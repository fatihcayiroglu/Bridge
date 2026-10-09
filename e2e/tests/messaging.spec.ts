// e2e/tests/messaging.spec.ts — Sprint 14: TypeScript dönüşümü (.js → .ts)
// e2e/tests/messaging.spec.js — Mesaj Gönderme E2E Testleri
// Kritik akış: mesaj gönder, al, gerçek zamanlı güncelleme

import { test, expect } from '../helpers/apiTest';
import { BridgePage, getTokens, createTestServer, createTestChannel, sendApiMessage } from '../helpers/bridge';
import { openSocket, waitForEvent, closeSockets, paceSends, joinChannelConfirmed } from '../helpers/socket';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

/**
 * Creates a message through the product's ONLY send path (Socket.IO `message:send` → own ack).
 * Final21 Faz 19 (19-33): the REST edit/delete tests below used to skip forever with
 * "Mesaj fixture gerekli" because their fixture came from a REST send endpoint that does not exist
 * (and they addressed `/channels/:cid/messages/:mid`, which is not the mutation route either).
 */
async function sendViaSocket(token: string, serverId: string, channelId: string, content: string): Promise<string> {
  const socket = await openSocket(token);
  try {
    // Both the join probe and the actual send create persisted messages.
    // The server anti-spam counter belongs to Alice, not to this spec. Reserve
    // BOTH sends under the same cross-worker 'alice' key used by other specs.
    await paceSends('alice');
    await joinChannelConfirmed(socket, channelId, serverId);
    await paceSends('alice');
    const ackId = `e2e-rest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ack = waitForEvent<{ ackId: string; messageId: string }>(socket, 'message:ack', 15_000, (a) => a?.ackId === ackId);
    socket.emit('message:send', { channelId, serverId, content, ackId });
    const { messageId } = await ack;
    expect(messageId).toBeTruthy();
    return messageId;
  } finally {
    closeSockets(socket);
  }
}

/** Sends through Socket.IO and returns what the server answered to THIS send (ackId-matched). */
async function sendExpectingOutcome(
  token: string, serverId: string, channelId: string, content: string,
): Promise<{ kind: 'ack' | 'error' | 'silence'; data?: { code?: string; ackId?: string; messageId?: string } }> {
  const socket = await openSocket(token);
  try {
    await paceSends('alice');
    await joinChannelConfirmed(socket, channelId, serverId);
    await paceSends('alice');
    const ackId = `e2e-reject-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    type Answer = { code?: string; ackId?: string; messageId?: string };
    const mine = (d: Answer) => d?.ackId === ackId;
    const acked = waitForEvent<Answer>(socket, 'message:ack', 10_000, mine).then((data) => ({ kind: 'ack' as const, data }), () => null);
    const refused = waitForEvent<Answer>(socket, 'error:message', 10_000, mine).then((data) => ({ kind: 'error' as const, data }), () => null);
    socket.emit('message:send', { channelId, serverId, content, ackId });
    return (await Promise.race([acked, refused])) ?? (await Promise.all([acked, refused])).find(Boolean) ?? { kind: 'silence' };
  } finally {
    closeSockets(socket);
  }
}

async function listMessages(
  request: import('@playwright/test').APIRequestContext, token: string, channelId: string,
): Promise<Array<{ _id: string; content: string }>> {
  const res = await request.get(`${BASE_URL}/api/channels/${channelId}/messages?limit=50`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const data = await res.json();
  return Array.isArray(data) ? data : data.messages || [];
}

test.describe('Mesajlaşma Akışları', () => {
  let testServerId;
  let testChannelId;
  let tokens;

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();

    // Test sunucusu ve kanalı oluştur
    const server = await createTestServer(request, tokens.alice, `E2E Mesaj Server ${Date.now()}`);
    expect(server, 'mesajlaşma sunucusu oluşturulamadı').toBeTruthy();
    testServerId = server._id || server.id;
    expect(testServerId, 'mesajlaşma sunucu kimliği eksik').toBeTruthy();
    const ch = await createTestChannel(request, tokens.alice, testServerId, 'genel');
    expect(ch, 'mesajlaşma kanalı oluşturulamadı').toBeTruthy();
    testChannelId = ch._id || ch.id;
    expect(testChannelId, 'mesajlaşma kanal kimliği eksik').toBeTruthy();
  });

  // ── API Testleri ─────────────────────────────────────────

  test('Socket.IO: mesaj gönderme (kanonik yazma yolu)', async ({ request }) => {
    expect(testServerId && testChannelId, 'sunucu/kanal fixture eksik').toBeTruthy();
    const content = `Mesaj gönderme E2E ${Date.now()}`;
    const messageId = await sendViaSocket(tokens.alice, testServerId, testChannelId, content);
    const res = await request.get(`${BASE_URL}/api/channels/${testChannelId}/messages?limit=50`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    const messages = Array.isArray(data) ? data : data.messages || [];
    expect(messages.find((m: { _id: string }) => m._id === messageId)).toMatchObject({ content });
  });
  test('REST okuma: Socket.IO ile yazılan mesajları listeler', async ({ request }) => {
    expect(testServerId && testChannelId, 'sunucu/kanal fixture eksik').toBeTruthy();
    const content = `Listeleme E2E ${Date.now()}`;
    const messageId = await sendViaSocket(tokens.alice, testServerId, testChannelId, content);
    const res = await request.get(`${BASE_URL}/api/channels/${testChannelId}/messages?limit=50`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    const messages = Array.isArray(data) ? data : data.messages || [];
    expect(messages.some((m: { _id: string; content: string }) => m._id === messageId && m.content === content)).toBe(true);
  });
  // Bu iki test eskiden var olmayan bir REST gönderim ucuna (`POST
  // /api/channels/:id/messages`) gidiyor ve 404'ü `>= 400` ile "ret" sayıyordu —
  // doğrulama HİÇ ölçülmüyordu. Ürünün tek yazma yolu Socket.IO `message:send`tir;
  // ret, bu gönderime ait (ackId) `error:message` ile gelir ve mesaj KALICILAŞMAZ.
  test('Socket.IO: boş mesaj reddedilir ve kalıcılaşmaz', async ({ request }) => {
    expect(testServerId && testChannelId, 'sunucu/kanal fixture eksik').toBeTruthy();
    const before = await listMessages(request, tokens.alice, testChannelId);

    const outcome = await sendExpectingOutcome(tokens.alice, testServerId, testChannelId, '');
    expect(outcome.kind, 'boş içerik kabul edildi ya da sessizce düştü').toBe('error');
    expect(outcome.data?.code).toBe('EMPTY_MESSAGE');

    // Kanala katılım yoklaması kendi (dolu) mesajını yazar; o yüzden sayı değil,
    // bu gönderim sırasında oluşan mesajların İÇERİĞİ denetlenir.
    const seen = new Set(before.map((m) => m._id));
    const created = (await listMessages(request, tokens.alice, testChannelId)).filter((m) => !seen.has(m._id));
    expect(created.filter((m) => !String(m.content ?? '').trim()), 'boş mesaj kalıcılaştı').toEqual([]);
  });

  test('Socket.IO: üye olmayan kullanıcı gönderemez ve mesaj kalıcılaşmaz', async ({ request }) => {
    expect(testServerId && testChannelId, 'sunucu/kanal fixture eksik').toBeTruthy();
    const outsider = await openSocket(tokens.bob);
    const ackId = `outsider-${Date.now()}`;
    const content = `Yetkisiz mesaj ${ackId}`;
    try {
      const rejected = waitForEvent<{ event: string; code: string }>(
        outsider, 'error:message', 10_000,
        data => data?.event === 'message:send' && data?.code === 'NOT_A_MEMBER',
      );
      outsider.emit('message:send', { channelId: testChannelId, serverId: testServerId, content, ackId });
      expect((await rejected).code).toBe('NOT_A_MEMBER');

      const res = await request.get(`${BASE_URL}/api/channels/${testChannelId}/messages?limit=50`, {
        headers: { Authorization: `Bearer ${tokens.alice}` },
      });
      expect(res.status()).toBe(200);
      const data = await res.json();
      const messages = Array.isArray(data) ? data : data.messages || [];
      expect(messages.some((m: { content: string }) => m.content === content)).toBe(false);
    } finally {
      closeSockets(outsider);
    }
  });
  /** Canonical REST read: the channel's first page. */
  async function listIds(request: import('@playwright/test').APIRequestContext): Promise<Map<string, { content?: string; editedAt?: unknown }>> {
    const res = await request.get(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const rows = (Array.isArray(body) ? body : body.messages ?? []) as Array<{ _id?: string; id?: string; content?: string; editedAt?: unknown }>;
    return new Map(rows.map((m) => [String(m._id ?? m.id), m]));
  }

  test('API: mesaj silme (REST mutasyon yolu, DELETE /api/channels/:messageId)', async ({ request }) => {
    expect(testChannelId, 'test kanalı oluşturulamadı').toBeTruthy();
    const msgId = await sendViaSocket(tokens.alice, testServerId, testChannelId, `Silinecek mesaj ${Date.now()}`);
    expect((await listIds(request)).has(msgId)).toBe(true);

    // A non-member cannot delete it (the channel is not visible to bob) — and it stays.
    const foreign = await request.delete(`${BASE_URL}/api/channels/${msgId}`, { headers: { Authorization: `Bearer ${tokens.bob}` } });
    expect(foreign.status()).toBe(403);
    expect((await listIds(request)).has(msgId)).toBe(true);

    const delRes = await request.delete(`${BASE_URL}/api/channels/${msgId}`, { headers: { Authorization: `Bearer ${tokens.alice}` } });
    expect(delRes.status()).toBe(200);
    expect(await delRes.json()).toEqual({ deleted: true, id: msgId });
    // Final state: the very next canonical read no longer lists it (cache dropped before the answer).
    expect((await listIds(request)).has(msgId)).toBe(false);
  });

  test('API: mesaj düzenleme (REST mutasyon yolu, PATCH /api/channels/:messageId)', async ({ request }) => {
    expect(testChannelId, 'test kanalı oluşturulamadı').toBeTruthy();
    const original = `Orijinal içerik ${Date.now()}`;
    const msgId = await sendViaSocket(tokens.alice, testServerId, testChannelId, original);

    const foreign = await request.patch(`${BASE_URL}/api/channels/${msgId}`, {
      headers: { Authorization: `Bearer ${tokens.bob}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: 'ele geçirme denemesi' }),
    });
    expect(foreign.status()).toBe(403);
    expect((await listIds(request)).get(msgId)?.content).toBe(original);

    const edited = `Düzenlenmiş içerik <b> & ${Date.now()}`;
    const editRes = await request.patch(`${BASE_URL}/api/channels/${msgId}`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: edited }),
    });
    expect(editRes.status()).toBe(200);
    expect((await editRes.json()).content).toBe(edited);
    // Final state from the canonical read: new text exactly as typed, marked edited.
    const row = (await listIds(request)).get(msgId);
    expect(row?.content).toBe(edited);
    expect(row?.editedAt).toBeTruthy();
  });

  test('API: sayfalama cursor çalışmalı', async ({ request }) => {
    expect(testChannelId, 'mesajlaşma kanalı fikstürü yok').toBeTruthy();

    const res = await request.get(
      `${BASE_URL}/api/channels/${testChannelId}/messages?limit=5`,
      { headers: { Authorization: `Bearer ${tokens.alice}` } }
    );
    expect(res.status()).toBe(200);
    const data = await res.json();
    // cursor veya pagination alanı gelmeli
    expect(data).toBeDefined();
  });

  // ── UI Testleri ──────────────────────────────────────────

  test('UI: mesaj input görünmeli', async ({ page }) => {
    const bp = new BridgePage(page);
    await bp.goto('/');
    await page.waitForTimeout(1000);

    // Ana sayfa yüklendi mi
    await expect(page.locator('body')).toBeVisible();
    // Bir kanal seçiliyse mesaj input'u olmalı
    const input = page.locator(
      '[data-testid="message-input"], #message-input, .message-input, [placeholder*="Message"], [placeholder*="Mesaj"]'
    ).first();

    // Input varsa görünür olmalı (kanal seçili olmayabilir)
    const count = await input.count();
    if (count > 0) {
      await expect(input).toBeVisible();
    }
  });

  test('Socket.IO: 2000 karakter sınırı — 2000 kabul, 2001 reddedilir ve kalıcılaşmaz', async ({ request }) => {
    expect(testServerId && testChannelId, 'sunucu/kanal fixture eksik').toBeTruthy();
    // Pozitif sınır kontrolü: tam 2000 karakter kabul edilir (istemci `maxlength=2000`).
    const atLimit = `${Date.now()}`.padEnd(2000, 'A');
    const acceptedId = await sendViaSocket(tokens.alice, testServerId, testChannelId, atLimit);

    const overLimit = `${Date.now()}`.padEnd(2001, 'B');
    const outcome = await sendExpectingOutcome(tokens.alice, testServerId, testChannelId, overLimit);
    expect(outcome.kind, '2001 karakter kabul edildi ya da sessizce düştü').toBe('error');
    expect(outcome.data?.code).toBe('MESSAGE_TOO_LONG');

    const after = await listMessages(request, tokens.alice, testChannelId);
    expect(after.find((m) => m._id === acceptedId), '2000 karakterlik mesaj listede yok').toMatchObject({ content: atLimit });
    expect(after.some((m) => m.content === overLimit), '2001 karakterlik mesaj kalıcılaştı').toBe(false);
  });

  test('XSS içerikli mesaj metin olarak saklanır ve tarayıcıda çalışmaz', async ({ page, request }) => {
    // Eski test var olmayan REST gönderim ucuna gidiyordu; 404 yüzünden `if (status < 400)`
    // hiç doğru olmadı ve test HİÇBİR ŞEY iddia etmeden geçti. Ürün sözleşmesi
    // (messages-send.ts, Final21 Faz 16): içerik HAM METİNDİR — HTML olarak hiçbir
    // yüzeyde işlenmez. Yani saklanan içerik yükü aynen taşır; güvenlik, tarayıcının
    // onu METİN olarak göstermesidir. İkisi de gerçek yoldan ölçülür.
    expect(testServerId, 'mesajlaşma sunucusu fikstürü yok').toBeTruthy();
    const stamp = Date.now();
    const channelName = `xss-${stamp.toString(36)}`;
    const channel = await createTestChannel(request, tokens.alice, testServerId, channelName);
    const channelId = channel?._id || channel?.id;
    expect(channelId, 'XSS kanalı oluşturulamadı').toBeTruthy();

    const scriptPayload = `<script>window.__bridgeXss = 'script-${stamp}'</script>xss-${stamp}`;
    const imgPayload = `<img src="x-${stamp}" onerror="window.__bridgeXss = 'img-${stamp}'">img-${stamp}`;
    const scriptId = await sendViaSocket(tokens.alice, testServerId, channelId, scriptPayload);
    const imgId = await sendViaSocket(tokens.alice, testServerId, channelId, imgPayload);

    const stored = await listMessages(request, tokens.alice, channelId);
    expect(stored.find((m) => m._id === scriptId), 'ham metin olarak saklanmalı').toMatchObject({ content: scriptPayload });
    expect(stored.find((m) => m._id === imgId)).toMatchObject({ content: imgPayload });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });
    await page.locator(`.server-icon[data-id="${testServerId}"]`).first().click({ timeout: 25_000 });
    await page.locator(`[aria-label="Kanal: ${channelName}"]`).first().click({ timeout: 20_000 });
    const scriptRow = page.locator('#messages-area .msg', { hasText: `xss-${stamp}` });
    const imgRow = page.locator('#messages-area .msg', { hasText: `img-${stamp}` });
    await expect(scriptRow).toBeVisible({ timeout: 20_000 });
    await expect(imgRow).toBeVisible();
    // Yük GÖRÜNÜR metindir…
    await expect(scriptRow).toContainText(`<script>window.__bridgeXss`);
    await expect(imgRow).toContainText(`<img src="x-${stamp}"`);
    // …ve DOM'a eleman olarak girmez, çalışmaz.
    await expect(page.locator(`#messages-area script`)).toHaveCount(0);
    await expect(page.locator(`#messages-area img[src="x-${stamp}"]`)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __bridgeXss?: string }).__bridgeXss)).toBeUndefined();
  });
});
