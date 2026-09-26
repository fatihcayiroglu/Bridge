// server/tests/moderation.test.ts
// Tests for timeout, remove-timeout, audit-log endpoints
import type { Request, Response, NextFunction } from 'express';

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

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
}));

// Default: full permissions
const mockHasPermission = jest.fn((..._args: unknown[]) => true);
const mockCanActOn = jest.fn(async (..._args: unknown[]) => true);
jest.mock('../routes/roles', () => ({
  getMemberPerms: async () => 0xFFFFFFFF,
  hasPermission: (...args: unknown[]) => mockHasPermission(...args),
  canActOn: (...args: unknown[]) => mockCanActOn(...args),
  PERMS: {
    MANAGE_MESSAGES: 32,
    TIMEOUT_MEMBERS: 64,
    KICK_MEMBERS: 128,
    BAN_MEMBERS: 256,
    ADMIN: 8,
    MANAGE_CHANNELS: 16,
    SEND_MESSAGES: 16,
  },
}));
jest.mock('../lib/permCache', () => ({
  invalidatePerms: jest.fn(),
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: { moderation: () => (_req: unknown, _res: unknown, next: () => void) => next() },
}));

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');

import router from '../routes/moderation';
import { Members } from '../db/repositories';

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: NextFunction) => {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    try { req.user = jwt.verify(h.slice(7), 'test-jwt-secret-long-enough-32chars!!'); } catch {}
  }
  next();
});
// mergeParams-style mounting
app.use('/api/servers/:serverId', router);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(err.status || 500).json({ error: err.message }));

function token(id: string) {
  return jwt.sign({ id, username: 'mod', displayName: 'Moderator', v: 0 }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });
}

const MOD_ID    = 'mod1';
const TARGET_ID = 'target1';
const SERVER_ID = 'srv1';

beforeAll(async () => {
  await mockDb.users.insert({ _id: MOD_ID,    username: 'mod',    displayName: 'Moderator', avatarColor: '#fff', status: 'online' });
  await mockDb.users.insert({ _id: TARGET_ID, username: 'victim', displayName: 'Victim',    avatarColor: '#fff', status: 'online' });
  await mockDb.servers.insert({ _id: SERVER_ID, name: 'TestServer', ownerId: MOD_ID, createdAt: Date.now() });
  await mockDb.members.insert({ userId: MOD_ID,    serverId: SERVER_ID, roles: '[]', joinedAt: Date.now() });
  await mockDb.members.insert({ userId: TARGET_ID, serverId: SERVER_ID, roles: '[]', joinedAt: Date.now() });
  await mockDb.auditLogs.insert({
    _id: 'seed-audit',
    serverId: SERVER_ID,
    actorId: MOD_ID,
    actorName: 'Moderator',
    action: 'timeout',
    targetId: TARGET_ID,
    targetName: 'victim',
    detail: 'seed',
    createdAt: Date.now(),
  });
});

beforeEach(() => {
  mockHasPermission.mockReset();
  mockHasPermission.mockReturnValue(true);
  mockCanActOn.mockReset();
  mockCanActOn.mockResolvedValue(true);
});

describe('POST /api/servers/:serverId/members/:userId/kick', () => {
  it('removes the target membership using userId/serverId repository ordering', async () => {
    await mockDb.members.remove({ userId: TARGET_ID, serverId: SERVER_ID });
    await mockDb.members.insert({ userId: TARGET_ID, serverId: SERVER_ID, roles: '[]', joinedAt: Date.now() });

    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/kick`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ reason: 'regression' });

    expect(res.status).toBe(200);
    expect(await mockDb.members.findOne({ userId: TARGET_ID, serverId: SERVER_ID })).toBeNull();

    // Keep the shared fixture usable by the timeout/audit tests below.
    await mockDb.members.insert({ userId: TARGET_ID, serverId: SERVER_ID, roles: '[]', joinedAt: Date.now() });
  });
});

describe('POST /api/servers/:serverId/members/:userId/timeout', () => {
  it('applies a valid timeout (60s)', async () => {
    const before = Date.now();
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/timeout`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ durationMs: 60_000 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Date.parse(res.body.until)).toBeGreaterThan(before);

    // member row should have timeoutUntil set
    const member = await requireDoc(mockDb.members, { userId: TARGET_ID, serverId: SERVER_ID });
    expect(member.timeoutUntil).toBeDefined();
    expect(member.timeoutUntil).toBeGreaterThan(before);
  });

  it('applies a 1-week timeout (604800s)', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/timeout`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ durationMs: 604_800_000 });
    expect(res.status).toBe(200);
  });

  it('accepts millisecond duration values', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/timeout`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ durationMs: 9_999 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });


  it.each([undefined, 'bad', '60000', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 28 * 24 * 60 * 60 * 1000 + 1])(
    'rejects malformed or out-of-policy durationMs %p instead of treating it as timeout removal',
    async (durationMs) => {
      const body = durationMs === undefined ? {} : { durationMs };
      const res = await request(app)
        .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/timeout`)
        .set('Authorization', `Bearer ${token(MOD_ID)}`)
        .send(body);
      expect(res.status).toBe(400);
    },
  );

  it('returns 404 for non-existent user', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/ghost-user/timeout`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ durationMs: 60_000 });
    expect(res.status).toBe(404);
  });

  it('rejects without permission', async () => {
    mockHasPermission.mockReturnValue(false);
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/timeout`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ durationMs: 60_000 });
    expect(res.status).toBe(403);
  });

  it('writes an audit log entry', async () => {
    await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/timeout`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ durationMs: 300_000, reason: 'manual test' });
    const logs = await mockDb.auditLogs.find({ serverId: SERVER_ID, action: 'timeout' });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[logs.length - 1].targetId).toBe(TARGET_ID);
    expect(logs[logs.length - 1].detail).toContain('manual test');
  });
});

describe('POST /api/servers/:serverId/members/:userId/timeout with durationMs=0', () => {
  it('removes a timeout', async () => {
    // first set a timeout
    await mockDb.members.update({ userId: TARGET_ID, serverId: SERVER_ID }, { $set: { timeoutUntil: Date.now() + 60000 } });

    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/timeout`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ durationMs: 0 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const member = await requireDoc(mockDb.members, { userId: TARGET_ID, serverId: SERVER_ID });
    expect(member.timeoutUntil).toBeNull();
  });

  it('rejects without permission', async () => {
    mockHasPermission.mockReturnValue(false);
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/timeout`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ durationMs: 0 });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/servers/:serverId/audit-log', () => {
  it('returns audit log entries (moderator)', async () => {
    const res = await request(app)
      .get(`/api/servers/${SERVER_ID}/audit-log`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries.length).toBeGreaterThan(0);
    expect(typeof res.body.total).toBe('number');
    if (res.body.entries.length > 1) {
      expect(res.body.entries[0].createdAt).toBeGreaterThanOrEqual(res.body.entries[1].createdAt);
    }
  });

  it('includes TIMEOUT entries', async () => {
    const res = await request(app)
      .get(`/api/servers/${SERVER_ID}/audit-log`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    const timeoutEntries = res.body.entries.filter((e: Record<string, unknown>) => e.action === 'timeout');
    expect(timeoutEntries.length).toBeGreaterThan(0);
  });

  it.each([
    '?limit=-1', '?limit=1.5', '?limit=10oops', '?limit=9007199254740992',
    '?offset=-1', '?offset=1.5', '?offset=10oops', '?offset=9007199254740992',
    '?format=xml', '?after=not-a-date', '?before=not-a-date',
  ])('rejects malformed audit query values: %s', async (query) => {
    const res = await request(app)
      .get(`/api/servers/${SERVER_ID}/audit-log${query}`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(res.status).toBe(400);
  });

  it('rejects inverted audit date ranges', async () => {
    const res = await request(app)
      .get(`/api/servers/${SERVER_ID}/audit-log?after=2026-08-30&before=2026-08-29`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(res.status).toBe(400);
  });

  it('returns 403 without permission', async () => {
    mockHasPermission.mockReturnValue(false);
    const res = await request(app)
      .get(`/api/servers/${SERVER_ID}/audit-log`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(res.status).toBe(403);
    mockHasPermission.mockReturnValue(true);
  });
});

/** Kanal izni anlik goruntusu — `null` "override YOK" demektir. */
type PermissionSnapshot = { allow: number; deny: number } | null;

interface PermissionAuditSeed {
  action?: string;
  /** Degisiklikten ONCEKI durum; olusturma olayinda `null`. */
  old?: PermissionSnapshot;
  /** Degisiklikten SONRAKI durum; silme olayinda `null`. */
  next?: PermissionSnapshot;
  /** DB'ye fiilen yazilacak guncel durum. */
  current?: PermissionSnapshot;
}

// Varsayilanlar nesne edebisinden CIKARILMIYORDU: `next` kendisine
// (`current = next`) atifta bulundugu icin TypeScript tipi cozemiyor ve
// TS7022 veriyordu. Ayrica `old: null` gecen cagrilar, cikarilan
// `{allow, deny}` tipine uymuyordu — oysa `null` MESRU bir durumdur.
async function seedPermissionAudit(suffix: string, {
  action = 'PERM_UPDATE',
  old = { allow: 1, deny: 0 },
  next = { allow: 0, deny: 1 },
  current = next,
}: PermissionAuditSeed = {}) {
  const channelId = `audit-channel-${suffix}`;
  const roleId = `audit-role-${suffix}`;
  const auditId = `permission-audit-${suffix}`;
  await mockDb.channels.insert({ _id: channelId, serverId: SERVER_ID, name: `staff-${suffix}`, type: 'text', createdAt: Date.now() });
  await mockDb.roles.insert({ _id: roleId, serverId: SERVER_ID, name: `Moderator-${suffix}`, permissions: 0, position: 1, createdAt: Date.now() });
  if (current) {
    await mockDb.channelPermissions.insert({
      _id: `override-${suffix}`, serverId: SERVER_ID, channelId, roleId,
      allow: current.allow, deny: current.deny, createdAt: Date.now(),
    });
  }
  await mockDb.auditLogs.insert({
    _id: auditId, serverId: SERVER_ID, channelId,
    actorId: MOD_ID, actorName: 'Moderator', action,
    targetId: roleId, targetName: roleId,
    old: old === null ? null : JSON.stringify(old),
    new: next === null ? null : JSON.stringify(next),
    extra: '{}', detail: '', createdAt: Date.now() - 100,
  });
  return { channelId, roleId, auditId, old, next };
}

describe('ADMIN AUDIT UX + narrow safe undo', () => {
  it('ui=1 mevcut audit kaydını kanal/rol adları ve kanıtlanmış undo durumuyla zenginleştirir', async () => {
    const seeded = await seedPermissionAudit('ui');
    const res = await request(app)
      .get(`/api/servers/${SERVER_ID}/audit-log?ui=1&limit=500`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);

    expect(res.status).toBe(200);
    const row = res.body.entries.find((entry: Record<string, unknown>) => entry._id === seeded.auditId);
    expect(row).toMatchObject({
      channelName: 'staff-ui', targetName: 'Moderator-ui',
      old: { allow: 1, deny: 0 }, new: { allow: 0, deny: 1 },
      undo: { supported: true, canUndo: true },
    });
  });

  it('PERM_UPDATE yalnız mevcut durum audit sonrası değerle eşitse atomik olarak eski değere döner', async () => {
    const seeded = await seedPermissionAudit('update');
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/audit-log/${seeded.auditId}/undo`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, scope: 'channel_permission' });
    const restored = await mockDb.channelPermissions.findOne({ channelId: seeded.channelId, roleId: seeded.roleId });
    expect(restored).toMatchObject({ allow: 1, deny: 0 });
    const undoLogs = await mockDb.auditLogs.find({
      serverId: SERVER_ID, channelId: seeded.channelId, targetId: seeded.roleId, action: 'PERM_UNDO',
    });
    expect(undoLogs).toHaveLength(1);
    expect(String(undoLogs[0].extra)).toContain(seeded.auditId);
  });

  it('yeni oluşturulmuş override’ın güvenli tersi exact-match silmedir', async () => {
    const seeded = await seedPermissionAudit('created', { old: null, next: { allow: 256, deny: 0 } });
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/audit-log/${seeded.auditId}/undo`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);

    expect(res.status).toBe(200);
    expect(await mockDb.channelPermissions.findOne({ channelId: seeded.channelId, roleId: seeded.roleId })).toBeNull();
  });

  it('silinmiş override yalnız hedef hâlâ boşsa eski değerle geri kurulur', async () => {
    const seeded = await seedPermissionAudit('deleted', {
      action: 'PERM_DELETE', old: { allow: 256, deny: 0 }, next: null, current: null,
    });
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/audit-log/${seeded.auditId}/undo`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);

    expect(res.status).toBe(200);
    const restored = await mockDb.channelPermissions.findOne({ channelId: seeded.channelId, roleId: seeded.roleId });
    expect(restored).toMatchObject({ allow: 256, deny: 0, serverId: SERVER_ID });
  });

  it('mevcut durum audit sonrası değerinden sapmışsa reddeder ve yeni durumu ezmez', async () => {
    const seeded = await seedPermissionAudit('diverged', { current: { allow: 512, deny: 0 } });
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/audit-log/${seeded.auditId}/undo`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/değişmiş/i);
    const current = await mockDb.channelPermissions.findOne({ channelId: seeded.channelId, roleId: seeded.roleId });
    expect(current).toMatchObject({ allow: 512, deny: 0 });
  });

  it('aynı hedefte daha yeni yönetici değişikliği varsa eski audit kaydını geri almaz', async () => {
    const seeded = await seedPermissionAudit('newer');
    await mockDb.auditLogs.insert({
      _id: 'permission-audit-newer-2', serverId: SERVER_ID,
      channelId: seeded.channelId, targetId: seeded.roleId,
      actorId: MOD_ID, actorName: 'Moderator', action: 'PERM_UPDATE',
      old: JSON.stringify(seeded.next), new: JSON.stringify(seeded.next), extra: '{}', detail: '',
      createdAt: Date.now(),
    });

    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/audit-log/${seeded.auditId}/undo`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/daha yeni/i);
  });

  it('kanal veya rol silinmişse hedefi hayalet olarak yeniden oluşturmaz', async () => {
    const seeded = await seedPermissionAudit('missing-target');
    await mockDb.roles.remove({ _id: seeded.roleId, serverId: SERVER_ID });

    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/audit-log/${seeded.auditId}/undo`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/artık mevcut değil/i);
  });

  it('kick/ban/timeout için genel rollback uydurmaz', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/audit-log/seed-audit/undo`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kapsamına dahil değil/i);
  });

  it('günlüğü görebilse bile MANAGE_CHANNELS olmayan yönetici geri alamaz', async () => {
    const seeded = await seedPermissionAudit('forbidden');
    mockHasPermission.mockImplementation((..._args: unknown[]) => _args[1] === 32); // yalnız MANAGE_MESSAGES
    const read = await request(app)
      .get(`/api/servers/${SERVER_ID}/audit-log`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    const undo = await request(app)
      .post(`/api/servers/${SERVER_ID}/audit-log/${seeded.auditId}/undo`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);

    expect(read.status).toBe(200);
    expect(undo.status).toBe(403);
  });

  it('after/before filtrelerini veri deposuna uygular', async () => {
    const after = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const res = await request(app)
      .get(`/api/servers/${SERVER_ID}/audit-log?after=${after}`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(0);
  });

  it('CSV hücrelerini ve spreadsheet formüllerini güvenli biçimde kaçışlar', async () => {
    await mockDb.auditLogs.insert({
      _id: 'csv-safe-audit', serverId: SERVER_ID, actorId: MOD_ID,
      actorName: '=HYPERLINK("https://evil")', action: 'csv_test',
      targetId: TARGET_ID, targetName: 'Victim, Inc.', detail: 'line\nnext', createdAt: Date.now(),
    });
    const res = await request(app)
      .get(`/api/servers/${SERVER_ID}/audit-log?format=csv&action=csv_test`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('"\'=HYPERLINK(""https://evil"")"');
    expect(res.text).toContain('"Victim, Inc."');
    expect(res.text).toContain('"line next"');
  });
});


describe('POST /api/servers/:serverId/bans input safety', () => {
  it.each([-1, 1.5, 8, 'bad', '7'])('rejects unsafe deleteMessageDays=%p before mutating membership', async (deleteMessageDays) => {
    const before = await mockDb.members.findOne({ userId: TARGET_ID, serverId: SERVER_ID });
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/bans`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ userId: TARGET_ID, deleteMessageDays });
    expect(res.status).toBe(400);
    expect(await mockDb.members.findOne({ userId: TARGET_ID, serverId: SERVER_ID })).toEqual(before);
  });

  it.each([
    ['timeout', `/api/servers/${SERVER_ID}/members/${TARGET_ID}/timeout`, { durationMs: 1000, reason: { nested: true } }],
    ['kick', `/api/servers/${SERVER_ID}/members/${TARGET_ID}/kick`, { reason: ['not', 'text'] }],
    ['ban', `/api/servers/${SERVER_ID}/bans`, { userId: TARGET_ID, deleteMessageDays: 0, reason: 123 }],
  ])('rejects non-string moderation reasons for %s before mutation', async (_label, url, body) => {
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send(body);
    expect(res.status).toBe(400);
  });

  it.each([null, [], 42, { nested: true }])('rejects non-string ban userId=%p before membership mutation', async (userId) => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/bans`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ userId, deleteMessageDays: 0 });
    expect(res.status).toBe(400);
  });

  it('accepts the documented upper bound of seven days', async () => {
    await mockDb.members.remove({ userId: TARGET_ID, serverId: SERVER_ID });
    await mockDb.members.insert({ userId: TARGET_ID, serverId: SERVER_ID, roles: '[]', joinedAt: Date.now() });
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/bans`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ userId: TARGET_ID, deleteMessageDays: 7, reason: 'safety-bound' });
    expect(res.status).toBe(200);
    await mockDb.members.remove({ userId: TARGET_ID, serverId: SERVER_ID });
    await mockDb.members.insert({ userId: TARGET_ID, serverId: SERVER_ID, roles: '[]', joinedAt: Date.now() });
  });
});


describe('moderation authority branch hardening', () => {
  it('does not claim timeout/kick success for a global user outside the selected server', async () => {
    const outsiderId = 'existing-global-nonmember';
    await mockDb.users.insert({ _id: outsiderId, username: 'outsider', displayName: 'Outsider' });
    await mockDb.members.remove({ userId: outsiderId, serverId: SERVER_ID });
    const auditCount = await mockDb.auditLogs.count({ serverId: SERVER_ID, targetId: outsiderId });

    const timeout = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${outsiderId}/timeout`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ durationMs: 1000 });
    const kick = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${outsiderId}/kick`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({});

    expect(timeout.status).toBe(404);
    expect(kick.status).toBe(404);
    expect(await mockDb.auditLogs.count({ serverId: SERVER_ID, targetId: outsiderId })).toBe(auditCount);
  });

  it('reports a lost kick race instead of auditing a successful removal', async () => {
    const before = await mockDb.auditLogs.count({ serverId: SERVER_ID, action: 'kick', targetId: TARGET_ID });
    const remove = jest.spyOn(Members, 'removeMember').mockResolvedValueOnce({ deleted: 0 } as any);
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/kick`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({});
    remove.mockRestore();
    expect(res.status).toBe(409);
    expect(await mockDb.auditLogs.count({ serverId: SERVER_ID, action: 'kick', targetId: TARGET_ID })).toBe(before);
  });

  it('returns not-found when unbanning a user with no ban row', async () => {
    const userId = 'never-banned-user';
    await mockDb.users.insert({ _id: userId, username: 'never-banned', displayName: 'Never Banned' });
    await mockDb.members.remove({ userId, serverId: SERVER_ID });
    const before = await mockDb.auditLogs.count({ serverId: SERVER_ID, action: 'unban', targetId: userId });
    const res = await request(app)
      .delete(`/api/servers/${SERVER_ID}/bans/${userId}`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(res.status).toBe(404);
    expect(await mockDb.auditLogs.count({ serverId: SERVER_ID, action: 'unban', targetId: userId })).toBe(before);
  });

  it('rejects self-kick before any mutation', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${MOD_ID}/kick`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ reason: 'self' });
    expect(res.status).toBe(400);
  });

  it('rejects kick without permission and when hierarchy denies the action', async () => {
    mockHasPermission.mockReturnValue(false);
    let res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/kick`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({});
    expect(res.status).toBe(403);

    mockHasPermission.mockReturnValue(true);
    mockCanActOn.mockResolvedValue(false);
    res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/kick`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('rejects timeout when hierarchy denies the action', async () => {
    mockCanActOn.mockResolvedValue(false);
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/timeout`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ durationMs: 1000 });
    expect(res.status).toBe(403);
  });

  it('guards ban list access', async () => {
    mockHasPermission.mockReturnValue(false);
    const denied = await request(app)
      .get(`/api/servers/${SERVER_ID}/bans`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(denied.status).toBe(403);
    mockHasPermission.mockReturnValue(true);
    const allowed = await request(app)
      .get(`/api/servers/${SERVER_ID}/bans`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(allowed.status).toBe(200);
    expect(Array.isArray(allowed.body)).toBe(true);
  });

  it('rejects self-ban and hierarchy-denied ban', async () => {
    let res = await request(app)
      .post(`/api/servers/${SERVER_ID}/bans`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ userId: MOD_ID, deleteMessageDays: 0 });
    expect(res.status).toBe(400);

    mockCanActOn.mockResolvedValue(false);
    res = await request(app)
      .post(`/api/servers/${SERVER_ID}/bans`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`)
      .send({ userId: TARGET_ID, deleteMessageDays: 0 });
    expect(res.status).toBe(403);
  });

  it('guards unban and records a successful unban', async () => {
    mockHasPermission.mockReturnValue(false);
    let res = await request(app)
      .delete(`/api/servers/${SERVER_ID}/bans/${TARGET_ID}`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(res.status).toBe(403);

    mockHasPermission.mockReturnValue(true);
    await mockDb.members.remove({ userId: TARGET_ID, serverId: SERVER_ID });
    await mockDb.members.insert({ userId: TARGET_ID, serverId: SERVER_ID, banned: true, joinedAt: Date.now() });
    res = await request(app)
      .delete(`/api/servers/${SERVER_ID}/bans/${TARGET_ID}`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(res.status).toBe(200);
    await mockDb.members.insert({ userId: TARGET_ID, serverId: SERVER_ID, roles: '[]', joinedAt: Date.now() });
  });
});

describe('moderation audit undo defensive branches', () => {
  it('ui=1 exposes supported-but-denied undo when actor lacks MANAGE_CHANNELS', async () => {
    const seeded = await seedPermissionAudit('ui-no-manage');
    mockHasPermission.mockImplementation((..._args: unknown[]) => _args[1] === 32); // MANAGE_MESSAGES only
    const res = await request(app)
      .get(`/api/servers/${SERVER_ID}/audit-log?ui=1&limit=500`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(res.status).toBe(200);
    const row = res.body.entries.find((entry: Record<string, unknown>) => entry._id === seeded.auditId);
    expect(row.undo).toMatchObject({ supported: true, canUndo: false });
    expect(row.undo.reason).toMatch(/kanalları yönetme/i);
  });

  it('rejects permission audits with malformed or overlapping masks instead of restoring them', async () => {
    const seeded = await seedPermissionAudit('malformed-mask');
    await mockDb.auditLogs.update(
      { _id: seeded.auditId },
      { $set: { old: JSON.stringify({ allow: 3, deny: 1 }) } },
    );
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/audit-log/${seeded.auditId}/undo`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/doğrulanam/i);
  });

  it('rejects incomplete permission audit identity instead of guessing the target', async () => {
    const seeded = await seedPermissionAudit('missing-identity');
    await mockDb.auditLogs.update({ _id: seeded.auditId }, { $set: { channelId: '' } });
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/audit-log/${seeded.auditId}/undo`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/gereken hedef bilgileri/i);
  });

  it('returns 404 for an audit id outside the selected server', async () => {
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/audit-log/does-not-exist/undo`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(res.status).toBe(404);
  });

  it('rejects undo when compare-and-update loses an atomic race', async () => {
    const seeded = await seedPermissionAudit('atomic-update-race');
    const original = mockDb.channelPermissions.update;
    const spy = jest.spyOn(mockDb.channelPermissions, 'update').mockResolvedValueOnce({ updated: 0 });
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/audit-log/${seeded.auditId}/undo`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/işlem sırasında değişti/i);
    spy.mockRestore();
    expect(mockDb.channelPermissions.update).toBe(original);
  });

  it('rejects undo when compare-and-delete loses an atomic race', async () => {
    const seeded = await seedPermissionAudit('atomic-delete-race', { old: null, next: { allow: 256, deny: 0 } });
    const spy = jest.spyOn(mockDb.channelPermissions, 'remove').mockResolvedValueOnce({ deleted: 0 });
    const res = await request(app)
      .post(`/api/servers/${SERVER_ID}/audit-log/${seeded.auditId}/undo`)
      .set('Authorization', `Bearer ${token(MOD_ID)}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/işlem sırasında değişti/i);
    spy.mockRestore();
  });

  it('guards the server owner for timeout, kick, and ban', async () => {
    await mockDb.servers.update({ _id: SERVER_ID }, { $set: { ownerId: TARGET_ID } });
    try {
      const auth = `Bearer ${token(MOD_ID)}`;
      const timeout = await request(app)
        .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/timeout`).set('Authorization', auth)
        .send({ durationMs: 1000 });
      const kick = await request(app)
        .post(`/api/servers/${SERVER_ID}/members/${TARGET_ID}/kick`).set('Authorization', auth).send({});
      const ban = await request(app)
        .post(`/api/servers/${SERVER_ID}/bans`).set('Authorization', auth)
        .send({ userId: TARGET_ID, deleteMessageDays: 0 });
      expect(timeout.status).toBe(403);
      expect(kick.status).toBe(403);
      expect(ban.status).toBe(403);
    } finally {
      await mockDb.servers.update({ _id: SERVER_ID }, { $set: { ownerId: MOD_ID } });
    }
  });
});
