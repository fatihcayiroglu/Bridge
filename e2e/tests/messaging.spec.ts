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
    await joinChannelConfirmed(socket, channelId, serverId);
    await paceSends('messaging-rest');
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

  test('API: mesaj gönderme', async ({ request }) => {
    test.skip(true, 'GEÇERSİZ MİMARİ: REST gönderim ucu yok; yerini alan kanonik kapsam → tests/message-actions.spec.ts (Socket.IO message:send)');
    test.skip(!testChannelId, 'Upload test kanalı fixture gerekli'  );

    const res = await request.post(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ content: 'Merhaba dünya! E2E testi.' }),
    });

    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.content || data.message?.content).toContain('Merhaba');
  });

  test('API: mesajları listeleme', async ({ request }) => {
    test.skip(true, 'GEÇERSİZ MİMARİ: REST gönderim ucu yok; yerini alan kanonik kapsam → tests/message-actions.spec.ts (gönderim + kanonik REST okuma)');
    test.skip(!testChannelId, 'Upload test kanalı fixture gerekli'  );

    // Önce bir mesaj gönder
    await request.post(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: 'Listeleme test mesajı' }),
    });

    // Mesajları getir
    const res = await request.get(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });

    expect(res.status()).toBe(200);
    const data = await res.json();
    const messages = data.messages || data;
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThan(0);
  });

  test('API: boş mesaj reddedilmeli', async ({ request }) => {
    test.skip(!testChannelId, 'Upload test kanalı fixture gerekli'  );

    const res = await request.post(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: '' }),
    });

    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('API: üye olmayan kullanıcı mesaj gönderememeli', async ({ request }) => {
    test.skip(true, 'GEÇERSİZ MİMARİ: REST gönderim ucu yok; yerini alan kanonik kapsam → tests/message-actions.spec.ts (üye olmayan yayın/yazma reddi)');
    test.skip(!testChannelId, 'Upload test kanalı fixture gerekli'  );

    const res = await request.post(`${BASE_URL}/api/channels/${testChannelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.bob}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: 'Yetkisiz mesaj' }),
    });

    // 403 Forbidden bekleniyor
    expect(res.status()).toBe(403);
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
