// e2e/tests/file-security.spec.ts
//
// DOSYA / MEDYA GÜVENLİĞİ — FAZ 5
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSURLAR
// ════════════════════════════════════════════════════════════════════════════
// 1) AVATAR VE BANNER HİÇ GÖRÜNMÜYORDU
//    `middleware/uploadAuthz.ts` yapısal bir kural uygular:
//      · uploads KÖKÜ      → ÖZEL mesaj ekleri (yetkilendirilir)
//      · uploads ALT DİZİN → HERKESE AÇIK varlıklar (emoji, sticker, avatar…)
//    Ama `routes/auth.ts` avatar ve banner'ı KÖKE yazıyordu. `findOwner`
//    bunları hiçbir mesajda bulamayıp `{kind:'orphan', uploaderId:null}`
//    döndürüyor, `authorized()` ise null yükleyici için FALSE dönüyordu.
//
//    ÖLÇÜLDÜ (yükleme başarılı, dosya erişilemez):
//      POST /api/me/avatar              → 200  { avatarUrl: /uploads/avatar_… }
//      GET  /uploads/avatar_… (sahibi)  → 403
//      GET  /uploads/avatar_… (anonim)  → 401   ← `<img>` yolu
//      GET  /uploads/avatar_… (başkası) → 403
//    Yani profil resimleri KİMSEYE görünmüyordu.
//
// 2) BOZUK ÇOK PARÇALI İSTEK 500 DÖNÜYORDU
//    Dosya adında NULL baytı → `busboy` "Malformed part header" fırlatıyor,
//    hata rota koduna ulaşmadan global işleyiciye düşüyor ve istemciye 500
//    dönüyordu. Güvenlik açığı değil ama bozuk İSTEMCİ girdisi SUNUCU hatası
//    olarak raporlanmamalı — gerçek arızaları maskeler.

import { test, expect } from '../helpers/apiTest';
import { request as pwRequest } from '@playwright/test';
import { getTokens, createTestServer, createTestChannel, joinServer } from '../helpers/bridge';
import { openSocket, closeSockets, waitForEvent, paceSends } from '../helpers/socket';
import { getCsrf } from '../helpers/csrf';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const SVG_EVIL = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

/** Gerçekten kimliksiz istek — paylaşılan fixture `bridge_media` çerezi taşır. */
async function anonGet(url: string) {
  const ctx = await pwRequest.newContext({
    baseURL: BASE, storageState: { cookies: [], origins: [] },
  });
  try { return await ctx.get(url); } finally { await ctx.dispose(); }
}

test.describe('dosya güvenliği', () => {
  let tokens: ReturnType<typeof getTokens>;

  test.beforeAll(() => { tokens = getTokens(); });

  function upload(
    request: import('@playwright/test').APIRequestContext,
    token: string, buf: Buffer, mimeType: string, name: string,
  ) {
    return request.post(`${BASE}/api/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: { file: { name, mimeType, buffer: buf } },
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1. AVATAR / BANNER GÖRÜNÜRLÜĞÜ
  // ══════════════════════════════════════════════════════════════════════════

  test('AVATAR yüklenince HERKESE görünür olur', async ({ request }) => {
    // KANITLAR    : açık profil varlığı özel-ek yetkilendirmesine takılmıyor.
    // KANITLAMAZ  : CDN/uzak depolama davranışını (yerel modda ölçüldü).
    const res = await request.post(`${BASE}/api/me/avatar`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'X-CSRF-Token': await getCsrf(request, tokens.alice),
      },
      multipart: { avatar: { name: 'me.png', mimeType: 'image/png', buffer: PNG } },
    });
    expect(res.status(), 'avatar yüklenemedi').toBe(200);
    const { avatarUrl } = await res.json() as { avatarUrl?: string };
    expect(avatarUrl, 'avatarUrl dönmedi').toBeTruthy();

    // Alt dizine yazılmalı — kök ÖZEL eklere ayrılmıştır.
    expect(avatarUrl, 'avatar hâlâ köke yazılıyor').toContain('/uploads/avatars/');

    // `<img>` yolu: kimlik başlığı GÖNDERİLEMEZ.
    const anon = await anonGet(avatarUrl!);
    expect(anon.status(), 'avatar anonim olarak görünmüyor — <img> kırılır').toBe(200);

    // Başka bir kullanıcı da görebilmeli (profil listeleri, mesaj başlıkları).
    const other = await request.get(`${BASE}${avatarUrl}`, {
      headers: { Authorization: `Bearer ${tokens.bob}` },
    });
    expect(other.status(), 'başka kullanıcı avatarı göremiyor').toBe(200);
  });

  test('ÖZEL EK anonim erişime KAPALI kalır — avatar düzeltmesi sınırı gevşetmedi', async ({ request }) => {
    // Avatar muafiyeti eklendi; bu test onun ÖZEL ekleri etkilemediğini kanıtlar.
    const up = await upload(request, tokens.alice, PNG, 'image/png', `priv-${Date.now()}.png`);
    expect(up.status()).toBe(200);
    const { url } = await up.json() as { url?: string };
    expect(url).toBeTruthy();

    const anon = await anonGet(url!);
    expect([401, 403], 'ÖZEL ek anonim erişime açıldı').toContain(anon.status());
  });

  test('saldırgan `avatar_` adlı bir EK ile muafiyeti ZORLAYAMAZ', async ({ request }) => {
    // KANITLAR    : muafiyet dosya adına dayansa da dosya adı SUNUCU tarafından
    //               üretilir (`${uuidv4()}${ext}`), istemciden alınmaz.
    const forged = 'avatar_00000000-0000-0000-0000-000000000000.png';
    const up = await upload(request, tokens.alice, PNG, 'image/png', forged);
    expect(up.status()).toBe(200);
    const { url } = await up.json() as { url?: string };
    expect(url, 'sunucu istemci dosya adını KULLANDI').not.toContain('avatar_');

    const anon = await anonGet(url!);
    expect([401, 403], 'sahte ad ile muafiyet zorlandı').toContain(anon.status());
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. İÇERİK DOĞRULAMA
  // ══════════════════════════════════════════════════════════════════════════

  test('MIME sahteciliği reddedilir (sihirli bayt denetimi)', async ({ request }) => {
    // image/png beyan edilir ama içerik HTML'dir.
    const res = await upload(request, tokens.alice, HTML, 'image/png', 'evil.png');
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json().catch(() => ({}))))
      .toContain('does not match');
  });

  test('çalıştırılabilir MIME türleri KABUL EDİLMEZ', async ({ request }) => {
    // text/html, text/javascript vb. izin listesinden ÇIKARILMIŞTIR — XSS vektörü.
    // Durum kodu 400'dür. `fileFilter` içeride `status: 415` işaretler ama
    // SEVK EDİLMİŞ sözleşme 400'dür ve `server/tests/upload.test.ts` bunu
    // belgeler; hata işleyici bunu bilerek korur (bkz. routes/upload.ts).
    for (const mime of ['text/html', 'application/javascript', 'text/javascript']) {
      const res = await upload(request, tokens.alice, HTML, mime, 'x.html');
      expect({ mime, status: res.status() }).toEqual({ mime, status: 400 });
    }
  });

  test('SCRIPT içeren SVG reddedilir', async ({ request }) => {
    // KANITLAR    : SVG içeriği taranıyor; yalnızca başlıklara güvenilmiyor.
    const res = await upload(request, tokens.alice, SVG_EVIL, 'image/svg+xml', 'x.svg');
    expect([400, 415, 422], `SVG kabul edildi (${res.status()})`).toContain(res.status());
  });

  test('DOSYA ADI yol geçişi (path traversal) etkisizdir', async ({ request }) => {
    // Sunucu adı yok sayıp UUID üretir; dizin dışına yazma mümkün değildir.
    const res = await upload(request, tokens.alice, PNG, 'image/png', '../../../evil.png');
    expect(res.status()).toBe(200);
    const { url } = await res.json() as { url?: string };
    expect(url, 'yol geçişi dosya adına sızdı').not.toContain('..');
    expect(url).toMatch(/^\/uploads\/[0-9a-f-]{36}\.png$/i);
  });

  test('BOZUK çok parçalı istek 400 döner — 500 DEĞİL', async ({ request }) => {
    // GERİLEME: dosya adındaki NULL baytı "Malformed part header" fırlatıyor
    // ve global işleyici bunu 500 yapıyordu.
    const res = await upload(request, tokens.alice, PNG, 'image/png', 'a\u0000.png');
    expect(res.status(), 'bozuk istek hâlâ 500 üretiyor').toBe(400);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. ERİŞİM SINIRLARI
  // ══════════════════════════════════════════════════════════════════════════

  test('KİMLİK TAHMİNİ ile rastgele dosya okunamaz', async () => {
    const res = await anonGet('/uploads/00000000-0000-0000-0000-000000000000.png');
    expect([401, 403, 404]).toContain(res.status());
  });

  test('statik servis GÜVENLİK BAŞLIKLARI gönderir', async ({ request }) => {
    // KANITLAR    : MIME sniffing ve çerçeveleme kapalı.
    // NOT: bu test aynı zamanda YÜKLEYİCİNİN kendi dosyasını okuyabildiğini de
    // gerektirir. Bir dönem okuyamıyordu: `recordUpload` anahtarı
    // `uploads/<ad>` olarak saklarken `findOwner` yalnızca `/uploads/<ad>` ve
    // `<ad>` biçimlerini arıyordu; hiçbiri eşleşmediği için `uploaderId`
    // daima null kalıyor ve gönderim öncesi önizleme 403 veriyordu.
    const up = await upload(request, tokens.alice, PNG, 'image/png', `hdr-${Date.now()}.png`);
    const { url } = await up.json() as { url?: string };
    const res = await request.get(`${BASE}${url}`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status()).toBe(200);
    const h = res.headers();
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(String(h['x-frame-options'] ?? '').toUpperCase()).toBe('DENY');
  });

  test('SİLİNEN mesajın eki artık SERVİS EDİLMEZ', async ({ request }) => {
    // ════════════════════════════════════════════════════════════════════
    // KANITLAR   : mesaj silinince ek yetkilendirmesi de düşer.
    // KANITLAMAZ : dosyanın DİSKTEN silindiğini — SİLİNMEZ. Bu bilinen bir
    //              saklama açığıdır (rapora bakınız): `deleteMessageCascade`
    //              `fs.unlink` çağırmaz ve aynı `fileUrl` birden çok mesaj
    //              tarafından paylaşılabildiği için sayaçsız silme GÜVENSİZ
    //              olurdu. Bytes diskte kalır; ERİŞİM kapanır.
    //
    // NOT: `uploadAuthz` sahiplik önbelleği 30 sn TTL taşır; bu yüzden test
    // TTL süresini BEKLER. Beklemeden ölçmek yanıltıcı bir 200 verir.
    // ════════════════════════════════════════════════════════════════════
    test.setTimeout(120_000);

    const srv = await createTestServer(request, tokens.alice, `FileDel ${Date.now()}`);
    const serverId = String((srv as { _id?: string })?._id ?? '');
    const ch = await createTestChannel(request, tokens.alice, serverId, `fd-${Date.now().toString(36)}`, 'text');
    const channelId = String((ch as { _id?: string })?._id ?? '');
    expect(serverId && channelId).toBeTruthy();
    expect(await joinServer(request, tokens.alice, tokens.bob, serverId)).toBe(true);

    const up = await upload(request, tokens.alice, PNG, 'image/png', `del-${Date.now()}.png`);
    const { url } = await up.json() as { url?: string };
    expect(url).toBeTruthy();

    const sock = await openSocket(tokens.alice);
    try {
      sock.emit('channel:join', { channelId, serverId });
      await paceSends('alice');
      const ack = waitForEvent<{ messageId: string }>(sock, 'message:ack', 15_000);
      sock.emit('message:send', {
        channelId, serverId, type: 'file',
        fileUrl: url, fileName: 'del.png', fileType: 'image/png',
        content: '', ackId: `fd-${Date.now()}`,
      });
      const msg = await ack;
      expect(msg.messageId).toBeTruthy();
      await new Promise(r => setTimeout(r, 800));

      // POZİTİF KONTROL: üye ek'e ERİŞEBİLİYOR olmalı.
      const before = await request.get(`${BASE}${url}`, {
        headers: { Authorization: `Bearer ${tokens.bob}` },
      });
      expect(before.status(), 'üye eki okuyamıyor — test anlamsız olurdu').toBe(200);

      await paceSends('alice');
      sock.emit('message:delete', { messageId: msg.messageId, channelId, serverId });

      // Sahiplik önbelleği (30 sn) geçene kadar bekle.
      await new Promise(r => setTimeout(r, 33_000));

      const after = await request.get(`${BASE}${url}`, {
        headers: { Authorization: `Bearer ${tokens.bob}` },
      });
      expect([401, 403, 404], 'silinen mesajın eki hâlâ servis ediliyor')
        .toContain(after.status());
    } finally { closeSockets(sock); }
  });
});
