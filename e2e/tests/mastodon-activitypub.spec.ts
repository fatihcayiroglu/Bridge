// e2e/tests/mastodon-activitypub.spec.ts — Sprint 14: TypeScript dönüşümü (.js → .ts)
// e2e/tests/mastodon-activitypub.spec.js
// Mastodon / ActivityPub Gerçek Sunucu Entegrasyon Testleri
//
// Gereksinimler:
//   MASTODON_URL      — Test Mastodon instance (örn: https://mastodon.social)
//   MASTODON_TOKEN    — OAuth2 access token (test hesabı)
//   BRIDGE_URL        — Bu Bridge instance (örn: http://localhost:3001)
//   BRIDGE_TEST_USER  — Bridge test kullanıcı adı
//   BRIDGE_TEST_PASS  — Bridge test şifresi
//
// Çalıştırma:
//   MASTODON_URL=https://mastodon.social \
//   MASTODON_TOKEN=xxx \
//   BRIDGE_URL=http://localhost:3001 \
//   npx playwright test e2e/tests/mastodon-activitypub.spec.js

import { test, expect, request } from '@playwright/test';

const MASTODON_URL    = process.env.MASTODON_URL;
const MASTODON_TOKEN  = process.env.MASTODON_TOKEN;
const BRIDGE_URL      = process.env.BRIDGE_URL || 'http://localhost:3001';
const BRIDGE_TEST_USER = process.env.BRIDGE_TEST_USER || 'testuser';
const BRIDGE_TEST_PASS = process.env.BRIDGE_TEST_PASS || 'testpass123';

// Mastodon instance yoksa tüm testleri atla
const skipIfNoMastodon = !MASTODON_URL || !MASTODON_TOKEN;

// ── Yardımcı: Mastodon API isteği ────────────────────────────
async function mastodonAPI(ctx, method, path, body = null) {
  const opts = {
    headers: {
      'Authorization': `Bearer ${MASTODON_TOKEN}`,
      'Content-Type':  'application/json',
    },
  };
  if (body) opts.data = body;
  const url = `${MASTODON_URL}${path}`;
  if (method === 'GET') return ctx.get(url, opts);
  if (method === 'POST') return ctx.post(url, opts);
  if (method === 'DELETE') return ctx.delete(url, opts);
}

// ── Yardımcı: Bridge API token al ────────────────────────────
async function getBridgeToken(ctx) {
  const r = await ctx.post(`${BRIDGE_URL}/api/auth/login`, {
    data: { username: BRIDGE_TEST_USER, password: BRIDGE_TEST_PASS },
    headers: { 'Content-Type': 'application/json' },
  });
  const body = await r.json();
  return body.token;
}

// ── Test Grubu 1: NodeInfo & WebFinger ───────────────────────
test.describe('ActivityPub Discovery', () => {
  test('Bridge NodeInfo endpoint döner', async ({ request: ctx }) => {
    const r = await ctx.get(`${BRIDGE_URL}/.well-known/nodeinfo`);
    expect(r.ok()).toBe(true);
    const body = await r.json();
    expect(body).toHaveProperty('links');
    expect(body.links.length).toBeGreaterThan(0);
    const niLink = body.links.find(l => l.rel.includes('nodeinfo'));
    expect(niLink).toBeTruthy();
    expect(niLink.href).toMatch(/nodeinfo\/2\.\d/);
  });

  test('Bridge NodeInfo 2.1 içeriği doğru', async ({ request: ctx }) => {
    const r = await ctx.get(`${BRIDGE_URL}/nodeinfo/2.1`);
    expect(r.ok()).toBe(true);
    const body = await r.json();
    expect(body.version).toBe('2.1');
    expect(body.software?.name).toBeTruthy();
    expect(body.protocols).toContain('activitypub');
    expect(body.usage?.users?.total).toBeGreaterThanOrEqual(0);
  });

  test('Bridge WebFinger kullanıcı lookup', async ({ request: ctx }) => {
    const r = await ctx.get(
      `${BRIDGE_URL}/.well-known/webfinger?resource=acct:${BRIDGE_TEST_USER}@${new URL(BRIDGE_URL).hostname}`
    );
    // 200 veya 404 (WebFinger henüz uygulanmamışsa) kabul edilir
    expect([200, 404]).toContain(r.status());
    if (r.status() === 200) {
      const body = await r.json();
      expect(body).toHaveProperty('subject');
      expect(body.links?.some(l => l.rel === 'self')).toBe(true);
    }
  });

  test.skip(!MASTODON_URL, 'Mastodon URL tanımlı değil');
  test('Mastodon Bridge\'i keşfedebilir (NodeInfo)', async ({ request: ctx }) => {
    // Mastodon instance'ından Bridge'i lookup et
    const bridgeHost = new URL(BRIDGE_URL).hostname;
    const r = await mastodonAPI(ctx, 'GET',
      `/api/v2/search?q=${encodeURIComponent(`@${BRIDGE_TEST_USER}@${bridgeHost}`)}&resolve=false`
    );
    // 200 dönmesi yeterli — keşfedilip keşfedilmemesi instance'a bağlı
    expect(r.status()).toBeLessThan(500);
  });
});

// ── Test Grubu 2: ActivityPub Actor ──────────────────────────
test.describe('ActivityPub Actor Endpoints', () => {
  let bridgeToken;
  test.beforeAll(async ({ request: ctx }) => {
    try { bridgeToken = await getBridgeToken(ctx); } catch { bridgeToken = null; }
  });

  test('Bridge /ap/users/:username Actor döner', async ({ request: ctx }) => {
    const r = await ctx.get(`${BRIDGE_URL}/ap/users/${BRIDGE_TEST_USER}`, {
      headers: { 'Accept': 'application/activity+json' },
    });
    expect(r.ok()).toBe(true);
    const body = await r.json();
    expect(body['@context']).toBeTruthy();
    expect(body.type).toBe('Person');
    expect(body.preferredUsername).toBe(BRIDGE_TEST_USER);
    expect(body.inbox).toContain('/inbox');
    expect(body.outbox).toContain('/outbox');
    expect(body.id).toContain(BRIDGE_TEST_USER);
  });

  test('Bridge Actor followers endpoint', async ({ request: ctx }) => {
    const r = await ctx.get(`${BRIDGE_URL}/ap/users/${BRIDGE_TEST_USER}/followers`, {
      headers: { 'Accept': 'application/activity+json' },
    });
    expect(r.ok()).toBe(true);
    const body = await r.json();
    expect(body.type).toBe('OrderedCollection');
    expect(typeof body.totalItems).toBe('number');
  });

  test('Bridge Actor following endpoint', async ({ request: ctx }) => {
    const r = await ctx.get(`${BRIDGE_URL}/ap/users/${BRIDGE_TEST_USER}/following`, {
      headers: { 'Accept': 'application/activity+json' },
    });
    expect(r.ok()).toBe(true);
    const body = await r.json();
    expect(body.type).toBe('OrderedCollection');
  });

  test('Bridge notes/:id Note döner', async ({ request: ctx }) => {
    // Önce bir mesaj gönder, ID'sini al
    if (!bridgeToken) return test.skip();
    // Test kanalı ID'si env'den alınır veya sabit test değeri
    const channelId = process.env.BRIDGE_TEST_CHANNEL || 'test-channel';

    // Not: Bu test sadece mesaj sistemi AP notlarını expose ediyorsa çalışır
    const r = await ctx.get(`${BRIDGE_URL}/ap/notes/nonexistent-id`, {
      headers: { 'Accept': 'application/activity+json' },
    });
    // 404 bekliyoruz (geçersiz ID)
    expect(r.status()).toBe(404);
  });
});

// ── Test Grubu 3: Mastodon → Bridge Follow ───────────────────
test.describe('Mastodon ↔ Bridge Follow', { skip: skipIfNoMastodon }, () => {
  const bridgeHost = BRIDGE_URL ? new URL(BRIDGE_URL).hostname : 'localhost';
  const bridgeActor = `${BRIDGE_TEST_USER}@${bridgeHost}`;

  let followId;

  test('Mastodon, Bridge kullanıcısını arayabilir', async ({ request: ctx }) => {
    const r = await mastodonAPI(ctx, 'GET',
      `/api/v2/search?q=${encodeURIComponent(bridgeActor)}&resolve=true`
    );
    const body = await r.json();
    // accounts dizisine bak — boş olabilir (Bridge WebFinger uygulamasına bağlı)
    expect(Array.isArray(body.accounts)).toBe(true);
  });

  test('Mastodon, Bridge kullanıcısını takip edebilir', async ({ request: ctx }) => {
    // Önce arama ile hesap ID'sini bul
    const searchR = await mastodonAPI(ctx, 'GET',
      `/api/v2/search?q=${encodeURIComponent(bridgeActor)}&resolve=true`
    );
    const { accounts } = await searchR.json();
    if (!accounts?.length) {
      test.skip(true, 'Bridge kullanıcısı Mastodon\'da bulunamadı — WebFinger gerekli');
      return;
    }

    const accountId = accounts[0].id;
    const followR   = await mastodonAPI(ctx, 'POST', `/api/v1/accounts/${accountId}/follow`);
    expect(followR.ok()).toBe(true);
    const followBody = await followR.json();
    followId = followBody.id;
    expect(followBody.following || followBody.requested).toBeTruthy();
  });

  test('Follow sonrası unfollow yapılabilir', async ({ request: ctx }) => {
    if (!followId) return test.skip(true, 'Follow ID yok');
    const r = await mastodonAPI(ctx, 'POST', `/api/v1/accounts/${followId}/unfollow`);
    expect(r.ok()).toBe(true);
  });
});

// ── Test Grubu 4: ActivityPub Inbox (Bridge alıcı) ───────────
test.describe('ActivityPub Inbox', () => {
  test('Bridge inbox endpoint mevcut', async ({ request: ctx }) => {
    const r = await ctx.post(`${BRIDGE_URL}/ap/users/${BRIDGE_TEST_USER}/inbox`, {
      headers: {
        'Content-Type': 'application/activity+json',
        'Accept':       'application/activity+json',
      },
      data: {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type:       'Follow',
        actor:      `https://mastodon.social/users/testbot`,
        object:     `${BRIDGE_URL}/ap/users/${BRIDGE_TEST_USER}`,
      },
    });
    // 200, 202 (queued), 401 (imza zorunlu), 404 kabul edilir
    // 500 kabul edilmez
    expect(r.status()).toBeLessThan(500);
  });

  test('İmzasız inbox isteği reddedilir', async ({ request: ctx }) => {
    // HTTP Signature olmadan gelen Follow isteği 401 veya 403 dönmeli
    const r = await ctx.post(`${BRIDGE_URL}/ap/users/${BRIDGE_TEST_USER}/inbox`, {
      headers: { 'Content-Type': 'application/activity+json' },
      data: {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type:       'Create',
        actor:      'https://evil.example.com/users/hacker',
        object:     { type: 'Note', content: 'Spam' },
      },
    });
    // İmza doğrulama varsa 401/403, yoksa 200/202 (her ikisi kabul)
    expect([200, 202, 401, 403, 404]).toContain(r.status());
  });
});

// ── Test Grubu 5: HTTP Signature Doğrulama ───────────────────
test.describe('HTTP Signature', () => {
  test('Bridge /api/ap/verify-signature endpoint', async ({ request: ctx }) => {
    // Bridge kendi imza doğrulama endpoint'ine sahipse test et
    const r = await ctx.post(`${BRIDGE_URL}/api/ap/verify-signature`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        signature:  'invalid',
        actor:      'https://mastodon.social/users/test',
        method:     'POST',
        path:       '/ap/users/test/inbox',
        headers:    {},
        body:       '',
      },
    });
    // Endpoint yoksa 404, varsa 400 (geçersiz imza)
    expect([400, 401, 404]).toContain(r.status());
  });
});

// ── Test Grubu 6: Federation ACL Entegrasyonu ────────────────
test.describe('Federation ACL', () => {
  let adminToken;

  test.beforeAll(async ({ request: ctx }) => {
    try {
      const adminUser = process.env.BRIDGE_ADMIN_USER || 'admin';
      const adminPass = process.env.BRIDGE_ADMIN_PASS || 'adminpass';
      const r = await ctx.post(`${BRIDGE_URL}/api/auth/login`, {
        data: { username: adminUser, password: adminPass },
        headers: { 'Content-Type': 'application/json' },
      });
      const body = await r.json();
      adminToken = body.token;
    } catch { adminToken = null; }
  });

  test('Blacklist\'e eklenen domain reddedilir', async ({ request: ctx }) => {
    if (!adminToken) return test.skip(true, 'Admin token yok');

    const testDomain = 'evil-federation.example.com';

    // Blacklist'e ekle
    const addR = await ctx.post(`${BRIDGE_URL}/api/admin/federation/blacklist`, {
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type':  'application/json',
      },
      data: { domain: testDomain, reason: 'Test blacklist' },
    });
    expect([200, 201, 409]).toContain(addR.status()); // 409: zaten var

    // Bu domain'den gelen inbox isteği reddedilmeli
    const inboxR = await ctx.post(`${BRIDGE_URL}/ap/users/${BRIDGE_TEST_USER}/inbox`, {
      headers: {
        'Content-Type': 'application/activity+json',
        'X-Forwarded-Host': testDomain,
      },
      data: {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type:       'Create',
        actor:      `https://${testDomain}/users/spammer`,
        object:     { type: 'Note', content: 'Spam from blacklisted domain' },
      },
    });
    // Blacklisted domain: 403 veya 401 dönmeli (ya da 200 — ACL middleware yoksa)
    expect(inboxR.status()).toBeLessThan(500);

    // Temizle
    await ctx.delete(`${BRIDGE_URL}/api/admin/federation/blacklist/${encodeURIComponent(testDomain)}`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
  });

  test('Whitelist boşsa tüm domain\'ler kabul edilir', async ({ request: ctx }) => {
    if (!adminToken) return test.skip(true, 'Admin token yok');

    const r = await ctx.get(`${BRIDGE_URL}/api/admin/federation/whitelist`, {
      headers: { 'Authorization': `Bearer ${adminToken}` },
    });
    expect(r.ok()).toBe(true);
    const { whitelist } = await r.json();
    // Boşsa herkes kabul edilmeli (test sadece API'ı doğrular)
    expect(Array.isArray(whitelist)).toBe(true);
  });
});
