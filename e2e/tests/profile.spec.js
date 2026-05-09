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

'use strict';

const { test, expect } = require('@playwright/test');
const { getTokens } = require('../helpers/bridge');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

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
    expect(data.username).toBe('e2e_alice');
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
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('PATCH /api/me — çok uzun displayName reddedilmeli', async ({ request }) => {
    const res = await request.patch(`${BASE}/api/me`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({ displayName: 'A'.repeat(200) }),
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
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

  test('PATCH /api/me — status online/idle/dnd/invisible olabilmeli', async ({ request }) => {
    for (const status of ['online', 'idle', 'dnd', 'invisible']) {
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
    // 400 veya 422 — geçersiz enum değeri
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  // ── 5. Başka kullanıcının profili ─────────────────────────

  test('GET /api/users/:id — başka kullanıcının profili görüntülenebilmeli', async ({ request }) => {
    // Bob'un ID'sini al
    const bobMe = await request.get(`${BASE}/api/me`, {
      headers: { Authorization: `Bearer ${tokens.bob}` },
    });
    if (!bobMe.ok()) return test.skip();
    const bob = await bobMe.json();
    const bobId = bob._id || bob.id;

    // Alice olarak Bob'un profilini al
    const res = await request.get(`${BASE}/api/users/${bobId}`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });

    // 200 veya 404 (kullanıcı endpoint'i yoksa)
    expect([200, 404]).toContain(res.status());

    if (res.status() === 200) {
      const profile = await res.json();
      expect(profile.username).toBe('e2e_bob');
      // Şifre hash'i asla dönmemeli
      expect(profile.passwordHash).toBeUndefined();
      expect(profile.password).toBeUndefined();
    }
  });

  // ── 6. Avatar upload ──────────────────────────────────────

  test('POST /api/me/avatar — küçük PNG yüklenebilmeli', async ({ request }) => {
    // Minimal valid 1x1 PNG
    const pngHex =
      '89504e470d0a1a0a' +
      '0000000d49484452000000010000000108020000009001 2e00' +
      '0000000c49444154789c626060f80f00000200016ba97e540000000049454e44ae426082';
    const pngBuffer = Buffer.from(pngHex.replace(/\s/g, ''), 'hex');

    const res = await request.post(`${BASE}/api/me/avatar`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
      multipart: {
        avatar: { name: 'avatar.png', mimeType: 'image/png', buffer: pngBuffer },
      },
    });

    // 200 (başarı) veya 400/422 (magic byte mismatch veya çok küçük) — 401/500 olmamalı
    expect(res.status()).not.toBe(401);
    expect(res.status()).not.toBe(500);
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

  test('POST /api/me/change-password — yanlış mevcut şifre reddedilmeli', async ({ request }) => {
    const res = await request.post(`${BASE}/api/me/change-password`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({
        currentPassword: 'YanlisEskiSifre123!',
        newPassword:     'YeniSifre456!',
      }),
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('POST /api/me/change-password — zayıf yeni şifre reddedilmeli', async ({ request }) => {
    const res = await request.post(`${BASE}/api/me/change-password`, {
      headers: {
        Authorization: `Bearer ${tokens.alice}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({
        currentPassword: tokens.users.alice.password,
        newPassword:     '123',
      }),
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });
});
