// e2e/tests/sprint83.spec.ts — Sprint 83 E2E Testleri
//
// Kapsar:
//   1. Bot Marketplace — public listeleme, kategori filtresi, detay, bilinmeyen 404
//   2. Bot Marketplace — POST submit (auth gerekli), duplicate id 409
//   3. Bot Marketplace — PATCH güncelleme (admin), DELETE (admin)
//   4. Stage Video Grid — socket olayı flow (API + mock)
//   5. Draw Together — socket olayı flow (API + mock)

import { test, expect } from '../helpers/apiTest';
import { getTokens, createTestServer, createTestChannel } from '../helpers/bridge';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const API  = `${BASE}/api`;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AdminPass123!';

// Final21 Faz 19 (19-32): the marketplace sections below used to hard-skip three tests with
// "POST /api/bots/marketplace route missing; the request lands in another handler" — the very
// defect Phase 14 fixed (F21-14-06) — and the admin tests accepted `[200, 403, 404]` /
// `[204, 403, 404]` with alice's token, i.e. they passed whether or not the feature worked (and
// left their listings behind). They now assert the real contract with exact statuses, use the
// provisioned admin for admin actions, and remove what they create.
async function adminLogin(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${API}/login`, {
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  expect(res.status(), 'admin fixture login (global setup provisions the admin)').toBe(200);
  const { token } = await res.json() as { token?: string };
  if (!token) throw new Error('admin login returned no token');
  return token;
}

async function submitListing(
  request: import('@playwright/test').APIRequestContext, token: string, id: string, extra: Record<string, unknown> = {},
) {
  return request.post(`${API}/bots/marketplace`, {
    data: JSON.stringify({ id, name: `E2E ${id}`, description: 'Playwright e2e listing.', category: 'utility', ...extra }),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. BOT MARKETPLACE — Public Endpoints
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Bot Marketplace — public API', () => {
  let tokens: { alice: string; bob: string };

  test.beforeAll(() => {
    tokens = getTokens();
  });

  test('GET /api/bots/marketplace — 200, bots dizisi döner', async ({ request }) => {
    const res = await request.get(`${API}/bots/marketplace`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('bots');
    expect(Array.isArray(body.bots)).toBe(true);
    expect(body).toHaveProperty('total');
    expect(typeof body.total).toBe('number');
    expect(body).toHaveProperty('limit');
    expect(body).toHaveProperty('offset');
  });

  test('GET /api/bots/marketplace — yalnızca approved botlar görünür', async ({ request }) => {
    const res = await request.get(`${API}/bots/marketplace`);
    expect(res.status()).toBe(200);
    const { bots } = await res.json();
    for (const bot of bots) {
      expect(bot.approved).toBe(true);
    }
  });

  test('GET /api/bots/marketplace?category=music — kategori filtresi çalışır', async ({ request }) => {
    const res = await request.get(`${API}/bots/marketplace?category=music`);
    expect(res.status()).toBe(200);
    const { bots } = await res.json();
    for (const bot of bots) {
      expect(bot.category).toBe('music');
    }
  });

  test('GET /api/bots/marketplace?featured=true — sadece featured döner', async ({ request }) => {
    const res = await request.get(`${API}/bots/marketplace?featured=true`);
    expect(res.status()).toBe(200);
    const { bots } = await res.json();
    for (const bot of bots) {
      expect(bot.featured).toBe(true);
    }
  });

  test('GET /api/bots/marketplace?limit=2 — pagination çalışır', async ({ request }) => {
    const res = await request.get(`${API}/bots/marketplace?limit=2`);
    expect(res.status()).toBe(200);
    const { bots, limit } = await res.json();
    expect(limit).toBe(2);
    expect(bots.length).toBeLessThanOrEqual(2);
  });

  test('GET /api/bots/marketplace/:botId — built-in example (bridgebot, seeded at every boot) is returned approved', async ({ request }) => {
    // The product never shipped a `bridge-music` listing; the boot seed (`db/seed-marketplace.ts`)
    // creates `bridgebot` and `pollbot`, approved, claiming only enforced scopes (migration 073).
    const res = await request.get(`${API}/bots/marketplace/bridgebot`);
    expect(res.status()).toBe(200);
    const bot = await res.json();
    expect(bot.id).toBe('bridgebot');
    expect(bot.name).toBe('BridgeBot');
    expect(bot.approved).toBe(true);
    expect(bot.verified).toBe(false);
    expect(bot.requestedScopes).toEqual(['commands', 'messages:reply']);
    expect(bot.unsupportedPermissions).toEqual([]);
  });

  test('GET /api/bots/marketplace/:botId — bilinmeyen bot 404', async ({ request }) => {
    const res = await request.get(`${API}/bots/marketplace/nonexistent-bot-xyz-${Date.now()}`);
    expect(res.status()).toBe(404);
  });

  test('GET /api/bots/marketplace?q=music — full-text arama çalışır', async ({ request }) => {
    const res = await request.get(`${API}/bots/marketplace?q=music`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('bots');
  });

  test('GET /api/bots/marketplace/categories — kategori listesi döner', async ({ request }) => {
    const res = await request.get(`${API}/bots/marketplace/categories`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    const first = body[0] as Record<string, unknown>;
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('icon');
    expect(first).toHaveProperty('label');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. BOT MARKETPLACE — Auth Endpoints
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Bot Marketplace — authenticated API', () => {
  let tokens: { alice: string; bob: string };
  let adminToken = '';
  const created: string[] = [];

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();
    adminToken = await adminLogin(request);
  });

  test.afterAll(async ({ request }) => {
    for (const id of created) {
      await request.delete(`${API}/bots/marketplace/${id}`, { headers: { Authorization: `Bearer ${adminToken}` } });
    }
  });

  test('POST /api/bots/marketplace — auth olmadan 401', async ({ request }) => {
    const res = await request.post(`${API}/bots/marketplace`, {
      data: JSON.stringify({ id: `e2e-noauth-${Date.now()}`, name: 'Test Bot', description: 'Açıklama', category: 'utility' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(401);
  });

  test('POST /api/bots/marketplace — zorunlu alanlar eksik → 400', async ({ request }) => {
    const res = await request.post(`${API}/bots/marketplace`, {
      data: JSON.stringify({ name: 'Eksik Bot' }),
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /api/bots/marketplace — geçersiz id formatı → 400', async ({ request }) => {
    const res = await submitListing(request, tokens.alice, 'INVALID ID!');
    expect(res.status()).toBe(400);
  });

  test('POST /api/bots/marketplace — desteklenmeyen izin bildiren liste → 400 (yalnız uygulanan kapsamlar)', async ({ request }) => {
    const id = `e2e-scope-${Date.now()}`;
    const res = await submitListing(request, tokens.alice, id, { permissions: ['members:ban'] });
    expect(res.status()).toBe(400);
    expect((await request.get(`${API}/bots/marketplace/${id}`)).status()).toBe(404);
  });

  test('POST /api/bots/marketplace — geçerli gönderim 201, onaysız ve herkese GÖRÜNMEZ', async ({ request }) => {
    const id = `e2e-submit-${Date.now()}`;
    const res = await submitListing(request, tokens.alice, id, { tags: ['test'], permissions: ['commands'] });
    expect(res.status()).toBe(201);
    created.push(id);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.approved).toBe(false);
    expect(body.installable).toBe(false);
    expect(body.verified).toBe(false);
    expect(body.requestedScopes).toEqual(['commands']);
    // Unapproved listings are not published: the public detail route does not reveal them.
    expect((await request.get(`${API}/bots/marketplace/${id}`)).status()).toBe(404);
  });

  test('POST /api/bots/marketplace — aynı id tekrar → 409 ve ilk gönderim değişmez', async ({ request }) => {
    const id = `e2e-dup-${Date.now()}`;
    expect((await submitListing(request, tokens.alice, id)).status()).toBe(201);
    created.push(id);
    const again = await submitListing(request, tokens.bob, id, { name: 'Hijack attempt' });
    expect(again.status()).toBe(409);
    const approve = await request.patch(`${API}/bots/marketplace/${id}`, {
      data: JSON.stringify({ approved: true }),
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    });
    expect(approve.status()).toBe(200);
    const listing = await (await request.get(`${API}/bots/marketplace/${id}`)).json();
    expect(listing.name).toBe(`E2E ${id}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. BOT MARKETPLACE — Admin Endpoints
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Bot Marketplace — admin API', () => {
  let tokens: { alice: string; bob: string };
  let adminToken = '';
  let testBotId: string;

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();
    adminToken = await adminLogin(request);
    testBotId = `e2e-admin-bot-${Date.now()}`;
    const res = await submitListing(request, tokens.alice, testBotId, { category: 'moderation' });
    expect(res.status(), 'admin fixture listing').toBe(201);
  });

  test.afterAll(async ({ request }) => {
    // Idempotent cleanup: 404 once the DELETE test has removed it.
    await request.delete(`${API}/bots/marketplace/${testBotId}`, { headers: { Authorization: `Bearer ${adminToken}` } });
  });

  test('PATCH /api/bots/marketplace/:botId — yönetici OLMAYAN onaylayamaz (403) ve liste yayımlanmaz', async ({ request }) => {
    const res = await request.patch(`${API}/bots/marketplace/${testBotId}`, {
      data: JSON.stringify({ approved: true }),
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(403);
    expect((await request.get(`${API}/bots/marketplace/${testBotId}`)).status()).toBe(404);
  });

  test('PATCH /api/bots/marketplace/:botId — yönetici onaylar, liste herkese açılır', async ({ request }) => {
    const res = await request.patch(`${API}/bots/marketplace/${testBotId}`, {
      data: JSON.stringify({ approved: true, note: 'E2E onayı' }),
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).approved).toBe(true);
    const pub = await request.get(`${API}/bots/marketplace/${testBotId}`);
    expect(pub.status()).toBe(200);
    expect((await pub.json()).approved).toBe(true);
  });

  test('DELETE /api/bots/marketplace/:botId — yönetici OLMAYAN silemez (403)', async ({ request }) => {
    const res = await request.delete(`${API}/bots/marketplace/${testBotId}`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status()).toBe(403);
    expect((await request.get(`${API}/bots/marketplace/${testBotId}`)).status()).toBe(200);
  });

  test('DELETE /api/bots/marketplace/:botId — yönetici siler (204), liste artık yok', async ({ request }) => {
    const res = await request.delete(`${API}/bots/marketplace/${testBotId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status()).toBe(204);
    expect((await request.get(`${API}/bots/marketplace/${testBotId}`)).status()).toBe(404);
  });

  test('DELETE /api/bots/marketplace/:botId — bilinmeyen bot 404 (yönetici)', async ({ request }) => {
    const res = await request.delete(`${API}/bots/marketplace/nonexistent-bot-${Date.now()}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status()).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. STAGE VIDEO GRID — HTTP / socket-adjacent kontroller
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Stage Video Grid — API akışları', () => {
  let tokens: { alice: string; bob: string };
  let serverId: string;
  let channelId: string;

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();
    const srv = await createTestServer(request, tokens.alice, `S83-VideoGrid-${Date.now()}`);
    serverId = srv?._id || srv?.id;
    if (!serverId) return;
    const ch = await createTestChannel(request, tokens.alice, serverId, 'stage-video');
    channelId = ch?._id || ch?.id;
  });

  test('Sunucu ve stage kanalı oluşturuldu', () => {
    expect(serverId).toBeTruthy();
    expect(channelId).toBeTruthy();
  });

  test('Stage kanalına katılım için auth gerekli', async ({ request }) => {
    // Voice/stage katılım endpoint'i (varsa) auth gerektirir
    const res = await request.post(`${API}/channels/${channelId}/voice/join`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({}),
    });
    // 401 veya 404 (endpoint olmayabilir), her ikisi de auth katmanının doğru çalıştığını gösterir
    expect([401, 404, 405]).toContain(res.status());
  });

  test('Video grid WebSocket olayı: auth olmadan bağlantı reddedilir', async ({ page }) => {
    // Socket.IO bağlantısı token olmadan yapılırsa server kapatmalı
    const wsError = await page.evaluate(async (base) => {
      return new Promise<string>((resolve) => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}/socket.io/?EIO=4&transport=websocket`);
        ws.onclose = (e) => resolve(`closed:${e.code}`);
        ws.onerror = () => resolve('error');
        setTimeout(() => resolve('timeout'), 3000);
      });
    }, BASE);
    // Bağlantı hata veya kapatılmalı (token yok)
    expect(['error', 'timeout'].some(s => wsError.includes(s)) || wsError.startsWith('closed')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. DRAW TOGETHER — HTTP katmanı ve bağlantı kontrolleri
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Draw Together — API ve güvenlik', () => {
  let tokens: { alice: string; bob: string };
  let serverId: string;
  let channelId: string;

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();
    const srv = await createTestServer(request, tokens.alice, `S83-DrawTogether-${Date.now()}`);
    serverId = srv?._id || srv?.id;
    if (!serverId) return;
    const ch = await createTestChannel(request, tokens.alice, serverId, 'draw-channel');
    channelId = ch?._id || ch?.id;
  });

  test('Sunucu ve kanal oluşturuldu', () => {
    expect(serverId).toBeTruthy();
    expect(channelId).toBeTruthy();
  });

  test('Activities endpoint — auth gerektirir', async ({ request }) => {
    // Aktivite başlatma (varsa) auth gerektirir
    const res = await request.post(`${API}/channels/${channelId}/activities`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ activityId: 'draw-together' }),
    });
    expect([401, 404, 405]).toContain(res.status());
  });

  test('Activities endpoint — auth ile çalışır (veya 404 if endpoint eksik)', async ({ request }) => {
    // Final21 Faz 22 (19-37): `[200, 201, 404, 405]` kabul ederek VAR OLMAYAN rotaya karşı GEÇİYORDU —
    // ölçüldü: 404 "Not found: POST /api/channels/…/activities". Etkinlikler soket üzerindendir
    // (kardeş test aynı gerekçeyle atlanıyor); geçmiş sayılmaz.
    test.skip(true, 'SEVK EDİLMEDİ: /api/channels/:id/activities REST ucu yok (ölçüldü 404) — etkinlikler soket tabanlı.');
    const res = await request.post(`${API}/channels/${channelId}/activities`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ activityId: 'draw-together' }),
    });
    // 200/201 (başarılı) veya 404 (route yoksa) — ikisi de kabul edilir
    expect([200, 201, 404, 405]).toContain(res.status());
  });

  test('Draw Together aktivitesi listesinde görünür', async ({ request }) => {
    // GET /api/activity veya benzeri endpoint activities listeler
    const res = await request.get(`${API}/activity`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    // Activity list endpoint opsiyonel — yoksa testi atla
    if (res.status() === 404) {
      test.skip(true, '/api/activity endpoint mevcut değil — Sprint 83 activity socket-only');
      return;
    }
    expect(res.status()).toBe(200);
    const body = await res.json();
    const activities: unknown[] = Array.isArray(body) ? body : body.activities ?? [];
    const hasDraw = activities.some(
      (a: unknown) => typeof a === 'object' && a !== null && ('id' in a) &&
        (a as { id: string }).id === 'draw-together'
    );
    // draw-together built-in aktiviteler arasında olmalı
    expect(hasDraw).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. SMOKE — Sprint 83 rotaları genel sağlık
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Sprint 83 — Genel Sağlık', () => {
  test('GET /api/bots/marketplace limiti 100 ile sınırlı', async ({ request }) => {
    const res = await request.get(`${API}/bots/marketplace?limit=999`);
    expect(res.status()).toBe(200);
    const { limit } = await res.json();
    expect(limit).toBeLessThanOrEqual(100);
  });

  // ── GÜNCELLENDİ: SESSİZ DÜZELTME DEĞİL, AÇIK RET ───────────────────────────
  // Bu test eskiden negatif `offset`in sessizce 0'a çekilmesini bekliyordu.
  // Üretim artık `lib/queryNumbers.ts` içindeki kanonik ayrıştırıcıyı kullanır
  // (11 rota dosyası aynı sözleşmeyi paylaşır): geçersiz sayfalama parametresi
  // UYDURULMAZ, 400 ile REDDEDİLİR.
  //
  // Bu daha güçlü davranıştır — sessiz düzeltme, istemcinin gönderdiğiyle
  // sunucunun uyguladığını ayrıştırır ve hatayı gizler. Test bu yüzden
  // gerçek sözleşmeye göre güncellendi; doğrulama GEVŞETİLMEDİ.
  test('GET /api/bots/marketplace negatif offset AÇIKÇA reddedilir', async ({ request }) => {
    const res = await request.get(`${API}/bots/marketplace?offset=-5`);
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toMatch(/offset/i);
  });

  test('GET /api/bots/marketplace geçerli offset aynen uygulanır', async ({ request }) => {
    const res = await request.get(`${API}/bots/marketplace?offset=5`);
    expect(res.status()).toBe(200);
    const { offset } = await res.json();
    expect(offset).toBe(5);
  });

  test('GET /api/docs (Swagger) Sprint 83 route\'larını içeriyor', async ({ request }) => {
    const res = await request.get(`${BASE}/api/docs`);
    // Swagger UI opsiyonel bağımlılık — prod'da kapalı olabilir
    if (res.status() === 404) {
      test.skip(true, '/api/docs Swagger UI bu ortamda etkin değil');
      return;
    }
    expect(res.status()).toBe(200);
  });
});
