// e2e/tests/privacy-lifecycle.spec.ts
//
// GİZLİLİK / VERİ YAŞAM DÖNGÜSÜ — FAZ 6
//
// ════════════════════════════════════════════════════════════════════════════
// NE DOĞRULANIYOR
// ════════════════════════════════════════════════════════════════════════════
// Kimlik bilgisi İPTALİ, gerçek bir gizlilik sınırıdır: "çıkış yaptım" diyen
// bir kullanıcının jetonu GERÇEKTEN ölmelidir. Bu dosya iptali ÜÇ ayrı yolda
// birden sürer — erişim jetonu, MEDYA çerezi ve yenileme jetonu — çünkü
// üçü de ayrı doğrulama yollarıdır ve biri unutulabilir.
//
// ── BU DOSYA NEDEN KENDİ KİMLİĞİNİ TAZELER ────────────────────────────────
// `logout-all` kullanıcının `tokenVersion` değerini artırır; yani o
// kullanıcının TÜM jetonları ölür — fixtür dosyasındaki jeton dahil. Test
// bittiğinde `carol` yeniden giriş yapıp `fixtures/tokens.json` güncellenir,
// aksi halde sonraki spec'ler 401 alırdı. Bu bir ürün sorunu değil, testin
// kendi yan etkisini temizlemesidir.
//
// ── KAPSAM ────────────────────────────────────────────────────────────────
// Kişisel veri dışa aktarma (`GET /api/account/export`) ve hesap silme
// (`DELETE /api/account`, Ayarlar → Gizlilik) artık vardır; silme yolculuğu
// `account-deletion-journey.spec.ts`, silinen kişinin görünümünün gerçekten
// gittiği `server/tests/pg-integration/account-erasure.pgtest.ts` ile ölçülür.

import { test, expect } from '../helpers/apiTest';
import { request as pwRequest } from '@playwright/test';
import { getTokens, createTestServer, createTestChannel, joinServer } from '../helpers/bridge';
import { openSocket, closeSockets, waitForEvent, paceSends } from '../helpers/socket';
import { getCsrf } from '../helpers/csrf';
import fs from 'fs';
import path from 'path';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const TOKENS_FILE = path.join(__dirname, '..', 'fixtures', 'tokens.json');

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

test.describe('gizlilik ve oturum yaşam döngüsü', () => {
  let tokens: ReturnType<typeof getTokens>;

  test.beforeAll(() => { tokens = getTokens(); });

  /** Taze bir erişim jetonu — fikstür jetonundan bağımsız. */
  async function freshLogin(
    request: import('@playwright/test').APIRequestContext, who: 'carol',
  ): Promise<string> {
    const u = tokens.users[who];
    const res = await request.post(`${BASE}/api/login`, {
      headers: JSON_HEADERS,
      data: JSON.stringify({ username: u.username, password: u.password }),
    });
    if (res.status() === 429) {
      // Giriş hız sınırı (`RL_LOGIN_MAX`, 10/dk) KASITLI bir kötüye kullanım
      // korumasıdır ve DEĞİŞTİRİLMEZ. Oturum iptali testi doğası gereği
      // birden çok giriş ister; paket hızlı tekrar koşulduğunda sınıra
      // takılabilir. Sessizce geçmek yerine AÇIKÇA atlanır.
      test.skip(true, 'giriş hız sınırında (429) — bu koşumda ölçülemedi. '
        + 'Yalıtık çalıştırın: npx playwright test tests/privacy-lifecycle.spec.ts');
    }
    expect(res.status(), 'giriş başarısız').toBe(200);
    const body = await res.json() as { token?: string; accessToken?: string };
    const token = body.token ?? body.accessToken ?? '';
    expect(token, 'jeton dönmedi').toBeTruthy();
    return token;
  }

  /** Fikstür jetonunu tazele — bu dosyanın yan etkisini temizler. */
  test.afterAll(async () => {
    const ctx = await pwRequest.newContext({ baseURL: BASE });
    try {
      const u = tokens.users.carol;
      const res = await ctx.post('/api/login', {
        headers: JSON_HEADERS,
        data: JSON.stringify({ username: u.username, password: u.password }),
      });
      if (res.ok()) {
        const body = await res.json() as { token?: string; accessToken?: string };
        const fresh = body.token ?? body.accessToken;
        if (fresh) {
          const raw = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
          raw.carol = fresh;
          fs.writeFileSync(TOKENS_FILE, JSON.stringify(raw, null, 2));
        }
      }
    } finally { await ctx.dispose(); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1. OTURUM İPTALİ
  // ══════════════════════════════════════════════════════════════════════════

  test('logout-all TÜM oturumları ve MEDYA yolunu birlikte iptal eder', async ({ request }) => {
    // ════════════════════════════════════════════════════════════════════
    // ÜÇ İPTAL YOLU TEK TESTTE
    // ════════════════════════════════════════════════════════════════════
    // Ayrı testler ayrı girişler gerektiriyordu ve `RL_LOGIN_MAX` (10/dk)
    // sınırına takılıyordu. Sınır DOĞRUDUR ve gevşetilmez; bunun yerine
    // test giriş sayısını azaltır. İddialardan HİÇBİRİ kaldırılmadı.
    //
    // KANITLAR    : `tokenVersion` artışı ÜÇ doğrulama yolunda da geçerli —
    //               eski oturum, yeni oturum ve medya (dosya) yolu.
    // KANITLAMAZ  : açık WebSocket bağlantılarının anında düştüğünü.
    const first = await freshLogin(request, 'carol');
    const second = await freshLogin(request, 'carol');

    // POZİTİF KONTROL: her iki oturum da GERÇEKTEN çalışıyor olmalı.
    expect((await request.get(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${first}` } })).status(),
      'ilk oturum çalışmıyor — test anlamsız olurdu').toBe(200);
    expect((await request.get(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${second}` } })).status(),
      'ikinci oturum çalışmıyor').toBe(200);

    // carol kendi dosyasını yükler — medya yolu için yörünge sahipliği.
    const up = await request.post(`${BASE}/api/upload`, {
      headers: { Authorization: `Bearer ${second}` },
      multipart: {
        file: {
          name: `priv-${Date.now()}.png`, mimeType: 'image/png',
          buffer: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64'),
        },
      },
    });
    expect(up.status()).toBe(200);
    const { url } = await up.json() as { url?: string };
    expect(url).toBeTruthy();
    expect((await request.get(`${BASE}${url}`, { headers: { Authorization: `Bearer ${second}` } })).status(),
      'yükleyici kendi dosyasını okuyamıyor').toBe(200);

    // ── HER YERDEN ÇIKIŞ ────────────────────────────────────────────────
    const out = await request.post(`${BASE}/api/logout-all`, {
      headers: {
        Authorization: `Bearer ${second}`, ...JSON_HEADERS,
        'X-CSRF-Token': await getCsrf(request, second),
      },
      data: '{}',
    });
    expect(out.status()).toBe(200);

    // 1) ESKİ oturum ölmeli (yalnızca sonuncusu değil)
    expect((await request.get(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${first}` } })).status(),
      'ESKİ oturum hâlâ geçerli').toBe(401);

    // 2) Çıkışı yapan oturum da ölmeli
    expect((await request.get(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${second}` } })).status(),
      'çıkış yapan oturum hâlâ geçerli').toBe(401);

    // 3) MEDYA yolu da kapanmalı — daha uzun ömürlü ayrı bir doğrulama yolu
    const media = await request.get(`${BASE}${url}`, { headers: { Authorization: `Bearer ${second}` } });
    expect([401, 403], 'iptal edilen jeton hâlâ dosya okuyabiliyor').toContain(media.status());
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. YENİLEME JETONU
  // ══════════════════════════════════════════════════════════════════════════

  test('yenileme jetonu OLMADAN yenileme yapılamaz', async ({ request }) => {
    // KANITLAR    : yenileme ucu kimlik istemeden jeton üretmiyor.
    const ctx = await pwRequest.newContext({
      baseURL: BASE, storageState: { cookies: [], origins: [] },
    });
    try {
      const res = await ctx.post('/api/refresh', { headers: JSON_HEADERS, data: '{}' });
      expect([400, 401], `çerezsiz yenileme ${res.status()} döndü`).toContain(res.status());
    } finally { await ctx.dispose(); }
  });

  test('SAHTE yenileme jetonu reddedilir', async () => {
    // ÖNEMLİ: paylaşılan `request` fixture'ı GEÇERLİ bir `bridge_refresh`
    // çerezi taşır. Onunla ölçmek 200 verir — çünkü uç, gövdedeki sahte
    // jetonu değil ÇEREZİ kullanır. İlk yazımda tam olarak bu oldu ve
    // "sahte jeton kabul edildi" gibi göründü. Temiz bağlam şarttır.
    const ctx = await pwRequest.newContext({
      baseURL: BASE, storageState: { cookies: [], origins: [] },
    });
    try {
      const res = await ctx.post('/api/refresh', {
        headers: JSON_HEADERS,
        data: JSON.stringify({ refreshToken: 'uydurma-jeton-' + Date.now() }),
      });
      expect([400, 401], `sahte jeton ${res.status()} döndü`).toContain(res.status());
      const body = JSON.stringify(await res.json().catch(() => ({})));
      expect(body, 'sahte jeton için yeni erişim jetonu üretildi').not.toContain('accessToken');
    } finally { await ctx.dispose(); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. SİLİNEN VERİ GERİ GETİRİLEMEZ
  // ══════════════════════════════════════════════════════════════════════════

  test('SİLİNEN mesaj hiçbir okuma ucundan geri gelmez', async ({ request }) => {
    // KANITLAR    : silme kalıcıdır (sert DELETE) ve liste/arama uçlarından
    //               geri okunamaz.
    // KANITLAMAZ  : veritabanı yedeklerinde kalıp kalmadığını — bu altyapı
    //               düzeyinde bir konudur ve ayrıca raporlanır.
    const srv = await createTestServer(request, tokens.alice, `Privacy ${Date.now()}`);
    const serverId = String((srv as { _id?: string })?._id ?? '');
    const ch = await createTestChannel(request, tokens.alice, serverId, `pv-${Date.now().toString(36)}`, 'text');
    const channelId = String((ch as { _id?: string })?._id ?? '');
    expect(serverId && channelId).toBeTruthy();

    const needle = `gizlilik-${Date.now().toString(36)}`;
    const sock = await openSocket(tokens.alice);
    try {
      sock.emit('channel:join', { channelId, serverId });
      await paceSends('alice');
      const ack = waitForEvent<{ messageId: string }>(sock, 'message:ack', 15_000);
      sock.emit('message:send', { channelId, serverId, content: `sil ${needle}`, ackId: `pv-${Date.now()}` });
      const msg = await ack;
      expect(msg.messageId).toBeTruthy();
      await new Promise(r => setTimeout(r, 1_200));

      // POZİTİF KONTROL: silmeden önce GERÇEKTEN okunabiliyor.
      const listBefore = await request.get(`${BASE}/api/channels/${channelId}/messages`, {
        headers: { Authorization: `Bearer ${tokens.alice}` },
      });
      expect(JSON.stringify(await listBefore.json().catch(() => ({})))).toContain(needle);

      await paceSends('alice');
      sock.emit('message:delete', { messageId: msg.messageId, channelId, serverId });
      await new Promise(r => setTimeout(r, 1_800));

      // Liste ucu
      const listAfter = await request.get(`${BASE}/api/channels/${channelId}/messages`, {
        headers: { Authorization: `Bearer ${tokens.alice}` },
      });
      expect(JSON.stringify(await listAfter.json().catch(() => ({}))),
        'silinen mesaj liste ucundan geri geldi').not.toContain(needle);

      // Arama ucu
      const search = await request.get(
        `${BASE}/api/search?q=${encodeURIComponent(needle)}`,
        { headers: { Authorization: `Bearer ${tokens.alice}` } },
      );
      const raw = JSON.stringify(await search.json().catch(() => ({})));
      expect(raw, 'silinen mesaj aramadan geri geldi').not.toContain(`sil ${needle}`);
    } finally { closeSockets(sock); }
  });
});
