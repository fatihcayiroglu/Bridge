// server/tests/role-hierarchy-delegation.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ROL HIYERARSISI — DEVREDILEN YETKI GERCEKTEN CALISMALI, AMA GENISLEMEMELI
// ════════════════════════════════════════════════════════════════════════════
// OLCULEN URUN KUSURU: her rol `position: 0` ile yaratiliyordu ve konumu
// degistiren baska bir uc yoktu. `canManageRole` / `canActOn` KESIN ustunluk
// (`actorTop > target`) aradigi icin bu karsilastirma sunucu SAHIBI disinda
// HICBIR ZAMAN saglanamiyordu.
//
// Sonucu: MANAGE_ROLES verilmis bir moderator KENDI yarattigi rolu bile
// atayamiyordu. Yetki devri urunde duruyor ama islemiyordu — ve hicbir yerde
// bunu soyleyen bir hata yoktu; yalnizca 403 doniyordu.
//
// Bu paket iki seyi AYNI ANDA kilitler:
//
//   1. MESRU DEVIR CALISIR — konumu kendisinin altinda ve izinleri kendi
//      izinlerinin alt kumesi olan bir rolu atayabilir.
//   2. YUKSELME YOK — kendine esit ya da ustun bir rol URETEMEZ, atayamaz;
//      ustun bir uyeye dokunamaz; sahibe hic dokunamaz.
//
// Ikinci maddenin her sikki ayri ayri olculur: birincisini saglamak icin
// yapilan degisiklik ikincisini bozmus olsaydi, bu bir yetki yukseltme
// acigi olurdu.
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import rolesRouter from '../routes/roles';
import { PERMS } from '../lib/permissions';

const db = require('../db/loader');
const jwt = require('jsonwebtoken');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers', rolesRouter);
  return app;
}
const tok = (uid: string) => jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

const DELEGATE_PERMS = PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES | PERMS.MANAGE_ROLES;

let app: ReturnType<typeof buildApp>;
let ownerId: string, modId: string, plainId: string, serverId: string;
let ownerToken: string, modToken: string;

/** Sahip olarak rol yaratir ve id'sini dondurur. */
async function createRoleAsOwner(name: string, permissions: number): Promise<string> {
  const res = await request(app)
    .post(`/api/servers/${serverId}/roles`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ name, permissions });
  expect(res.status).toBeLessThan(300);
  return String(res.body._id ?? res.body.id);
}

async function positionOf(roleId: string): Promise<number> {
  const row = await db.roles.findOne({ _id: roleId });
  return Number(row.position || 0);
}

beforeEach(async () => {
  db._reset?.();
  app = buildApp();
  ownerId = uuidv4(); modId = uuidv4(); plainId = uuidv4(); serverId = uuidv4();
  ownerToken = tok(ownerId); modToken = tok(modId);

  await db.users.insert({ _id: ownerId, username: 'owner', displayName: 'Owner', tokenVersion: 0 });
  await db.users.insert({ _id: modId, username: 'mod', displayName: 'Mod', tokenVersion: 0 });
  await db.users.insert({ _id: plainId, username: 'plain', displayName: 'Plain', tokenVersion: 0 });
  await db.servers.insert({ _id: serverId, name: 'Test', ownerId });
  await db.members.insert({ userId: ownerId, serverId, roles: [] });
  await db.members.insert({ userId: modId, serverId, roles: [] });
  await db.members.insert({ userId: plainId, serverId, roles: [] });
});

describe('role positions form a real hierarchy', () => {
  it('gives each owner-created role its own level instead of stacking them all at zero', async () => {
    const first = await createRoleAsOwner('Birinci', PERMS.VIEW_CHANNELS);
    const second = await createRoleAsOwner('Ikinci', PERMS.VIEW_CHANNELS);

    // Duzeyler AYRI olmalidir; hepsi 0 olsaydi hicbir karsilastirma saglanmazdi.
    expect(await positionOf(first)).toBeGreaterThan(0);
    expect(await positionOf(second)).toBeGreaterThan(await positionOf(first));
  });

  it('places a delegate-created role strictly below the delegate', async () => {
    const modRole = await createRoleAsOwner('Moderator', DELEGATE_PERMS);
    await db.members.update({ userId: modId, serverId }, { $set: { roles: [modRole] } });

    const made = await request(app)
      .post(`/api/servers/${serverId}/roles`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ name: 'Alt', permissions: PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES });
    expect(made.status).toBeLessThan(300);

    const madeId = String(made.body._id ?? made.body.id);
    // KESIN olarak altinda: esit olsaydi moderator kendi yarattigini yonetemezdi;
    // ustunde olsaydi yetki yukseltmis olurdu.
    expect(await positionOf(madeId)).toBeLessThan(await positionOf(modRole));
  });
});

describe('a legitimate delegate can actually use the delegated power', () => {
  let modRole: string;

  beforeEach(async () => {
    modRole = await createRoleAsOwner('Moderator', DELEGATE_PERMS);
    await db.members.update({ userId: modId, serverId }, { $set: { roles: [modRole] } });
  });

  it('assigns a role it created to another member', async () => {
    const made = await request(app)
      .post(`/api/servers/${serverId}/roles`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ name: 'Uye', permissions: PERMS.VIEW_CHANNELS });
    const madeId = String(made.body._id ?? made.body.id);

    const res = await request(app)
      .post(`/api/servers/${serverId}/members/${plainId}/roles`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ roleId: madeId });

    expect(res.status).toBeLessThan(300);
    const membership = await db.members.findOne({ userId: plainId, serverId });
    expect(membership.roles).toContain(madeId);
  });

  it('assigns an equivalent role to itself', async () => {
    // Kendine vermek YENI yetki uretmez: rol zaten kendi izinlerinin alt
    // kumesidir ve konumu kendisinin altindadir.
    const made = await request(app)
      .post(`/api/servers/${serverId}/roles`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ name: 'Esdeger', permissions: PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES });
    const madeId = String(made.body._id ?? made.body.id);

    const res = await request(app)
      .post(`/api/servers/${serverId}/members/${modId}/roles`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ roleId: madeId });
    expect(res.status).toBeLessThan(300);
  });

  it('removes a role it is allowed to manage', async () => {
    const made = await request(app)
      .post(`/api/servers/${serverId}/roles`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ name: 'Gecici', permissions: PERMS.VIEW_CHANNELS });
    const madeId = String(made.body._id ?? made.body.id);

    await request(app)
      .post(`/api/servers/${serverId}/members/${plainId}/roles`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ roleId: madeId });

    const res = await request(app)
      .delete(`/api/servers/${serverId}/members/${plainId}/roles/${madeId}`)
      .set('Authorization', `Bearer ${modToken}`);
    expect(res.status).toBeLessThan(300);
    const membership = await db.members.findOne({ userId: plainId, serverId });
    expect(membership.roles ?? []).not.toContain(madeId);
  });
});

describe('the hierarchy still refuses every escalation', () => {
  let modRole: string;

  beforeEach(async () => {
    modRole = await createRoleAsOwner('Moderator', DELEGATE_PERMS);
    await db.members.update({ userId: modId, serverId }, { $set: { roles: [modRole] } });
  });

  it('refuses to assign the delegate’s own level to anyone', async () => {
    // `modRole` moderatorun KENDI duzeyidir; esit bir rolu dagitmak,
    // hiyerarsiyi duzlestirip yetkiyi cogaltirdi.
    const res = await request(app)
      .post(`/api/servers/${serverId}/members/${plainId}/roles`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ roleId: modRole });
    expect(res.status).toBe(403);
  });

  it('refuses to assign a role created above the delegate', async () => {
    const high = await createRoleAsOwner('Yuksek', DELEGATE_PERMS | PERMS.MANAGE_SERVER);
    expect(await positionOf(high)).toBeGreaterThan(await positionOf(modRole));

    const res = await request(app)
      .post(`/api/servers/${serverId}/members/${modId}/roles`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ roleId: high });
    expect(res.status).toBe(403);
  });

  it('refuses to create a role carrying a permission the delegate lacks', async () => {
    const res = await request(app)
      .post(`/api/servers/${serverId}/roles`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ name: 'Admin', permissions: PERMS.ADMINISTRATOR });
    expect(res.status).toBe(403);
  });

  it('refuses to act on a member who outranks the delegate', async () => {
    const high = await createRoleAsOwner('Yuksek', DELEGATE_PERMS);
    await db.members.update({ userId: plainId, serverId }, { $set: { roles: [high] } });

    const made = await request(app)
      .post(`/api/servers/${serverId}/roles`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ name: 'Alt', permissions: PERMS.VIEW_CHANNELS });
    const madeId = String(made.body._id ?? made.body.id);

    const res = await request(app)
      .post(`/api/servers/${serverId}/members/${plainId}/roles`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ roleId: madeId });
    expect(res.status).toBe(403);
  });

  it('refuses to act on a peer holding the very same role', async () => {
    await db.members.update({ userId: plainId, serverId }, { $set: { roles: [modRole] } });

    const made = await request(app)
      .post(`/api/servers/${serverId}/roles`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ name: 'Alt', permissions: PERMS.VIEW_CHANNELS });
    const madeId = String(made.body._id ?? made.body.id);

    const res = await request(app)
      .post(`/api/servers/${serverId}/members/${plainId}/roles`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ roleId: madeId });
    // Esitler birbirine dokunamaz — self istisnasi YALNIZCA aktorun KENDISI icindir.
    expect(res.status).toBe(403);
  });

  it('refuses to touch the server owner', async () => {
    const made = await request(app)
      .post(`/api/servers/${serverId}/roles`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ name: 'Alt', permissions: PERMS.VIEW_CHANNELS });
    const madeId = String(made.body._id ?? made.body.id);

    const res = await request(app)
      .post(`/api/servers/${serverId}/members/${ownerId}/roles`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ roleId: madeId });
    expect(res.status).toBe(403);
  });

  it('refuses a member with no MANAGE_ROLES at all', async () => {
    const made = await createRoleAsOwner('Herhangi', PERMS.VIEW_CHANNELS);
    const res = await request(app)
      .post(`/api/servers/${serverId}/members/${plainId}/roles`)
      .set('Authorization', `Bearer ${tok(plainId)}`)
      .send({ roleId: made });
    expect(res.status).toBe(403);
  });
});
