// server/tests/media-token-scope.test.ts
// MEDYA JETONU KAPSAM AYRIMI — AYRICALIK YÜKSELTMESİ KAPALI.
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR (kendi eklediğim özellikte, canlı üründe ölçüldü)
// ════════════════════════════════════════════════════════════════════════════
// Özel ek yetkilendirmesi için `bridge_media` çerezi eklendi. Çerez, `<img>`
// isteklerinin `Authorization` başlığı taşıyamaması yüzünden gereklidir.
import type { Request, Response, NextFunction } from 'express';
//
// ANCAK `verifyToken` YALNIZCA imzayı doğrular. Medya jetonu da aynı
// `JWT_SECRET` ile imzalandığı ve 7 GÜN yaşadığı için, denetlenmeseydi
// API'ye tam erişim veren UZUN ÖMÜRLÜ bir kimlik olurdu.
//
// CANLI ÖLÇÜM (düzeltmeden önce):
//     Authorization: Bearer <medya jetonu>
//       GET /api/servers  -> 200
//       GET /api/me       -> 200
//       GET /api/friends  -> 200
//
// Yani 15 dakikalık erişim jetonu yerine 7 günlük bir API kimliği doğmuştu.
//
// ════════════════════════════════════════════════════════════════════════════
// KORUNAN DEĞİŞMEZ — AYRIM İKİ YÖNLÜDÜR
// ════════════════════════════════════════════════════════════════════════════
//   · `purpose: 'media'` taşıyan jeton API kimliği OLARAK KABUL EDİLMEZ.
//   · Normal erişim jetonu medya çerezi yerine GEÇEMEZ (uploadAuthz testinde).
//   · Her iki yolda da `tokenVersion` doğrulanır → oturum iptali GEÇERLİDİR.

process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

const mockUsers = new Map<string, { _id: string; username: string; tokenVersion: number }>();
jest.mock('../db/loader', () => ({
  users: {
    findOne: async (q: { _id?: string }) => mockUsers.get(String(q._id ?? '')) ?? null,
    findById: async (id: string) => mockUsers.get(String(id)) ?? null,
  },
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { authMiddleware, makeMediaToken, makeToken, _invalidateTokenCache } from '../middleware/auth';

const USER = { _id: 'user-media-1', username: 'medyaci', tokenVersion: 0 };

function app() {
  const a = express();
  a.get('/api/protected', authMiddleware, (_req: Request, res: Response) => { res.json({ ok: true }); });
  return a;
}

beforeEach(() => {
  mockUsers.clear();
  mockUsers.set(USER._id, { ...USER });
});

// ════════════════════════════════════════════════════════════════════════════
describe('authMiddleware — medya jetonu API kimliği DEĞİLDİR', () => {
  it('POZİTİF KONTROL: normal erişim jetonu korumalı ucu açar', async () => {
    const res = await request(app()).get('/api/protected')
      .set('Authorization', `Bearer ${makeToken(USER)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('MEDYA jetonu korumalı uçta REDDEDİLİR', async () => {
    const res = await request(app()).get('/api/protected')
      .set('Authorization', `Bearer ${makeMediaToken(USER)}`);

    expect(res.status).toBe(401);
    expect(res.body.ok).toBeUndefined();
  });

  it('elle üretilmiş purpose=media jetonu da REDDEDİLİR (imza geçerli olsa bile)', async () => {
    const forged = jwt.sign(
      { id: USER._id, username: USER.username, v: 0, purpose: 'media' },
      'test-jwt-secret-long-enough-32chars!!', { expiresIn: '7d' },
    );

    const res = await request(app()).get('/api/protected').set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(401);
  });

  it('medya jetonu YETKİ İDDİASI taşımaz (isAdmin/role/flags yok)', () => {
    const admin = { ...USER, isAdmin: true, role: 'admin', flags: ['admin'] };
    const payload = jwt.decode(makeMediaToken(admin)) as Record<string, unknown>;

    expect(payload.purpose).toBe('media');
    expect(payload.isAdmin).toBeUndefined();
    expect(payload.role).toBeUndefined();
    expect(payload.flags).toBeUndefined();
  });

  it('medya jetonu İPTAL için tokenVersion taşır', () => {
    const payload = jwt.decode(makeMediaToken({ ...USER, tokenVersion: 7 })) as Record<string, unknown>;

    expect(payload.v).toBe(7);
  });

  it('İPTAL EDİLMİŞ normal jeton da reddedilir (mevcut semantik korunur)', async () => {
    const stale = makeToken({ ...USER, tokenVersion: 0 });
    mockUsers.set(USER._id, { ...USER, tokenVersion: 4 });   // sunucuda surum ilerledi
    // Jeton surumu LRU onbellekte tutulur (her istekte DB'ye gidilmesin diye).
    // Onceki testler surum 0'i onbellege aldigi icin acikca gecersizlenir —
    // bu bir TEST kosumu ayrintisidir, urun davranisi degil.
    _invalidateTokenCache(USER._id);

    const res = await request(app()).get('/api/protected').set('Authorization', `Bearer ${stale}`);

    expect(res.status).toBe(401);
  });
});
