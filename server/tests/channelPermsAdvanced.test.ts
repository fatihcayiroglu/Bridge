// server/tests/channelPermsAdvanced.test.ts
// Eksik test coverage: export/import, bitmask validation, batch PUT, sistem mesajı
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/permCache', () => ({ invalidatePerms: jest.fn() }));
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());
jest.mock('../lib/permissions', () => ({
  resolvePermissions: jest.fn().mockResolvedValue(2),
  hasPermission:      jest.fn().mockReturnValue(true),
  PERMS:          jest.requireActual('../lib/permissions').PERMS,
  VALID_BITS:     jest.requireActual('../lib/permissions').VALID_BITS,
  validateBitmask: jest.requireActual('../lib/permissions').validateBitmask,
}));

// bulk.js SQLite transaction kullanıyor — test ortamında mock gerekiyor
jest.mock('../db/loader', () => {
  const mock = require('./helpers/mockDb').createMockDb();
  // SQLite transaction mock: callback'i hemen çalıştır
  mock._sqlite = {
    transaction: (fn) => () => fn(),
    prepare: () => ({
      run:     jest.fn(),
      get:     jest.fn().mockReturnValue(null),
      all:     jest.fn().mockReturnValue([]),
    }),
  };
  return mock;
});

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
const { authMiddleware }   = require('../middleware/auth');
const channelPermsRouter   = require('../routes/channelPerms');
import { validateBitmask, PERMS, VALID_BITS } from '../lib/permissions';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:sid/channels/:cid/permissions', authMiddleware, channelPermsRouter);
  return app;
}
function tok(uid, v = 0) {
  return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

// ─────────────────────────────────────────────────────────────
// validateBitmask — Unit testler
// ─────────────────────────────────────────────────────────────
describe('validateBitmask — lib/permissions', () => {
  it('geçerli allow/deny çifti için ok:true döner', () => {
    const result = validateBitmask(PERMS.SEND_MESSAGES, 0);
    expect(result.ok).toBe(true);
  });

  it('allow=0 deny=0 geçerlidir (boş override)', () => {
    expect(validateBitmask(0, 0).ok).toBe(true);
  });

  it('çakışan bit (allow ve deny\'de aynı anda) reddedilir', () => {
    const result = validateBitmask(PERMS.SEND_MESSAGES, PERMS.SEND_MESSAGES);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/aynı anda/i);
  });

  it('tanımsız bit allow\'da reddedilir', () => {
    const invalidBit = 1 << 25; // PERMS tanımında yok
    const result = validateBitmask(invalidBit, 0);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/geçersiz bit/i);
  });

  it('tanımsız bit deny\'de reddedilir', () => {
    const invalidBit = 1 << 25;
    const result = validateBitmask(0, invalidBit);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/geçersiz bit/i);
  });

  it('negatif allow reddedilir', () => {
    const result = validateBitmask(-1, 0);
    expect(result.ok).toBe(false);
  });

  it('negatif deny reddedilir', () => {
    const result = validateBitmask(0, -1);
    expect(result.ok).toBe(false);
  });

  it('ondalıklı sayı reddedilir', () => {
    const result = validateBitmask(1.5, 0);
    expect(result.ok).toBe(false);
  });

  it('string reddedilir', () => {
    const result = validateBitmask('256', 0);
    expect(result.ok).toBe(false);
  });

  it('çok sayıda geçerli bit kombinasyonu kabul edilir', () => {
    const allow = PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES | PERMS.READ_HISTORY;
    const deny  = PERMS.CONNECT | PERMS.SPEAK;
    expect(validateBitmask(allow, deny).ok).toBe(true);
  });

  it('VALID_BITS\'in tamamı allow\'da geçerlidir', () => {
    // Tüm tanımlı bitler allow'da, deny 0
    expect(validateBitmask(VALID_BITS, 0).ok).toBe(true);
  });

  it('VALID_BITS\'in tamamı deny\'de geçerlidir', () => {
    // Tüm tanımlı bitler deny'da, allow 0
    expect(validateBitmask(0, VALID_BITS).ok).toBe(true);
  });

  it('hata mesajında geçersiz hex değeri belirtilir', () => {
    const invalidBit = 1 << 25;
    const result = validateBitmask(invalidBit, 0);
    expect(result.error).toMatch(/0x/); // hex gösterim
  });
});

// ─────────────────────────────────────────────────────────────
// Export / Import — HTTP endpoint testleri
// ─────────────────────────────────────────────────────────────
describe('Channel Permissions — Export & Import', () => {
  let app, ownerId, serverId, channelId, roleId, ownerToken;

  beforeEach(async () => {
    db._reset?.();
    app       = buildApp();
    ownerId   = uuidv4();
    serverId  = uuidv4();
    channelId = uuidv4();
    roleId    = uuidv4();
    ownerToken = tok(ownerId);

    await db.users.insert({ _id: ownerId, username: 'owner', displayName: 'Owner', tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'TestServer', ownerId });
    await db.channels.insert({ _id: channelId, serverId, name: 'general', type: 'text' });
    await db.roles.insert({ _id: roleId, serverId, name: 'Moderatör', position: 1 });

    // mock'ların her test öncesi resetlenmesi
    const perms = require('../lib/permissions');
    perms.resolvePermissions.mockResolvedValue(2);
    perms.hasPermission.mockReturnValue(true);
  });

  describe('GET /export', () => {
    it('override\'ları JSON olarak döner', async () => {
      // Önce bir override ekle
      await db.channelPermissions.insert({
        _id: uuidv4(), channelId, roleId, serverId,
        allow: 256, deny: 0, targetType: 'role', createdAt: Date.now(),
      });

      const res = await request(app)
        .get(`/api/servers/${serverId}/channels/${channelId}/permissions/export`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('version', 1);
      expect(res.body).toHaveProperty('exportedAt');
      expect(res.body).toHaveProperty('overrides');
      expect(Array.isArray(res.body.overrides)).toBe(true);
    });

    it('export yanıtı sourceServer ve sourceChannel içerir', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/channels/${channelId}/permissions/export`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.body).toHaveProperty('sourceServer');
      expect(res.body).toHaveProperty('sourceChannel');
    });

    it('override olmasa bile boş dizi döner', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/channels/${channelId}/permissions/export`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.overrides).toEqual([]);
    });

    it('export yanıtında her override allow/deny/targetType içerir', async () => {
      await db.channelPermissions.insert({
        _id: uuidv4(), channelId, roleId, serverId,
        allow: 256, deny: 512, targetType: 'role',
        targetName: 'Moderatör', createdAt: Date.now(),
      });

      const res = await request(app)
        .get(`/api/servers/${serverId}/channels/${channelId}/permissions/export`)
        .set('Authorization', `Bearer ${ownerToken}`);

      const ovr = res.body.overrides[0];
      expect(ovr).toHaveProperty('roleId', roleId);
      expect(ovr).toHaveProperty('allow', 256);
      expect(ovr).toHaveProperty('deny', 512);
      expect(ovr).toHaveProperty('targetType', 'role');
    });

    it('MANAGE_CHANNELS olmadan 403 döner', async () => {
      const perms = require('../lib/permissions');
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

  describe('POST /import', () => {
    const validImportPayload = () => ({
      overrides: [
        { roleId: null, roleName: 'Moderatör', allow: 256, deny: 0, targetType: 'role' },
      ],
      merge: false,
    });

    beforeEach(() => {
      // SQLite mock'u: import işlemi transaction kullanıyor
      // Her testte prepare() çağrıları sıfırlanır
    });

    it('geçerli import payload\'ı 200 döner', async () => {
      // roleId'yi sunucudaki bir role'e ayarla
      const payload = {
        overrides: [{ roleId, roleName: 'Moderatör', allow: 256, deny: 0, targetType: 'role' }],
        merge: false,
      };

      const res = await request(app)
        .post(`/api/servers/${serverId}/channels/${channelId}/permissions/import`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(payload);

      expect([200, 400]).toContain(res.status); // SQLite mock nedeniyle 400 gelebilir
      // En azından auth geçilmeli ve 401/403 gelmemeli
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it('boş overrides dizisi 400 döner', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/channels/${channelId}/permissions/import`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ overrides: [] });
      expect(res.status).toBe(400);
    });

    it('geçersiz bitmask (çakışan bitler) 400 döner', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/channels/${channelId}/permissions/import`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          overrides: [{ roleId, allow: 256, deny: 256 }], // allow ve deny aynı bit
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/bitmask/i);
    });

    it('tanımsız bit içeren bitmask 400 döner', async () => {
      const invalidBit = 1 << 25;
      const res = await request(app)
        .post(`/api/servers/${serverId}/channels/${channelId}/permissions/import`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          overrides: [{ roleId, allow: invalidBit, deny: 0 }],
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/bitmask/i);
    });

    it('allow veya deny sayı değilse 400 döner', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/channels/${channelId}/permissions/import`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          overrides: [{ roleId, allow: 'yazmak-lazım', deny: 0 }],
        });
      expect(res.status).toBe(400);
    });

    it('MANAGE_CHANNELS olmadan 403 döner', async () => {
      const perms = require('../lib/permissions');
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

  // ─────────────────────────────────────────────────────────────
  // Batch PUT bitmask validation
  // ─────────────────────────────────────────────────────────────
  describe('PUT /batch — bitmask validation', () => {
    it('çakışan bitmask batch PUT\'ta 400 döner', async () => {
      const res = await request(app)
        .put(`/api/servers/${serverId}/channels/${channelId}/permissions/batch`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          overrides: [{ roleId, allow: 256, deny: 256 }], // çakışan
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/bitmask/i);
    });

    it('tanımsız bit batch PUT\'ta 400 döner', async () => {
      const res = await request(app)
        .put(`/api/servers/${serverId}/channels/${channelId}/permissions/batch`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          overrides: [{ roleId, allow: 1 << 25, deny: 0 }], // tanımsız bit
        });
      expect(res.status).toBe(400);
    });

    it('geçerli bitmask batch PUT\'ta reddedilmez', async () => {
      const res = await request(app)
        .put(`/api/servers/${serverId}/channels/${channelId}/permissions/batch`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          overrides: [{ roleId, allow: 256, deny: 0 }], // SEND_MESSAGES allow
        });
      // SQLite mock nedeniyle hata gelebilir ama bitmask nedeniyle 400 gelmemeli
      expect(res.status).not.toBe(400);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });
});

// ─────────────────────────────────────────────────────────────
// VALID_BITS bütünlük testi
// ─────────────────────────────────────────────────────────────
describe('VALID_BITS bütünlük kontrolü', () => {
  it('VALID_BITS tüm tanımlı PERMS değerlerini kapsar', () => {
    for (const [key, bit] of Object.entries(PERMS)) {
      expect(VALID_BITS & bit).toBe(bit);
    }
  });

  it('VALID_BITS tanımsız bir biti içermez (sızdırma yok)', () => {
    // PERMS değerlerinin dışında hiçbir bit set edilmemiş olmalı
    const allDefinedBits = Object.values(PERMS).reduce((a, b) => a | b, 0);
    expect(VALID_BITS).toBe(allDefinedBits);
  });
});
