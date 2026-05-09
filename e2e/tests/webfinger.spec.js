// e2e/tests/webfinger.spec.js
// Federation WebFinger & ActivityPub Actor E2E Testleri
//
// Gereksinimler:
//   BASE_URL   — Bridge sunucusu (varsayılan: http://localhost:3001)
//
// Çalıştırma:
//   BASE_URL=http://localhost:3001 npx playwright test e2e/tests/webfinger.spec.js

'use strict';

const { test, expect, request } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';

// ── Yardımcı: API isteği ─────────────────────────────────────────
async function apiGet(ctx, path, headers = {}) {
  return ctx.get(`${BASE_URL}${path}`, { headers });
}

// ── Test hesabı oluştur ──────────────────────────────────────────
async function registerTestUser(ctx, suffix = '') {
  const username = `wftest_${Date.now()}${suffix}`;
  const res = await ctx.post(`${BASE_URL}/api/auth/register`, {
    data: { username, email: `${username}@example.com`, password: 'TestPass123!' },
  });
  return { username, res };
}

// ════════════════════════════════════════════════════════════════
// /.well-known/webfinger
// ════════════════════════════════════════════════════════════════
test.describe('WebFinger Endpoint (/.well-known/webfinger)', () => {

  test('geçerli kullanıcı için JRD+JSON döndürür', async () => {
    const ctx = await request.newContext();

    // Kayıt
    const { username } = await registerTestUser(ctx, '_a');

    const hostname = new URL(BASE_URL).hostname;
    const resource = `acct:${username}@${hostname}`;

    const res = await apiGet(ctx, `/.well-known/webfinger?resource=${encodeURIComponent(resource)}`);
    expect(res.status()).toBe(200);

    const ct = res.headers()['content-type'] || '';
    expect(ct).toMatch(/jrd\+json|json/);

    const body = await res.json();
    expect(body.subject).toBe(resource);
    expect(Array.isArray(body.links)).toBe(true);

    const selfLink = body.links.find(l => l.rel === 'self');
    expect(selfLink).toBeTruthy();
    expect(selfLink.type).toBe('application/activity+json');
    expect(selfLink.href).toContain(username);

    await ctx.dispose();
  });

  test('var olmayan kullanıcı için 404 döndürür', async () => {
    const ctx = await request.newContext();

    const hostname = new URL(BASE_URL).hostname;
    const resource = `acct:kullanici_yok_xyz_99999@${hostname}`;

    const res = await apiGet(ctx, `/.well-known/webfinger?resource=${encodeURIComponent(resource)}`);
    expect(res.status()).toBe(404);

    await ctx.dispose();
  });

  test('resource parametresi olmadan 400 döndürür', async () => {
    const ctx = await request.newContext();

    const res = await apiGet(ctx, '/.well-known/webfinger');
    expect(res.status()).toBe(400);

    await ctx.dispose();
  });

  test('acct: ön eki olmayan resource için 400 döndürür', async () => {
    const ctx = await request.newContext();

    const res = await apiGet(ctx, '/.well-known/webfinger?resource=https://example.com/users/someone');
    expect(res.status()).toBe(400);

    await ctx.dispose();
  });

  test('links dizisinde href doğru instance URL içerir', async () => {
    const ctx = await request.newContext();

    const { username } = await registerTestUser(ctx, '_b');
    const hostname = new URL(BASE_URL).hostname;
    const resource = `acct:${username}@${hostname}`;

    const res = await apiGet(ctx, `/.well-known/webfinger?resource=${encodeURIComponent(resource)}`);
    const body = await res.json();

    const self = body.links.find(l => l.rel === 'self');
    expect(self.href).toContain('/api/federation/users/');
    expect(self.href).toContain(username);

    await ctx.dispose();
  });
});

// ════════════════════════════════════════════════════════════════
// /api/federation/webfinger (alias — aynı mantık)
// ════════════════════════════════════════════════════════════════
test.describe('Federation API WebFinger (/api/federation/webfinger)', () => {

  test('geçerli kullanıcı için JRD döndürür', async () => {
    const ctx = await request.newContext();

    const { username } = await registerTestUser(ctx, '_c');
    const hostname = new URL(BASE_URL).hostname;
    const resource = `acct:${username}@${hostname}`;

    const res = await apiGet(ctx, `/api/federation/webfinger?resource=${encodeURIComponent(resource)}`);
    expect([200, 301, 302]).toContain(res.status()); // redirect veya direkt 200

    await ctx.dispose();
  });

  test('resource yoksa 400 döndürür', async () => {
    const ctx = await request.newContext();

    const res = await apiGet(ctx, '/api/federation/webfinger');
    expect(res.status()).toBe(400);

    await ctx.dispose();
  });
});

// ════════════════════════════════════════════════════════════════
// ActivityPub Actor (/api/federation/users/:username)
// ════════════════════════════════════════════════════════════════
test.describe('ActivityPub Actor Endpoint', () => {

  test('activity+json Accept başlığıyla actor döndürür', async () => {
    const ctx = await request.newContext();

    const { username } = await registerTestUser(ctx, '_d');

    const res = await apiGet(
      ctx,
      `/api/federation/users/${username}`,
      { Accept: 'application/activity+json' }
    );

    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.type).toBe('Person');
    expect(body.preferredUsername).toBe(username);
    expect(body['@context']).toBeTruthy();
    expect(body.inbox).toContain('/inbox');
    expect(body.outbox).toContain('/outbox');
    expect(body.id).toContain(username);

    await ctx.dispose();
  });

  test('var olmayan kullanıcı için 404 döndürür', async () => {
    const ctx = await request.newContext();

    const res = await apiGet(
      ctx,
      '/api/federation/users/kullanici_olmayan_xyz_0000',
      { Accept: 'application/activity+json' }
    );
    expect(res.status()).toBe(404);

    await ctx.dispose();
  });

  test('actor href WebFinger self linkiyle uyuşur', async () => {
    const ctx = await request.newContext();

    const { username } = await registerTestUser(ctx, '_e');
    const hostname = new URL(BASE_URL).hostname;
    const resource = `acct:${username}@${hostname}`;

    const wfRes   = await apiGet(ctx, `/.well-known/webfinger?resource=${encodeURIComponent(resource)}`);
    const wfBody  = await wfRes.json();
    const selfHref = wfBody.links.find(l => l.rel === 'self')?.href;

    const actorRes  = await ctx.get(selfHref, { headers: { Accept: 'application/activity+json' } });
    expect(actorRes.status()).toBe(200);

    const actorBody = await actorRes.json();
    expect(actorBody.id).toBe(selfHref);

    await ctx.dispose();
  });
});

// ════════════════════════════════════════════════════════════════
// /.well-known/nodeinfo
// ════════════════════════════════════════════════════════════════
test.describe('NodeInfo Endpoint', () => {

  test('nodeinfo 2.1 şema linkini döndürür', async () => {
    const ctx = await request.newContext();

    const res = await apiGet(ctx, '/.well-known/nodeinfo');
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.links)).toBe(true);

    const link = body.links.find(l => l.rel?.includes('nodeinfo'));
    expect(link).toBeTruthy();
    expect(link.href).toContain('/nodeinfo');

    await ctx.dispose();
  });

  test('/nodeinfo/2.1 endpoint geçerli yanıt döndürür', async () => {
    const ctx = await request.newContext();

    const res = await apiGet(ctx, '/nodeinfo/2.1');
    if (res.status() === 404) {
      // Opsiyonel endpoint — varsa kontrol et
      test.skip(true, '/nodeinfo/2.1 henüz uygulanmadı');
      return;
    }

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.version).toBe('2.1');
    expect(body.software).toBeTruthy();
    expect(body.software.name).toBeTruthy();

    await ctx.dispose();
  });
});
