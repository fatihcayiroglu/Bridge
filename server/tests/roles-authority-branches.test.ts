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
import { Members } from '../db/repositories';
import { PERMS, VALID_BITS } from '../lib/permissions';
import { _resetRateLimitStoreForTest } from '../middleware/rateLimit';

const db = require('../db/loader');
const { invalidatePerms } = require('../lib/permCache');
const { evictUserFromServerRooms } = require('../lib/liveMembership');
import { requireDoc } from './helpers/mockDb';

const SID = 'roles-authority-server';
const OWNER = 'roles-owner';
const MANAGER = 'roles-manager';
const HIGH = 'roles-high';
const LOW = 'roles-low';
const OUTSIDER = 'roles-outsider';
const MANAGER_ROLE = 'manager-role';
const HIGH_ROLE = 'high-role';
const LOW_ROLE = 'low-role';

function token(id: string): string {
  return jwt.sign({ id, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/servers', rolesRouter);
  return instance;
}

async function seed() {
  _resetRateLimitStoreForTest();
  db._reset?.();
  jest.clearAllMocks();
  for (const id of [OWNER, MANAGER, HIGH, LOW, OUTSIDER]) {
    await db.users.insert({ _id: id, username: id, displayName: id, tokenVersion: 0 });
  }
  await db.servers.insert({ _id: SID, name: 'Roles Authority', ownerId: OWNER });
  await db.roles.insert({
    _id: MANAGER_ROLE, serverId: SID, name: 'Manager',
    permissions: PERMS.MANAGE_ROLES | PERMS.KICK_MEMBERS | PERMS.SEND_MESSAGES,
    position: 50,
  });
  await db.roles.insert({
    _id: HIGH_ROLE, serverId: SID, name: 'High', permissions: PERMS.SEND_MESSAGES, position: 100,
  });
  await db.roles.insert({
    _id: LOW_ROLE, serverId: SID, name: 'Low', permissions: PERMS.SEND_MESSAGES, position: 10,
  });
  await db.members.insert({ userId: OWNER, serverId: SID, roles: [] });
  await db.members.insert({ userId: MANAGER, serverId: SID, roles: [MANAGER_ROLE] });
  await db.members.insert({ userId: HIGH, serverId: SID, roles: [HIGH_ROLE] });
  await db.members.insert({ userId: LOW, serverId: SID, roles: [] });
}

describe('role authorization and persisted bitmask boundary', () => {
  beforeEach(seed);

  it('preserves an explicit zero permission mask instead of silently granting SEND_MESSAGES', async () => {
    const res = await request(app())
      .post(`/api/servers/${SID}/roles`)
      .set('Authorization', `Bearer ${token(OWNER)}`)
      .send({ name: 'Zero', permissions: 0 });
    expect(res.status).toBe(200);
    expect(res.body.permissions).toBe(0);
  });

  it.each([
    ['non-integer', 1.5],
    ['negative', -1],
    ['unknown bit', 1 << 25],
    ['empty string', ''],
    ['array', ['KICK_MEMBERS']],
  ])('rejects malformed persisted permission masks: %s', async (_label, permissions) => {
    const res = await request(app())
      .post(`/api/servers/${SID}/roles`)
      .set('Authorization', `Bearer ${token(OWNER)}`)
      .send({ name: 'Invalid', permissions });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/permission/i);
  });

  it('still applies the documented default only when permissions is omitted', async () => {
    const res = await request(app())
      .post(`/api/servers/${SID}/roles`)
      .set('Authorization', `Bearer ${token(OWNER)}`)
      .send({ name: 'Default', color: 'not-a-color' });
    expect(res.status).toBe(200);
    expect(res.body.permissions).toBe(PERMS.SEND_MESSAGES);
    expect(res.body.color).toBe('#99aab5');
  });

  it('accepts a valid numeric string without changing its mask', async () => {
    const mask = PERMS.SEND_MESSAGES | PERMS.ATTACH_FILES;
    const res = await request(app())
      .post(`/api/servers/${SID}/roles`)
      .set('Authorization', `Bearer ${token(OWNER)}`)
      .send({ name: 'String mask', permissions: String(mask), color: '#abc' });
    expect(res.status).toBe(200);
    expect(res.body.permissions).toBe(mask);
    expect(res.body.color).toBe('#abc');
  });

  it('prevents a delegated role manager from granting a bit they do not possess', async () => {
    const res = await request(app())
      .post(`/api/servers/${SID}/roles`)
      .set('Authorization', `Bearer ${token(MANAGER)}`)
      .send({ name: 'Escalation', permissions: PERMS.MANAGE_ROLES | PERMS.BAN_MEMBERS });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/olmayan izin/i);
  });

  it('allows a delegated manager to create a role containing only their own bits', async () => {
    const res = await request(app())
      .post(`/api/servers/${SID}/roles`)
      .set('Authorization', `Bearer ${token(MANAGER)}`)
      .send({ name: 'Delegated', permissions: PERMS.SEND_MESSAGES });
    expect(res.status).toBe(200);
    expect(res.body.permissions).toBe(PERMS.SEND_MESSAGES);
  });

  it('rejects malformed permission updates instead of silently converting them to zero', async () => {
    const res = await request(app())
      .patch(`/api/servers/${SID}/roles/${LOW_ROLE}`)
      .set('Authorization', `Bearer ${token(OWNER)}`)
      .send({ permissions: 'not-a-mask' });
    expect(res.status).toBe(400);
    const stored = await db.roles.findOne({ _id: LOW_ROLE });
    expect(stored.permissions).toBe(PERMS.SEND_MESSAGES);
  });

  it('preserves explicit zero on update and invalidates permission cache', async () => {
    const res = await request(app())
      .patch(`/api/servers/${SID}/roles/${LOW_ROLE}`)
      .set('Authorization', `Bearer ${token(OWNER)}`)
      .send({ permissions: 0 });
    expect(res.status).toBe(200);
    expect(res.body.permissions).toBe(0);
    expect(invalidatePerms).toHaveBeenCalledWith(SID);
  });

  it('rejects a non-boolean profile visibility value without mutating the role', async () => {
    const res = await request(app())
      .patch(`/api/servers/${SID}/roles/${LOW_ROLE}`)
      .set('Authorization', `Bearer ${token(OWNER)}`)
      .send({ displayOnProfile: 'false' });
    expect(res.status).toBe(400);
  });

  it('prevents a lower manager from editing or deleting a higher role', async () => {
    const patch = await request(app())
      .patch(`/api/servers/${SID}/roles/${HIGH_ROLE}`)
      .set('Authorization', `Bearer ${token(MANAGER)}`)
      .send({ name: 'tampered' });
    expect(patch.status).toBe(403);

    const del = await request(app())
      .delete(`/api/servers/${SID}/roles/${HIGH_ROLE}`)
      .set('Authorization', `Bearer ${token(MANAGER)}`);
    expect(del.status).toBe(403);
    expect(await db.roles.findOne({ _id: HIGH_ROLE })).toBeTruthy();
  });

  it('does not let a lower manager change roles on a higher-ranked member', async () => {
    const assign = await request(app())
      .post(`/api/servers/${SID}/members/${HIGH}/roles`)
      .set('Authorization', `Bearer ${token(MANAGER)}`)
      .send({ roleId: LOW_ROLE });
    expect(assign.status).toBe(403);
    expect(assign.body.error).toMatch(/hierarchy/i);

    const remove = await request(app())
      .delete(`/api/servers/${SID}/members/${HIGH}/roles/${LOW_ROLE}`)
      .set('Authorization', `Bearer ${token(MANAGER)}`);
    expect(remove.status).toBe(403);
  });

  it('allows a manager to assign/remove a lower role on a lower-ranked member', async () => {
    const assign = await request(app())
      .post(`/api/servers/${SID}/members/${LOW}/roles`)
      .set('Authorization', `Bearer ${token(MANAGER)}`)
      .send({ roleId: LOW_ROLE });
    expect(assign.status).toBe(200);
    expect(assign.body.roles).toContain(LOW_ROLE);

    const duplicate = await request(app())
      .post(`/api/servers/${SID}/members/${LOW}/roles`)
      .set('Authorization', `Bearer ${token(MANAGER)}`)
      .send({ roleId: LOW_ROLE });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.roles.filter((r: string) => r === LOW_ROLE)).toHaveLength(1);

    const remove = await request(app())
      .delete(`/api/servers/${SID}/members/${LOW}/roles/${LOW_ROLE}`)
      .set('Authorization', `Bearer ${token(MANAGER)}`);
    expect(remove.status).toBe(200);
    expect(remove.body.roles).not.toContain(LOW_ROLE);
  });

  it('prevents a lower manager from kicking a higher-ranked member', async () => {
    const res = await request(app())
      .post(`/api/servers/${SID}/members/${HIGH}/kick`)
      .set('Authorization', `Bearer ${token(MANAGER)}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/hierarchy/i);
    expect(await db.members.findOne({ userId: HIGH, serverId: SID })).toBeTruthy();
  });

  it('kicks a lower-ranked member and evicts their live server rooms', async () => {
    const io = { sockets: { sockets: new Map() } };
    const instance = app();
    instance.set('io', io);
    const res = await request(instance)
      .post(`/api/servers/${SID}/members/${LOW}/kick`)
      .set('Authorization', `Bearer ${token(MANAGER)}`);
    expect(res.status).toBe(200);
    expect(await db.members.findOne({ userId: LOW, serverId: SID })).toBeFalsy();
    expect(invalidatePerms).toHaveBeenCalledWith(SID, LOW);
    expect(evictUserFromServerRooms).toHaveBeenCalledWith(io, LOW, SID);
  });

  it('returns 404 when kicking a user who is not a member', async () => {
    const res = await request(app())
      .post(`/api/servers/${SID}/members/${OUTSIDER}/kick`)
      .set('Authorization', `Bearer ${token(MANAGER)}`);
    expect(res.status).toBe(404);
  });

  it('still rejects self-kick and server-owner kick before hierarchy mutation', async () => {
    const self = await request(app())
      .post(`/api/servers/${SID}/members/${MANAGER}/kick`)
      .set('Authorization', `Bearer ${token(MANAGER)}`);
    expect(self.status).toBe(400);

    const owner = await request(app())
      .post(`/api/servers/${SID}/members/${OWNER}/kick`)
      .set('Authorization', `Bearer ${token(MANAGER)}`);
    expect(owner.status).toBe(403);
  });
});

describe('role authority remaining production branches', () => {
  beforeEach(seed);

  it('prevents a delegated manager from escalating an existing lower role beyond their own bits', async () => {
    const res = await request(app())
      .patch(`/api/servers/${SID}/roles/${LOW_ROLE}`)
      .set('Authorization', `Bearer ${token(MANAGER)}`)
      .send({ permissions: PERMS.SEND_MESSAGES | PERMS.BAN_MEMBERS });
    expect(res.status).toBe(403);
    expect((await requireDoc(db.roles, { _id: LOW_ROLE })).permissions).toBe(PERMS.SEND_MESSAGES);
  });

  it('persists a boolean profile-visibility change without changing permissions', async () => {
    const before = await db.roles.findOne({ _id: LOW_ROLE });
    const res = await request(app())
      .patch(`/api/servers/${SID}/roles/${LOW_ROLE}`)
      .set('Authorization', `Bearer ${token(OWNER)}`)
      .send({ displayOnProfile: false });
    expect(res.status).toBe(200);
    expect(res.body.displayOnProfile).toBe(false);
    expect(res.body.permissions).toBe(before.permissions);
  });

  it('reads legacy JSON-string role lists and hides roles marked off-profile', async () => {
    await db.members.update({ userId: LOW, serverId: SID }, { $set: { roles: JSON.stringify([HIGH_ROLE, LOW_ROLE]) } });
    await db.roles.update({ _id: LOW_ROLE }, { $set: { displayOnProfile: false } });
    const res = await request(app())
      .get(`/api/servers/${SID}/members/${LOW}/roles`)
      .set('Authorization', `Bearer ${token(MANAGER)}`);
    expect(res.status).toBe(200);
    expect(res.body.map((r: { _id: string }) => r._id)).toEqual([HIGH_ROLE]);
    expect(res.body[0].permissions).toBeUndefined();
  });

  it('treats malformed legacy role storage as no visible roles instead of throwing', async () => {
    await db.members.update({ userId: LOW, serverId: SID }, { $set: { roles: '[broken' } });
    const res = await request(app())
      .get(`/api/servers/${SID}/members/${LOW}/roles`)
      .set('Authorization', `Bearer ${token(MANAGER)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('fails closed for missing role/member on assign/remove', async () => {
    let res = await request(app())
      .post(`/api/servers/${SID}/members/${LOW}/roles`)
      .set('Authorization', `Bearer ${token(MANAGER)}`)
      .send({ roleId: 'missing-role' });
    expect(res.status).toBe(404);

    res = await request(app())
      .post(`/api/servers/${SID}/members/${OUTSIDER}/roles`)
      .set('Authorization', `Bearer ${token(MANAGER)}`)
      .send({ roleId: LOW_ROLE });
    expect(res.status).toBe(404);

    res = await request(app())
      .delete(`/api/servers/${SID}/members/${LOW}/roles/missing-role`)
      .set('Authorization', `Bearer ${token(MANAGER)}`);
    expect(res.status).toBe(404);

    res = await request(app())
      .delete(`/api/servers/${SID}/members/${OUTSIDER}/roles/${LOW_ROLE}`)
      .set('Authorization', `Bearer ${token(MANAGER)}`);
    expect(res.status).toBe(404);
  });

  it('rejects kick when the actor lacks KICK_MEMBERS', async () => {
    const res = await request(app())
      .post(`/api/servers/${SID}/members/${LOW}/kick`)
      .set('Authorization', `Bearer ${token(LOW)}`);
    expect(res.status).toBe(403);
  });
});

describe('role membership persisted-state normalization', () => {
  beforeEach(seed);

  it('drops malformed JSON-looking role state instead of re-persisting it as a fake role id', async () => {
    await db.members.update({ userId: LOW, serverId: SID }, { $set: { roles: '[broken' } });
    const res = await request(app())
      .post(`/api/servers/${SID}/members/${LOW}/roles`)
      .set('Authorization', `Bearer ${token(MANAGER)}`)
      .send({ roleId: LOW_ROLE });
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual([LOW_ROLE]);
    const stored = await db.members.findOne({ userId: LOW, serverId: SID });
    expect(stored.roles).not.toContain('[broken');
  });

  it('filters non-string, blank, and duplicate ids from corrupted array state before mutation', async () => {
    await db.members.update(
      { userId: LOW, serverId: SID },
      { $set: { roles: [LOW_ROLE, LOW_ROLE, '', 7, null] } },
    );
    const res = await request(app())
      .post(`/api/servers/${SID}/members/${LOW}/roles`)
      .set('Authorization', `Bearer ${token(MANAGER)}`)
      .send({ roleId: LOW_ROLE });
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual([LOW_ROLE]);
  });

  it('keeps a legacy single bare role id compatible', async () => {
    await db.members.update({ userId: LOW, serverId: SID }, { $set: { roles: LOW_ROLE } });
    const res = await request(app())
      .delete(`/api/servers/${SID}/members/${LOW}/roles/${LOW_ROLE}`)
      .set('Authorization', `Bearer ${token(MANAGER)}`);
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual([]);
  });

  it('does not lose either role when two authorized assignments race', async () => {
    const originalAddRole = Members.addRole.bind(Members);
    let arrivals = 0;
    let release!: () => void;
    const bothReady = new Promise<void>(resolve => { release = resolve; });
    const addRole = jest.spyOn(Members, 'addRole').mockImplementation(async (userId, serverId, roleId) => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothReady;
      return originalAddRole(userId, serverId, roleId);
    });
    try {
      const [high, low] = await Promise.all([
        request(app()).post(`/api/servers/${SID}/members/${LOW}/roles`)
          .set('Authorization', `Bearer ${token(OWNER)}`).send({ roleId: HIGH_ROLE }),
        request(app()).post(`/api/servers/${SID}/members/${LOW}/roles`)
          .set('Authorization', `Bearer ${token(OWNER)}`).send({ roleId: LOW_ROLE }),
      ]);
      expect(high.status).toBe(200);
      expect(low.status).toBe(200);
      const stored = await db.members.findOne({ userId: LOW, serverId: SID });
      const roles = Array.isArray(stored.roles) ? stored.roles : JSON.parse(stored.roles);
      expect(new Set(roles)).toEqual(new Set([HIGH_ROLE, LOW_ROLE]));
    } finally {
      addRole.mockRestore();
    }
  });
});

describe('role runtime body type validation', () => {
  beforeEach(seed);

  it.each([
    [{ name: 7 }, /name/i],
    [{ name: 'valid', color: { hex: '#fff' } }, /color/i],
  ])('rejects malformed role creation metadata %#', async (body, pattern) => {
    const res = await request(app()).post(`/api/servers/${SID}/roles`)
      .set('Authorization', `Bearer ${token(OWNER)}`).send(body);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(pattern);
  });

  it.each([
    [{ name: 7 }, /name/i],
    [{ color: ['#fff'] }, /color/i],
  ])('rejects malformed role update metadata %#', async (body, pattern) => {
    const res = await request(app()).patch(`/api/servers/${SID}/roles/${LOW_ROLE}`)
      .set('Authorization', `Bearer ${token(OWNER)}`).send(body);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(pattern);
  });

  it.each([7, {}, ['role']])('rejects a non-string roleId assignment: %p', async (roleId) => {
    const res = await request(app()).post(`/api/servers/${SID}/members/${LOW}/roles`)
      .set('Authorization', `Bearer ${token(OWNER)}`).send({ roleId });
    expect(res.status).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Final21 Phase 17 — the refusals and defaults of role management.
//
// The suite covered the hierarchy rules well but never asked what happens at the edges of
// the same endpoints: a body that is not an object, a role or member that does not exist,
// a plain member reaching the role-removal endpoint, and the server owner — who by design
// is not bounded by the grant ceiling that binds everyone else.
// ════════════════════════════════════════════════════════════════════════════
// Bu urunun TANIMLAMADIGI ilk bit. Sabit yazmak yerine turetilir: yeni bir izin
// eklendiginde test sessizce anlamsizlasmasin.
const UNDEFINED_BIT = (() => { let bit = 1; while ((VALID_BITS & bit) !== 0) bit *= 2; return bit; })();

describe('Final21 Phase 17 — role management refusals and defaults', () => {
  beforeEach(seed);

  it('the server owner may create a role carrying every permission', async () => {
    // Everyone else may only hand out bits they themselves hold. The owner holds the server,
    // so the ceiling does not apply — otherwise a fresh server could never get its first
    // administrator role.
    const res = await request(app())
      .post(`/api/servers/${SID}/roles`)
      .set(`Authorization`, `Bearer ${token(OWNER)}`)
      .send({ name: 'Yönetici', permissions: PERMS.ADMINISTRATOR | PERMS.MANAGE_ROLES | PERMS.BAN_MEMBERS });

    expect(res.status).toBe(200);
    expect(Number(res.body.permissions) & PERMS.ADMINISTRATOR).toBe(PERMS.ADMINISTRATOR);
  });

  it('refuses a permission mask carrying bits this product does not define', async () => {
    // An unknown bit is not harmless: it is stored and later resolved, so a future release
    // that gives that bit a meaning would silently hand it to everyone holding this role.
    const res = await request(app())
      .post(`/api/servers/${SID}/roles`)
      .set(`Authorization`, `Bearer ${token(OWNER)}`)
      .send({ name: 'Gelecek', permissions: UNDEFINED_BIT | PERMS.SEND_MESSAGES });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/canonical non-negative integer bitmask/i);
    expect(await db.roles.findOne({ serverId: SID, name: 'Gelecek' })).toBeFalsy();
  });

  it('a channel row with no name or type still previews, with the documented defaults', async () => {
    // Rows created by older versions (and by imports) carry neither. Throwing or printing
    // "undefined" in the permission preview would make the screen unusable for exactly the
    // servers that need it most.
    await db.channels.insert({ _id: 'legacy-ch', serverId: SID });
    const res = await request(app())
      .get(`/api/servers/${SID}/roles/${LOW_ROLE}/preview`)
      .set(`Authorization`, `Bearer ${token(OWNER)}`);

    expect(res.status).toBe(200);
    const row = res.body.channels.find((c: { channelId: string }) => c.channelId === 'legacy-ch');
    expect(row).toMatchObject({ name: 'Adsız kanal', type: 'text', categoryId: null });
  });

  it('previewing a role that does not belong to this server is a 404, not an empty preview', async () => {
    const res = await request(app())
      .get(`/api/servers/${SID}/roles/does-not-exist/preview`)
      .set(`Authorization`, `Bearer ${token(OWNER)}`);

    expect(res.status).toBe(404);
  });

  it('a JSON array body is treated as no fields at all, not as a mutation', async () => {
    const res = await request(app())
      .patch(`/api/servers/${SID}/roles/${LOW_ROLE}`)
      .set(`Authorization`, `Bearer ${token(OWNER)}`)
      .send([{ name: 'Sızdırılmış' }]);

    expect(res.status).toBe(200);
    expect(await db.roles.findOne({ _id: LOW_ROLE })).toMatchObject({ name: 'Low' });
  });

  it('deleting a role that is not in this server is a 404', async () => {
    const res = await request(app())
      .delete(`/api/servers/${SID}/roles/no-such-role`)
      .set(`Authorization`, `Bearer ${token(OWNER)}`);

    expect(res.status).toBe(404);
  });

  it('assigning a role needs a roleId in an object body', async () => {
    const res = await request(app())
      .post(`/api/servers/${SID}/members/${LOW}/roles`)
      .set(`Authorization`, `Bearer ${token(OWNER)}`)
      .send([LOW_ROLE]);

    expect(res.status).toBe(400);
    expect((await requireDoc(db.members, { userId: LOW, serverId: SID })).roles).toEqual([]);
  });

  it('assigning a role to someone who is not a member is a 404', async () => {
    const res = await request(app())
      .post(`/api/servers/${SID}/members/${OUTSIDER}/roles`)
      .set(`Authorization`, `Bearer ${token(OWNER)}`)
      .send({ roleId: LOW_ROLE });

    expect(res.status).toBe(404);
  });

  it('removing a role from someone who is not a member is a 404', async () => {
    const res = await request(app())
      .delete(`/api/servers/${SID}/members/${OUTSIDER}/roles/${LOW_ROLE}`)
      .set(`Authorization`, `Bearer ${token(OWNER)}`);

    expect(res.status).toBe(404);
  });

  it('a plain member cannot strip a role off anyone', async () => {
    await db.members.update({ userId: HIGH, serverId: SID }, { $set: { roles: [HIGH_ROLE] } });
    const res = await request(app())
      .delete(`/api/servers/${SID}/members/${HIGH}/roles/${HIGH_ROLE}`)
      .set(`Authorization`, `Bearer ${token(LOW)}`);

    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/MANAGE_ROLES/);
    expect((await requireDoc(db.members, { userId: HIGH, serverId: SID })).roles).toEqual([HIGH_ROLE]);
  });

  it('a manager cannot strip a role that outranks them', async () => {
    await db.members.update({ userId: HIGH, serverId: SID }, { $set: { roles: [HIGH_ROLE] } });
    const res = await request(app())
      .delete(`/api/servers/${SID}/members/${HIGH}/roles/${HIGH_ROLE}`)
      .set(`Authorization`, `Bearer ${token(MANAGER)}`);

    expect(res.status).toBe(403);
    // TAM mesaj: 'bu ROL' guardi. Yalnizca /hierarchy/ aramak yetmezdi — o kalip, bir
    // alttaki UYE hiyerarsisi reddine de uyar, yani rol guardi silinse bile test gecerdi
    // (mutasyon kontrolu bunu boyle yakaladi).
    expect(res.body.error).toBe('Role hierarchy prevents removing this role');
    expect((await requireDoc(db.members, { userId: HIGH, serverId: SID })).roles).toEqual([HIGH_ROLE]);
  });
});
