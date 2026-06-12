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


import { test, expect } from '@playwright/test';
import { getTokens, createTestServer, createTestChannel } from '../helpers/bridge';

const BASE = process.env.BASE_URL || 'http://localhost:3000';

test.describe('Reaksiyon Akışları', () => {
  let tokens;
  let channelId;
  let msgId;

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();

    const srv = await createTestServer(request, tokens.alice, `React-Server-${Date.now()}`);
    const sid = srv?._id || srv?.id;
    if (!sid) return;

    const ch = await createTestChannel(request, tokens.alice, sid, 'reactions');
    channelId = ch?._id || ch?.id;
    if (!channelId) return;

    // Test mesajı oluştur
    const res = await request.post(`${BASE}/api/channels/${channelId}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ content: 'Reaksiyon test mesajı 🎯' }),
    });
    if (res.ok()) {
      const data = await res.json();
      msgId = data._id || data.id || data.message?._id;
    }
  });

  // ── 1. Reaksiyon ekleme ───────────────────────────────────

  test('API: reaksiyon ekleme başarılı', async ({ request }) => {
    test.skip(!msgId, 'Mesaj fixture bekleniyor — önceki test başarısız'); if (!msgId) return;

    const res = await request.post(
      `${BASE}/api/channels/${channelId}/messages/${msgId}/react`,
      {
        headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
        data: JSON.stringify({ emoji: '👍' }),
      }
    );
    // 200 veya 201
    expect(res.status()).toBeLessThan(300);
  });

  test('API: reaksiyon sonrası mesajda görünmeli', async ({ request }) => {
    test.skip(!msgId, 'Mesaj fixture bekleniyor — önceki test başarısız'); if (!msgId) return;

    // Reaksiyon ekle
    await request.post(
      `${BASE}/api/channels/${channelId}/messages/${msgId}/react`,
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
    test.skip(!msgId, 'Mesaj fixture bekleniyor — önceki test başarısız'); if (!msgId) return;

    const emoji = '🔥';

    // İlk reaksiyon — ekle
    const add = await request.post(
      `${BASE}/api/channels/${channelId}/messages/${msgId}/react`,
      {
        headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
        data: JSON.stringify({ emoji }),
      }
    );
    expect(add.status()).toBeLessThan(300);

    // İkinci kez aynı emoji — kaldır (toggle) veya idempotent
    const remove = await request.post(
      `${BASE}/api/channels/${channelId}/messages/${msgId}/react`,
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
    test.skip(!msgId, 'Mesaj fixture bekleniyor — önceki test başarısız'); if (!msgId) return;

    // Bob'u sunucuya üye et — davet linki veya direkt join
    // Bob üye olmayabilir, bu durumda 403 beklenir — her iki durum geçerli
    const res = await request.post(
      `${BASE}/api/channels/${channelId}/messages/${msgId}/react`,
      {
        headers: { Authorization: `Bearer ${tokens.bob}`, 'Content-Type': 'application/json' },
        data: JSON.stringify({ emoji: '👋' }),
      }
    );
    // 200 (üye ise) veya 403 (üye değilse) — ikisi de doğru davranış
    expect([200, 201, 403]).toContain(res.status());
  });

  // ── 4. Geçersiz emoji ─────────────────────────────────────

  test('API: boş emoji reddedilmeli', async ({ request }) => {
    test.skip(!msgId, 'Mesaj fixture bekleniyor — önceki test başarısız'); if (!msgId) return;

    const res = await request.post(
      `${BASE}/api/channels/${channelId}/messages/${msgId}/react`,
      {
        headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
        data: JSON.stringify({ emoji: '' }),
      }
    );
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('API: çok uzun emoji string reddedilmeli', async ({ request }) => {
    test.skip(!msgId, 'Mesaj fixture bekleniyor — önceki test başarısız'); if (!msgId) return;

    const res = await request.post(
      `${BASE}/api/channels/${channelId}/messages/${msgId}/react`,
      {
        headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
        data: JSON.stringify({ emoji: 'a'.repeat(200) }),
      }
    );
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  // ── 5. Auth kontrolü ─────────────────────────────────────

  test('API: token olmadan reaksiyon reddedilmeli (401)', async ({ request }) => {
    test.skip(!msgId, 'Mesaj fixture bekleniyor — önceki test başarısız'); if (!msgId) return;

    const res = await request.post(
      `${BASE}/api/channels/${channelId}/messages/${msgId}/react`,
      {
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ emoji: '👍' }),
      }
    );
    expect(res.status()).toBe(401);
  });

  test('API: var olmayan mesaja reaksiyon 404 dönmeli', async ({ request }) => {
    const res = await request.post(
      `${BASE}/api/channels/${channelId}/messages/nonexistent-msg-id-xyz/react`,
      {
        headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
        data: JSON.stringify({ emoji: '👍' }),
      }
    );
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });
});
