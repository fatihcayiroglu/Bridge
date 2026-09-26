// e2e/tests/search-security.spec.ts
//
// ARAMA GÜVENLİĞİ — KİRACI (TENANCY) VE KANAL SINIRI
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// Arama, üründeki EN GENİŞ okuma yüzeyidir: tek bir sorgu, kullanıcının
// erişebildiği her sunucudaki her mesajı tarar. Sınır burada kırılırsa
// başka hiçbir yetkilendirme kontrolü bunu telafi etmez.
//
// Sunucu tarafında iki ayrı kapı vardır (server/routes/search.ts):
//   1. SUNUCU KAPISI  — `Members.findByUser` ile caller'ın üyelikleri alınır;
//      sorgu YALNIZCA o sunucu kimlikleriyle çalışır. Sahte `serverId` 403.
//   2. KANAL KAPISI   — `viewableChannelIds` her kanal için
//      `resolvePermissions` çağırır ve `VIEW_CHANNELS` yoksa eler.
//      Hata durumunda FAIL-CLOSED: kanal görünmez sayılır.
//
// Bu iki kapının hiçbiri E2E ile doğrulanmamıştı. Kod doğru görünüyordu ama
// "doğru görünmek" kanıt değildir — bu dosya kapıları GERÇEKTEN zorlar.
//
// ── KANIT STRATEJİSİ ──────────────────────────────────────────────────────
// Yazma yolu kanoniktir (Socket.IO `message:send`), okuma yolu REST'tir.
// Her testte benzersiz bir "işaret" (needle) dizesi kullanılır; böylece
// "bulundu/bulunmadı" tesadüfe değil, o teste ait tek bir mesaja bağlıdır.

import { test, expect } from '../helpers/apiTest';
import { request as playwrightRequest } from '@playwright/test';
import { getTokens, createTestServer, createTestChannel, joinServer } from '../helpers/bridge';
import { openSocket, closeSockets, waitForEvent, paceSends } from '../helpers/socket';
import { getCsrf } from '../helpers/csrf';
import type { Socket } from 'socket.io-client';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** VIEW_CHANNELS = 1 << 0 (server/lib/permissions.ts). */
const VIEW_CHANNELS = 1 << 0;

test.describe('arama güvenliği — kiracı ve kanal sınırı', () => {
  let tokens: ReturnType<typeof getTokens>;

  // alice'in sunucusu: bob ÜYE DEĞİL.
  let aliceServerId = '';
  let aliceChannelId = '';
  let aliceNeedle = '';

  // Ortak sunucu: bob ÜYE, ama bir kanal ondan gizli.
  let sharedServerId = '';
  let openChannelId = '';
  let hiddenChannelId = '';
  let openNeedle = '';
  let hiddenNeedle = '';

  let aliceSock: Socket;

  /** Kanonik yol: `message:send` → `message:ack`. REST gönderim ucu YOKTUR. */
  async function send(sock: Socket, who: string, channelId: string, serverId: string, content: string) {
    await paceSends(who);
    const ackId = `srch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ack = waitForEvent<{ ackId: string; messageId: string }>(sock, 'message:ack', 15_000);
    sock.emit('message:send', { channelId, serverId, content, ackId });
    const got = await ack;
    expect(got.messageId, 'mesaj oluşturulamadı').toBeTruthy();
    return got.messageId;
  }

  async function search(token: string, params: Record<string, string>) {
    const qs = new URLSearchParams(params).toString();
    const ctx = await playwrightRequest.newContext({
      baseURL: BASE,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const res = await ctx.get(`/api/search?${qs}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': UA },
      });
      const body = res.ok() ? await res.json().catch(() => ({})) : {};
      return { status: res.status(), body: body as { messages?: Array<{ content?: string }> } };
    } finally {
      await ctx.dispose();
    }
  }

  const contents = (r: { body: { messages?: Array<{ content?: string }> } }) =>
    (r.body.messages ?? []).map(m => String(m.content ?? ''));

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();
    const stamp = Date.now().toString(36);

    // ── 1. alice'e ait, bob'un ÜYE OLMADIĞI sunucu ────────────────────────
    const s1 = await createTestServer(request, tokens.alice, `SrchPriv ${Date.now()}`);
    aliceServerId = String((s1 as { _id?: string })?._id ?? '');
    expect(aliceServerId, 'özel arama sunucusu oluşturulamadı').toBeTruthy();
    const c1 = await createTestChannel(request, tokens.alice, aliceServerId, `priv-${stamp}`, 'text');
    aliceChannelId = String((c1 as { _id?: string })?._id ?? '');
    expect(aliceChannelId, 'özel kanal oluşturulamadı').toBeTruthy();

    // ── 2. bob'un ÜYE OLDUĞU ortak sunucu ─────────────────────────────────
    const s2 = await createTestServer(request, tokens.alice, `SrchShared ${Date.now()}`);
    sharedServerId = String((s2 as { _id?: string })?._id ?? '');
    expect(sharedServerId, 'ortak arama sunucusu oluşturulamadı').toBeTruthy();
    const c2 = await createTestChannel(request, tokens.alice, sharedServerId, `open-${stamp}`, 'text');
    openChannelId = String((c2 as { _id?: string })?._id ?? '');
    const c3 = await createTestChannel(request, tokens.alice, sharedServerId, `hidden-${stamp}`, 'text');
    hiddenChannelId = String((c3 as { _id?: string })?._id ?? '');
    expect(openChannelId && hiddenChannelId, 'ortak kanallar oluşturulamadı').toBeTruthy();

    await joinServer(request, tokens.alice, tokens.bob, sharedServerId);

    // ── 3. Gizli kanalda @everyone için VIEW_CHANNELS REDDEDİLİR ──────────
    // Kanonik uç: PUT /api/servers/:sid/channels/:cid/permissions/:roleId
    // `@everyone` rolü sunucu kimliğiyle aynı kimliği taşır (Discord kalıbı).
    const csrf = await getCsrf(request, tokens.alice);
    const permRes = await request.put(
      `${BASE}/api/servers/${sharedServerId}/channels/${hiddenChannelId}/permissions/${sharedServerId}`,
      {
        headers: {
          Authorization: `Bearer ${tokens.alice}`,
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
        },
        data: JSON.stringify({ allow: 0, deny: VIEW_CHANNELS, targetType: 'role', targetName: '@everyone' }),
      },
    );
    // Uç sürüme göre 200/201/204 dönebilir; BAŞARISIZSA testler bunu
    // sessizce yutmaz — aşağıdaki gizli-kanal testi açıkça doğrular.
    expect([200, 201, 204], `izin geçersiz kılma reddedildi: ${permRes.status()}`)
      .toContain(permRes.status());

    // ── 4. İşaretli mesajlar (kanonik socket yolu) ────────────────────────
    aliceSock = await openSocket(tokens.alice);
    aliceSock.emit('channel:join', { channelId: aliceChannelId, serverId: aliceServerId });
    aliceSock.emit('channel:join', { channelId: openChannelId, serverId: sharedServerId });
    aliceSock.emit('channel:join', { channelId: hiddenChannelId, serverId: sharedServerId });

    aliceNeedle  = `needlepriv${stamp}`;
    openNeedle   = `needleopen${stamp}`;
    hiddenNeedle = `needlehidden${stamp}`;

    await send(aliceSock, 'alice', aliceChannelId, aliceServerId, `gizli ${aliceNeedle} icerik`);
    await send(aliceSock, 'alice', openChannelId, sharedServerId, `acik ${openNeedle} icerik`);
    await send(aliceSock, 'alice', hiddenChannelId, sharedServerId, `gizlikanal ${hiddenNeedle} icerik`);

    // FTS indeksinin yazmayı görmesi için kısa bir pay.
    await new Promise(r => setTimeout(r, 1_500));
  });

  test.afterAll(() => { closeSockets(aliceSock); });

  // ══════════════════════════════════════════════════════════════════════════

  test('kimliksiz arama REDDEDİLİR', async () => {
    // KANITLAR    : arama ucu kimlik doğrulaması olmadan hiçbir şey döndürmez.
    // KANITLAMAZ  : oturum açmış bir kullanıcının ne görebildiğini.
    const ctx = await playwrightRequest.newContext({
      baseURL: BASE, storageState: { cookies: [], origins: [] },
    });
    try {
      const res = await ctx.get(`/api/search?q=${aliceNeedle}`, {
        headers: { Accept: 'application/json', 'User-Agent': UA },
      });
      expect([401, 403], `kimliksiz arama ${res.status()} döndü`).toContain(res.status());
    } finally { await ctx.dispose(); }
  });

  test('sahibi KENDİ sunucusundaki mesajı bulur — pozitif kontrol', async () => {
    // KANITLAR    : arama gerçekten çalışıyor. Bu OLMADAN negatif testler
    //               "hiçbir şey bulunamadı" diye yanlışlıkla geçerdi.
    // KANITLAMAZ  : alaka sıralamasını.
    const r = await search(tokens.alice, { q: aliceNeedle });
    expect(r.status).toBe(200);
    expect(contents(r).join('\n'), 'sahibi kendi mesajını bulamadı')
      .toContain(aliceNeedle);
  });

  test('ÜYE OLMAYAN kullanıcı başka sunucunun mesajını GÖREMEZ', async () => {
    // KANITLAR    : sunucu kapısı gerçekten kapalı — kiracı sızıntısı yok.
    // KANITLAMAZ  : veritabanı seviyesindeki satır güvenliğini.
    const r = await search(tokens.bob, { q: aliceNeedle });
    expect(r.status).toBe(200);
    expect(contents(r).join('\n'), 'KİRACI SIZINTISI: üye olmayan başka sunucunun mesajını gördü')
      .not.toContain(aliceNeedle);
  });

  test('SAHTE serverId ile arama 403 döner', async () => {
    // KANITLAR    : üye olunmayan bir sunucu kimliği zorlanamaz.
    // KANITLAMAZ  : var olmayan kimliklerin davranışını (ayrı durum).
    const r = await search(tokens.bob, { q: aliceNeedle, serverId: aliceServerId });
    expect(r.status, 'üye olunmayan serverId 403 dönmedi').toBe(403);
  });

  test('ÜYE, erişebildiği kanaldaki mesajı bulur — pozitif kontrol', async () => {
    // KANITLAR    : ortak sunucuda normal görünürlük çalışıyor.
    const r = await search(tokens.bob, { q: openNeedle });
    expect(r.status).toBe(200);
    expect(contents(r).join('\n'), 'üye açık kanaldaki mesajı bulamadı')
      .toContain(openNeedle);
  });

  test('ÜYE, VIEW_CHANNELS REDDEDİLEN kanaldaki mesajı GÖREMEZ', async () => {
    // ════════════════════════════════════════════════════════════════════
    // EN KRİTİK İDDİA
    // ════════════════════════════════════════════════════════════════════
    // Sunucu üyeliği kanal erişimi DEĞİLDİR. bob bu sunucunun üyesidir —
    // yani sunucu kapısından geçer — ama `hidden` kanalında @everyone için
    // VIEW_CHANNELS reddedilmiştir. Arama bunu ELEMELİDİR
    // (`viewableChannelIds` → `resolvePermissions`).
    //
    // KANITLAR    : kanal kapısının arama yolunda GERÇEKTEN uygulandığını.
    // KANITLAMAZ  : diğer okuma yollarını (mesaj listesi ayrı test edilir).
    const r = await search(tokens.bob, { q: hiddenNeedle });
    expect(r.status).toBe(200);
    expect(contents(r).join('\n'),
      'KANAL SIZINTISI: VIEW_CHANNELS reddedilmiş kanalın mesajı aramada göründü')
      .not.toContain(hiddenNeedle);
  });

  test('sahibi gizli kanalı GÖRÜR — kural körü körüne engellemiyor', async () => {
    // KANITLAR    : eleme YETKİYE dayalı, topyekûn bir sansür değil.
    //               Bu olmadan önceki test "arama hiç çalışmıyor" ile de geçerdi.
    const r = await search(tokens.alice, { q: hiddenNeedle });
    expect(r.status).toBe(200);
    expect(contents(r).join('\n'), 'sunucu sahibi kendi gizli kanalını göremedi')
      .toContain(hiddenNeedle);
  });

  test('çok kısa sorgu sonuç SIZDIRMAZ', async () => {
    // KANITLAR    : 2 karakterden kısa sorgular boş döner — geniş tarama yok.
    const r = await search(tokens.bob, { q: 'a' });
    expect(r.status).toBe(200);
    expect((r.body.messages ?? []).length, 'kısa sorgu sonuç döndürdü').toBe(0);
  });

  test('`from:` değiştiricisi kiracı sınırını AŞAMAZ', async () => {
    // KANITLAR    : arama değiştiricileri sunucu kapısının ÜSTÜNDE çalışır,
    //               yerine geçmez. `from:alice` bile bob'a özel sunucuyu açmaz.
    const r = await search(tokens.bob, { q: aliceNeedle, from: tokens.users.alice.username });
    expect(r.status).toBe(200);
    expect(contents(r).join('\n'), 'değiştirici kiracı sınırını aştı')
      .not.toContain(aliceNeedle);
  });

  test('/search/unified AYNI sınırı uygular', async () => {
    // KANITLAR    : ikinci arama ucu birinciyle aynı kapıyı kullanıyor.
    //               Ayrı uçlar ayrı sızıntı yüzeyleridir.
    const ctx = await playwrightRequest.newContext({
      baseURL: BASE, storageState: { cookies: [], origins: [] },
    });
    try {
      const res = await ctx.get(`/api/search/unified?q=${aliceNeedle}`, {
        headers: { Authorization: `Bearer ${tokens.bob}`, Accept: 'application/json', 'User-Agent': UA },
      });
      expect([200, 400], `beklenmeyen durum: ${res.status()}`).toContain(res.status());
      if (res.status() === 200) {
        const raw = JSON.stringify(await res.json().catch(() => ({})));
        expect(raw, 'KİRACI SIZINTISI: /unified başka sunucunun mesajını döndürdü')
          .not.toContain(aliceNeedle);
      }
    } finally { await ctx.dispose(); }
  });
});
