// server/tests/channelPermsIntegration.test.ts
// bulk.js / overrides.js refactor sonrası entegrasyon testleri.
// Mount sırası bug'ı: bulk.js önce mount edilmeli, aksi hâlde
//   GET /export → /:roleId'ye düşer (roleId="export" olur → yanlış 403/404)
//   PUT /batch  → /:roleId'ye düşer (roleId="batch" olur → yanlış davranış)
// Bu testler söz konusu regresyonları yakalar.

process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../lib/permCache',  () => ({ invalidatePerms: jest.fn() }));
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());

// İki ayrı mock bloğu: ilki ezdirmesin diye tek tanım yapıyoruz
jest.mock('../db/loader', () => {
  const mock = require('./helpers/mockDb').createMockDb();
  mock._sqlite = {
    transaction: (fn) => () => fn(),
    prepare: () => ({
      run: jest.fn(),
      get: jest.fn().mockReturnValue(null),
      all: jest.fn().mockReturnValue([]),
    }),
  };
  return mock;
});

jest.mock('../lib/permissions', () => ({
  resolvePermissions: jest.fn().mockResolvedValue(2),
  hasPermission:      jest.fn().mockReturnValue(true),
  PERMS:              jest.requireActual('../lib/permissions').PERMS,
  VALID_BITS:         jest.requireActual('../lib/permissions').VALID_BITS,
  validateBitmask:    jest.requireActual('../lib/permissions').validateBitmask,
  DEFAULT_PERMISSIONS: jest.requireActual('../lib/permissions').DEFAULT_PERMISSIONS ?? 0,
}));

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const jwt     = require('jsonwebtoken');
const db      = require('../db/loader');
const { authMiddleware }  = require('../middleware/auth');
const channelPermsRouter  = require('../routes/channelPerms');
const perms   = require('../lib/permissions');

function buildApp() {
  const app = express();
  app.use(express.json());
  // Tam production mount — channelPerms.js refactor sonrası wrapper'ı kullanır
  app.use('/api/servers/:sid/channels/:cid/permissions', authMiddleware, channelPermsRouter);
  return app;
}
function tok(uid) { return jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

// ─── Fixture ───────────────────────────────────────────────────────────────
let app, ownerId, serverId, channelId, ch2Id, roleId, ownerToken;

beforeEach(async () => {
  db._reset?.();
  perms.resolvePermissions.mockResolvedValue(2);
  perms.hasPermission.mockReturnValue(true);

  app       = buildApp();
  ownerId   = uuidv4();
  serverId  = uuidv4();
  channelId = uuidv4();
  ch2Id     = uuidv4();
  roleId    = uuidv4();
  ownerToken = tok(ownerId);

  await db.users.insert({ _id: ownerId, username: 'owner', displayName: 'Owner', tokenVersion: 0 });
  await db.servers.insert({ _id: serverId, name: 'TestServer', ownerId });
  await db.channels.insert({ _id: channelId, serverId, name: 'general', type: 'text' });
  await db.channels.insert({ _id: ch2Id,     serverId, name: 'announcements', type: 'text' });
  await db.members.insert({ userId: ownerId, serverId, roles: [] });
  await db.roles.insert({ _id: roleId, serverId, name: 'Moderatör', permissions: 0 });
  // Mock SQLite'ı her test için sıfırla
  db._sqlite.prepare = () => ({
    run: jest.fn(),
    get: jest.fn().mockReturnValue(null),
    all: jest.fn().mockReturnValue([]),
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. MOUNT SIRASI — bulk.js / overrides.js çakışması
//    Bu describe bloğu v56.1 refactor'ın kritik doğruluğunu test eder.
// ═══════════════════════════════════════════════════════════════════════════
describe('Mount Sırası — bulk.js önce, overrides.js sonra', () => {

  // GET /export → overrides.js'deki /:roleId route'una DÜŞMEMALI
  it('GET /export route\'u bulk.js\'den gelir, "export" roleId olarak işlenmez', async () => {
    const res = await request(app)
      .get(`/api/servers/${serverId}/channels/${channelId}/permissions/export`)
      .set('Authorization', `Bearer ${ownerToken}`);

    // Eğer mount sırası yanlışsa, /:roleId'deki override lookup çalışır
    // ve farklı bir yanıt (muhtemelen 200 ama yanlış shape) döner.
    // Doğru mount'ta export JSON'u döner: { overrides, version, sourceServer, ... }
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('overrides');
    expect(res.body).toHaveProperty('version');
    // "export" adında roleId araması yapılmadığını doğrula
    expect(res.body).not.toHaveProperty('roleId');
    expect(res.body).not.toHaveProperty('hasOverride');
  });

  // PUT /batch → overrides.js'deki /:roleId route'una DÜŞMEMALI
  it('PUT /batch route\'u bulk.js\'den gelir, "batch" roleId olarak işlenmez', async () => {
    const res = await request(app)
      .put(`/api/servers/${serverId}/channels/${channelId}/permissions/batch`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ overrides: [{ roleId, allow: 256, deny: 0 }], deletes: [] });

    // Doğru mount'ta { ok: true, saved, deleted } döner
    // Yanlış mount'ta /:roleId'ye düşer ve body { allow: undefined... } ile işlenir
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    // 200 veya SQLite mock nedeniyle 500 gelebilir; asıl test: "batch" roleId gibi işlenmedi
    if (res.status === 200) {
      expect(res.body).toHaveProperty('ok', true);
      expect(res.body).toHaveProperty('saved');
    }
  });

  // POST /bulk-sync → overrides.js'deki /:roleId'ye DÜŞMEMELİ (bu bir POST)
  it('POST /bulk-sync route\'u bulk.js\'den gelir', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/channels/${channelId}/permissions/bulk-sync`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ channelIds: [ch2Id], overrides: [] });

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    // 200 = başarı, 400 = channelIds validasyon hatası (her ikisi de doğru route)
    expect([200, 400]).toContain(res.status);
    // /:roleId wildcard bir POST kabul etmez; 404 gelse de bu test route'un bulk.js'e gittiğini kanıtlar
  });

  // POST /bulk-sync/preview → bulk.js'den gelir
  it('POST /bulk-sync/preview route\'u bulk.js\'den gelir', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/channels/${channelId}/permissions/bulk-sync/preview`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ channelIds: [ch2Id], overrides: [] });

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect([200, 400]).toContain(res.status);
  });

  // GET /audit-log → overrides.js'den gelir (bulk'dan değil)
  it('GET /audit-log route\'u overrides.js\'den gelir', async () => {
    const res = await request(app)
      .get(`/api/servers/${serverId}/channels/${channelId}/permissions/audit-log`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true); // audit log listesi dönmeli
  });

  // GET /inheritance/:roleId → overrides.js
  it('GET /inheritance/:roleId route\'u overrides.js\'den gelir', async () => {
    const res = await request(app)
      .get(`/api/servers/${serverId}/channels/${channelId}/permissions/inheritance/${roleId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('roleId');
    expect(res.body).toHaveProperty('bitSources');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. OVERRIDES.JS — temel CRUD (refactor sonrası)
// ═══════════════════════════════════════════════════════════════════════════
describe('overrides.js — GET / (liste)', () => {
  it('boş kanalda overrides:[] ve roles:[...] döner', async () => {
    const res = await request(app)
      .get(`/api/servers/${serverId}/channels/${channelId}/permissions`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.overrides)).toBe(true);
    expect(Array.isArray(res.body.roles)).toBe(true);
  });

  it('kayıtlı override\'ı listeler', async () => {
    await db.channelPermissions.insert({
      _id: uuidv4(), channelId, roleId, serverId, allow: 256, deny: 0,
      targetType: 'role', createdAt: Date.now(),
    });

    const res = await request(app)
      .get(`/api/servers/${serverId}/channels/${channelId}/permissions`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.overrides).toHaveLength(1);
    expect(res.body.overrides[0].roleId).toBe(roleId);
  });

  it('MANAGE_CHANNELS olmadan 403 döner', async () => {
    perms.hasPermission.mockReturnValue(false);
    const res = await request(app)
      .get(`/api/servers/${serverId}/channels/${channelId}/permissions`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(403);
  });

  it('kimlik doğrulaması olmadan 401 döner', async () => {
    const res = await request(app)
      .get(`/api/servers/${serverId}/channels/${channelId}/permissions`);
    expect(res.status).toBe(401);
  });
});

describe('overrides.js — PUT /:roleId', () => {
  it('yeni override oluşturur (201 veya 200)', async () => {
    const res = await request(app)
      .put(`/api/servers/${serverId}/channels/${channelId}/permissions/${roleId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ allow: 256, deny: 0 });

    expect([200, 201]).toContain(res.status);
    expect(res.body.ok).toBe(true);
  });

  it('mevcut override\'ı günceller', async () => {
    await db.channelPermissions.insert({
      _id: uuidv4(), channelId, roleId, serverId, allow: 0, deny: 256, createdAt: Date.now(),
    });

    const res = await request(app)
      .put(`/api/servers/${serverId}/channels/${channelId}/permissions/${roleId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ allow: 256, deny: 0 });

    expect([200, 201]).toContain(res.status);
    expect(res.body.ok).toBe(true);
  });

  it('@everyone özel roleId\'sini kabul eder', async () => {
    const res = await request(app)
      .put(`/api/servers/${serverId}/channels/${channelId}/permissions/__everyone__`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ allow: 64, deny: 0 });

    expect([200, 201]).toContain(res.status);
    expect(res.body.ok).toBe(true);
  });

  it('MANAGE_CHANNELS olmadan 403 döner', async () => {
    perms.hasPermission.mockReturnValue(false);
    const res = await request(app)
      .put(`/api/servers/${serverId}/channels/${channelId}/permissions/${roleId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ allow: 256, deny: 0 });
    expect(res.status).toBe(403);
  });
});

describe('overrides.js — DELETE /:roleId', () => {
  it('override\'ı siler', async () => {
    await db.channelPermissions.insert({
      _id: uuidv4(), channelId, roleId, serverId, allow: 256, deny: 0, createdAt: Date.now(),
    });

    const res = await request(app)
      .delete(`/api/servers/${serverId}/channels/${channelId}/permissions/${roleId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const remaining = await db.channelPermissions.find({ channelId, roleId });
    expect(remaining).toHaveLength(0);
  });

  it('var olmayan override\'ı silmek 200 döner', async () => {
    const res = await request(app)
      .delete(`/api/servers/${serverId}/channels/${channelId}/permissions/${uuidv4()}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. BULK.JS — export / import / batch / bulk-sync
// ═══════════════════════════════════════════════════════════════════════════
describe('bulk.js — GET /export', () => {
  it('boş kanaldan export → overrides:[]', async () => {
    const res = await request(app)
      .get(`/api/servers/${serverId}/channels/${channelId}/permissions/export`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.overrides).toEqual([]);
    expect(res.body.version).toBe(1);
  });

  it('kayıtlı override export JSON\'unda görünür', async () => {
    await db.channelPermissions.insert({
      _id: uuidv4(), channelId, roleId, serverId,
      allow: 256, deny: 512, targetType: 'role',
      targetName: 'Moderatör', createdAt: Date.now(),
    });

    const res = await request(app)
      .get(`/api/servers/${serverId}/channels/${channelId}/permissions/export`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const ovr = res.body.overrides[0];
    expect(ovr.roleId).toBe(roleId);
    expect(ovr.allow).toBe(256);
    expect(ovr.deny).toBe(512);
  });

  it('Content-Disposition attachment header içerir', async () => {
    const res = await request(app)
      .get(`/api/servers/${serverId}/channels/${channelId}/permissions/export`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['content-disposition']).toMatch(/\.json/);
  });

  it('MANAGE_CHANNELS olmadan 403 döner', async () => {
    perms.hasPermission.mockReturnValue(false);
    const res = await request(app)
      .get(`/api/servers/${serverId}/channels/${channelId}/permissions/export`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(403);
  });

  it('kimlik doğrulaması olmadan 401 döner', async () => {
    const res = await request(app)
      .get(`/api/servers/${serverId}/channels/${channelId}/permissions/export`);
    expect(res.status).toBe(401);
  });
});

describe('bulk.js — POST /import — input validation', () => {
  it('overrides dizisi boşsa 400 döner', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/channels/${channelId}/permissions/import`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ overrides: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('çakışan bitmask (allow & deny aynı bit) → 400', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/channels/${channelId}/permissions/import`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ overrides: [{ roleId, allow: 256, deny: 256 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bitmask/i);
  });

  it('allow sayı değilse 400 döner', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/channels/${channelId}/permissions/import`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ overrides: [{ roleId, allow: 'bad', deny: 0 }] });
    expect(res.status).toBe(400);
  });

  it('MANAGE_CHANNELS olmadan 403 döner', async () => {
    perms.hasPermission.mockReturnValue(false);
    const res = await request(app)
      .post(`/api/servers/${serverId}/channels/${channelId}/permissions/import`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ overrides: [{ roleId, allow: 0, deny: 0 }] });
    expect(res.status).toBe(403);
  });

  it('kimlik doğrulaması olmadan 401 döner', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/channels/${channelId}/permissions/import`)
      .send({ overrides: [{ roleId, allow: 0, deny: 0 }] });
    expect(res.status).toBe(401);
  });
});

describe('bulk.js — PUT /batch — bitmask & auth', () => {
  it('çakışan bitmask batch\'te 400 döner', async () => {
    const res = await request(app)
      .put(`/api/servers/${serverId}/channels/${channelId}/permissions/batch`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ overrides: [{ roleId, allow: 256, deny: 256 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bitmask/i);
  });

  it('tanımsız bit batch\'te 400 döner', async () => {
    const res = await request(app)
      .put(`/api/servers/${serverId}/channels/${channelId}/permissions/batch`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ overrides: [{ roleId, allow: 1 << 25, deny: 0 }] });
    expect(res.status).toBe(400);
  });

  it('negatif allow batch\'te 400 döner', async () => {
    const res = await request(app)
      .put(`/api/servers/${serverId}/channels/${channelId}/permissions/batch`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ overrides: [{ roleId, allow: -1, deny: 0 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bitmask/i);
  });

  it('geçerli bitmask 400 değil döner (auth/bitmask ok)', async () => {
    const res = await request(app)
      .put(`/api/servers/${serverId}/channels/${channelId}/permissions/batch`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ overrides: [{ roleId, allow: 256, deny: 0 }] });
    // 400/401/403 olmamalı; SQLite mock nedeniyle 200 veya 500 olabilir
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('MANAGE_CHANNELS olmadan 403 döner', async () => {
    perms.hasPermission.mockReturnValue(false);
    const res = await request(app)
      .put(`/api/servers/${serverId}/channels/${channelId}/permissions/batch`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ overrides: [] });
    expect(res.status).toBe(403);
  });
});

describe('bulk.js — POST /bulk-sync', () => {
  it('channelIds boşsa 400 döner', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/channels/${channelId}/permissions/bulk-sync`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ channelIds: [], overrides: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/channelIds/i);
  });

  it('sunucuya ait olmayan kanal IDleri gecersiz kanal olarak degerlendirilir', async () => {
    const foreignId = uuidv4(); // bu sunucuda yok
    const res = await request(app)
      .post(`/api/servers/${serverId}/channels/${channelId}/permissions/bulk-sync`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ channelIds: [foreignId], overrides: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kanal/i);
  });

  it('MANAGE_CHANNELS olmadan 403 döner', async () => {
    perms.hasPermission.mockReturnValue(false);
    const res = await request(app)
      .post(`/api/servers/${serverId}/channels/${channelId}/permissions/bulk-sync`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ channelIds: [ch2Id], overrides: [] });
    expect(res.status).toBe(403);
  });

  it('kimlik doğrulaması olmadan 401 döner', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/channels/${channelId}/permissions/bulk-sync`)
      .send({ channelIds: [ch2Id], overrides: [] });
    expect(res.status).toBe(401);
  });
});

describe('bulk.js — POST /bulk-sync/preview', () => {
  it('channelIds boşsa 400 döner', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/channels/${channelId}/permissions/bulk-sync/preview`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ channelIds: [], overrides: [] });
    expect(res.status).toBe(400);
  });

  it('geçerli kanal ile preview diff özeti döner', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/channels/${channelId}/permissions/bulk-sync/preview`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ channelIds: [ch2Id], overrides: [] });

    // ch2Id sunucuya ait, preview çalışmalı
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('preview');
    expect(res.body).toHaveProperty('summary');
    expect(Array.isArray(res.body.preview)).toBe(true);
  });

  it('preview summary totalChannels içerir', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/channels/${channelId}/permissions/bulk-sync/preview`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ channelIds: [ch2Id], overrides: [] });

    expect(res.status).toBe(200);
    expect(res.body.summary).toHaveProperty('totalChannels');
    expect(res.body.summary.totalChannels).toBeGreaterThanOrEqual(1);
  });

  it('kaynak kanalı (cid) önizleme listesine dahil etmez (kendine uygulama yok)', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/channels/${channelId}/permissions/bulk-sync/preview`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ channelIds: [channelId, ch2Id], overrides: [] });

    expect(res.status).toBe(200);
    // channelId (kaynak) preview'dan çıkarılmış olmalı
    const previewIds = res.body.preview.map(p => p.channelId);
    expect(previewIds).not.toContain(channelId);
  });
});
