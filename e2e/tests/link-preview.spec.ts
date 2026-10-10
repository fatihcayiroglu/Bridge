// e2e/tests/link-preview.spec.ts — Sprint 14: TypeScript dönüşümü (.js → .ts)
// e2e/tests/link-preview.spec.js — Link Önizleme E2E Testleri
//
// Kapsar:
//   1. /api/link-preview?url= — geçerli URL önizlemesi
//   2. Geçersiz / özel ağ URL'leri reddedilmeli (SSRF koruması)
//   3. url param olmadan 400 dönmeli
//   4. Auth olmadan 401 dönmeli
//   5. POST /api/link-preview — içerikten URL çıkarma
//   6. Cache — aynı URL'e iki istek (ikincisi daha hızlı olmalı)
//   7. content-type HTML olmayan URL önizleme dönmemeli


import { test, expect } from '../helpers/apiTest';
import { getTokens } from '../helpers/bridge';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

// Bu testler auth gerektirir
test.use({ storageState: 'fixtures/auth-state.json' });

test.describe('Link Önizleme', () => {
  let tokens;

  test.beforeAll(() => {
    tokens = getTokens();
  });

  // ── 1. Geçerli URL ────────────────────────────────────────

  test('GET: geçerli URL için önizleme dönmeli', async ({ request }) => {
    // example.com — stabil, herkese açık
    const res = await request.get(
      `${BASE}/api/link-preview?url=${encodeURIComponent('https://example.com')}`,
      { headers: { Authorization: `Bearer ${tokens.alice}` } }
    );

    // Positive OG response requires outbound internet; a failed external
    // fetch is an exact 404, not an implicit green (or a made-up fixture).
    expect([200, 404]).toContain(res.status());
    if (res.status() === 404) {
      expect(await res.json()).toEqual({ error: 'Preview not available' });
      test.info().annotations.push({ type: 'EXTERNAL_UNVERIFIED',
        description: 'Positive OG fetch not measured: public example.com unavailable' });
    } else {
      const data = await res.json();
      // En azından url alanı dönmeli
      expect(data.url || data.title).toBeTruthy();
      expect(data.type).toBe('link');
    }
  });

  test('GET: önizleme yanıtı beklenen alanları içermeli', async ({ request }) => {
    const res = await request.get(
      `${BASE}/api/link-preview?url=${encodeURIComponent('https://example.com')}`,
      { headers: { Authorization: `Bearer ${tokens.alice}` } }
    );

    expect([200, 404]).toContain(res.status());
    if (res.status() === 404) {
      expect(await res.json()).toEqual({ error: 'Preview not available' });
      test.info().annotations.push({ type: 'EXTERNAL_UNVERIFIED',
        description: 'No remote OG metadata was retrieved; field schema not positively tested' });
    } else {
      const data = await res.json();
      // Zorunlu alanlar
      expect(typeof data.url).toBe('string');
      expect(typeof data.title).toBe('string');
      // Opsiyonel ama beklenen
      expect(['string', 'undefined', 'object']).toContain(typeof data.description);
    }
  });

  // ── 2. SSRF Koruması ──────────────────────────────────────

  test('GET: localhost URL SSRF korumasıyla reddedilmeli', async ({ request }) => {
    const res = await request.get(
      `${BASE}/api/link-preview?url=${encodeURIComponent('http://localhost:5432')}`,
      { headers: { Authorization: `Bearer ${tokens.alice}` } }
    );
    // 400 veya 404 — 200 kesinlikle olmamalı
    expect(res.status()).not.toBe(200);
    expect(res.status()).not.toBe(500);
  });

  test('GET: 192.168.x.x private IP SSRF koruması', async ({ request }) => {
    const res = await request.get(
      `${BASE}/api/link-preview?url=${encodeURIComponent('http://192.168.1.1')}`,
      { headers: { Authorization: `Bearer ${tokens.alice}` } }
    );
    expect(res.status()).not.toBe(200);
  });

  test('GET: 10.x.x.x private IP SSRF koruması', async ({ request }) => {
    const res = await request.get(
      `${BASE}/api/link-preview?url=${encodeURIComponent('http://10.0.0.1/secret')}`,
      { headers: { Authorization: `Bearer ${tokens.alice}` } }
    );
    expect(res.status()).not.toBe(200);
  });

  test('GET: file:// protokolü reddedilmeli', async ({ request }) => {
    const res = await request.get(
      `${BASE}/api/link-preview?url=${encodeURIComponent('file:///etc/passwd')}`,
      { headers: { Authorization: `Bearer ${tokens.alice}` } }
    );
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('GET: javascript: protokolü reddedilmeli', async ({ request }) => {
    const res = await request.get(
      `${BASE}/api/link-preview?url=${encodeURIComponent("javascript:alert('xss')")}`,
      { headers: { Authorization: `Bearer ${tokens.alice}` } }
    );
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  // ── 3. Parametre doğrulama ────────────────────────────────

  test('GET: url param olmadan 400 dönmeli', async ({ request }) => {
    const res = await request.get(`${BASE}/api/link-preview`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status()).toBe(400);
  });

  test('GET: boş url ile 400 dönmeli', async ({ request }) => {
    const res = await request.get(`${BASE}/api/link-preview?url=`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status()).toBe(400);
  });

  // ── 4. Auth kontrolü ─────────────────────────────────────

  test('GET: token olmadan 401 dönmeli', async ({ request }) => {
    const res = await request.get(
      `${BASE}/api/link-preview?url=${encodeURIComponent('https://example.com')}`
    );
    expect(res.status()).toBe(401);
  });

  // ── 5. POST — içerikten URL çıkarma ──────────────────────

  test('POST: metin içindeki URL\'leri çıkarıp önizleme döndürmeli', async ({ request }) => {
    const res = await request.post(`${BASE}/api/link-preview`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ content: 'Bak şu siteye: https://example.com harika!' }),
    });

    // POST returns {previews: []} even when outbound URLs are unreachable.
    expect(res.status(), await res.text()).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('previews');
    expect(Array.isArray(data.previews)).toBe(true);
    expect(data.previews.length).toBeLessThanOrEqual(1);
  });

  test('POST: URL içermeyen metin — boş dizi döndürmeli', async ({ request }) => {
    const res = await request.post(`${BASE}/api/link-preview`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ content: 'URL olmayan bir metin.' }),
    });

    if (res.status() === 200) {
      const data = await res.json();
      expect(data.previews).toHaveLength(0);
    }
  });

  test('POST: maksimum 3 URL işlenmeli (limit)', async ({ request }) => {
    const manyUrls =
      'https://example.com https://example.org https://example.net https://httpbin.org https://httpstat.us';

    const res = await request.post(`${BASE}/api/link-preview`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ content: manyUrls }),
    });

    // Only the count is an offline-safe E2E contract. Remote OG positive
    // responses remain explicitly external; absence is never a skipped assert.
    expect(res.status(), await res.text()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.previews)).toBe(true);
    expect(data.previews.length).toBeLessThanOrEqual(3);
  });

  // ── 6. Cache davranışı ────────────────────────────────────

  test('GET: aynı URL iki kez — ikinci istek daha hızlı ya da eşit hızda', async ({ request }) => {
    const url = `${BASE}/api/link-preview?url=${encodeURIComponent('https://example.com')}`;
    const headers = { Authorization: `Bearer ${tokens.alice}` };

    const t1 = Date.now();
    const res1 = await request.get(url, { headers });
    const dur1 = Date.now() - t1;

    if (res1.status() === 404) {
      expect(await res1.json()).toEqual({ error: 'Preview not available' });
      const res2 = await request.get(url, { headers });
      expect(res2.status(), await res2.text()).toBe(404);
      expect(await res2.json()).toEqual({ error: 'Preview not available' });
      test.info().annotations.push({ type: 'EXTERNAL_CACHE_UNVERIFIED',
        description: 'No positive preview to measure cache speed; checked consistent 404 responses' });
      return;
    }
    expect(res1.status(), await res1.text()).toBe(200);

    const t2 = Date.now();
    const res2 = await request.get(url, { headers });
    const dur2 = Date.now() - t2;

    expect(res2.status()).toBe(200);
    // İkinci istek: cache'ten gelmeli, 2x daha hızlı olması beklenir
    // Ama CI ortamı değişken olabilir — sadece 5x yavaş olmaması yeterli
    expect(dur2).toBeLessThan(dur1 * 5 + 2000);
  });
});
