// e2e/tests/ban-enforcement.spec.ts
//
// BAN GERÇEKTEN UYGULANIYOR MU — GERİLEME TESTLERİ
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK AÇIKLAR (üçü bir arada)
// ════════════════════════════════════════════════════════════════════════════
// Ban, Bridge'de `members` tablosunda `banned = true` olan bir SATIRDIR.
// Üç ayrı kusur bir araya gelince çekirdek moderasyon işlevi çalışmıyordu:
//
// 1) BAN UCU HER ÇAĞRIDA 500 VERİYORDU
//      sebepsiz ban → Unknown column name: "actorName"   (denetim günlüğü)
//      sebepli ban  → Unknown column name: "banReason"   (üye kaydı)
//    Kanonik şema bu sütunları tanımlamıyordu.
//
// 2) VAR OLAN ÜYEYİ BANLAMAK SESSİZ NO-OP İDİ
//    `banMember` yalnızca `insert` çağırıyordu; birincil anahtar
//    `(userId, serverId)` olduğu için adaptör `ON CONFLICT DO NOTHING`
//    üretiyordu. Uç 200 dönüyor, satır `banned = false` kalıyordu.
//      ban öncesi okuma → 200
//      ban yanıtı       → 200
//      ban SONRASI      → 200   ← ban hiçbir şey yapmadı
//
// 3) ÜYE OLMAYANI BANLAMAK ONA ERİŞİM VERİYORDU
//    `banMember` bir üyelik satırı yazıyor, `Members.findOne` ise `banned`
//    bayrağını hiç dikkate almıyordu. Yani BANLAMAK, kişiyi ÜYE yapıyordu:
//      ban öncesi okuma → 403
//      ban SONRASI      → 200   ← ters etki
//
// Bu dosya üçünü de kilitler ve banın davetle atlatılamadığını doğrular.

import { test, expect } from '../helpers/apiTest';
import { getTokens, createTestServer, createTestChannel, joinServer } from '../helpers/bridge';
import { getCsrf } from '../helpers/csrf';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

const uid = (t: string): string => {
  try {
    const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return String(JSON.parse(Buffer.from(b, 'base64').toString('utf8')).id ?? '');
  } catch { return ''; }
};

test.describe('ban uygulaması', () => {
  let tokens: ReturnType<typeof getTokens>;

  test.beforeAll(() => { tokens = getTokens(); });

  /** Her test kendi sunucusunu alır — ban kalıcı bir durumdur, paylaşılamaz. */
  async function freshServer(request: import('@playwright/test').APIRequestContext) {
    const srv = await createTestServer(request, tokens.alice, `Ban ${Date.now()}${Math.random().toString(36).slice(2, 5)}`);
    const serverId = String((srv as { _id?: string })?._id ?? '');
    expect(serverId, 'sunucu oluşturulamadı').toBeTruthy();
    const ch = await createTestChannel(request, tokens.alice, serverId, `bn-${Date.now().toString(36)}`, 'text');
    const channelId = String((ch as { _id?: string })?._id ?? '');
    expect(channelId, 'kanal oluşturulamadı').toBeTruthy();
    const headers = {
      Authorization: `Bearer ${tokens.alice}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': await getCsrf(request, tokens.alice),
    };
    return { serverId, channelId, headers };
  }

  const readChannel = (
    request: import('@playwright/test').APIRequestContext, channelId: string, token: string,
  ) => request.get(`${BASE}/api/channels/${channelId}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // ══════════════════════════════════════════════════════════════════════════

  test('ban ucu ÇÖKMEZ — sebepli ve sebepsiz', async ({ request }) => {
    // KANITLAR    : şema ile kod uyumlu; 500 yok.
    // KANITLAMAZ  : erişimin kesildiğini (aşağıda ayrıca ölçülür).
    const { serverId, headers } = await freshServer(request);

    const noReason = await request.post(`${BASE}/api/servers/${serverId}/bans`, {
      headers, data: JSON.stringify({ userId: uid(tokens.media1) }),
    });
    expect(noReason.status(), 'sebepsiz ban çöktü').toBeLessThan(300);

    const withReason = await request.post(`${BASE}/api/servers/${serverId}/bans`, {
      headers, data: JSON.stringify({ userId: uid(tokens.media2), reason: 'spam' }),
    });
    expect(withReason.status(), 'sebepli ban çöktü').toBeLessThan(300);
  });

  test('VAR OLAN ÜYEYİ banlamak erişimi GERÇEKTEN keser', async ({ request }) => {
    // En yaygın moderasyon durumu — ve tam olarak sessizce çalışmayan durum.
    const { serverId, channelId, headers } = await freshServer(request);
    expect(await joinServer(request, tokens.alice, tokens.bob, serverId), 'bob katılamadı').toBe(true);

    // POZİTİF KONTROL: ban ÖNCESİ gerçekten erişebiliyor olmalı.
    const before = await readChannel(request, channelId, tokens.bob);
    expect(before.status(), 'üye ban öncesi okuyamıyor — test anlamsız olurdu').toBeLessThan(300);

    const ban = await request.post(`${BASE}/api/servers/${serverId}/bans`, {
      headers, data: JSON.stringify({ userId: uid(tokens.bob), reason: 'test' }),
    });
    expect(ban.status()).toBeLessThan(300);

    const after = await readChannel(request, channelId, tokens.bob);
    expect([401, 403, 404], 'BAN ETKİSİZ: banlı üye hâlâ okuyabiliyor')
      .toContain(after.status());
  });

  test('banlı sunucu kullanıcının SUNUCU LİSTESİNDEN düşer', async ({ request }) => {
    // KANITLAR    : ban yalnız uçlarda değil, listelemede de uygulanıyor.
    const { serverId, headers } = await freshServer(request);
    expect(await joinServer(request, tokens.alice, tokens.bob, serverId)).toBe(true);

    const listBefore = await request.get(`${BASE}/api/servers`, {
      headers: { Authorization: `Bearer ${tokens.bob}` },
    });
    const before = await listBefore.json().catch(() => []) as Array<{ _id?: string; id?: string }>;
    expect(before.some(s => (s._id ?? s.id) === serverId), 'sunucu listede yok — kurulum hatalı').toBe(true);

    await request.post(`${BASE}/api/servers/${serverId}/bans`, {
      headers, data: JSON.stringify({ userId: uid(tokens.bob), reason: 'liste testi' }),
    });

    const listAfter = await request.get(`${BASE}/api/servers`, {
      headers: { Authorization: `Bearer ${tokens.bob}` },
    });
    const after = await listAfter.json().catch(() => []) as Array<{ _id?: string; id?: string }>;
    expect(after.some(s => (s._id ?? s.id) === serverId), 'banlı sunucu hâlâ listede').toBe(false);
  });

  test('ÜYE OLMAYANI banlamak ona erişim VERMEZ', async ({ request }) => {
    // Ters etkili kusur: ban bir üyelik satırı yazdığı için kişiyi üye yapıyordu.
    const { serverId, channelId, headers } = await freshServer(request);

    const before = await readChannel(request, channelId, tokens.carol);
    expect([401, 403, 404], 'üye olmayan zaten erişebiliyor — kurulum hatalı')
      .toContain(before.status());

    const ban = await request.post(`${BASE}/api/servers/${serverId}/bans`, {
      headers, data: JSON.stringify({ userId: uid(tokens.carol), reason: 'ters etki testi' }),
    });
    expect(ban.status()).toBeLessThan(300);

    const after = await readChannel(request, channelId, tokens.carol);
    expect([401, 403, 404], 'BANLAMAK ERİŞİM VERDİ — ters etki geri geldi')
      .toContain(after.status());
  });

  test('banlı kullanıcı DAVETLE geri dönemez', async ({ request }) => {
    // KANITLAR    : ban tek bir davet bağlantısıyla atlatılamıyor.
    // KANITLAMAZ  : IP/cihaz düzeyinde kaçınmayı — o ayrı bir katmandır.
    const { serverId, headers } = await freshServer(request);
    expect(await joinServer(request, tokens.alice, tokens.bob, serverId)).toBe(true);

    await request.post(`${BASE}/api/servers/${serverId}/bans`, {
      headers, data: JSON.stringify({ userId: uid(tokens.bob), reason: 'davet testi' }),
    });

    // Yeni davet üret ve banlı kullanıcı ile kullanmayı dene.
    const inv = await request.post(`${BASE}/api/servers/invites`, {
      headers, data: JSON.stringify({ serverId }),
    });
    expect(inv.status(), 'davet üretilemedi').toBeLessThan(300);
    const { code } = await inv.json() as { code?: string };
    expect(code, 'davet kodu dönmedi').toBeTruthy();

    const used = await request.post(`${BASE}/api/servers/invites/${code}/use`, {
      headers: {
        Authorization: `Bearer ${tokens.bob}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': await getCsrf(request, tokens.bob),
      },
      data: JSON.stringify({}),
    });
    expect([400, 403], 'banlı kullanıcı davetle geri döndü').toContain(used.status());
  });

  test('BAN KALDIRILINCA erişim geri gelir', async ({ request }) => {
    // KANITLAR    : eleme kalıcı bir kilit değil, geri alınabilir bir durum.
    //               Bu olmadan diğer testler "her şeyi engelle" ile de geçerdi.
    const { serverId, channelId, headers } = await freshServer(request);
    expect(await joinServer(request, tokens.alice, tokens.bob, serverId)).toBe(true);

    await request.post(`${BASE}/api/servers/${serverId}/bans`, {
      headers, data: JSON.stringify({ userId: uid(tokens.bob), reason: 'geri alma testi' }),
    });
    const banned = await readChannel(request, channelId, tokens.bob);
    expect([401, 403, 404]).toContain(banned.status());

    const unban = await request.delete(`${BASE}/api/servers/${serverId}/bans/${uid(tokens.bob)}`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'X-CSRF-Token': headers['X-CSRF-Token'] },
    });
    expect(unban.status(), 'ban kaldırılamadı').toBeLessThan(300);

    // Ban kaldırıldı: kullanıcı artık davetle geri KATILABİLMELİ.
    const inv = await request.post(`${BASE}/api/servers/invites`, {
      headers, data: JSON.stringify({ serverId }),
    });
    const { code } = await inv.json() as { code?: string };
    const rejoin = await request.post(`${BASE}/api/servers/invites/${code}/use`, {
      headers: {
        Authorization: `Bearer ${tokens.bob}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': await getCsrf(request, tokens.bob),
      },
      data: JSON.stringify({}),
    });
    expect(rejoin.status(), 'ban kaldırıldı ama geri katılamadı').toBeLessThan(300);
  });

  test('ban sebebi ve denetim günlüğü ADLARI kalıcı olur', async ({ request }) => {
    // KANITLAR    : moderasyon geçmişi okunabilir — yalnız kimliklerden ibaret değil.
    const { serverId, headers } = await freshServer(request);
    const reason = `sebep-${Date.now().toString(36)}`;

    const ban = await request.post(`${BASE}/api/servers/${serverId}/bans`, {
      headers, data: JSON.stringify({ userId: uid(tokens.media1), reason }),
    });
    expect(ban.status()).toBeLessThan(300);

    const bans = await request.get(`${BASE}/api/servers/${serverId}/bans`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(JSON.stringify(await bans.json().catch(() => [])),
      'ban sebebi kaydedilmedi').toContain(reason);

    const audit = await request.get(`${BASE}/api/servers/${serverId}/audit-log`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    const raw = JSON.stringify(await audit.json().catch(() => ({})));
    expect(raw, 'denetim günlüğü aktör adını kaydetmedi').toContain('actorName');
    expect(raw, 'ban eylemi günlüğe düşmedi').toContain('"action":"ban"');
  });
});
