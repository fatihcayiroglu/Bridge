// e2e/tests/search-security-extended.spec.ts
//
// ARAMA GÜVENLİĞİ — İKİNCİ YOL: SEMANTİK ARAMA, SİLİNMİŞ VE E2EE İÇERİK
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN AYRI BİR DOSYA
// ════════════════════════════════════════════════════════════════════════════
// `search-security.spec.ts` klasik `/api/search` yolunu sürer. Ancak AYNI
// VERİYE giden İKİNCİ bir yol daha vardır: `/api/semantic/search`.
// Ayrı uçlar ayrı sızıntı yüzeyleridir — biri sertleştirilip diğeri
// unutulabilir. Kaynak yorumları bunun bir kez GERÇEKTEN yaşandığını
// söylüyor (server/routes/semantic.ts):
//
//   "Bu uç yalnız SUNUCU ÜYELİĞİNİ denetliyordu ve sunucudaki TÜM kanalların
//    mesajlarını çekiyordu ... bir üye, göremediği özel kanalların metnini
//    /api/semantic/search üzerinden okuyabiliyordu."
//
// Bu dosya o düzeltmeyi KİLİTLER ve iki ek sınıfı daha ölçer:
//   · SİLİNMİŞ mesaj arama sonucunda görünmemeli
//   · E2EE mesajın düz metni hiçbir arama yolunda görünmemeli

import { test, expect } from '../helpers/apiTest';
import { getTokens, createTestServer, createTestChannel, joinServer } from '../helpers/bridge';
import { openSocket, closeSockets, waitForEvent, paceSends } from '../helpers/socket';
import { getCsrf } from '../helpers/csrf';
import type { Socket } from 'socket.io-client';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

/** server/lib/permissions.ts — VIEW_CHANNELS = 1 << 0 */
const VIEW_CHANNELS = 1 << 0;

test.describe('arama güvenliği — semantik yol, silinmiş ve E2EE içerik', () => {
  let tokens: ReturnType<typeof getTokens>;
  let serverId = '';
  let openChannelId = '';
  let hiddenChannelId = '';
  let openNeedle = '';
  let hiddenNeedle = '';
  let deletedNeedle = '';
  let deletedMessageId = '';
  let aliceSock: Socket;
  let csrfAlice = '';

  async function send(channelId: string, content: string): Promise<string> {
    await paceSends('alice');
    const ackId = `sx-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ack = waitForEvent<{ messageId: string }>(aliceSock, 'message:ack', 15_000);
    aliceSock.emit('message:send', { channelId, serverId, content, ackId });
    const got = await ack;
    expect(got.messageId, 'mesaj oluşturulamadı').toBeTruthy();
    return got.messageId;
  }

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();
    const stamp = Date.now().toString(36);

    const srv = await createTestServer(request, tokens.alice, `SemSec ${Date.now()}`);
    serverId = String((srv as { _id?: string })?._id ?? '');
    expect(serverId, 'sunucu oluşturulamadı').toBeTruthy();

    const openCh = await createTestChannel(request, tokens.alice, serverId, `sopen-${stamp}`, 'text');
    openChannelId = String((openCh as { _id?: string })?._id ?? '');
    const hidCh = await createTestChannel(request, tokens.alice, serverId, `shid-${stamp}`, 'text');
    hiddenChannelId = String((hidCh as { _id?: string })?._id ?? '');
    expect(openChannelId && hiddenChannelId, 'kanallar oluşturulamadı').toBeTruthy();

    expect(await joinServer(request, tokens.alice, tokens.bob, serverId), 'bob katılamadı').toBe(true);

    // Gizli kanalda @everyone için VIEW_CHANNELS reddedilir.
    csrfAlice = await getCsrf(request, tokens.alice);
    const perm = await request.put(
      `${BASE}/api/servers/${serverId}/channels/${hiddenChannelId}/permissions/${serverId}`,
      {
        headers: {
          Authorization: `Bearer ${tokens.alice}`,
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfAlice,
        },
        data: JSON.stringify({ allow: 0, deny: VIEW_CHANNELS, targetType: 'role', targetName: '@everyone' }),
      },
    );
    expect([200, 201, 204]).toContain(perm.status());

    aliceSock = await openSocket(tokens.alice);
    aliceSock.emit('channel:join', { channelId: openChannelId, serverId });
    aliceSock.emit('channel:join', { channelId: hiddenChannelId, serverId });

    openNeedle    = `semopen${stamp}`;
    hiddenNeedle  = `semhidden${stamp}`;
    deletedNeedle = `semdeleted${stamp}`;

    await send(openChannelId, `acik ${openNeedle} icerik`);
    await send(hiddenChannelId, `gizli ${hiddenNeedle} icerik`);
    deletedMessageId = await send(openChannelId, `silinecek ${deletedNeedle} icerik`);

    await new Promise(r => setTimeout(r, 1_200));
  });

  test.afterAll(() => { closeSockets(aliceSock); });

  function semantic(token: string, body: Record<string, unknown>) {
    return { token, body };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1. SEMANTİK ARAMA — kiracı ve kanal sınırı
  // ══════════════════════════════════════════════════════════════════════════

  test('semantik arama — ÜYE OLMAYAN 403 alır', async ({ request }) => {
    // KANITLAR    : ikinci arama yolu da üyelik denetimi yapıyor.
    // KANITLAMAZ  : gömme (embedding) sağlayıcısının davranışını — bu
    //               kurulumda AI kapalıdır ve anahtar kelime yedeği çalışır.
    const res = await request.post(`${BASE}/api/semantic/search`, {
      headers: {
        Authorization: `Bearer ${tokens.carol}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': await getCsrf(request, tokens.carol),
      },
      data: JSON.stringify({ query: openNeedle, serverId, days: 30 }),
    });
    expect([401, 403]).toContain(res.status());
  });

  test('semantik arama — ÜYE gizli kanal içeriğini GÖREMEZ', async ({ request }) => {
    // ════════════════════════════════════════════════════════════════════
    // EN KRİTİK İDDİA — kaynak yorumundaki canlı sızıntı tam olarak buydu
    // ════════════════════════════════════════════════════════════════════
    // bob sunucunun ÜYESİDİR (üyelik kapısından geçer) ama `hidden` kanalında
    // VIEW_CHANNELS reddedilmiştir. Aday kümesi, sonuç üretilmeden ÖNCE
    // filtrelenmelidir.
    const res = await request.post(`${BASE}/api/semantic/search`, {
      headers: {
        Authorization: `Bearer ${tokens.bob}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': await getCsrf(request, tokens.bob),
      },
      data: JSON.stringify({ query: hiddenNeedle, serverId, days: 30 }),
    });
    expect(res.status()).toBeLessThan(300);
    // DIKKAT: yanit `query` alaninda arama terimini AYNEN geri yansitir.
    // Ham JSON uzerinde arama yapmak bu yankiyi "sizinti" sanardi — ilk
    // yazimda tam olarak bu oldu. Yalnizca SONUC kumesi denetlenir.
    const body = await res.json().catch(() => ({})) as { matches?: unknown[] };
    const matches = JSON.stringify(body.matches ?? []);
    expect(matches).not.toContain(hiddenNeedle);
  });

  test('ÖNBELLEK KULLANICIYA GÖRE AYRILIR — ayrıcalıklı sonuç sızmaz', async ({ request }) => {
    // ════════════════════════════════════════════════════════════════════
    // KAPATILAN GERÇEK AÇIK — SIRA BAĞIMLI YETKİ SIZINTISI
    // ════════════════════════════════════════════════════════════════════
    // Önbellek anahtarı `sem:<serverId>:<channelId>:<query>:<days>` idi —
    // KULLANICI KİMLİĞİ YOKTU. `viewableChannelIds` filtresi her istekte
    // doğru çalışıyordu ama önbellek onu kısa devre yapıyordu:
    //
    //   alice (sahip) q=hidden → matches=1   (önbelleğe yazıldı)
    //   bob   (üye)   q=hidden → matches=1   ← SIZINTI (önbellekten)
    //
    // Sonuç, SORAN KİŞİYE değil SIRAYA bağlıydı: bob önce sorsaydı ikisi de
    // 0 dönüyordu. Bu test o sırayı BİLEREK kurar — önce ayrıcalıklı
    // kullanıcı, sonra sıradan üye.
    //
    // KANITLAR    : önbellek yetkilendirmeyi atlatmıyor.
    // KANITLAMAZ  : Redis kümesinde çok düğümlü tutarlılığı.
    const aliceRes = await request.post(`${BASE}/api/semantic/search`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfAlice,
      },
      data: JSON.stringify({ query: hiddenNeedle, serverId, days: 30 }),
    });
    expect(aliceRes.status()).toBeLessThan(300);
    const aliceBody = await aliceRes.json().catch(() => ({})) as { matches?: unknown[] };
    // Sahip GÖRMELİ — yoksa test "arama hiç çalışmıyor" ile de geçerdi.
    expect(JSON.stringify(aliceBody.matches ?? [])).toContain(hiddenNeedle);

    // ŞİMDİ sıradan üye AYNI sorguyu çalıştırır.
    const bobRes = await request.post(`${BASE}/api/semantic/search`, {
      headers: {
        Authorization: `Bearer ${tokens.bob}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': await getCsrf(request, tokens.bob),
      },
      data: JSON.stringify({ query: hiddenNeedle, serverId, days: 30 }),
    });
    expect(bobRes.status()).toBeLessThan(300);
    const bobBody = await bobRes.json().catch(() => ({})) as { matches?: unknown[] };
    expect(JSON.stringify(bobBody.matches ?? []),
      'ÖNBELLEK SIZINTISI: ayrıcalıklı sonuç sıradan üyeye döndü')
      .not.toContain(hiddenNeedle);
  });

  test('semantik arama — SAHİP gizli kanalı görür (pozitif kontrol)', async ({ request }) => {
    // Bu olmadan önceki test "semantik arama hiç çalışmıyor" ile de geçerdi.
    const res = await request.post(`${BASE}/api/semantic/search`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfAlice,
      },
      data: JSON.stringify({ query: hiddenNeedle, serverId, days: 30 }),
    });
    expect(res.status()).toBeLessThan(300);
    const body = await res.json().catch(() => ({})) as { matches?: unknown[]; aiDisabled?: boolean };
    const matches = JSON.stringify(body.matches ?? []);
    // Bu kurulumda AI kapalidir ve anahtar kelime yedegi calisir; yedek de
    // ayni yetki filtresinden gecer. Sahip icin sonuc GELMELIDIR.
    expect(matches).toContain(hiddenNeedle);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. SİLİNMİŞ İÇERİK
  // ══════════════════════════════════════════════════════════════════════════

  test('SİLİNEN mesaj arama sonucunda GÖRÜNMEZ', async ({ request }) => {
    // KANITLAR    : silme, arama indeksinden de düşürüyor.
    // KANITLAMAZ  : yedeklerde/ihraç dosyalarında kalıp kalmadığını.
    // Önce GERÇEKTEN aranabilir olduğunu doğrula — pozitif kontrol.
    const before = await request.get(
      `${BASE}/api/search?q=${encodeURIComponent(deletedNeedle)}`,
      { headers: { Authorization: `Bearer ${tokens.alice}` } },
    );
    expect(before.status()).toBe(200);
    const beforeRaw = JSON.stringify(await before.json().catch(() => ({})));
    expect(beforeRaw, 'silinmeden önce bulunamadı — test anlamsız olurdu')
      .toContain(deletedNeedle);

    // Kanonik silme yolu: socket `message:delete`.
    await paceSends('alice');
    aliceSock.emit('message:delete', { messageId: deletedMessageId, channelId: openChannelId, serverId });
    await new Promise(r => setTimeout(r, 1_500));

    const after = await request.get(
      `${BASE}/api/search?q=${encodeURIComponent(deletedNeedle)}`,
      { headers: { Authorization: `Bearer ${tokens.alice}` } },
    );
    expect(after.status()).toBe(200);
    const afterRaw = JSON.stringify(await after.json().catch(() => ({})));
    expect(afterRaw, 'SIZINTI: silinen mesaj hâlâ aramada').not.toContain(deletedNeedle);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. E2EE İÇERİK
  // ══════════════════════════════════════════════════════════════════════════

  test('E2EE mesajın DÜZ METNİ aramada görünmez', async ({ request }) => {
    // KANITLAR    : sunucu E2EE düz metni saklamıyor; arayamaz da.
    //               (server/socket/handlers/messages-send.ts → content = '')
    // KANITLAMAZ  : istemci tarafı şifrelemenin kriptografik gücünü.
    const secret = `e2eeplain${Date.now().toString(36)}`;
    await paceSends('alice');
    aliceSock.emit('message:send', {
      channelId: openChannelId, serverId, type: 'e2ee',
      encryptedContent: Buffer.from(secret).toString('base64'),
      iv: 'MDEyMzQ1Njc4OWFiY2RlZg==',
      ackId: `e2ee-${Date.now()}`,
    });
    await new Promise(r => setTimeout(r, 1_500));

    const res = await request.get(
      `${BASE}/api/search?q=${encodeURIComponent(secret)}`,
      { headers: { Authorization: `Bearer ${tokens.alice}` } },
    );
    expect(res.status()).toBe(200);
    const raw = JSON.stringify(await res.json().catch(() => ({})));
    expect(raw, 'SIZINTI: E2EE düz metni aranabilir').not.toContain(secret);
  });
});
