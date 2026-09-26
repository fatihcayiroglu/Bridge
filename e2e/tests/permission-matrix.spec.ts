// e2e/tests/permission-matrix.spec.ts
//
// ROL / İZİN MATRİSİ + MODERASYON YETKİLERİ — ARKA UÇ ZORLAMASI
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// Arayüzde bir düğmeyi GİZLEMEK yetkilendirme DEĞİLDİR. Bu dosya arayüze hiç
// bakmaz: her eylemi doğrudan ürünün API ucuna, her rol için sürer ve
// yetkisiz olanın FAIL-CLOSED (401/403/404) döndüğünü doğrular.
//
// ROLLER (Bridge modelinde):
//   Owner      — sunucu sahibi; `canActOn` onu her zaman üstün sayar
//   Admin      — ADMINISTRATOR (1<<30) biti
//   Moderator  — KICK/BAN/TIMEOUT/MANAGE_MESSAGES, ADMIN yok
//   Member     — DEFAULT_PERMISSIONS (görüntüle, yaz, sesli katıl)
//   Guest      — sunucuya ÜYE OLMAYAN kimlik (Bridge'de ayrı bir "guest"
//                rolü yoktur; üye olmamak bu sınıfın gerçek karşılığıdır)
//   Blocked    — banlanmış kullanıcı
//
// HER TESTTE: KANITLAR / KANITLAMAZ ayrımı yazılır.

import { test, expect } from '../helpers/apiTest';
import { getTokens, createTestServer, createTestChannel, joinServer } from '../helpers/bridge';
import { getCsrf } from '../helpers/csrf';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

/** server/lib/permissions.ts ile birebir aynı bitler. */
const P = {
  VIEW_CHANNELS:   1 << 0,
  MANAGE_CHANNELS: 1 << 1,
  MANAGE_ROLES:    1 << 2,
  MANAGE_SERVER:   1 << 3,
  KICK_MEMBERS:    1 << 4,
  BAN_MEMBERS:     1 << 5,
  TIMEOUT_MEMBERS: 1 << 7,
  SEND_MESSAGES:   1 << 8,
  MANAGE_MESSAGES: 1 << 9,
  CONNECT:         1 << 16,
  ADMINISTRATOR:   1 << 30,
} as const;

const uid = (t: string): string => {
  try {
    const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return String(JSON.parse(Buffer.from(b, 'base64').toString('utf8')).id ?? '');
  } catch { return ''; }
};

type Ctx = import('@playwright/test').APIRequestContext;

test.describe('rol / izin matrisi — arka uç zorlaması', () => {
  let tokens: ReturnType<typeof getTokens>;
  let serverId = '';
  let channelId = '';
  let csrf: Record<string, string> = {};

  // alice = Owner, bob = Moderator, carol = Guest (üye değil), media1 = Member
  const ROLE_OF = { alice: 'Owner', bob: 'Moderator', carol: 'Guest', media1: 'Member' } as const;

  async function hdr(request: Ctx, who: keyof typeof ROLE_OF) {
    const token = tokens[who] as string;
    csrf[who] ??= await getCsrf(request, token);
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf[who],
    };
  }

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();
    csrf = {};

    const srv = await createTestServer(request, tokens.alice, `Matrix ${Date.now()}`);
    serverId = String((srv as { _id?: string })?._id ?? '');
    expect(serverId, 'matris sunucusu oluşturulamadı').toBeTruthy();

    const ch = await createTestChannel(request, tokens.alice, serverId, `mx-${Date.now().toString(36)}`, 'text');
    channelId = String((ch as { _id?: string })?._id ?? '');
    expect(channelId, 'matris kanalı oluşturulamadı').toBeTruthy();

    // bob ve media1 üye olur; carol BİLEREK dışarıda kalır.
    expect(await joinServer(request, tokens.alice, tokens.bob, serverId), 'bob katılamadı').toBe(true);
    expect(await joinServer(request, tokens.alice, tokens.media1, serverId), 'media1 katılamadı').toBe(true);

    // bob'a moderatör rolü — ADMINISTRATOR YOK.
    const aliceHdr = await hdr(request, 'alice');
    const roleRes = await request.post(`${BASE}/api/servers/${serverId}/roles`, {
      headers: aliceHdr,
      data: JSON.stringify({
        name: 'Moderator',
        permissions: P.VIEW_CHANNELS | P.SEND_MESSAGES | P.KICK_MEMBERS
          | P.BAN_MEMBERS | P.TIMEOUT_MEMBERS | P.MANAGE_MESSAGES,
      }),
    });
    expect(roleRes.status(), 'moderatör rolü oluşturulamadı').toBeLessThan(300);
    const role = await roleRes.json() as { _id?: string; id?: string };
    const roleId = String(role._id ?? role.id ?? '');
    expect(roleId, 'rol kimliği dönmedi').toBeTruthy();

    const assign = await request.post(
      `${BASE}/api/servers/${serverId}/members/${uid(tokens.bob)}/roles`,
      { headers: aliceHdr, data: JSON.stringify({ roleId }) },
    );
    expect(assign.status(), 'moderatör rolü atanamadı').toBeLessThan(300);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1. YETKİ YÜKSELTME — en kritik sınıf
  // ══════════════════════════════════════════════════════════════════════════

  test('MODERATÖR kendine ADMINISTRATOR rolü veremez', async ({ request }) => {
    // KANITLAR    : MANAGE_ROLES sahibi olmayan bir moderatör rol üretemez.
    // KANITLAMAZ  : MANAGE_ROLES'i OLAN birinin sınırlarını (ayrı test).
    const res = await request.post(`${BASE}/api/servers/${serverId}/roles`, {
      headers: await hdr(request, 'bob'),
      data: JSON.stringify({ name: 'Pwn', permissions: P.ADMINISTRATOR }),
    });
    expect([401, 403]).toContain(res.status());
  });

  test('ÜYE rol oluşturamaz', async ({ request }) => {
    const res = await request.post(`${BASE}/api/servers/${serverId}/roles`, {
      headers: await hdr(request, 'media1'),
      data: JSON.stringify({ name: 'MemberPwn', permissions: P.ADMINISTRATOR }),
    });
    expect([401, 403]).toContain(res.status());
  });

  test('ÜYE OLMAYAN rol oluşturamaz', async ({ request }) => {
    const res = await request.post(`${BASE}/api/servers/${serverId}/roles`, {
      headers: await hdr(request, 'carol'),
      data: JSON.stringify({ name: 'GuestPwn', permissions: P.ADMINISTRATOR }),
    });
    expect([401, 403, 404]).toContain(res.status());
  });

  test('ÜYE kendine rol ATAYAMAZ', async ({ request }) => {
    // Rol atama MANAGE_ROLES ister; üyede yoktur.
    const roles = await request.get(`${BASE}/api/servers/${serverId}/roles`, {
      headers: await hdr(request, 'alice'),
    });
    const list = await roles.json() as Array<{ _id?: string; id?: string; name?: string }>;
    const mod = list.find(r => r.name === 'Moderator');
    expect(mod, 'moderatör rolü listede yok').toBeTruthy();

    const res = await request.post(
      `${BASE}/api/servers/${serverId}/members/${uid(tokens.media1)}/roles`,
      { headers: await hdr(request, 'media1'), data: JSON.stringify({ roleId: mod!._id ?? mod!.id }) },
    );
    expect([401, 403]).toContain(res.status());
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. MODERASYON — ban / kick / timeout
  // ══════════════════════════════════════════════════════════════════════════

  test('ÜYE ban ATAMAZ', async ({ request }) => {
    const res = await request.post(`${BASE}/api/servers/${serverId}/bans`, {
      headers: await hdr(request, 'media1'),
      data: JSON.stringify({ userId: uid(tokens.bob), reason: 'test' }),
    });
    expect([401, 403]).toContain(res.status());
  });

  test('ÜYE OLMAYAN ban ATAMAZ', async ({ request }) => {
    const res = await request.post(`${BASE}/api/servers/${serverId}/bans`, {
      headers: await hdr(request, 'carol'),
      data: JSON.stringify({ userId: uid(tokens.bob), reason: 'test' }),
    });
    expect([401, 403, 404]).toContain(res.status());
  });

  test('MODERATÖR sunucu SAHİBİNİ banlayamaz', async ({ request }) => {
    // KANITLAR    : sahiplik koruması moderasyon yetkisinin ÜSTÜNDEDİR.
    const res = await request.post(`${BASE}/api/servers/${serverId}/bans`, {
      headers: await hdr(request, 'bob'),
      data: JSON.stringify({ userId: uid(tokens.alice), reason: 'takeover' }),
    });
    expect([403]).toContain(res.status());
  });

  test('MODERATÖR KENDİNİ banlayamaz', async ({ request }) => {
    const res = await request.post(`${BASE}/api/servers/${serverId}/bans`, {
      headers: await hdr(request, 'bob'),
      data: JSON.stringify({ userId: uid(tokens.bob), reason: 'self' }),
    });
    expect([400, 403]).toContain(res.status());
  });

  test('ÜYE kick ATAMAZ', async ({ request }) => {
    const res = await request.post(
      `${BASE}/api/servers/${serverId}/members/${uid(tokens.bob)}/kick`,
      { headers: await hdr(request, 'media1'), data: JSON.stringify({ reason: 'test' }) },
    );
    expect([401, 403]).toContain(res.status());
  });

  test('ÜYE timeout ATAMAZ', async ({ request }) => {
    const res = await request.post(
      `${BASE}/api/servers/${serverId}/members/${uid(tokens.bob)}/timeout`,
      { headers: await hdr(request, 'media1'), data: JSON.stringify({ durationMs: 10 * 60_000 }) },
    );
    expect([401, 403]).toContain(res.status());
  });

  test('MODERATÖR sunucu sahibine timeout VEREMEZ', async ({ request }) => {
    const res = await request.post(
      `${BASE}/api/servers/${serverId}/members/${uid(tokens.alice)}/timeout`,
      { headers: await hdr(request, 'bob'), data: JSON.stringify({ durationMs: 10 * 60_000 }) },
    );
    expect([400, 403]).toContain(res.status());
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. SUNUCU / KANAL YÖNETİMİ
  // ══════════════════════════════════════════════════════════════════════════

  test('ÜYE sunucuyu SİLEMEZ', async ({ request }) => {
    const res = await request.delete(`${BASE}/api/servers/${serverId}`, {
      headers: await hdr(request, 'media1'),
    });
    expect([401, 403]).toContain(res.status());
  });

  test('MODERATÖR sunucuyu SİLEMEZ', async ({ request }) => {
    // Moderasyon yetkisi sahiplik DEĞİLDİR.
    const res = await request.delete(`${BASE}/api/servers/${serverId}`, {
      headers: await hdr(request, 'bob'),
    });
    expect([401, 403]).toContain(res.status());
  });

  test('ÜYE kanal OLUŞTURAMAZ', async ({ request }) => {
    const res = await request.post(`${BASE}/api/servers/${serverId}/channels`, {
      headers: await hdr(request, 'media1'),
      data: JSON.stringify({ name: `x${Date.now().toString(36)}`, type: 'text' }),
    });
    expect([401, 403]).toContain(res.status());
  });

  test('ÜYE kanal SİLEMEZ', async ({ request }) => {
    const res = await request.delete(`${BASE}/api/servers/${serverId}/channels/${channelId}`, {
      headers: await hdr(request, 'media1'),
    });
    expect([401, 403]).toContain(res.status());
  });

  test('ÜYE sunucu ayarlarını DEĞİŞTİREMEZ', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/servers/${serverId}`, {
      headers: await hdr(request, 'media1'),
      data: JSON.stringify({ name: 'hijacked' }),
    });
    expect([401, 403]).toContain(res.status());
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. OKUMA SINIRLARI — üye olmayan hiçbir şey göremez
  // ══════════════════════════════════════════════════════════════════════════

  test('ÜYE OLMAYAN kanal mesajlarını OKUYAMAZ', async ({ request }) => {
    const res = await request.get(`${BASE}/api/channels/${channelId}/messages`, {
      headers: await hdr(request, 'carol'),
    });
    expect([401, 403, 404]).toContain(res.status());
  });

  test('ÜYE OLMAYAN üye listesini GÖREMEZ', async ({ request }) => {
    const res = await request.get(`${BASE}/api/servers/${serverId}/members`, {
      headers: await hdr(request, 'carol'),
    });
    expect([401, 403, 404]).toContain(res.status());
  });

  test('ÜYE OLMAYAN denetim günlüğünü GÖREMEZ', async ({ request }) => {
    // Denetim günlüğü moderasyon geçmişidir — sızması ciddi olurdu.
    const res = await request.get(`${BASE}/api/servers/${serverId}/audit-log`, {
      headers: await hdr(request, 'carol'),
    });
    expect([401, 403, 404]).toContain(res.status());
  });

  test('ÜYE denetim günlüğünü GÖREMEZ', async ({ request }) => {
    const res = await request.get(`${BASE}/api/servers/${serverId}/audit-log`, {
      headers: await hdr(request, 'media1'),
    });
    expect([401, 403]).toContain(res.status());
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. POZİTİF KONTROLLER — kural körü körüne engellemiyor
  // ══════════════════════════════════════════════════════════════════════════

  test('SAHİP kanal oluşturabilir', async ({ request }) => {
    const res = await request.post(`${BASE}/api/servers/${serverId}/channels`, {
      headers: await hdr(request, 'alice'),
      data: JSON.stringify({ name: `ok${Date.now().toString(36)}`, type: 'text' }),
    });
    expect(res.status()).toBeLessThan(300);
  });

  test('SAHİP denetim günlüğünü görebilir', async ({ request }) => {
    const res = await request.get(`${BASE}/api/servers/${serverId}/audit-log`, {
      headers: await hdr(request, 'alice'),
    });
    expect(res.status()).toBeLessThan(300);
  });

  test('ÜYE kanal mesajlarını okuyabilir', async ({ request }) => {
    const res = await request.get(`${BASE}/api/channels/${channelId}/messages`, {
      headers: await hdr(request, 'media1'),
    });
    expect(res.status()).toBeLessThan(300);
  });

  test('MODERATÖR denetim günlüğünü görebilir', async ({ request }) => {
    const res = await request.get(`${BASE}/api/servers/${serverId}/audit-log`, {
      headers: await hdr(request, 'bob'),
    });
    expect(res.status()).toBeLessThan(300);
  });
});
