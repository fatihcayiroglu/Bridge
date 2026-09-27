// e2e/tests/channel-permissions.spec.ts
//
// KANAL İZİN GEÇERSİZ KILMALARI — YAZMA, UYGULAMA, YETKİ
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR — KAPATILAN GERÇEK ÜRÜN KUSURU
// ════════════════════════════════════════════════════════════════════════════
// `PUT /api/servers/:sid/channels/:cid/permissions/:roleId` bir kanal için
// İLK override yazılırken 500 dönüyordu. Doğrudan ölçüm:
//
//     { allow, deny }                          → 200
//     { allow, deny, targetType }              → 500
//     { allow, deny, targetType, targetName }  → 500
//     PUT .../permissions/batch                → 500  (her zaman)
//
// Sunucu günlüğü:
//     [pgCollection] Unknown column name: "targetName"
//       at PgCollection.insert → ChannelPermissionRepository.insert
//
// SEBEP: rotalar `channel_permissions` tablosuna `targetType` / `targetId` /
// `targetName` yazıyordu; kanonik şemada (db/postgres/migrations.ts) BU
// SÜTUNLAR YOK. Tablo yalnızca `_id, channelId, roleId, serverId, allow,
// deny, createdAt, updatedAt` tutar.
//
// NEDEN UZUN SÜRE GÖRÜNMEDİ: yalnızca INSERT yolu etkileniyordu. Aynı
// kanal+rol için İKİNCİ çağrı UPDATE yoluna giriyor ve bu alanları hiç
// yazmıyordu — yani elle denendiğinde "çalışıyor" gibi görünüyordu.
// Birim testler de yakalayamaz: mock DB'de sütun allowlist'i yoktur.
//
// Bu dosya hem kusuru KİLİTLER hem de izinlerin GERÇEKTEN uygulandığını
// doğrular — 200 dönmesi, erişimin kesildiği anlamına gelmez.

import { test, expect } from '../helpers/apiTest';
import { request as playwrightRequest } from '@playwright/test';
import { getTokens, createTestServer, createTestChannel, joinServer } from '../helpers/bridge';
import { openSocket, closeSockets, waitForEvent, paceSends } from '../helpers/socket';
import { getCsrf } from '../helpers/csrf';
import type { Socket } from 'socket.io-client';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

/** server/lib/permissions.ts — PERMS.VIEW_CHANNELS = 1 << 0 */
const VIEW_CHANNELS = 1 << 0;

test.describe('kanal izin geçersiz kılmaları', () => {
  let tokens: ReturnType<typeof getTokens>;
  let serverId = '';
  let csrfAlice = '';
  let aliceSock: Socket;

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();
    const srv = await createTestServer(request, tokens.alice, `Perms ${Date.now()}`);
    serverId = String((srv as { _id?: string })?._id ?? '');
    expect(serverId, 'izin test sunucusu oluşturulamadı').toBeTruthy();
    await joinServer(request, tokens.alice, tokens.bob, serverId);
    csrfAlice = await getCsrf(request, tokens.alice);
    aliceSock = await openSocket(tokens.alice);
  });

  test.afterAll(() => { closeSockets(aliceSock); });

  /** Her test kendi kanalını alır — INSERT yolu böyle gerçekten sınanır. */
  async function freshChannel(request: import('@playwright/test').APIRequestContext) {
    const ch = await createTestChannel(
      request, tokens.alice, serverId,
      `perm-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, 'text',
    );
    const id = String((ch as { _id?: string })?._id ?? '');
    expect(id, 'test kanalı oluşturulamadı').toBeTruthy();
    return id;
  }

  function putOverride(
    request: import('@playwright/test').APIRequestContext,
    token: string, csrf: string, channelId: string, roleId: string, body: Record<string, unknown>,
  ) {
    return request.put(
      `${BASE}/api/servers/${serverId}/channels/${channelId}/permissions/${roleId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
        },
        data: JSON.stringify(body),
      },
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1. GERİLEME — İLK yazma, görüntüleme meta verisiyle birlikte
  // ══════════════════════════════════════════════════════════════════════════

  test('İLK override, targetType ile birlikte yazılabilir', async ({ request }) => {
    // KANITLAR    : INSERT yolu artık şemada olmayan sütun yazmıyor.
    // KANITLAMAZ  : iznin etkisini (aşağıda ayrıca ölçülüyor).
    const cid = await freshChannel(request);
    const res = await putOverride(request, tokens.alice, csrfAlice, cid, serverId,
      { allow: 0, deny: VIEW_CHANNELS, targetType: 'role' });
    expect(res.status(), `İLK override targetType ile ${res.status()} döndü`).toBe(200);
  });

  test('İLK override, targetName ile birlikte yazılabilir', async ({ request }) => {
    // Tam olarak 500'e yol açan alan buydu: `Unknown column name: "targetName"`.
    const cid = await freshChannel(request);
    const res = await putOverride(request, tokens.alice, csrfAlice, cid, serverId,
      { allow: 0, deny: VIEW_CHANNELS, targetType: 'role', targetName: '@everyone' });
    expect(res.status(), `İLK override targetName ile ${res.status()} döndü`).toBe(200);
  });

  test('toplu yazma (/batch) çalışır', async ({ request }) => {
    // `bulk.ts` bu alanları KOŞULSUZ yazıyordu — yani /batch HER ZAMAN 500'dü.
    const cid = await freshChannel(request);
    const res = await request.put(
      `${BASE}/api/servers/${serverId}/channels/${cid}/permissions/batch`,
      {
        headers: {
          Authorization: `Bearer ${tokens.alice}`,
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfAlice,
        },
        data: JSON.stringify({
          overrides: [{ roleId: serverId, allow: 0, deny: VIEW_CHANNELS, targetType: 'role', targetName: '@everyone' }],
        }),
      },
    );
    expect(res.status(), `/batch ${res.status()} döndü`).toBe(200);
  });

  test('sadece allow/deny ile yazma da çalışır — ürün istemcisinin yolu', async ({ request }) => {
    // Bridge web istemcisi YALNIZCA { allow, deny } gönderir
    // (client/js/core/channel-perms/channelPermsStore.ts). Bu yol hiç
    // bozulmamıştı; regresyon testinin bunu da tutması gerekir.
    const cid = await freshChannel(request);
    const res = await putOverride(request, tokens.alice, csrfAlice, cid, serverId,
      { allow: 0, deny: VIEW_CHANNELS });
    expect(res.status()).toBe(200);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. ETKİ — 200 dönmesi erişimin kesildiği anlamına GELMEZ
  // ══════════════════════════════════════════════════════════════════════════

  test('VIEW_CHANNELS reddi ÜYENİN mesaj okumasını GERÇEKTEN engeller', async ({ request }) => {
    // KANITLAR    : override yalnızca kaydedilmiyor, UYGULANIYOR da.
    // KANITLAMAZ  : arayüzün kanalı gizlediğini (ayrı yüzey).
    const cid = await freshChannel(request);

    // Önce bob GERÇEKTEN erişebiliyor olmalı — pozitif kontrol.
    // Bu olmadan test, kanal hiç var olmasa da "geçerdi".
    const before = await request.get(`${BASE}/api/channels/${cid}/messages`, {
      headers: { Authorization: `Bearer ${tokens.bob}` },
    });
    expect(before.status(), 'bob başlangıçta kanalı okuyamıyor — pozitif kontrol başarısız')
      .toBeLessThan(300);

    const put = await putOverride(request, tokens.alice, csrfAlice, cid, serverId,
      { allow: 0, deny: VIEW_CHANNELS, targetType: 'role', targetName: '@everyone' });
    expect(put.status()).toBe(200);

    const after = await request.get(`${BASE}/api/channels/${cid}/messages`, {
      headers: { Authorization: `Bearer ${tokens.bob}` },
    });
    expect([401, 403, 404], `VIEW_CHANNELS reddedildiği hâlde bob ${after.status()} ile okudu`)
      .toContain(after.status());
  });

  test('reddedilen kanalda SUNUCU SAHİBİ okumaya devam eder', async ({ request }) => {
    // KANITLAR    : eleme yetkiye dayalı; topyekûn kilit DEĞİL.
    const cid = await freshChannel(request);
    await putOverride(request, tokens.alice, csrfAlice, cid, serverId,
      { allow: 0, deny: VIEW_CHANNELS, targetType: 'role', targetName: '@everyone' });

    const res = await request.get(`${BASE}/api/channels/${cid}/messages`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status(), 'sunucu sahibi kendi kanalını okuyamadı').toBeLessThan(300);
  });

  test('override SİLİNİNCE erişim geri gelir (inherit)', async ({ request }) => {
    // KANITLAR    : DELETE gerçekten devralmaya döndürüyor — kalıcı kilit yok.
    const cid = await freshChannel(request);
    await putOverride(request, tokens.alice, csrfAlice, cid, serverId,
      { allow: 0, deny: VIEW_CHANNELS, targetType: 'role', targetName: '@everyone' });

    const blocked = await request.get(`${BASE}/api/channels/${cid}/messages`, {
      headers: { Authorization: `Bearer ${tokens.bob}` },
    });
    expect([401, 403, 404]).toContain(blocked.status());

    const del = await request.delete(
      `${BASE}/api/servers/${serverId}/channels/${cid}/permissions/${serverId}`,
      { headers: { Authorization: `Bearer ${tokens.alice}`, 'X-CSRF-Token': csrfAlice } },
    );
    expect(del.status(), 'override silinemedi').toBeLessThan(300);

    const restored = await request.get(`${BASE}/api/channels/${cid}/messages`, {
      headers: { Authorization: `Bearer ${tokens.bob}` },
    });
    expect(restored.status(), 'override silindi ama erişim geri gelmedi').toBeLessThan(300);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. YETKİ — izin yazmak ayrıcalıklı bir işlemdir
  // ══════════════════════════════════════════════════════════════════════════

  test('SIRADAN ÜYE izin geçersiz kılma YAZAMAZ', async ({ request }) => {
    // KANITLAR    : yetki yükseltme kapalı — bob kendine izin veremez.
    // KANITLAMAZ  : rol hiyerarşisinin tüm kenar durumlarını.
    const cid = await freshChannel(request);
    const csrfBob = await getCsrf(request, tokens.bob);
    const res = await putOverride(request, tokens.bob, csrfBob, cid, serverId,
      { allow: VIEW_CHANNELS, deny: 0, targetType: 'role' });
    expect([401, 403], `sıradan üye override yazabildi (${res.status()})`)
      .toContain(res.status());
  });

  test('ÜYE OLMAYAN kullanıcı izin geçersiz kılma YAZAMAZ', async ({ request }) => {
    const cid = await freshChannel(request);
    const csrfCarol = await getCsrf(request, tokens.carol);
    const res = await putOverride(request, tokens.carol, csrfCarol, cid, serverId,
      { allow: VIEW_CHANNELS, deny: 0 });
    expect([401, 403, 404], `üye olmayan override yazabildi (${res.status()})`)
      .toContain(res.status());
  });

  test('CSRF token OLMADAN izin yazılamaz', async ({ request }) => {
    // KANITLAR    : mutasyon koruması bu uçta da uygulanıyor.
    const cid = await freshChannel(request);
    // `helpers/apiTest` fixture'ı mutasyonlara CSRF başlığını OTOMATİK ekler
    // (kasıtlı: spec'lerin çoğu CSRF sertleştirmesinden önce yazıldı). Bu
    // yüzden CSRF YOKLUĞU o fixture ile ÖLÇÜLEMEZ — ilk denemede istek 200
    // döndü çünkü başlık arka planda eklenmişti. Ham bağlam kullanılır.
    const rawCtx = await playwrightRequest.newContext({
      baseURL: BASE, storageState: { cookies: [], origins: [] },
    });
    try {
      const res = await rawCtx.put(
        `/api/servers/${serverId}/channels/${cid}/permissions/${serverId}`,
        {
          headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
          data: JSON.stringify({ allow: 0, deny: VIEW_CHANNELS }),
        },
      );
      expect([403], `CSRF'siz istek ${res.status()} döndü`).toContain(res.status());
    } finally { await rawCtx.dispose(); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. MESAJ GÖRÜNÜRLÜĞÜ — gerçek içerikle uçtan uca
  // ══════════════════════════════════════════════════════════════════════════

  test('reddedilen kanaldaki MESAJ İÇERİĞİ üyeye sızmaz', async ({ request }) => {
    // KANITLAR    : engelleme yalnızca liste ucunda değil, içerik düzeyinde.
    const cid = await freshChannel(request);
    const needle = `permleak${Date.now().toString(36)}`;

    aliceSock.emit('channel:join', { channelId: cid, serverId });
    await paceSends('alice');
    const ackId = `perm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ack = waitForEvent<{ messageId: string }>(aliceSock, 'message:ack', 15_000);
    aliceSock.emit('message:send', { channelId: cid, serverId, content: `gizli ${needle}`, ackId });
    expect((await ack).messageId, 'mesaj oluşturulamadı').toBeTruthy();

    await putOverride(request, tokens.alice, csrfAlice, cid, serverId,
      { allow: 0, deny: VIEW_CHANNELS, targetType: 'role', targetName: '@everyone' });

    const res = await request.get(`${BASE}/api/channels/${cid}/messages`, {
      headers: { Authorization: `Bearer ${tokens.bob}` },
    });
    const raw = res.status() < 300 ? JSON.stringify(await res.json().catch(() => ({}))) : '';
    expect(raw, 'İÇERİK SIZINTISI: reddedilen kanalın mesajı üyeye döndü')
      .not.toContain(needle);
  });
});
