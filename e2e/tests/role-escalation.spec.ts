// e2e/tests/role-escalation.spec.ts
//
// YETKİ YÜKSELTME — GERİLEME TESTLERİ
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK AÇIK
// ════════════════════════════════════════════════════════════════════════════
// Bir kullanıcıya YALNIZCA `MANAGE_ROLES` verildiğinde (ADMINISTRATOR YOK),
// gerçek API ile ölçüldü:
//
//     POST /api/servers/:sid/roles  { permissions: 1073741824 }   → 200
//         (1073741824 = 1<<30 = ADMINISTRATOR)
//     POST /api/servers/:sid/members/<self>/roles { roleId }       → 200
//
// Yani kullanıcı KENDİNE ADMINISTRATOR verdi. Kazanılan gerçek yetkiler
// ölçüldü:
//     kanal oluşturma     → 200
//     denetim günlüğü     → 200
//     giden webhook açma  → 201   ← mesaj içeriğini dışarı taşıyan yüzey
//     sunucu silme        → 403   (sahiplik ayrıca koruyordu)
//     sunucu ayarları     → 403
//
// KÖK SEBEP: rol oluşturma/güncelleme, gövdeden gelen `permissions` değerini
// AKTÖRÜN KENDİ İZİNLERİYLE KARŞILAŞTIRMADAN yazıyordu. "Rolleri yönet",
// sunucu sahibinin güvendiği birine verilebilecek SINIRLI bir delegasyondur.
//
// ÇÖZÜM: aktör yalnızca KENDİSİNDE BULUNAN izinleri verebilir. Sahip ve
// ADMINISTRATOR muaftır. Üç yol birden korunur: oluşturma, güncelleme, atama.

import { test, expect } from '../helpers/apiTest';
import { getTokens, createTestServer, joinServer } from '../helpers/bridge';
import { getCsrf } from '../helpers/csrf';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

const P = {
  VIEW:          1 << 0,
  MANAGE_ROLES:  1 << 2,
  KICK:          1 << 4,
  BAN:           1 << 5,
  SEND:          1 << 8,
  ADMINISTRATOR: 1 << 30,
} as const;

const uid = (t: string): string => {
  try {
    const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return String(JSON.parse(Buffer.from(b, 'base64').toString('utf8')).id ?? '');
  } catch { return ''; }
};

test.describe('yetki yükseltme koruması', () => {
  let tokens: ReturnType<typeof getTokens>;
  let serverId = '';
  let aliceHdr: Record<string, string>;
  let bobHdr: Record<string, string>;
  let mgrRoleId = '';

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();
    const srv = await createTestServer(request, tokens.alice, `Esc ${Date.now()}`);
    serverId = String((srv as { _id?: string })?._id ?? '');
    expect(serverId, 'test sunucusu oluşturulamadı').toBeTruthy();
    expect(await joinServer(request, tokens.alice, tokens.bob, serverId), 'bob katılamadı').toBe(true);

    aliceHdr = {
      Authorization: `Bearer ${tokens.alice}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': await getCsrf(request, tokens.alice),
    };
    bobHdr = {
      Authorization: `Bearer ${tokens.bob}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': await getCsrf(request, tokens.bob),
    };

    // bob: MANAGE_ROLES + temel izinler. ADMINISTRATOR ve BAN YOK.
    const r = await request.post(`${BASE}/api/servers/${serverId}/roles`, {
      headers: aliceHdr,
      data: JSON.stringify({ name: 'RoleMgr', permissions: P.VIEW | P.SEND | P.MANAGE_ROLES }),
    });
    expect(r.status(), 'yönetici rolü oluşturulamadı').toBeLessThan(300);
    const role = await r.json() as { _id?: string; id?: string };
    mgrRoleId = String(role._id ?? role.id ?? '');
    const asg = await request.post(
      `${BASE}/api/servers/${serverId}/members/${uid(tokens.bob)}/roles`,
      { headers: aliceHdr, data: JSON.stringify({ roleId: mgrRoleId }) },
    );
    expect(asg.status(), 'rol atanamadı').toBeLessThan(300);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // YÜKSELTME ENGELLENİR
  // ══════════════════════════════════════════════════════════════════════════

  test('MANAGE_ROLES sahibi ADMINISTRATOR rolü OLUŞTURAMAZ', async ({ request }) => {
    // KANITLAR    : oluşturma yolunda izin kısıtlaması uygulanıyor.
    // KANITLAMAZ  : rol hiyerarşisinin (position) tüm kenar durumlarını.
    const res = await request.post(`${BASE}/api/servers/${serverId}/roles`, {
      headers: bobHdr,
      data: JSON.stringify({ name: 'Pwn', permissions: P.ADMINISTRATOR }),
    });
    expect(res.status()).toBe(403);
  });

  test('MANAGE_ROLES sahibi KENDİNDE OLMAYAN tekil izni veremez', async ({ request }) => {
    // ADMINISTRATOR kadar bariz olmayan durum: bob'da BAN yok.
    const res = await request.post(`${BASE}/api/servers/${serverId}/roles`, {
      headers: bobHdr,
      data: JSON.stringify({ name: 'Banner', permissions: P.VIEW | P.BAN }),
    });
    expect(res.status()).toBe(403);
  });

  test('MANAGE_ROLES sahibi MEVCUT rolü ADMINISTRATOR yapamaz', async ({ request }) => {
    // Güncelleme yolu ayrı bir kaçıştı: yeni rol yaratmak yerine kendi
    // rolünü düzenlemek aynı sonucu verirdi.
    const res = await request.patch(`${BASE}/api/servers/${serverId}/roles/${mgrRoleId}`, {
      headers: bobHdr,
      data: JSON.stringify({ permissions: P.ADMINISTRATOR }),
    });
    expect(res.status()).toBe(403);
  });

  test('MANAGE_ROLES sahibi YÜKSEK yetkili mevcut rolü ATAYAMAZ', async ({ request }) => {
    // Atama da bir izin verme işlemidir. Sahip yüksek bir rol oluşturur;
    // bob onu kendine atamaya çalışır.
    const high = await request.post(`${BASE}/api/servers/${serverId}/roles`, {
      headers: aliceHdr,
      data: JSON.stringify({ name: `High${Date.now().toString(36)}`, permissions: P.ADMINISTRATOR }),
    });
    expect(high.status(), 'sahip yüksek rol oluşturamadı').toBeLessThan(300);
    const hr = await high.json() as { _id?: string; id?: string };

    const res = await request.post(
      `${BASE}/api/servers/${serverId}/members/${uid(tokens.bob)}/roles`,
      { headers: bobHdr, data: JSON.stringify({ roleId: String(hr._id ?? hr.id) }) },
    );
    expect(res.status()).toBe(403);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // MEŞRU KULLANIM KIRILMADI — pozitif kontroller
  // ══════════════════════════════════════════════════════════════════════════

  test('SAHİP her izni verebilir', async ({ request }) => {
    // Bu olmadan yukarıdaki testler "her şeyi reddet" ile de geçerdi.
    const res = await request.post(`${BASE}/api/servers/${serverId}/roles`, {
      headers: aliceHdr,
      data: JSON.stringify({ name: `OwnerAdmin${Date.now().toString(36)}`, permissions: P.ADMINISTRATOR }),
    });
    expect(res.status()).toBeLessThan(300);
  });

  test('MANAGE_ROLES sahibi KENDİNDE OLAN izinlerle rol oluşturabilir', async ({ request }) => {
    // Delegasyon çalışmaya devam etmeli: bob VIEW+SEND sahibidir.
    const res = await request.post(`${BASE}/api/servers/${serverId}/roles`, {
      headers: bobHdr,
      data: JSON.stringify({ name: `Ok${Date.now().toString(36)}`, permissions: P.VIEW | P.SEND }),
    });
    expect(res.status(), 'meşru rol oluşturma engellendi').toBeLessThan(300);
  });

  test('MANAGE_ROLES sahibi eşdeğer rolü ATAYABİLİR', async ({ request }) => {
    const mk = await request.post(`${BASE}/api/servers/${serverId}/roles`, {
      headers: bobHdr,
      data: JSON.stringify({ name: `Peer${Date.now().toString(36)}`, permissions: P.VIEW | P.SEND }),
    });
    expect(mk.status()).toBeLessThan(300);
    const role = await mk.json() as { _id?: string; id?: string };

    const res = await request.post(
      `${BASE}/api/servers/${serverId}/members/${uid(tokens.bob)}/roles`,
      { headers: bobHdr, data: JSON.stringify({ roleId: String(role._id ?? role.id) }) },
    );
    expect(res.status(), 'meşru rol atama engellendi').toBeLessThan(300);
  });
});
