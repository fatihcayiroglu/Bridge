// e2e/tests/invites.spec.ts — Sunucu davet akışı, GERÇEK uçlara karşı.
//
// ════════════════════════════════════════════════════════════════════════════
// FINAL21 FAZ 17 — BU DOSYA ÜRÜNÜ HİÇ ÇALIŞTIRMIYORDU
// ════════════════════════════════════════════════════════════════════════════
// Ölçüldü (tools/p17-invite-surface-probe.mjs, canlı sunucu):
//
//   POST /api/invite/:code            → 404  (böyle bir rota YOK)
//   GET  /api/invite/:code/preview    → 404  (böyle bir rota YOK)
//   GET  /api/servers/:sid/invites    → 404  (davet LİSTELEME ucu yok)
//   GET  /api/servers/invites         → 404
//
// Yani "Bob sunucuya katılabilmeli", "davet önizlemesi", "davet listesi" ve
// "üye olmayan listeyi göremez" testlerinin tamamı OLMAYAN uçlara istek atıyordu.
// Geçiyorlardı, çünkü iddiaları 404'ü kabul ediyordu: `expect(status).not.toBe(401)`,
// `expect([200, 404]).toContain(status)`, `if (res.ok()) { ... }`. Katılma bozulsa,
// davet sistemi tamamen kaldırılsa bile bu dosya YEŞİL kalırdı.
//
// Gerçek uçlar:
//   POST /api/servers/invites               { serverId }   → davet oluştur
//   POST /api/servers/invites/:code/use                    → davetle katıl
//   GET  /api/servers/invites/:code/qr[/data]              → paylaşım QR'ı
//   GET  /invite/:code                                     → herkese açık önizleme sayfası
//
// Kapsanan: oluşturma, yetkisiz oluşturma, katılma + ÜYELİĞİN DOĞRULANMASI,
// tekrar katılma, geçersiz kod, QR ve herkese açık önizlemenin gizlilik sınırı.

import { test, expect } from '../helpers/apiTest';
import { getTokens, createTestServer } from '../helpers/bridge';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test.describe('Sunucu Davet Sistemi', () => {
  let tokens;
  let serverId;
  let serverName;
  let inviteCode;
  let bobId;

  test.beforeAll(async ({ request }) => {
    tokens = getTokens();
    serverName = `Invite-Server-${Date.now()}`;
    const srv = await createTestServer(request, tokens.alice, serverName);
    expect(srv, 'davet sunucusu oluşturulamadı').toBeTruthy();
    serverId = srv._id || srv.id;
    expect(serverId, 'davet sunucusu kimliği yok').toBeTruthy();

    const me = await request.get(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${tokens.bob}` } });
    expect(me.status(), 'Bob kullanıcı fikstürü doğrulanamadı').toBe(200);
    const body = await me.json();
    bobId = String(body._id || body.id);
    expect(bobId, 'Bob kullanıcı kimliği eksik').toBeTruthy();
  });

  // ── 1. Davet kodu oluşturma ───────────────────────────────

  test('POST /api/servers/invites — davet kodu oluşturulabilmeli', async ({ request }) => {
    expect(Boolean(serverId), 'davet fikstürü hazır değil').toBe(true);

    const res = await request.post(`${BASE}/api/servers/invites`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ serverId }),
    });

    expect(res.status()).toBe(200);
    const data = await res.json();
    const code = data.code || data.invite?.code;
    expect(code).toBeTruthy();
    inviteCode = code;
  });

  test('POST /api/servers/invites — maxUses ile oluşturulabilmeli', async ({ request }) => {
    expect(Boolean(serverId), 'davet fikstürü hazır değil').toBe(true);

    const res = await request.post(`${BASE}/api/servers/invites`, {
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ serverId, maxUses: 5, expiresIn: 3600 }),
    });

    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.code || data.invite?.code).toBeTruthy();
  });

  test('POST /api/servers/invites — auth olmadan 401', async ({ request }) => {
    expect(Boolean(serverId), 'davet fikstürü hazır değil').toBe(true);

    const res = await request.post(`${BASE}/api/servers/invites`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ serverId }),
    });
    expect(res.status()).toBe(401);
  });

  test('POST /api/servers/invites — üye olmayan başkasının sunucusuna davet üretemez', async ({ request }) => {
    expect(Boolean(serverId), 'davet fikstürü hazır değil').toBe(true);

    // carol fikstürde YALNIZCA üye-olmayan taraf olarak vardır.
    const res = await request.post(`${BASE}/api/servers/invites`, {
      headers: { Authorization: `Bearer ${tokens.carol}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ serverId }),
    });

    expect([403, 404]).toContain(res.status());
    const body = await res.text();
    expect(body).not.toContain(inviteCode ?? '__no_invite__');
  });

  // ── 2. Davetle katılma ────────────────────────────────────

  test('POST /api/servers/invites/:code/use — Bob katılır VE üye listesinde görünür', async ({ request }) => {
    expect(Boolean(inviteCode && serverId && bobId), 'davet fikstürü hazır değil').toBe(true);

    const join = await request.post(`${BASE}/api/servers/invites/${inviteCode}/use`, {
      headers: { Authorization: `Bearer ${tokens.bob}`, 'Content-Type': 'application/json' },
    });
    expect(join.status()).toBe(200);

    // Davetin TEK işi budur. Eski sürüm bunu `if (membersRes.ok())` içine saklıyor ve
    // bulunamazsa yalnızca konsola not düşüyordu.
    const membersRes = await request.get(`${BASE}/api/servers/${serverId}/members`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(membersRes.ok()).toBeTruthy();
    const data = await membersRes.json();
    const members = Array.isArray(data) ? data : (data.members ?? []);
    const ids = members.map((m) => String(m._id ?? m.id ?? m.userId));
    expect(ids).toContain(bobId);
  });

  test('POST /api/servers/invites/:code/use — zaten üye olan reddedilir, üyelik bozulmaz', async ({ request }) => {
    expect(Boolean(inviteCode && serverId && bobId), 'davet fikstürü hazır değil').toBe(true);

    const again = await request.post(`${BASE}/api/servers/invites/${inviteCode}/use`, {
      headers: { Authorization: `Bearer ${tokens.bob}`, 'Content-Type': 'application/json' },
    });

    expect(again.status()).toBe(400);
    expect(String((await again.json()).error)).toMatch(/already a member/i);

    // Reddedilmek üyeliği KALDIRMAMALIDIR.
    const membersRes = await request.get(`${BASE}/api/servers/${serverId}/members`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    const data = await membersRes.json();
    const members = Array.isArray(data) ? data : (data.members ?? []);
    expect(members.map((m) => String(m._id ?? m.id ?? m.userId))).toContain(bobId);
  });

  // ── 3. Geçersiz kod ───────────────────────────────────────

  test('POST /api/servers/invites/:code/use — geçersiz kod 404 ile reddedilir', async ({ request }) => {
    const res = await request.post(`${BASE}/api/servers/invites/YANLIS-KOD-XYZ-123/use`, {
      headers: { Authorization: `Bearer ${tokens.carol}`, 'Content-Type': 'application/json' },
    });

    expect(res.status()).toBe(404);
    expect(String((await res.json()).error)).toMatch(/invalid invite code/i);
  });

  test('POST /api/servers/invites/:code/use — auth olmadan 401', async ({ request }) => {
    expect(Boolean(inviteCode), 'davet fikstürü hazır değil').toBe(true);

    const res = await request.post(`${BASE}/api/servers/invites/${inviteCode}/use`, {
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(401);
  });

  // ── 4. Paylaşım yüzeyleri ─────────────────────────────────

  test('GET /api/servers/invites/:code/qr — kodu bilen için paylaşılabilir QR döner', async ({ request }) => {
    expect(Boolean(inviteCode), 'davet fikstürü hazır değil').toBe(true);

    const svg = await request.get(`${BASE}/api/servers/invites/${inviteCode}/qr`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(svg.status()).toBe(200);
    expect(await svg.text()).toContain('<svg');

    const data = await request.get(`${BASE}/api/servers/invites/${inviteCode}/qr/data`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(data.status()).toBe(200);
    const body = await data.json();
    // Bağlantı, herkese açık önizleme sayfasını göstermelidir — API ucunu değil.
    expect(String(body.inviteUrl)).toContain(`/invite/${inviteCode}`);
  });

  test('GET /invite/:code — herkese açık önizleme sunucu adını gösterir, üyeleri SIZDIRMAZ', async ({ request }) => {
    expect(Boolean(inviteCode && serverName), 'davet fikstürü hazır değil').toBe(true);

    // Paylaşım bağlantısı OTURUMSUZ açılır: davet edilen kişinin hesabı yoktur.
    const res = await request.get(`${BASE}/invite/${inviteCode}`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain(serverName);

    // Sınır: bağlantıyı ele geçiren biri sunucunun ÜYELERİNİ öğrenmemelidir.
    expect(html).not.toContain(tokens.users.alice.username);
    expect(html).not.toContain(tokens.users.bob.username);
    if (bobId) expect(html).not.toContain(bobId);
  });

  test('GET /invite/:code — bilinmeyen kod için 404 önizleme sayfası', async ({ request }) => {
    const res = await request.get(`${BASE}/invite/gecersizkod123`);
    expect(res.status()).toBe(404);
  });
});
