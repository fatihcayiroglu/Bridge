// e2e/tests/profile.spec.ts — Sprint 14: TypeScript dönüşümü (.js → .ts)
// e2e/tests/profile.spec.js — Profil Güncelleme E2E Testleri
//
// Kapsar:
//   1. /api/me — mevcut kullanıcı bilgisi
//   2. PATCH /api/me — displayName güncelleme
//   3. PATCH /api/me — bio güncelleme
//   4. PATCH /api/me — geçersiz alan reddedilmeli
//   5. Başka kullanıcının profili görüntüleme
//   6. Avatar upload (multipart)
//   7. Şifre değiştirme


import { test, expect } from '../helpers/apiTest';
import { getTokens, registerFreshUser } from '../helpers/bridge';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

test.describe('Profil Yönetimi', () => {
  let tokens;

  test.beforeAll(() => {
    tokens = getTokens();
  });

  // ── 1. /api/me ───────────────────────────────────────────

  test('GET /api/me — mevcut kullanıcı döndürülmeli', async ({ request }) => {
    const res = await request.get(`${BASE}/api/me`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.username).toBe(tokens.users.alice.username);
    // Hassas alanlar dönmemeli
    expect(data.password).toBeUndefined();
    expect(data.passwordHash).toBeUndefined();
  });

  test('GET /api/me — token olmadan 401', async ({ request }) => {
    const res = await request.get(`${BASE}/api/me`);
    expect(res.status()).toBe(401);
  });

  // ── 2. displayName güncelleme ─────────────────────────────

  test('PATCH /api/me — displayName güncellenebilmeli', async ({ request }) => {
    const newName = `Alice E2E ${Date.now()}`;

    const res = await request.patch(`${BASE}/api/me`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ displayName: newName }),
    });

    // 200 veya 204
    expect(res.status()).toBeLessThan(300);

    // Doğrula
    const meRes = await request.get(`${BASE}/api/me`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    if (meRes.ok()) {
      const me = await meRes.json();
      expect(me.displayName).toBe(newName);
    }
  });

  test('PATCH /api/me — boş displayName reddedilmeli', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/me`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ displayName: '' }),
    });
    expect(res.status(), await res.text()).toBe(400);
  });

  test('PATCH /api/me — çok uzun displayName reddedilmeli', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/me`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ displayName: 'A'.repeat(200) }),
    });
    // ÜRÜN SÖZLEŞMESİ: aşırı uzun displayName REDDEDİLMEZ, 32 karaktere
    // KIRPILIR (server/routes/auth.ts: displayName.trim().slice(0, 32)).
    // Doğrulanan şey sınırın GERÇEKTEN uygulandığıdır.
    expect(res.status()).toBe(200);
    const saved = await res.json() as { displayName?: string };
    expect((saved.displayName ?? '').length).toBeLessThanOrEqual(32);
  });

  // ── 3. bio güncelleme ─────────────────────────────────────

  test('PATCH /api/me — bio güncellenebilmeli', async ({ request }) => {
    const bio = 'E2E test kullanıcısı 🤖';

    const res = await request.patch(`${BASE}/api/me`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ bio }),
    });

    expect(res.status()).toBeLessThan(300);
  });

  // ── 4. Status güncelleme ──────────────────────────────────

  test('PATCH /api/me — status online/idle/dnd/offline olabilmeli', async ({ request }) => {
    // Kabul edilen durumlar: online | idle | dnd | offline.
    // 'invisible' bir DURUM DEĞİLDİR — görünmezlik ayrı bir alanla yönetilir
    // (presenceVisibility: visible | hidden, migration 026_presence_visibility).
    for (const status of ['online', 'idle', 'dnd', 'offline']) {
      const res = await request.patch(`${BASE}/api/me`, {
        headers: {
          Authorization: `Bearer ${tokens.alice}`,
          'Content-Type': 'application/json',
        },
        data: JSON.stringify({ status }),
      });
      expect(res.status()).toBeLessThan(300);
    }
  });

  test('PATCH /api/me — geçersiz status reddedilmeli', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/me`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ status: 'superonline' }),
    });
    // Geçersiz enum değeri: 400 (ölçüldü). 429/5xx bir ret değildir.
    expect(res.status(), await res.text()).toBe(400);
  });

  // ── 5. Başka kullanıcının profili ─────────────────────────

  test('GET /api/users/:id — başka kullanıcının profili görüntülenebilmeli', async ({ request }) => {
    // Bob'un ID'sini al
    const bobMe = await request.get(`${BASE}/api/me`, {
      headers: { Authorization: `Bearer ${tokens.bob}` },
    });
    expect(bobMe.status(), 'Bob kullanıcı profili doğrulanamadı').toBe(200);
    const bob = await bobMe.json();
    const bobId = bob._id || bob.id;

    // Alice olarak Bob'un profilini al
    const res = await request.get(`${BASE}/api/users/${bobId}`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });

    // Final21 Faz 22 (19-37): uç VAR ve 200 döner (ölçüldü); 404'ü kabul etmek profil ucunun
    // kaybolmasını görünmez yapardı.
    expect(res.status()).toBe(200);

    if (res.status() === 200) {
      const profile = await res.json();
      expect(profile.username).toBe(tokens.users.bob.username);
      // Şifre hash'i asla dönmemeli
      expect(profile.passwordHash).toBeUndefined();
      expect(profile.password).toBeUndefined();
    }
  });

  // ── 6. Avatar upload ──────────────────────────────────────

  test('POST /api/me/avatar — küçük PNG yüklenebilmeli', async ({ request }) => {
    // Gerçekten geçerli 1×1 PNG. Eskiden "minimal valid" denen bayt dizisinin IHDR
    // CRC'si yanlıştı; yüklemeler ayrıştırıldığından bu bozuk bir dosyadır.
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

    const res = await request.post(`${BASE}/api/me/avatar`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: {
        avatar: { name: 'avatar.png', mimeType: 'image/png', buffer: pngBuffer },
      },
    });

    // Geçerli PNG avatar olur: 200 ve yeni avatar yolu. Eskiden yalnız "401/500 değil"
    // deniyordu; 400/422 (reddedilen yükleme) de geçerdi.
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json() as { avatarUrl?: string }).avatarUrl).toMatch(/^\/uploads\//);
  });

  test('POST /api/me/avatar — auth olmadan 401', async ({ request }) => {
    const res = await request.post(`${BASE}/api/me/avatar`, {
      multipart: {
        avatar: { name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from('fake') },
      },
    });
    expect(res.status()).toBe(401);
  });

  // ── 7. Şifre değiştirme ───────────────────────────────────
  // Ürün rotası `POST /api/change-password`tır (authRouter API köküne bağlı,
  // server/routes/auth.ts). Bu iki test eskiden var olmayan
  // `/api/me/change-password`'e gidiyor ve 404'ü `>= 400` ile "ret" sayıyordu:
  // parola doğrulaması HİÇ ölçülmüyordu. `changePassword` sınırı kullanıcı başına
  // 5 dk'da 3'tür ve gevşetilmez; her test kendi kalıcı kimliğiyle koşar ve
  // reddin hiçbir şeyi değiştirmediğini eski parolayla yeniden girerek kanıtlar
  // (yeni parolayla BAŞARISIZ giriş denenmez: IP'nin captcha sayacını besler).

  async function signInStatus(request: import('@playwright/test').APIRequestContext, username: string, password: string) {
    const res = await request.post(`${BASE}/api/login`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ username, password }),
    });
    return res.status();
  }

  test('POST /api/change-password — yanlış mevcut şifre reddedilmeli', async ({ request }) => {
    const who = await registerFreshUser(request, 'chpwdwrong');
    const res = await request.post(`${BASE}/api/change-password`, {
      headers: {
        Authorization: `Bearer ${who.token}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({
        currentPassword: 'YanlisEskiSifre123!',
        newPassword:     'YeniSifre456!',
      }),
    });
    expect(res.status(), await res.text()).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Current password is incorrect' });
    expect(await signInStatus(request, who.username, who.password), 'eski parola geçerli kalmalı').toBe(200);
  });

  test('POST /api/change-password — zayıf yeni şifre reddedilmeli', async ({ request }) => {
    const who = await registerFreshUser(request, 'chpwdweak');
    const res = await request.post(`${BASE}/api/change-password`, {
      headers: {
        Authorization: `Bearer ${who.token}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({
        currentPassword: who.password,
        newPassword:     '123',
      }),
    });
    expect(res.status(), await res.text()).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'newPassword must be at least 8 characters' });
    expect(await signInStatus(request, who.username, who.password), 'eski parola geçerli kalmalı').toBe(200);
  });
});
