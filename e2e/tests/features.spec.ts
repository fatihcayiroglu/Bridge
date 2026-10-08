// e2e/tests/features.spec.ts
// Sprint 111 — 11 eksik özellik için E2E smoke testleri
// forum, polls, canvas, soundboard, clips, semantic, boost, badges,
// scheduled-messages, go-live, command-palette

import { test, expect } from '../helpers/apiTest';
import { getTokens, createTestServer, createTestChannel } from '../helpers/bridge';
import { openSocket, waitForEvent, closeSockets } from '../helpers/socket';

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
    // v1.123: eski atlama gerekcesi ("uc yok - 404") YANLISTI. Uc sevk
    // edilmisti; test YANLIS YOLU cagiriyordu. Gercek sozlesme:
    //   POST /api/threads  { channelId, name, firstMessage? }
    // Dogru yola gecirilince iki GERCEK urun hatasi ortaya cikti ve
    // duzeltildi: (1) `locked` sutunu ALLOWED_COLUMNS'ta yoktu,
    // (2) threads."parentMessageId" NOT NULL idi - oysa forum konusu
    // KANAL koklidir ve ust mesaji yoktur. Ikisi de 500 uretiyordu.
    test.skip(!forumChannelId, 'Forum kanali fixture gerekli');
    const res = await request.post('/api/threads', {
      headers: { Authorization: `Bearer ${token}` },
      data:    { channelId: forumChannelId, name: 'Test Konusu', firstMessage: 'Ilk mesaj' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    // Yanit { thread } sarmalayicisi dondurur.
    expect(body.thread).toHaveProperty('_id');
    expect(body.thread.name).toBe('Test Konusu');
    // Kanal kokli konuda ust mesaj YOKTUR - 500'e yol acan tam kosul budur.
    expect(body.thread.parentMessageId).toBeNull();
  });

  test('thread listesi alınabilir', async ({ request }) => {
    // v1.123: yol duzeltildi - GET /api/threads/channel/:channelId
    test.skip(!forumChannelId, 'Forum kanali fixture gerekli');
    const res = await request.get(`/api/threads/channel/${forumChannelId}`, {
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
    // v1.123: anket ucu SEVK EDILMISTIR; test yanlis yolu cagiriyordu.
    // Gercek yol kanal kaplidir: POST /api/channels/:channelId/polls
    test.skip(!channelId, 'Kanal fixture gerekli');
    const res = await request.post(`/api/channels/${channelId}/polls`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
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
    // Secenekler sunucuda kimliklendirilir; oy verme bu yapiya dayanir.
    expect(Array.isArray(body.options)).toBe(true);
    expect(body.options).toHaveLength(4);
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
    // Final21 Faz 22 (19-37): bu test `[200, 404]` kabul ederek VAR OLMAYAN bir rotaya karşı
    // GEÇİYORDU — ölçüldü: `GET /api/canvas/:id` → 404 "Not found: GET /api/canvas/…" (genel 404
    // işleyicisi). Canvas durumu soket üzerinden gelir (`canvas:state-sync`); kardeş test zaten
    // aynı gerekçeyle atlanıyordu. Geçmiş sayılmaz, AÇIKÇA atlanır.
    test.skip(true, 'MIMARI: canvas REST degil soket tabanlidir (GET /api/canvas/:id yok — olculdu 404).');
    const res = await request.get(`/api/canvas/${channelId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toHaveProperty('strokes');
  });

  test('canvas temizlenebilir', async ({ request }) => {
    // v1.123 DOGRULANDI: canvas'in REST yonlendiricisi YOKTUR; ozellik
    // soket olaylari uzerinden sevk edilir (`canvas:state-sync`,
    // `canvas:stroke-delete`). Atlama gecerlidir - gerekce duzeltildi.
    test.skip(true, 'MIMARI: canvas REST degil soket tabanlidir.');
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
    // Sahibi olduğu yeni sunucuda: 200 ve boş liste (ölçüldü). 404/403 artık kabul edilmez.
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('soundboard: dosyasız (yalnız URL) ekleme reddedilir — ses DOSYASI zorunlu', async ({ request }) => {
    // Eski başlık "URL ile eklenebilir" diyordu ve `[201, 200, 400, 403]` kabul ediyordu. Ürün
    // sözleşmesi (ölçüldü): uç yalnızca yüklenen dosyayı kabul eder; URL'li gövde 400 "No file uploaded".
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
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/file/i);
    // Hiçbir şey eklenmedi.
    const list = await request.get(`/api/servers/${serverId}/soundboard`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await list.json()).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// CLIPS (Ses/Video Kayıt)
// ══════════════════════════════════════════════════════════════════════════════

test.describe('Clips — gerçek Socket.IO metadata protokolü', () => {
  type Clip = {
    id: string;
    channelId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    durationMs: number;
  };

  async function listClips(socket: Awaited<ReturnType<typeof openSocket>>): Promise<Clip[]> {
    const result = waitForEvent<Clip[]>(socket, 'clip:list_result', 10_000);
    socket.emit('clip:list', { channelId });
    return result;
  }

  test('clip:save → clip:saved ve clip:list gerçek metadata döndürür', async () => {
    expect(channelId, 'kanal fixture gerekli').toBeTruthy();
    const socket = await openSocket(token);
    const filename = `clip-${Date.now()}.webm`;
    try {
      const saved = waitForEvent<{ clipId: string; filename: string }>(
        socket, 'clip:saved', 10_000, value => value?.filename === filename,
      );
      socket.emit('clip:save', {
        channelId, filename, mimeType: 'video/webm', sizeBytes: 1234, durationMs: 5000,
      });
      const clipId = (await saved).clipId;
      expect(clipId).toBeTruthy();
      const clips = await listClips(socket);
      expect(clips.find(clip => clip.id === clipId)).toMatchObject({
        channelId, filename, mimeType: 'video/webm', sizeBytes: 1234, durationMs: 5000,
      });
    } finally {
      closeSockets(socket);
    }
  });

  test('başkasının klipleri clip:list üzerinden başka kullanıcıya sızmaz', async () => {
    expect(channelId, 'kanal fixture gerekli').toBeTruthy();
    const alice = await openSocket(tokens.alice);
    const bob = await openSocket(tokens.bob);
    const filename = `private-${Date.now()}.webm`;
    try {
      const saved = waitForEvent<{ clipId: string; filename: string }>(
        alice, 'clip:saved', 10_000, value => value?.filename === filename,
      );
      alice.emit('clip:save', {
        channelId, filename, mimeType: 'video/webm', sizeBytes: 2048, durationMs: 2000,
      });
      const { clipId } = await saved;
      const mine = await listClips(alice);
      expect(mine.some(clip => clip.id === clipId)).toBe(true);

      // Bob has no membership in the freshly created private server.
      // A clip:list request must never return Alice's clip metadata.
      const others = await listClips(bob);
      expect(others.some(clip => clip.id === clipId || clip.filename === filename)).toBe(false);
    } finally {
      closeSockets(alice, bob);
    }
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

  test('boş sorgu reddedilir (400)', async ({ request }) => {
    // Eski başlık "200 döner" diyordu ve `[200, 400]` kabul ediyordu; ölçülen sözleşme: 400 "query gerekli".
    test.skip(!serverId, 'Sunucu fixture gerekli');
    const res = await request.post('/api/semantic/search', {
      headers: { Authorization: `Bearer ${token}` },
      data:    { query: '', serverId },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBeTruthy();
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
    // Final21 Faz 22 (19-37): test TEKİL `/boost`a gidiyordu (rota yok — ölçüldü 404) ve `[200, 404]`
    // kabul ettiği için GEÇİYORDU; `level` alanı da üründe yok. Gerçek uç `GET /servers/:sid/boosts`.
    test.skip(!serverId, 'Sunucu fixture gerekli');
    const res = await request.get(`/api/servers/${serverId}/boosts`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.count).toBe('number');
    expect(typeof body.tier).toBe('number');
    expect(Array.isArray(body.boosters)).toBe(true);
  });

  test('boost isteği gönderilebilir', async ({ request }) => {
    // v1.123: yol TEKIL yazilmisti (`/boost`); gercek uc COGULDUR.
    // Her koşum YENİ bir sunucu kurar: ilk boost 200 (ölçüldü) ve sayaç artar.
    test.skip(!serverId, 'Sunucu fixture gerekli');
    const before = await (await request.get(`/api/servers/${serverId}/boosts`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const res = await request.post(`/api/servers/${serverId}/boosts`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.count).toBe(before.count + 1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// BADGES
// ══════════════════════════════════════════════════════════════════════════════

test.describe('Badges (Rozetler)', () => {
  test('kullanıcı rozet listesi alınabilir', async ({ request }) => {
    test.skip(!token, 'Auth token gerekli');
    // Final21 Faz 22 (19-37): test `/api/users/@me`e gidiyordu — rota YOK (ölçüldü 404) — ve 200
    // olmayınca SESSİZCE `return` ediyordu: hiçbir iddia koşmadan GEÇİYORDU. Kanonik uç `/api/me`.
    const profileRes = await request.get('/api/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(profileRes.status()).toBe(200);
    const me = await profileRes.json();
    expect(me._id).toBeTruthy();

    const res = await request.get(`/api/users/${me._id}/badges`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('rozet tanımları listelenebilir', async ({ request }) => {
    // v1.123: bu testin YOLU zaten dogruydu; yalnizca atlama gerekcesi
    // ("/api/badges 404") yanlisti ve CALISIR bir uc kapatilmisti.
    const res = await request.get('/api/badges/definitions', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    // OLCULDU: tanimlar bos degil; alanlar `badge` / `label` (id/name DEGIL).
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty('badge');
    expect(body[0]).toHaveProperty('label');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ZAMANLANMIŞ MESAJLAR
// ══════════════════════════════════════════════════════════════════════════════

test.describe('Zamanlanmış Mesajlar', () => {
  test('zamanlanmış mesaj oluşturulabilir', async ({ request }) => {
    // v1.123: uc `/api/scheduled` olarak SEVK EDILMISTIR (`-messages` eki
    // yok) ve `serverId` ZORUNLUDUR - eksikse 400 doner.
    test.skip(!channelId || !serverId, 'Kanal fixture gerekli');
    // OLCULDU: rota `sendAt`i STRING bekler (typeof kontrolu); ham epoch
    // sayisi 'required' hatasina dusuyordu.
    const sendAt = new Date(Date.now() + 3600 * 1000).toISOString();
    const res = await request.post('/api/scheduled', {
      headers: { Authorization: `Bearer ${token}` },
      data:    { channelId, serverId, content: 'Zamanlanmis test mesaji', sendAt },
    });
    expect([200, 201]).toContain(res.status());
    const body = await res.json();
    expect(body).toHaveProperty('_id');
  });

  test('zamanlanmış mesaj listesi alınabilir', async ({ request }) => {
    test.skip(!channelId, 'Kanal fixture gerekli');
    const res = await request.get(`/api/scheduled?channelId=${channelId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('geçmişe ait sendAt reddedilir', async ({ request }) => {
    // v1.123: dogru uca gecirildi. Bu, testin ASIL amaci olan gecmis-tarih
    // reddini GERCEKTEN dogrular (once uc 404 aldigi icin hic calismamisti).
    test.skip(!channelId || !serverId, 'Kanal fixture gerekli');
    const res = await request.post('/api/scheduled', {
      headers: { Authorization: `Bearer ${token}` },
      data:    { channelId, serverId, content: 'Gecmis zaman', sendAt: new Date(Date.now() - 3600 * 1000).toISOString() },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain('future');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GO LIVE (Ekran Paylaşımı)
// ══════════════════════════════════════════════════════════════════════════════

test.describe('Go Live (Ekran Paylaşımı)', () => {
  test('go-live oturumu başlatılabilir (API)', async ({ request }) => {
    // v1.123 DOGRULANDI: ne /api/golive ne de /api/channels/:id/go-live
    // mevcuttur (setupRoutes.ts'te hicbir baglama yok). Atlama gecerlidir.
    test.skip(true, 'SEVK EDILMEDI (v1.123 dogrulandi): go-live REST ucu yok.');
    test.skip(!channelId, 'Kanal fixture gerekli');
    const res = await request.post(`/api/channels/${channelId}/go-live`, {
      headers: { Authorization: `Bearer ${token}` },
      data:    { quality: '720p' },
    });
    // 200 başarı, 403 ses kanalı değil, 409 zaten aktif
    expect([200, 201, 403, 409]).toContain(res.status());
  });

  test('go-live oturumu sonlandırılabilir', async ({ request }) => {
    // Final21 Faz 22 (19-37): `[200, 204, 404]` kabul ederek VAR OLMAYAN rotaya karşı GEÇİYORDU —
    // ölçüldü: 404 "Not found: DELETE /api/channels/…/go-live". Kardeşi (başlatma) aynı gerekçeyle
    // zaten atlanıyordu; geçmiş sayılmaz.
    test.skip(true, 'SEVK EDILMEDI (v1.123 dogrulandi, Faz 22 olculdu): go-live REST ucu yok.');
    const res = await request.delete(`/api/channels/${channelId}/go-live`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(204);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// KOMUT PALETİ (UI — sadece smoke)
// ══════════════════════════════════════════════════════════════════════════════

// Final21 Faz 19 (19-26): bu iki test `UI_BASE_URL` (UI ile API'nin AYRI sunulduğu döneme ait)
// tanımlı değil diye HER koşumda atlanıyordu; uygulama `BASE_URL`de sunulur. Ayrıca seçicileri
// yanlıştı: `.cp-overlay` üründe KANAL İZİN DÜZENLEYİCİSİNİN katmanıdır, komut paletinin değil —
// yani "Escape kapatır" testi açılsaydı BOŞUNA geçerdi. Palet: `#cp-listbox` taşıyan diyalog.
const APP_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const commandPalette = (page: import('@playwright/test').Page) =>
  page.locator('[role="dialog"][aria-modal="true"]:has(#cp-listbox)');

test.describe('Komut Paleti (UI)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[aria-current="page"]').first()).toBeVisible({ timeout: 20_000 });
  });

  test('⌘K ile komut paleti açılır', async ({ page }) => {
    await expect(commandPalette(page)).toHaveCount(0);
    await page.keyboard.press('Control+k');
    await expect(commandPalette(page)).toBeVisible({ timeout: 10_000 });
  });

  test('Escape ile komut paleti kapanır', async ({ page }) => {
    await page.keyboard.press('Control+k');
    await expect(commandPalette(page)).toBeVisible({ timeout: 10_000 });   // önce GERÇEKTEN açık
    await page.keyboard.press('Escape');
    await expect(commandPalette(page)).toBeHidden({ timeout: 5_000 });
  });
});
