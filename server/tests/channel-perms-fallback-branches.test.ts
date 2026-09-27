// server/tests/channel-perms-fallback-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// routes/channelPerms — YETKİ REDDİ, DOĞRULAMA MERDİVENİ VE ADLANDIRMA YEDEKLERİ
// ════════════════════════════════════════════════════════════════════════════
// Kanal izin uçları, bir sunucudaki HER ÜYENİN neyi görüp yazabileceğini
// belirler. Bu yüzden iki sınıf dal ayrı ayrı kanıtlanmalıdır:
//
//   1. YETKİ REDDİ — `MANAGE_CHANNELS` olmadan hiçbir uç iş yapmamalıdır.
//      Mevcut paketler `hasPermission`'ı `true` döndürecek şekilde mock'lar;
//      bu dosya reddi de ölçer, aksi hâlde 403 dalı hiç çalışmamış olurdu.
//
//   2. ADLANDIRMA YEDEKLERİ — denetim kaydı ve log mesajı, aktörün ve rolün
//      ADINI yazar. Görünen ad yoksa kullanıcı adına, o da yoksa kimliğe
//      düşülür. Yedek çalışmazsa denetim kaydında `undefined` görünür ve
//      moderasyon geçmişi kimin ne yaptığını söyleyemez.
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/permCache', () => ({ invalidatePerms: jest.fn() }));
jest.mock('express-rate-limit', () => () => (_req: any, _res: any, next: any) => next());
jest.mock('../lib/permissions', () => {
  const actual = jest.requireActual('../lib/permissions');
  return {
    ...actual,
    resolvePermissions: jest.fn().mockResolvedValue(actual.PERMS.MANAGE_CHANNELS),
    hasPermission: jest.fn().mockReturnValue(true),
  };
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import channelPermsRouter from '../routes/channelPerms';
import { PERMS } from '../lib/permissions';

const db = require('../db/loader');
const permissions = require('../lib/permissions');
import { requireDoc } from './helpers/mockDb';

const SID = 'perm-fallback-server';
const CID = 'perm-fallback-channel';
const C2 = 'perm-fallback-target';
const USER = 'perm-fallback-user';
const R1 = 'role-alpha';
const R2 = 'role-beta';

const token = () => jwt.sign({ id: USER, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
const base = `/api/servers/${SID}/channels/${CID}/permissions`;

function app(io: unknown = null) {
  const instance = express();
  instance.use(express.json());
  if (io) instance.set('io', io);
  instance.use('/api/servers/:sid/channels/:cid/permissions', channelPermsRouter);
  return instance;
}

async function seed(actor: Record<string, unknown> = { username: 'fallbackuser', displayName: 'Fallback User' }) {
  db._reset?.();
  jest.clearAllMocks();
  permissions.resolvePermissions.mockResolvedValue(PERMS.MANAGE_CHANNELS);
  permissions.hasPermission.mockReturnValue(true);
  await db.users.insert({ _id: USER, tokenVersion: 0, ...actor });
  await db.servers.insert({ _id: SID, name: 'Fallback Server', ownerId: USER });
  await db.channels.insert({ _id: CID, serverId: SID, name: 'source', type: 'text' });
  await db.channels.insert({ _id: C2, serverId: SID, name: 'target', type: 'text' });
  await db.roles.insert({ _id: R1, serverId: SID, name: 'Alpha', permissions: 0 });
  await db.roles.insert({ _id: R2, serverId: SID, name: 'Beta', permissions: 0 });
}

beforeEach(() => seed());

describe('MANAGE_CHANNELS is required by every mutating and inspecting endpoint', () => {
  const denied = [
    ['post', `${base}/bulk-sync`, { channelIds: [C2], overrides: [] }],
    ['post', `${base}/bulk-sync/preview`, { channelIds: [C2], overrides: [] }],
    ['put', `${base}/batch`, { overrides: [], deletes: [] }],
    ['get', `${base}/export`, undefined],
    ['post', `${base}/import`, { overrides: [{ roleId: R1, allow: 0, deny: 0 }] }],
    ['put', `${base}/${R1}`, { allow: 0, deny: 0 }],
    ['delete', `${base}/${R1}`, undefined],
    ['get', `${base}/audit-log`, undefined],
    ['get', `${base}/inheritance/${R1}`, undefined],
  ] as const;

  it.each(denied)('refuses %s %s without MANAGE_CHANNELS', async (method, url, body) => {
    permissions.hasPermission.mockReturnValue(false);
    const call = (request(app()) as any)[method](url).set('Authorization', `Bearer ${token()}`);
    const res = await (body ? call.send(body) : call);
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain('MANAGE_CHANNELS');
    // Reddedilen istek HİÇBİR kalıcı etki bırakmamalıdır.
    expect(await db.channelPermissions.count({})).toBe(0);
    expect(await db.auditLogs.count({})).toBe(0);
  });

  it.each(denied)('refuses %s %s when the channel belongs to another server', async (method, url, body) => {
    await db.channels.update({ _id: CID }, { $set: { serverId: 'other-server' } });
    const call = (request(app()) as any)[method](url).set('Authorization', `Bearer ${token()}`);
    const res = await (body ? call.send(body) : call);
    expect(res.status).toBe(404);
    expect(await db.channelPermissions.count({})).toBe(0);
  });
});

describe('bulk-sync request validation', () => {
  it('rejects a non-array overrides payload and duplicate role ids', async () => {
    const notArray = await request(app()).post(`${base}/bulk-sync`).set('Authorization', `Bearer ${token()}`)
      .send({ channelIds: [C2], overrides: { roleId: R1 } });
    expect(notArray.status).toBe(400);
    expect(notArray.body.error).toContain('dizi');

    const duplicate = await request(app()).post(`${base}/bulk-sync`).set('Authorization', `Bearer ${token()}`)
      .send({ channelIds: [C2], overrides: [{ roleId: R1, allow: 0, deny: 0 }, { roleId: R1, allow: 1, deny: 0 }] });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toContain('roleId');
  });

  it('reports the offending role id even when the override object carries none', async () => {
    const res = await request(app()).post(`${base}/bulk-sync`).set('Authorization', `Bearer ${token()}`)
      .send({ channelIds: [C2], overrides: [{ allow: 0, deny: 0 }] });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Role not found in this server: ');
  });

  it('treats omitted allow/deny as an explicit zero mask', async () => {
    const res = await request(app()).post(`${base}/bulk-sync`).set('Authorization', `Bearer ${token()}`)
      .send({ channelIds: [C2], overrides: [{ roleId: R1 }] });
    expect(res.status).toBe(200);
    expect(await db.channelPermissions.findOne({ channelId: C2, roleId: R1 })).toMatchObject({ allow: 0, deny: 0 });
  });

  it('accepts a sync that targets only the source channel and writes nothing', async () => {
    const res = await request(app()).post(`${base}/bulk-sync`).set('Authorization', `Bearer ${token()}`)
      .send({ channelIds: [CID], overrides: [{ roleId: R1, allow: PERMS.SEND_MESSAGES, deny: 0 }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, updated: 0 });
    expect(await db.channelPermissions.count({})).toBe(0);
  });

  it('preview rejects duplicate role ids and an unknown role before touching any channel', async () => {
    const duplicate = await request(app()).post(`${base}/bulk-sync/preview`).set('Authorization', `Bearer ${token()}`)
      .send({ channelIds: [C2], overrides: [{ roleId: R1, allow: 0, deny: 0 }, { roleId: R1, allow: 0, deny: 0 }] });
    expect(duplicate.status).toBe(400);

    const unknown = await request(app()).post(`${base}/bulk-sync/preview`).set('Authorization', `Bearer ${token()}`)
      .send({ channelIds: [C2], overrides: [{ allow: 0, deny: 0 }] });
    expect(unknown.status).toBe(404);

    const badMask = await request(app()).post(`${base}/bulk-sync/preview`).set('Authorization', `Bearer ${token()}`)
      .send({ channelIds: [C2], overrides: [{ roleId: R1, allow: PERMS.SEND_MESSAGES, deny: PERMS.SEND_MESSAGES }] });
    expect(badMask.status).toBe(400);
    expect(badMask.body.error).toContain('bitmask');
  });

  it('preview counts an existing row as updated when only one of allow/deny differs', async () => {
    await db.channelPermissions.insert({ _id: 'p1', channelId: C2, serverId: SID, roleId: R1, allow: 0, deny: PERMS.ATTACH_FILES });
    const res = await request(app()).post(`${base}/bulk-sync/preview`).set('Authorization', `Bearer ${token()}`)
      .send({ channelIds: [C2], overrides: [{ roleId: R1 }] });
    expect(res.status).toBe(200);
    expect(res.body.preview[0]).toMatchObject({ updated: 1, added: 0, removed: 0, unchanged: 0 });
  });

  it('preview with no target channels reports an empty plan', async () => {
    const res = await request(app()).post(`${base}/bulk-sync/preview`).set('Authorization', `Bearer ${token()}`)
      .send({ channelIds: [CID], overrides: [{ roleId: R1, allow: 0, deny: 0 }] });
    expect(res.status).toBe(200);
    expect(res.body.preview).toEqual([]);
  });
});

describe('batch endpoint audit naming', () => {
  it('falls back through displayName, username and finally the raw actor id', async () => {
    const send = async () => request(app()).put(`${base}/batch`).set('Authorization', `Bearer ${token()}`)
      .send({ overrides: [{ roleId: R1, allow: PERMS.SEND_MESSAGES, deny: 0 }], deletes: [] });

    expect((await send()).status).toBe(200);
    expect(await db.auditLogs.findOne({ targetId: R1 })).toMatchObject({ actorName: 'Fallback User' } as never);

    await seed({ username: 'onlyusername' });
    expect((await send()).status).toBe(200);
    expect(await db.auditLogs.findOne({ targetId: R1 })).toMatchObject({ actorName: 'onlyusername' } as never);

    await seed({});
    expect((await send()).status).toBe(200);
    expect(await db.auditLogs.findOne({ targetId: R1 })).toMatchObject({ actorName: USER } as never);
  });

  it('rejects a delete list that repeats a role or collides with an update', async () => {
    const repeated = await request(app()).put(`${base}/batch`).set('Authorization', `Bearer ${token()}`)
      .send({ overrides: [], deletes: [R1, R1] });
    expect(repeated.status).toBe(400);

    const collision = await request(app()).put(`${base}/batch`).set('Authorization', `Bearer ${token()}`)
      .send({ overrides: [{ roleId: R1, allow: 0, deny: 0 }], deletes: [R1] });
    expect(collision.status).toBe(400);

    const blank = await request(app()).put(`${base}/batch`).set('Authorization', `Bearer ${token()}`)
      .send({ overrides: [], deletes: ['   '] });
    expect(blank.status).toBe(400);
  });

  it('records a delete of a role that has no stored override as a null previous value', async () => {
    const res = await request(app()).put(`${base}/batch`).set('Authorization', `Bearer ${token()}`)
      .send({ overrides: [], deletes: [R2] });
    expect(res.status).toBe(200);
    const log = await db.auditLogs.findOne({ targetId: R2 });
    expect(log).toMatchObject({ action: 'PERM_DELETE' } as never);
    expect(log!.oldVals ?? null).toBeNull();
  });
});

describe('export and import fallbacks', () => {
  it('names the export file and payload from ids when the channel and server rows lack names', async () => {
    await db.channels.update({ _id: CID }, { $set: { name: undefined } });
    await db.servers.update({ _id: SID }, { $set: { name: undefined } });
    await db.channelPermissions.insert({ _id: 'e1', channelId: CID, serverId: SID, roleId: '__everyone__', allow: 1, deny: 0 });
    await db.channelPermissions.insert({ _id: 'e2', channelId: CID, serverId: SID, roleId: 'ghost-role', allow: 0, deny: 1 });

    const res = await request(app()).get(`${base}/export`).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain(`permissions-${CID.replace(/[^a-z0-9]/gi, '_')}.json`);
    expect(res.body.sourceServer).toBe(SID);
    expect(res.body.sourceChannel).toBe(CID);
    expect(res.body.overrides).toEqual([
      { roleId: '__everyone__', roleName: '@everyone', targetType: 'role', allow: 1, deny: 0 },
      { roleId: 'ghost-role', roleName: 'ghost-role', targetType: 'role', allow: 0, deny: 1 },
    ]);
  });

  it('validates every import entry before applying any of them', async () => {
    const post = (body: unknown) => request(app()).post(`${base}/import`).set('Authorization', `Bearer ${token()}`).send(body as never);

    expect((await post({ overrides: [{ roleId: R1, allow: 0, deny: 0 }], merge: 'yes' })).status).toBe(400);
    expect((await post({ overrides: [] })).status).toBe(400);
    expect((await post({ overrides: [null] })).status).toBe(400);
    expect((await post({ overrides: [['x']] })).status).toBe(400);
    expect((await post({ overrides: [{ roleId: '  ' }] })).status).toBe(400);
    expect((await post({ overrides: [{ roleId: 'x'.repeat(129), allow: 0, deny: 0 }] })).status).toBe(400);
    expect((await post({ overrides: [{ roleId: R1, roleName: 5, allow: 0, deny: 0 }] })).status).toBe(400);
    expect((await post({ overrides: [{ roleId: R1, targetType: 'group', allow: 0, deny: 0 }] })).status).toBe(400);
    expect((await post({ overrides: [{ roleId: R1, allow: 1.5, deny: 0 }] })).status).toBe(400);
    expect((await post({ overrides: [{ roleId: R1, allow: PERMS.SEND_MESSAGES, deny: PERMS.SEND_MESSAGES }] })).status).toBe(400);
    expect(await db.channelPermissions.count({})).toBe(0);
  });

  it('resolves an import by role name, skips user overrides and reports what was skipped', async () => {
    const res = await request(app()).post(`${base}/import`).set('Authorization', `Bearer ${token()}`).send({
      merge: true,
      overrides: [
        { roleId: 'stale-id', roleName: 'Beta', targetType: 'role', allow: PERMS.SEND_MESSAGES, deny: 0 },
        { roleId: 'user-1', roleName: 'Someone', targetType: 'user', allow: 0, deny: 1 },
        { roleId: 'missing-role', allow: 0, deny: 1 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, imported: 1, merge: true, skippedCount: 2 });
    // Ad ile çözülen override GERÇEK rol kimliğine yazılır, dosyadaki eski
    // kimliğe değil — aksi hâlde import sessizce yetkisiz bir satır üretirdi.
    expect(await db.channelPermissions.findOne({ channelId: CID, roleId: R2 })).toBeTruthy();
    expect(await db.channelPermissions.findOne({ channelId: CID, roleId: 'stale-id' })).toBeNull();
    expect(res.body.skipped.map((s: { reason: string }) => s.reason))
      .toEqual(['user override atlandı', 'role not found in this server']);
  });

  it('refuses a replace import in which nothing survived resolution', async () => {
    const res = await request(app()).post(`${base}/import`).set('Authorization', `Bearer ${token()}`)
      .send({ overrides: [{ roleId: 'user-1', targetType: 'user', allow: 0, deny: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('korunuyor');
    expect(res.body.skipped).toHaveLength(1);
  });

  it('refuses an import that maps two entries onto the same resolved role', async () => {
    const res = await request(app()).post(`${base}/import`).set('Authorization', `Bearer ${token()}`).send({
      overrides: [
        { roleId: R2, allow: 0, deny: 0 },
        { roleId: 'other', roleName: 'Beta', allow: 1, deny: 0 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('birden fazla override');
  });
});

describe('single override and audit listing fallbacks', () => {
  it('treats an omitted mask as zero and names the actor from the id when the row is gone', async () => {
    await db.users.remove({ _id: USER });
    const res = await request(app()).put(`${base}/${R1}`).set('Authorization', `Bearer ${token()}`).send({});
    expect(res.status).toBe(200);
    expect(await db.channelPermissions.findOne({ channelId: CID, roleId: R1 })).toMatchObject({ allow: 0, deny: 0 });
    expect(await db.auditLogs.findOne({ targetId: R1 })).toMatchObject({ actorName: USER } as never);
  });

  it('deletes an override and audits it with the actor id fallback', async () => {
    await db.channelPermissions.insert({ _id: 'd1', channelId: CID, serverId: SID, roleId: R1, allow: 1, deny: 0 });
    await db.users.remove({ _id: USER });
    const res = await request(app()).delete(`${base}/${R1}`).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(await db.channelPermissions.findOne({ channelId: CID, roleId: R1 })).toBeNull();
  });

  it('rejects oversized or repeated audit filters', async () => {
    const longAction = await request(app()).get(`${base}/audit-log?action=${'x'.repeat(129)}`).set('Authorization', `Bearer ${token()}`);
    expect(longAction.status).toBe(400);
    const longTarget = await request(app()).get(`${base}/audit-log?targetId=${'y'.repeat(161)}`).set('Authorization', `Bearer ${token()}`);
    expect(longTarget.status).toBe(400);
    const repeated = await request(app()).get(`${base}/audit-log?action=a&action=b`).set('Authorization', `Bearer ${token()}`);
    expect(repeated.status).toBe(400);
    const inverted = await request(app()).get(`${base}/audit-log?since=100&until=10`).set('Authorization', `Bearer ${token()}`);
    expect(inverted.status).toBe(400);
  });

  it('falls back to stored names when actor and role rows can no longer be resolved', async () => {
    await db.auditLogs.insert({
      _id: 'a1', serverId: SID, channelId: CID, actorId: 'ghost-actor', actorName: 'Stored Actor',
      targetId: 'ghost-role', targetName: 'Stored Role', action: 'PERM_UPDATE', createdAt: 2,
    });
    await db.auditLogs.insert({
      _id: 'a2', serverId: SID, channelId: CID, actorId: 'ghost-2', targetId: '__everyone__',
      action: 'PERM_DELETE', createdAt: 1,
    });
    const res = await request(app()).get(`${base}/audit-log`).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ actorName: 'Stored Actor', targetName: 'Stored Role' });
    expect(res.body[1]).toMatchObject({ actorName: 'ghost-2', targetName: '@everyone' });
  });

  it('prefers the live user row over the stored audit name', async () => {
    await db.users.insert({ _id: 'live-actor', username: 'liveuser' });
    await db.auditLogs.insert({
      _id: 'a3', serverId: SID, channelId: CID, actorId: 'live-actor', actorName: 'Stale Name',
      targetId: R1, targetName: 'Stale Role', action: 'PERM_UPDATE', createdAt: 3,
    });
    const res = await request(app()).get(`${base}/audit-log`).set('Authorization', `Bearer ${token()}`);
    expect(res.body[0]).toMatchObject({ actorName: 'liveuser', targetName: 'Alpha' });
  });
});
