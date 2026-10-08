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
  serverId  = srv?._id || srv?.id;
  expect(serverId, 'Ortak özellik testleri: sunucu fixture oluşturulamadı').toBeTruthy();

  const ch = await createTestChannel(request, token, serverId, 'genel', 'text');
  channelId = ch?._id || ch?.id;
  expect(channelId, 'Ortak özellik testleri: kanal fixture oluşturulamadı').toBeTruthy();
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
    expect(channelId, 'Kanal fixture gerekli').toBeTruthy();
    const createRes = await request.post(`/api/channels/${channelId}/polls`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { question: 'Oy testi?', options: ['Evet', 'Hayır'], duration: 3600 },
    });
    expect(createRes.status()).toBe(200);
    const poll = await createRes.json();
    expect(poll.options).toHaveLength(2);
    const optionId = poll.options[0].id;
    expect(typeof optionId).toBe('string');
    const voteRes = await request.post(`/api/polls/${poll._id}/vote`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { optionIds: [optionId] },
    });
    expect(voteRes.status()).toBe(200);
    const voted = await voteRes.json();
    expect(voted.options.find((option: { id: string }) => option.id === optionId)).toMatchObject({
      votedByMe: true,
      voteCount: 1,
    });
  });

  test('anket sonuçları alınabilir', async ({ request }) => {
    expect(channelId, 'Kanal fixture gerekli').toBeTruthy();
    const createRes = await request.post(`/api/channels/${channelId}/polls`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { question: 'Sonuç testi?', options: ['A', 'B'], duration: 3600 },
    });
    expect(createRes.status()).toBe(200);
    const poll = await createRes.json();
    expect(poll._id).toBeTruthy();
    const resRes = await request.get(`/api/polls/${poll._id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resRes.status()).toBe(200);
    const body = await resRes.json();
    expect(body._id).toBe(poll._id);
    expect(body.options).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// CANVAS
// ══════════════════════════════════════════════════════════════════════════════

test.describe('Canvas (Ortak Çizim)', () => {
  type CanvasSnapshot = {
    channelId: string;
    strokes: Array<{ id: string; points: Array<{ x: number; y: number }> }>;
    clearedAt: number | null;
  };

  test('canvas durumu gerçek Socket.IO protokolüyle alınabilir', async () => {
    expect(channelId, 'kanal fixture kurulmalı').toBeTruthy();
    const socket = await openSocket(token);
    try {
      const ready = waitForEvent<CanvasSnapshot>(
        socket, 'canvas:state-sync', 15_000, value => value?.channelId === channelId,
      );
      socket.emit('canvas:join', { channelId });
      const state = await ready;
      expect(state.channelId).toBe(channelId);
      expect(Array.isArray(state.strokes)).toBe(true);
      expect(state.clearedAt === null || typeof state.clearedAt === 'number').toBe(true);
    } finally {
      closeSockets(socket);
    }
  });

  test('canvas temizleme değişikliği kalıcı state-sync ile doğrulanır', async () => {
    expect(channelId, 'kanal fixture kurulmalı').toBeTruthy();
    const owner = await openSocket(token);
    const observer = await openSocket(token);
    try {
      const ownerReady = waitForEvent<CanvasSnapshot>(
        owner, 'canvas:state-sync', 15_000, value => value?.channelId === channelId,
      );
      owner.emit('canvas:join', { channelId });
      await ownerReady;

      const observerReady = waitForEvent<CanvasSnapshot>(
        observer, 'canvas:state-sync', 15_000, value => value?.channelId === channelId,
      );
      observer.emit('canvas:join', { channelId });
      await observerReady;

      const strokeId = `canvas-e2e-${Date.now()}`;
      const drawn = waitForEvent<{ channelId: string; stroke: { id: string } }>(
        observer, 'canvas:draw', 15_000,
        value => value?.channelId === channelId && value?.stroke?.id === strokeId,
      );
      owner.emit('canvas:draw', {
        channelId,
        stroke: { id: strokeId, tool: 'pen', color: '#123456', width: 2, points: [{ x: 10, y: 20 }] },
      });
      expect((await drawn).stroke.id).toBe(strokeId);

      const before = waitForEvent<CanvasSnapshot>(
        owner, 'canvas:state-sync', 15_000, value => value?.channelId === channelId,
      );
      owner.emit('canvas:state-request', { channelId });
      expect((await before).strokes.some(stroke => stroke.id === strokeId)).toBe(true);

      const clear = waitForEvent<{ channelId: string; clearedAt: number }>(
        owner, 'canvas:clear', 15_000, value => value?.channelId === channelId,
      );
      owner.emit('canvas:clear', { channelId });
      expect((await clear).clearedAt).toEqual(expect.any(Number));

      const after = waitForEvent<CanvasSnapshot>(
        owner, 'canvas:state-sync', 15_000, value => value?.channelId === channelId,
      );
      owner.emit('canvas:state-request', { channelId });
      const cleared = await after;
      expect(cleared.strokes).toHaveLength(0);
      expect(cleared.clearedAt).toEqual(expect.any(Number));
    } finally {
      closeSockets(owner, observer);
    }
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

test.describe('Clips — actual Socket.IO metadata contract', () => {
  type ClipMeta = {
    id: string;
    channelId: string;
    userId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    durationMs: number;
  };

  function payload(filename: string) {
    return {
      channelId, filename, mimeType: 'video/webm',
      sizeBytes: 1024, durationMs: 2500,
    };
  }

  test('clip:save and clip:list return the owner\'s clip metadata', async () => {
    expect(channelId, 'clip channel fixture must exist').toBeTruthy();
    const socket = await openSocket(token);
    try {
      const filename = `e2e-clip-${Date.now()}.webm`;
      const savedPromise = waitForEvent<{ clipId: string; filename: string }>(
        socket, 'clip:saved', 15_000, data => data?.filename === filename,
      );
      socket.emit('clip:save', payload(filename));
      const saved = await savedPromise;
      expect(saved.clipId).toBeTruthy();

      const listPromise = waitForEvent<ClipMeta[]>(
        socket, 'clip:list_result', 10_000,
        list => Array.isArray(list) && list.some(c => c.id === saved.clipId),
      );
      socket.emit('clip:list', { channelId });
      const clips = await listPromise;
      expect(clips.find(c => c.id === saved.clipId)).toMatchObject({
        channelId, filename, mimeType: 'video/webm', sizeBytes: 1024, durationMs: 2500,
      });
    } finally {
      closeSockets(socket);
    }
  });

  test('a non-member cannot save a clip or see an owner\'s metadata', async () => {
    expect(channelId, 'clip channel fixture must exist').toBeTruthy();
    const alice = await openSocket(token);
    const outsider = await openSocket(tokens.bob);
    try {
      const filename = `protected-clip-${Date.now()}.webm`;
      const savedPromise = waitForEvent<{ clipId: string; filename: string }>(
        alice, 'clip:saved', 15_000, data => data?.filename === filename,
      );
      alice.emit('clip:save', payload(filename));
      const saved = await savedPromise;
      expect(saved.clipId).toBeTruthy();

      // Bob is not a member of the server, and clip:list must only expose
      // the authenticated caller's own metadata (regardless of channel).
      const outsiderList = waitForEvent<ClipMeta[]>(outsider, 'clip:list_result', 10_000);
      outsider.emit('clip:list', { channelId });
      expect((await outsiderList).some(c => c.id === saved.clipId)).toBe(false);

      // There is no clip:delete event in the shipped product. Verify the
      // security-relevant write boundary rather than asserting a fake HTTP
      // DELETE 403. The server must NOT acknowledge an unauthorized save.
      const forbiddenFilename = `forbidden-clip-${Date.now()}.webm`;
      let unauthorizedSaved = false;
      outsider.on('clip:saved', (event: { filename?: string }) => {
        if (event?.filename === forbiddenFilename) unauthorizedSaved = true;
      });
      outsider.emit('clip:save', payload(forbiddenFilename));
      await new Promise(resolve => setTimeout(resolve, 400));
      const after = waitForEvent<ClipMeta[]>(outsider, 'clip:list_result', 10_000);
      outsider.emit('clip:list', { channelId });
      expect((await after).some(c => c.filename === forbiddenFilename)).toBe(false);
      expect(unauthorizedSaved).toBe(false);
    } finally {
      closeSockets(alice, outsider);
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
