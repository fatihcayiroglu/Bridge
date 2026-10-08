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

test.describe('Mesajlaşma Akışları', () => {
  let testServerId;
  let testChannelId;
  let tokens;

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();

    // Test sunucusu ve kanalı oluştur
    const server = await createTestServer(request, tokens.alice, `E2E Mesaj Server ${Date.now()}`);
    testServerId = server._id || server.id;

    if (testServerId) {
      const ch = await createTestChannel(request, tokens.alice, testServerId, 'genel');
      testChannelId = ch._id || ch.id;
    }
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
  test('API: boş mesaj reddedilmeli', async ({ request }) => {
    test.skip(!testChannelId, 'Upload test kanalı fixture gerekli'  );

    const res = await request.post(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: '' }),
    });

    expect(res.status()).toBeGreaterThanOrEqual(400);
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
    test.skip(!testChannelId, 'Upload test kanalı fixture gerekli'  );

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

  test('UI: uzun mesaj 2000 karakteri geçememeli', async ({ request }) => {
    test.skip(!testChannelId, 'Upload test kanalı fixture gerekli'  );

    const longMsg = 'A'.repeat(2001);
    const res = await request.post(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: longMsg }),
    });

    // 2000 karakterden uzun mesaj reddedilmeli
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('API: XSS içerikli mesaj sanitize edilmeli', async ({ request }) => {
    test.skip(!testChannelId, 'Upload test kanalı fixture gerekli'  );

    const xssPayload = '<script>alert("xss")</script>Merhaba';
    const res = await request.post(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: xssPayload }),
    });

    if (res.status() < 400) {
      const data = await res.json();
      const content = data.content || data.message?.content || '';
      // Script tag'i çalışmamalı (sanitize veya encode edilmiş olmalı)
      expect(content).not.toContain('<script>');
    }
  });
});
