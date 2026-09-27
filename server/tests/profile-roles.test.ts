// server/tests/profile-roles.test.ts
// ÜYE PROFİLİNDE SUNUCU ROLLERİ — SUNUM ≠ YETKİ.
//
// ════════════════════════════════════════════════════════════════════════════
// ÖNCEKİ DURUM
// ════════════════════════════════════════════════════════════════════════════
// Üye→rol eşlemesi hiçbir uçtan okunamıyordu (`/:sid/members` yalnızca
// kullanıcı + `nickname` dönüyordu), bu yüzden profil rol gösteremiyordu.
//
// ════════════════════════════════════════════════════════════════════════════
// EKLENEN SÖZLEŞME
// ════════════════════════════════════════════════════════════════════════════
//   GET /api/servers/:sid/members/:uid/roles
//     · yalnızca sunucu ÜYELERİ okuyabilir
//     · `permissions` bit alanı ASLA dönmez
//     · `displayOnProfile=false` roller SUNUCUDA elenir
//     · hiyerarşi sırası (position DESC) korunur
//
//   PATCH /api/servers/:sid/roles/:rid  { displayOnProfile }
//     · yalnızca MANAGE_ROLES
//     · SUNUM ayarıdır: izin/hiyerarşi/kanal yetkisini DEĞİŞTİRMEZ

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import type { RequestBody } from './helpers/httpDoubles';
import { createMockDb, requireDoc } from './helpers/mockDb';
const mockDb = createMockDb();
jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (
    req: { headers: { authorization?: string }; user?: unknown },
    res: { status: (c: number) => { json: (b: unknown) => unknown } },
    next: () => void,
  ) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    const jwt = require('jsonwebtoken');
    try { req.user = jwt.verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!'); next(); }
    catch { res.status(401).json({ error: 'Invalid token' }); }
  },
  verifyToken: (t: string) => { try { return require('jsonwebtoken').verify(t, 'test-jwt-secret-long-enough-32chars!!'); } catch { return null; } },
}));
// `limits.roles()` gibi cagrilar icin: MODUL degil, `limits` NESNESI proxy olmali.
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_r: unknown, _s: unknown, n: () => void) => n() }),
}));

import request from 'supertest';
import express from 'express';
const jwt = require('jsonwebtoken');
import rolesRouter from '../routes/roles';

const app = express();
app.use(express.json());
app.use('/api/servers', rolesRouter);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

const tok = (id: string) => jwt.sign({ id, username: id, v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

const SRV     = 'srv-roles';
const ADMIN   = 'admin-1';     // MANAGE_ROLES sahibi (sunucu sahibi)
const MEMBER  = 'member-1';    // rolleri gosterilecek kisi
const VIEWER  = 'viewer-1';    // sirada bir uye
const OUTSIDE = 'outsider-1';  // uye DEGIL

const R_ADMIN = { _id: 'role-admin', serverId: SRV, name: 'Admin',     color: '#e05260', permissions: 8,  position: 30, displayOnProfile: true,  createdAt: 1 };
const R_DEV   = { _id: 'role-dev',   serverId: SRV, name: 'Developer', color: '#2d9cdb', permissions: 0,  position: 20, displayOnProfile: true,  createdAt: 1 };
const R_INT   = { _id: 'role-int',   serverId: SRV, name: 'Dahili',    color: '#888888', permissions: 0,  position: 10, displayOnProfile: false, createdAt: 1 };

beforeEach(async () => {
  mockDb._reset?.();
  await mockDb.servers.insert({ _id: SRV, name: 'Rol Test', ownerId: ADMIN, createdAt: 1 });
  for (const u of [ADMIN, MEMBER, VIEWER, OUTSIDE]) {
    await mockDb.users.insert({ _id: u, username: u, displayName: u });
  }
  await mockDb.members.insert({ userId: ADMIN,  serverId: SRV, roles: [], joinedAt: 1 });
  await mockDb.members.insert({ userId: VIEWER, serverId: SRV, roles: [], joinedAt: 1 });
  // MEMBER uc role sahip; biri gizli.
  await mockDb.members.insert({ userId: MEMBER, serverId: SRV, roles: [R_DEV._id, R_ADMIN._id, R_INT._id], joinedAt: 1 });
  for (const r of [R_ADMIN, R_DEV, R_INT]) await mockDb.roles.insert({ ...r });
});

const getRoles = (target: string, who: string) =>
  request(app).get(`/api/servers/${SRV}/members/${target}/roles`).set('Authorization', `Bearer ${tok(who)}`);

// ════════════════════════════════════════════════════════════════════════════
describe('GET üye rolleri — sunum sözleşmesi', () => {
  it('POZİTİF: üye, başka üyenin GÖRÜNÜR rollerini görür', async () => {
    const res = await getRoles(MEMBER, VIEWER);

    expect(res.status).toBe(200);
    expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Admin', 'Developer']);
  });

  it('HİYERARŞİ sırasına göre döner (alfabetik DEĞİL)', async () => {
    const res = await getRoles(MEMBER, VIEWER);
    // position: Admin 30 > Developer 20. Alfabetik olsaydi Admin,Developer
    // yine ayni cikardi; bu yuzden ters konumlu bir kontrol de yapilir.
    await mockDb.roles.update({ _id: R_DEV._id }, { $set: { position: 99 } });
    const res2 = await getRoles(MEMBER, VIEWER);

    expect(res.body[0].name).toBe('Admin');
    expect(res2.body[0].name).toBe('Developer');   // konum degisti -> sira degisti
  });

  it('GİZLİ rol (displayOnProfile=false) HİÇ dönmez', async () => {
    const res = await getRoles(MEMBER, VIEWER);

    expect(JSON.stringify(res.body)).not.toContain('Dahili');
  });

  it('YETKİ BİTLERİ sızmaz (permissions alanı yok)', async () => {
    const res = await getRoles(MEMBER, VIEWER);

    for (const r of res.body) {
      expect(r.permissions).toBeUndefined();
      expect(Object.keys(r).sort()).toEqual(['_id', 'color', 'name', 'position']);
    }
  });

  it('ÜYE OLMAYAN okuyamaz', async () => {
    const res = await getRoles(MEMBER, OUTSIDE);

    expect(res.status).toBe(403);
  });

  it('kimliksiz istek reddedilir', async () => {
    const res = await request(app).get(`/api/servers/${SRV}/members/${MEMBER}/roles`);

    expect(res.status).toBe(401);
  });
});

describe('PATCH displayOnProfile — SUNUM, yetki DEĞİL', () => {
  const patch = (who: string, body: RequestBody) =>
    request(app).patch(`/api/servers/${SRV}/roles/${R_DEV._id}`)
      .set('Authorization', `Bearer ${tok(who)}`).send(body);

  it('MANAGE_ROLES sahibi gizleyebilir → rol profilden kaybolur', async () => {
    const before = await getRoles(MEMBER, VIEWER);
    expect(before.body.map((r: { name: string }) => r.name)).toContain('Developer');

    const p = await patch(ADMIN, { displayOnProfile: false });
    expect(p.status).toBe(200);

    const after = await getRoles(MEMBER, VIEWER);
    expect(after.body.map((r: { name: string }) => r.name)).not.toContain('Developer');
  });

  it('tekrar açınca rol GERİ GELİR', async () => {
    await patch(ADMIN, { displayOnProfile: false });
    await patch(ADMIN, { displayOnProfile: true });

    const after = await getRoles(MEMBER, VIEWER);
    expect(after.body.map((r: { name: string }) => r.name)).toContain('Developer');
  });

  it('görünürlük değişimi İZİNLERİ ve HİYERARŞİYİ DEĞİŞTİRMEZ', async () => {
    const before = await requireDoc(mockDb.roles, { _id: R_DEV._id });
    await patch(ADMIN, { displayOnProfile: false });
    const after = await requireDoc(mockDb.roles, { _id: R_DEV._id });

    expect(after.permissions).toBe(before.permissions);
    expect(after.position).toBe(before.position);
  });

  it('YETKİSİZ üye görünürlüğü değiştiremez', async () => {
    const res = await patch(VIEWER, { displayOnProfile: false });

    expect(res.status).toBe(403);
    const after = await getRoles(MEMBER, VIEWER);
    expect(after.body.map((r: { name: string }) => r.name)).toContain('Developer');
  });

  it('boolean olmayan sunum değerini reddeder ("false" trueya donusmez)', async () => {
    const res = await patch(ADMIN, { displayOnProfile: 'false' });

    expect(res.status).toBe(400);
    const after = await getRoles(MEMBER, VIEWER);
    expect(after.body.map((r: { name: string }) => r.name)).toContain('Developer');
  });

  it('baska sunucudaki bilinen rol kimligini sizdirmaz veya guncellemez', async () => {
    const otherServer = 'srv-other';
    const otherRole = {
      _id: 'role-other', serverId: otherServer, name: 'Gizli Diger Rol',
      color: '#ffffff', permissions: 0, position: 1, displayOnProfile: true, createdAt: 1,
    };
    await mockDb.servers.insert({ _id: otherServer, name: 'Diger', ownerId: OUTSIDE, createdAt: 1 });
    await mockDb.roles.insert(otherRole);

    const res = await request(app).patch(`/api/servers/${SRV}/roles/${otherRole._id}`)
      .set('Authorization', `Bearer ${tok(ADMIN)}`).send({ displayOnProfile: false });

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(otherRole.name);
    expect((await requireDoc(mockDb.roles, { _id: otherRole._id })).displayOnProfile).toBe(true);
  });

  it('sıradan üye kendine rol ATAYAMAZ', async () => {
    const res = await request(app).post(`/api/servers/${SRV}/members/${VIEWER}/roles`)
      .set('Authorization', `Bearer ${tok(VIEWER)}`).send({ roleId: R_ADMIN._id });

    expect(res.status).toBe(403);
  });

  it('yönetici rol atar -> profil gösterir; kaldırır -> profil gizler', async () => {
    const assign = await request(app).post(`/api/servers/${SRV}/members/${VIEWER}/roles`)
      .set('Authorization', `Bearer ${tok(ADMIN)}`).send({ roleId: R_DEV._id });
    expect(assign.status).toBe(200);
    expect((await getRoles(VIEWER, ADMIN)).body.map((r: { name: string }) => r.name)).toContain('Developer');

    const remove = await request(app).delete(`/api/servers/${SRV}/members/${VIEWER}/roles/${R_DEV._id}`)
      .set('Authorization', `Bearer ${tok(ADMIN)}`);
    expect(remove.status).toBe(200);
    expect((await getRoles(VIEWER, ADMIN)).body).toEqual([]);
  });
});
