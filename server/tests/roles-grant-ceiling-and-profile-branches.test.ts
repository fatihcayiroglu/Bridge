// server/tests/roles-grant-ceiling-and-profile-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ROLLER — VERME TAVANI, KONUM TAHSİSİ VE PROFİL GÖRÜNÜRLÜĞÜ
// ════════════════════════════════════════════════════════════════════════════
//
// `tests/roles-authority-branches.test.ts` bitmask sınırını ve hiyerarşiyi
// ölçer. Bu tamamlayıcı takım geri kalan karar dallarını kapatır:
//
//   · VERME TAVANI. Bir aktör YALNIZCA kendisinde bulunan izinleri verebilir.
//     Muafiyetler dar ve açıktır: ADMINISTRATOR ve sunucu SAHİBİ. Muafiyet
//     kontrolü atlanırsa MANAGE_ROLES sessizce ADMINISTRATOR'e yükselir.
//     Aynı tavan üç yerde geçerlidir: rol OLUŞTURMA, rol DÜZENLEME ve rol
//     ATAMA — çünkü var olan yüksek bir rolü atamak, onu oluşturmakla aynı
//     sonucu verir.
//   · KONUM TAHSİSİ. Yeni rol, aktörün konumunun ALTINA yerleşir; sahip için
//     yığının üstüne yeni bir düzey açılır. Yanlış tahsis, yeni rolü aktörün
//     ÜSTÜNE koyup hiyerarşiyi tersine çevirirdi.
//   · PROFİL GÖRÜNÜRLÜĞÜ bir SUNUM ayarıdır: izin çözümünü etkilemez, izin
//     önbelleğini geçersizleştirmez, ama denetim günlüğüne yazılır — ve rol
//     listesi hiçbir zaman izin bitlerini dışarı vermez.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/permCache', () => ({ invalidatePerms: jest.fn() }));
jest.mock('../lib/liveMembership', () => ({ evictUserFromServerRooms: jest.fn().mockResolvedValue(undefined) , evictSocketsWithoutChannelAccessBestEffort: jest.fn().mockResolvedValue(undefined), evictSocketsWithoutChannelAccess: jest.fn().mockResolvedValue(0) }));
jest.mock('express-rate-limit', () => () => (_req: unknown, _res: unknown, next: () => void) => next());

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import rolesRouter from '../routes/roles';
import { PERMS } from '../lib/permissions';
import { Auth, Roles } from '../db/repositories';
import { _resetRateLimitStoreForTest } from '../middleware/rateLimit';

const db = require('../db/loader');
const { invalidatePerms } = require('../lib/permCache');

const SID = 'grant-ceiling-server';
const OWNER = 'gc-owner';
const ADMIN = 'gc-admin';
const MANAGER = 'gc-manager';
const PLAIN = 'gc-plain';
const ADMIN_ROLE = 'gc-admin-role';
const MANAGER_ROLE = 'gc-manager-role';
const HIGH_ROLE = 'gc-high-role';
const LOW_ROLE = 'gc-low-role';
const SNEAKY_ROLE = 'gc-sneaky-role';

const token = (id: string) => jwt.sign({ id, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/servers', rolesRouter);
  return instance;
}

// MANAGE_ROLES plus a couple of ordinary permissions: enough to manage roles,
// nowhere near enough to hand out everything.
const MANAGER_PERMS = PERMS.MANAGE_ROLES | PERMS.SEND_MESSAGES | PERMS.KICK_MEMBERS;

// `logAudit` is a thin wrapper around the audit repository; asserting on the
// durable write is both simpler and closer to what actually has to happen.
let auditWrite: jest.SpyInstance;
// The in-memory adapter hands back the STORED object, so a later write would
// retroactively change the "before" snapshot the handler compares against.
// PostgreSQL returns a row copy; this spy restores that semantics.
let rowSnapshot: jest.SpyInstance;

afterEach(() => { auditWrite?.mockRestore(); rowSnapshot?.mockRestore(); });

async function seed() {
  _resetRateLimitStoreForTest();
  db._reset?.();
  jest.clearAllMocks();
  auditWrite = jest.spyOn(Auth, 'insertAuditLog').mockResolvedValue(undefined as never);
  // Amac: her okumada satirin KOPYASINI dondurmek (cagiranin mutasyonu
  // depoyu bozmasin). Imza hedefin kendi imzasindan alinir; `never[]`
  // yayilimi ve `Role -> Record` donusumu boylece gereksizlesir.
  const readRow = Roles.findByIdAndServer.bind(Roles);
  rowSnapshot = jest.spyOn(Roles, 'findByIdAndServer').mockImplementation(
    async (id: string, serverId: string) => {
      const row = await readRow(id, serverId);
      return row ? { ...row } : row;
    });
  for (const id of [OWNER, ADMIN, MANAGER, PLAIN]) {
    await db.users.insert({ _id: id, username: id, displayName: id, tokenVersion: 0 });
  }
  await db.servers.insert({ _id: SID, name: 'Grant Ceiling', ownerId: OWNER });
  await db.roles.insert({
    _id: ADMIN_ROLE, serverId: SID, name: 'Admin', permissions: PERMS.ADMINISTRATOR, position: 90,
  });
  await db.roles.insert({
    _id: MANAGER_ROLE, serverId: SID, name: 'Manager', permissions: MANAGER_PERMS, position: 50,
  });
  await db.roles.insert({
    _id: HIGH_ROLE, serverId: SID, name: 'High', permissions: PERMS.BAN_MEMBERS, position: 80,
  });
  await db.roles.insert({
    _id: LOW_ROLE, serverId: SID, name: 'Low', permissions: PERMS.SEND_MESSAGES, position: 10,
  });
  // Below the manager in the hierarchy, so only the GRANT ceiling can stop it.
  await db.roles.insert({
    _id: SNEAKY_ROLE, serverId: SID, name: 'Sneaky', permissions: PERMS.BAN_MEMBERS, position: 20,
  });
  await db.members.insert({ userId: OWNER, serverId: SID, roles: [] });
  await db.members.insert({ userId: ADMIN, serverId: SID, roles: [ADMIN_ROLE] });
  await db.members.insert({ userId: MANAGER, serverId: SID, roles: [MANAGER_ROLE] });
  await db.members.insert({ userId: PLAIN, serverId: SID, roles: [LOW_ROLE] });
}

const createRole = (actor: string, body: Record<string, unknown>) =>
  request(app()).post(`/api/servers/${SID}/roles`).set('Authorization', `Bearer ${token(actor)}`).send(body);
const patchRole = (actor: string, rid: string, body: Record<string, unknown>) =>
  request(app()).patch(`/api/servers/${SID}/roles/${rid}`).set('Authorization', `Bearer ${token(actor)}`).send(body);
const assignRole = (actor: string, uid: string, body: Record<string, unknown>) =>
  request(app()).post(`/api/servers/${SID}/members/${uid}/roles`).set('Authorization', `Bearer ${token(actor)}`).send(body);

beforeEach(seed);

describe('the grant ceiling applies wherever permissions can be handed out', () => {
  it('a manager cannot create a role carrying a permission they lack', async () => {
    const res = await createRole(MANAGER, { name: 'Escalation', permissions: PERMS.BAN_MEMBERS });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Kendinizde olmayan izinleri veremezsiniz/);
  });

  it('a manager can create a role that is a subset of their own permissions', async () => {
    const res = await createRole(MANAGER, { name: 'Subset', permissions: PERMS.SEND_MESSAGES });
    expect(res.status).toBe(200);
    expect(res.body.permissions).toBe(PERMS.SEND_MESSAGES);
  });

  it('a manager cannot edit an existing role up to a permission they lack', async () => {
    // Editing is the same escalation as creating: the check must be in both.
    const res = await patchRole(MANAGER, LOW_ROLE, { permissions: PERMS.ADMINISTRATOR });
    expect(res.status).toBe(403);
    const row = await db.roles.findOne({ _id: LOW_ROLE });
    expect(row.permissions).toBe(PERMS.SEND_MESSAGES);
  });

  it('a manager cannot assign a lower role that still carries a permission they lack', async () => {
    // The hierarchy alone would allow this role (it sits below the manager);
    // only the grant ceiling stops the escalation.
    const res = await assignRole(MANAGER, PLAIN, { roleId: SNEAKY_ROLE });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Kendinizde olmayan izinleri veremezsiniz/);
  });

  it('a manager cannot grant such a role to themselves either', async () => {
    const res = await assignRole(MANAGER, MANAGER, { roleId: SNEAKY_ROLE });
    expect(res.status).toBe(403);
  });

  it('a role above the actor is refused by the hierarchy before the ceiling', async () => {
    const res = await assignRole(MANAGER, PLAIN, { roleId: HIGH_ROLE });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Role hierarchy prevents assigning this role/);
  });

  it('an ADMINISTRATOR is exempt from the ceiling', async () => {
    const res = await createRole(ADMIN, { name: 'AdminMade', permissions: PERMS.BAN_MEMBERS });
    expect(res.status).toBe(200);
  });

  it('the server owner is exempt from the ceiling', async () => {
    const res = await createRole(OWNER, { name: 'OwnerMade', permissions: PERMS.BAN_MEMBERS });
    expect(res.status).toBe(200);
  });

  it('a non-owner without MANAGE_ROLES is refused before anything else', async () => {
    const res = await createRole(PLAIN, { name: 'Nope' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/MANAGE_ROLES/);
  });
});

describe('role creation input handling', () => {
  const badBodies: Array<[string, unknown, RegExp]> = [
    ['no name', {}, /Role name required/],
    ['a blank name', { name: '   ' }, /Role name required/],
    ['a non-string name', { name: 42 }, /Role name required/],
    ['a non-string colour', { name: 'X', color: 123 }, /Role color must be a string/],
    ['an array body', [], /Role name required/],
  ];
  for (const [name, body, message] of badBodies) {
    it(`refuses ${name}`, async () => {
      const res = await createRole(OWNER, body as Record<string, unknown>);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
    });
  }

  it('trims and bounds the role name', async () => {
    const res = await createRole(OWNER, { name: `  ${'x'.repeat(50)}  ` });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('x'.repeat(32));
  });
});

describe('new roles are positioned relative to the actor', () => {
  it('a manager\'s new role lands directly below their own highest role', async () => {
    const res = await createRole(MANAGER, { name: 'Below manager' });
    expect(res.status).toBe(200);
    expect(res.body.position).toBe(49);
  });

  it('the owner opens a new level above the whole stack', async () => {
    const res = await createRole(OWNER, { name: 'Top' });
    expect(res.status).toBe(200);
    // The tallest existing role sits at 90.
    expect(res.body.position).toBe(91);
  });

  it('the owner of a server with no roles at all starts at level one', async () => {
    const emptySid = 'grant-ceiling-empty';
    await db.servers.insert({ _id: emptySid, name: 'Empty', ownerId: OWNER });
    await db.members.insert({ userId: OWNER, serverId: emptySid, roles: [] });

    const res = await request(app()).post(`/api/servers/${emptySid}/roles`)
      .set('Authorization', `Bearer ${token(OWNER)}`).send({ name: 'First' });

    expect(res.status).toBe(200);
    expect(res.body.position).toBe(1);
  });

  it('roles with unusable stored positions do not push the new one below zero', async () => {
    const oddSid = 'grant-ceiling-odd';
    await db.servers.insert({ _id: oddSid, name: 'Odd', ownerId: OWNER });
    await db.members.insert({ userId: OWNER, serverId: oddSid, roles: [] });
    await db.roles.insert({ _id: 'odd-role', serverId: oddSid, name: 'Odd', permissions: 0 });

    const res = await request(app()).post(`/api/servers/${oddSid}/roles`)
      .set('Authorization', `Bearer ${token(OWNER)}`).send({ name: 'Next' });

    expect(res.status).toBe(200);
    expect(res.body.position).toBe(1);
  });
});

describe('editing a role', () => {
  it('an unknown role in this server is a 404, whatever exists elsewhere', async () => {
    const otherSid = 'grant-ceiling-other';
    await db.servers.insert({ _id: otherSid, name: 'Other', ownerId: OWNER });
    await db.roles.insert({ _id: 'foreign-role', serverId: otherSid, name: 'Foreign', permissions: 0, position: 5 });

    const res = await patchRole(OWNER, 'foreign-role', { name: 'Renamed' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Role not found in this server/);
  });

  const badPatches: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a non-string name', { name: 42 }, /Role name must be a string/],
    ['a non-string colour', { color: 42 }, /Role color must be a string/],
    ['a non-boolean profile flag', { displayOnProfile: 'yes' }, /displayOnProfile must be a boolean/],
  ];
  for (const [name, body, message] of badPatches) {
    it(`refuses ${name}`, async () => {
      const res = await patchRole(OWNER, LOW_ROLE, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
    });
  }

  it('a blank name or colour leaves the stored value untouched', async () => {
    const before = await db.roles.findOne({ _id: LOW_ROLE });
    const res = await patchRole(OWNER, LOW_ROLE, { name: '   ', color: '' });
    expect(res.status).toBe(200);
    const after = await db.roles.findOne({ _id: LOW_ROLE });
    expect(after.name).toBe(before.name);
  });

  it('a colour is normalised before it is stored', async () => {
    const res = await patchRole(OWNER, LOW_ROLE, { color: 'not-a-colour' });
    expect(res.status).toBe(200);
    expect(String(res.body.color)).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('changing only the profile flag does not invalidate the permission cache', async () => {
    const res = await patchRole(OWNER, LOW_ROLE, { displayOnProfile: false });
    expect(res.status).toBe(200);
    expect(invalidatePerms).not.toHaveBeenCalled();
    expect(auditWrite).toHaveBeenCalledWith(expect.objectContaining({
      serverId: SID, actorId: OWNER, action: 'ROLE_PROFILE_VISIBILITY_UPDATE', target: LOW_ROLE,
      extra: expect.objectContaining({
        before: { displayOnProfile: true }, after: { displayOnProfile: false },
      }),
    }));
  });

  it('re-setting the profile flag to its current value writes no audit entry', async () => {
    const res = await patchRole(OWNER, LOW_ROLE, { displayOnProfile: true });
    expect(res.status).toBe(200);
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it('changing permissions does invalidate the permission cache', async () => {
    const res = await patchRole(OWNER, LOW_ROLE, { permissions: PERMS.SEND_MESSAGES | PERMS.ATTACH_FILES });
    expect(res.status).toBe(200);
    expect(invalidatePerms).toHaveBeenCalledWith(SID);
  });
});

describe('a member\'s public role list', () => {
  const listFor = (actor: string, uid: string) => request(app())
    .get(`/api/servers/${SID}/members/${uid}/roles`).set('Authorization', `Bearer ${token(actor)}`);

  it('never exposes permission bits', async () => {
    const res = await listFor(MANAGER, PLAIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ _id: LOW_ROLE, name: 'Low' })]);
    expect(res.body[0]).not.toHaveProperty('permissions');
  });

  it('is ordered from the highest role downwards', async () => {
    await db.members.update({ userId: PLAIN, serverId: SID }, { $set: { roles: [LOW_ROLE, HIGH_ROLE] } });
    const res = await listFor(MANAGER, PLAIN);
    expect(res.body.map((r: { _id: string }) => r._id)).toEqual([HIGH_ROLE, LOW_ROLE]);
  });

  it('omits roles hidden from profiles', async () => {
    await db.roles.update({ _id: LOW_ROLE }, { $set: { displayOnProfile: false } });
    const res = await listFor(MANAGER, PLAIN);
    expect(res.body).toEqual([]);
  });

  it('a member with no roles yields an empty list without reading the role table', async () => {
    const res = await listFor(MANAGER, OWNER);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('a user who is not a member of this server yields an empty list, not a 404', async () => {
    const res = await listFor(MANAGER, 'gc-nobody');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('roles stored as a JSON string are read just the same', async () => {
    await db.members.update({ userId: PLAIN, serverId: SID },
      { $set: { roles: JSON.stringify([LOW_ROLE]) } });
    const res = await listFor(MANAGER, PLAIN);
    expect(res.body.map((r: { _id: string }) => r._id)).toEqual([LOW_ROLE]);
  });

  it('an unparseable roles column reads as no roles rather than throwing', async () => {
    await db.members.update({ userId: PLAIN, serverId: SID }, { $set: { roles: '{not json' } });
    const res = await listFor(MANAGER, PLAIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('a non-member cannot read anyone\'s roles', async () => {
    await db.users.insert({ _id: 'gc-outsider', username: 'gc-outsider', tokenVersion: 0 });
    const res = await listFor('gc-outsider', PLAIN);
    expect(res.status).toBe(403);
  });
});

describe('assigning a role to a member', () => {
  const badRoleIds: Array<[string, unknown]> = [
    ['a missing roleId', undefined],
    ['an empty roleId', ''],
    ['a blank roleId', '   '],
    ['a non-string roleId', 42],
    ['an over-long roleId', 'x'.repeat(129)],
  ];
  for (const [name, roleId] of badRoleIds) {
    it(`refuses ${name}`, async () => {
      const res = await assignRole(OWNER, PLAIN, { roleId });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('roleId required');
    });
  }

  it('refuses a role that belongs to another server', async () => {
    const otherSid = 'grant-ceiling-other-2';
    await db.servers.insert({ _id: otherSid, name: 'Other', ownerId: OWNER });
    await db.roles.insert({ _id: 'foreign-role-2', serverId: otherSid, name: 'Foreign', permissions: 0, position: 5 });

    const res = await assignRole(OWNER, PLAIN, { roleId: 'foreign-role-2' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Role not found in this server/);
  });

  it('refuses to assign to someone who is not a member', async () => {
    const res = await assignRole(OWNER, 'gc-nobody', { roleId: LOW_ROLE });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Member not found');
  });

  it('lets an actor assign a permitted role to themselves', async () => {
    // Self-assignment of a role that already passed both gates grants nothing
    // new, so the strict "must outrank" rule is deliberately not applied here.
    const res = await assignRole(MANAGER, MANAGER, { roleId: LOW_ROLE });
    expect(res.status).toBe(200);
    const row = await db.members.findOne({ userId: MANAGER, serverId: SID });
    expect(row.roles).toContain(LOW_ROLE);
  });

  it('refuses to modify a member who outranks the actor', async () => {
    await db.members.update({ userId: PLAIN, serverId: SID }, { $set: { roles: [HIGH_ROLE] } });
    const res = await assignRole(MANAGER, PLAIN, { roleId: LOW_ROLE });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Role hierarchy prevents managing this member/);
  });
});
