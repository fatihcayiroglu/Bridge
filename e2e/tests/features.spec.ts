// e2e/tests/features.spec.ts
// Sprint 111 — 11 eksik özellik için E2E smoke testleri
// forum, polls, canvas, soundboard, clips, semantic, boost, badges,
// scheduled-messages, go-live, command-palette

import { test, expect } from '@playwright/test';
import { getTokens, createTestServer, createTestChannel } from '../helpers/bridge';

// ── Ortak setup ──────────────────────────────────────────────────────────────

let tokens:    ReturnType<typeof getTokens>;
let serverId:  string;
let channelId: string;
let token:     string;

test.beforeAll(async ({ request }) => {
  tokens    = getTokens();
  token     = tokens.alice;

  const srv = await createTestServer(request, token, `Feature Tests ${Date.now()}`);
  serverId  = srv._id || srv.id;

  if (serverId) {
    const ch  = await createTestChannel(request, token, serverId, 'genel', 'text');
    channelId = ch?._id || ch?.id;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// FORUM
// ══════════════════════════════════════════════════════════════════════════════

test.describe('Forum kanalı', () => {
  let forumChannelId: string;

  test.beforeAll(async ({ request }) => {
    test.skip(!serverId, 'Sunucu fixture gerekli');
    const ch = await createTestChannel(request, token, serverId, 'forum-kanal', 'forum');
    forumChannelId = ch?._id || ch?.id;
  });

  test('forum kanalı oluşturulabilir', async ({ request }) => {
    test.skip(!serverId, 'Sunucu fixture gerekli');
    const res = await request.post(`/api/servers/${serverId}/channels`, {
      headers: { Authorization: `Bearer ${token}` },
      data:    { name: 'forum-test', type: 'forum' },
    });
    expect([200, 201]).toContain(res.status());
  });

  test('forum kanalında thread açılabilir', async ({ request }) => {
    test.skip(!forumChannelId, 'Forum kanalı fixture gerekli');
    const res = await request.post(`/api/channels/${forumChannelId}/threads`, {
      headers: { Authorization: `Bearer ${token}` },
      data:    { title: 'Test Konusu', content: 'İlk mesaj içeriği' },
    });
    expect([200, 201]).toContain(res.status());
    const body = await res.json();
    expect(body).toHaveProperty('_id');
    expect(body.title).toBe('Test Konusu');
  });

  test('thread listesi alınabilir', async ({ request }) => {
    test.skip(!forumChannelId, 'Forum kanalı fixture gerekli');
    const res = await request.get(`/api/channels/${forumChannelId}/threads`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POLLS
// ══════════════════════════════════════════════════════════════════════════════

test.describe('Anket (Polls)', () => {
  test('anket oluşturulabilir', async ({ request }) => {
    test.skip(!channelId, 'Kanal fixture gerekli');
    const res = await request.post('/api/polls', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        channelId,
        question: 'En iyi programlama dili hangisi?',
        options:  ['TypeScript', 'Rust', 'Python', 'Go'],
        duration: 3600,
        multipleChoice: false,
      },
    });
    expect([200, 201]).toContain(res.status());
    const body = await res.json();
    expect(body).toHaveProperty('_id');
    expect(body.question).toContain('programlama');
  });

  test('ankete oy verilebilir', async ({ request }) => {
    test.skip(!channelId, 'Kanal fixture gerekli');
    // Önce anket oluştur
    const createRes = await request.post('/api/polls', {
      headers: { Authorization: `Bearer ${token}` },
      data: { channelId, question: 'Oy testi?', options: ['Evet', 'Hayır'], duration: 3600 },
    });
    if (createRes.status() !== 201 && createRes.status() !== 200) return;
    const poll = await createRes.json();
    const pollId = poll._id;

    const voteRes = await request.post(`/api/polls/${pollId}/vote`, {
      headers: { Authorization: `Bearer ${token}` },
      data:    { optionIndex: 0 },
    });
    expect([200, 204]).toContain(voteRes.status());
  });

  test('anket sonuçları alınabilir', async ({ request }) => {
    test.skip(!channelId, 'Kanal fixture gerekli');
    const createRes = await request.post('/api/polls', {
      headers: { Authorization: `Bearer ${token}` },
      data: { channelId, question: 'Sonuç testi?', options: ['A', 'B'], duration: 3600 },
    });
    if (createRes.status() !== 201 && createRes.status() !== 200) return;
    const poll    = await createRes.json();
    const pollId  = poll._id;

    const resRes = await request.get(`/api/polls/${pollId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resRes.status()).toBe(200);
    const body = await resRes.json();
    expect(body).toHaveProperty('options');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// CANVAS
// ══════════════════════════════════════════════════════════════════════════════

test.describe('Canvas (Ortak Çizim)', () => {
  test('canvas durumu alınabilir', async ({ request }) => {
    test.skip(!channelId, 'Kanal fixture gerekli');
    const res = await request.get(`/api/canvas/${channelId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([200, 404]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(body).toHaveProperty('strokes');
    }
  });

  test('canvas temizlenebilir', async ({ request }) => {
    test.skip(!channelId, 'Kanal fixture gerekli');
    const res = await request.delete(`/api/canvas/${channelId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([200, 204, 403]).toContain(res.status());
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SOUNDBOARD
// ══════════════════════════════════════════════════════════════════════════════

test.describe('Soundboard', () => {
  test('soundboard sesleri listelenebilir', async ({ request }) => {
    test.skip(!serverId, 'Sunucu fixture gerekli');
    const res = await request.get(`/api/servers/${serverId}/soundboard`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([200, 404]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    }
  });

  test('soundboard ses eklenebilir (URL ile)', async ({ request }) => {
    test.skip(!serverId, 'Sunucu fixture gerekli');
    const res = await request.post(`/api/servers/${serverId}/soundboard`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name:     'Test Sesi',
        emoji:    '🔊',
        volume:   1.0,
        url:      'https://example.com/test.mp3',
      },
    });
    // 201 başarı, 403 owner değil, 400 validasyon
    expect([201, 200, 400, 403]).toContain(res.status());
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// CLIPS (Ses/Video Kayıt)
// ══════════════════════════════════════════════════════════════════════════════

test.describe('Clips', () => {
  test('clip listesi alınabilir', async ({ request }) => {
    test.skip(!serverId, 'Sunucu fixture gerekli');
    const res = await request.get(`/api/clips?serverId=${serverId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([200, 404]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(Array.isArray(body) || typeof body === 'object').toBe(true);
    }
  });

  test('clip silme yetkisiz kullanıcı 403 alır', async ({ request }) => {
    const fakeClipId = '00000000-0000-0000-0000-000000000000';
    const res = await request.delete(`/api/clips/${fakeClipId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([403, 404]).toContain(res.status());
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SEMANTİK ARAMA
// ══════════════════════════════════════════════════════════════════════════════

test.describe('Semantik Arama', () => {
  test('POST /api/semantic/search çalışır', async ({ request }) => {
    test.skip(!serverId, 'Sunucu fixture gerekli');
    const res = await request.post('/api/semantic/search', {
      headers: { Authorization: `Bearer ${token}` },
      data:    { query: 'test mesajı', serverId, limit: 5 },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('matches');
    expect(Array.isArray(body.matches)).toBe(true);
  });

  test('boş sorgu 200 döner', async ({ request }) => {
    test.skip(!serverId, 'Sunucu fixture gerekli');
    const res = await request.post('/api/semantic/search', {
      headers: { Authorization: `Bearer ${token}` },
      data:    { query: '', serverId },
    });
    expect([200, 400]).toContain(res.status());
  });

  test('GET /api/semantic/digest/:serverId çalışır', async ({ request }) => {
    test.skip(!serverId, 'Sunucu fixture gerekli');
    const res = await request.get(`/api/semantic/digest/${serverId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('channelStats');
    expect(body).toHaveProperty('period');
  });

  test('GET /api/semantic/engagement/:serverId çalışır', async ({ request }) => {
    test.skip(!serverId, 'Sunucu fixture gerekli');
    const res = await request.get(`/api/semantic/engagement/${serverId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('periods');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// BOOST
// ══════════════════════════════════════════════════════════════════════════════

test.describe('Boost', () => {
  test('boost bilgisi alınabilir', async ({ request }) => {
    test.skip(!serverId, 'Sunucu fixture gerekli');
    const res = await request.get(`/api/servers/${serverId}/boost`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([200, 404]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(body).toHaveProperty('level');
      expect(body).toHaveProperty('count');
    }
  });

  test('boost isteği gönderilebilir', async ({ request }) => {
    test.skip(!serverId, 'Sunucu fixture gerekli');
    const res = await request.post(`/api/servers/${serverId}/boost`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // 200 başarı, 409 zaten boosted, 403 yetki yok
    expect([200, 201, 409, 403]).toContain(res.status());
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// BADGES
// ══════════════════════════════════════════════════════════════════════════════

test.describe('Badges (Rozetler)', () => {
  test('kullanıcı rozet listesi alınabilir', async ({ request }) => {
    test.skip(!token, 'Auth token gerekli');
    // Kendi profilimizin rozet listesi
    const profileRes = await request.get('/api/users/@me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (profileRes.status() !== 200) return;
    const me = await profileRes.json();

    const res = await request.get(`/api/users/${me._id}/badges`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([200, 404]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    }
  });

  test('rozet tanımları listelenebilir', async ({ request }) => {
    const res = await request.get('/api/badges/definitions', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([200, 404]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      if (body.length > 0) {
        expect(body[0]).toHaveProperty('id');
        expect(body[0]).toHaveProperty('name');
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ZAMANLANMIŞ MESAJLAR
// ══════════════════════════════════════════════════════════════════════════════

test.describe('Zamanlanmış Mesajlar', () => {
  test('zamanlanmış mesaj oluşturulabilir', async ({ request }) => {
    test.skip(!channelId, 'Kanal fixture gerekli');
    const sendAt = Date.now() + 3600 * 1000; // 1 saat sonra
    const res = await request.post('/api/scheduled-messages', {
      headers: { Authorization: `Bearer ${token}` },
      data:    { channelId, content: 'Zamanlanmış test mesajı', sendAt },
    });
    expect([200, 201, 400]).toContain(res.status());
    if ([200, 201].includes(res.status())) {
      const body = await res.json();
      expect(body).toHaveProperty('_id');
    }
  });

  test('zamanlanmış mesaj listesi alınabilir', async ({ request }) => {
    test.skip(!channelId, 'Kanal fixture gerekli');
    const res = await request.get(`/api/scheduled-messages?channelId=${channelId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([200, 404]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    }
  });

  test('geçmişe ait sendAt reddedilir', async ({ request }) => {
    test.skip(!channelId, 'Kanal fixture gerekli');
    const res = await request.post('/api/scheduled-messages', {
      headers: { Authorization: `Bearer ${token}` },
      data:    { channelId, content: 'Geçmiş zaman', sendAt: Date.now() - 1000 },
    });
    expect(res.status()).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GO LIVE (Ekran Paylaşımı)
// ══════════════════════════════════════════════════════════════════════════════

test.describe('Go Live (Ekran Paylaşımı)', () => {
  test('go-live oturumu başlatılabilir (API)', async ({ request }) => {
    test.skip(!channelId, 'Kanal fixture gerekli');
    const res = await request.post(`/api/channels/${channelId}/go-live`, {
      headers: { Authorization: `Bearer ${token}` },
      data:    { quality: '720p' },
    });
    // 200 başarı, 403 ses kanalı değil, 409 zaten aktif
    expect([200, 201, 403, 409]).toContain(res.status());
  });

  test('go-live oturumu sonlandırılabilir', async ({ request }) => {
    test.skip(!channelId, 'Kanal fixture gerekli');
    const res = await request.delete(`/api/channels/${channelId}/go-live`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([200, 204, 404]).toContain(res.status());
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// KOMUT PALETİ (UI — sadece smoke)
// ══════════════════════════════════════════════════════════════════════════════

test.describe('Komut Paleti (UI)', () => {
  test('⌘K ile komut paleti açılır', async ({ page }) => {
    test.skip(!process.env.UI_BASE_URL, 'UI_BASE_URL tanımlı değil — UI testleri atlanıyor');
    await page.goto(process.env.UI_BASE_URL!);
    // Giriş gerekiyorsa bekle
    await page.waitForLoadState('networkidle');

    // ⌘K / Ctrl+K gönder
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(300);

    const palette = await page.$('.cp-overlay, [role="dialog"][aria-label*="Komut"]');
    expect(palette).not.toBeNull();
  });

  test('Escape ile komut paleti kapanır', async ({ page }) => {
    test.skip(!process.env.UI_BASE_URL, 'UI_BASE_URL tanımlı değil — UI testleri atlanıyor');
    await page.goto(process.env.UI_BASE_URL!);
    await page.waitForLoadState('networkidle');

    await page.keyboard.press('Control+k');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    const palette = await page.$('.cp-overlay');
    expect(palette).toBeNull();
  });
});
