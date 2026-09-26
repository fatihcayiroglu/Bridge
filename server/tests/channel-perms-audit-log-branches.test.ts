// server/tests/channel-perms-audit-log-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// KANAL İZİN DENETİM GÜNLÜĞÜ — FİLTRELER VE ADLANDIRMA
// ════════════════════════════════════════════════════════════════════════════
//
// Denetim günlüğü, "bu kanalda izinleri kim değiştirdi" sorusunun TEK
// cevabıdır. Ölçülenler:
//
//   · FİLTRE SINIRLARI. `action`/`targetId`/`limit`/`since`/`until` doğrudan
//     bir sorguya gider; biçimsiz ya da tutarsız aralıklar REDDEDİLİR. `since`
//     ile `until` yalnız VERİLDİKLERİNDE sorguya eklenir.
//   · ADLANDIRMA. Aktör ve hedef adları AYRI sorgulardan gelir. Satır artık
//     çözülemiyorsa (kullanıcı/rol silinmiş) kayıtta saklanan ada, o da yoksa
//     kimliğe düşülür — okunamaz bir `undefined` gösterilmez.
//   · @everyone bir rol satırı DEĞİLDİR ve rol sorgusuna dahil edilmez.
//   · BOZUK JSON. Eski/yeni durum alanı ayrıştırılamıyorsa `null` gösterilir;
//     tüm günlük çökmez.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/permCache', () => ({ invalidatePerms: jest.fn() }));
jest.mock('express-rate-limit', () => () => (_req: unknown, _res: unknown, next: () => void) => next());

const resolvePermissions = jest.fn();
jest.mock('../lib/permissions', () => ({
  ...jest.requireActual('../lib/permissions'),
  resolvePermissions: (...a: unknown[]) => resolvePermissions(...a),
  hasPermission: jest.requireActual('../lib/permissions').hasPermission,
}));

const auditLogsFind = jest.fn<unknown, unknown[]>();
const findByIds = jest.fn<Promise<unknown>, unknown[]>();
const rolesFindWhere = jest.fn<Promise<unknown>, unknown[]>();

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { PERMS } from '../lib/permissions';
import { Auth, Users, Roles } from '../db/repositories';

const { authMiddleware } = require('../middleware/auth');
const channelPermsRouter = require('../routes/channelPerms');
const db: any = require('../db/loader');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:sid/channels/:cid/permissions', authMiddleware, channelPermsRouter);
  return app;
}
const tok = (uid: string) => jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });

const SID = 'srv-audit';
const CID = 'ch-audit';
const USER = 'user-audit';

let app: express.Express;
const spies: jest.SpyInstance[] = [];

/** A cursor shaped like the repository's chainable find(). */
function cursor(rows: unknown[]) {
  return { sort: () => ({ limit: async () => rows }) };
}

beforeEach(async () => {
  db._reset?.();
  jest.clearAllMocks();
  spies.length = 0;
  app = buildApp();

  await db.users.insert({ _id: USER, username: 'auditor', displayName: 'Auditor', tokenVersion: 0 });
  await db.servers.insert({ _id: SID, name: 'Audit', ownerId: USER });
  await db.channels.insert({ _id: CID, serverId: SID, name: 'genel', type: 'text' });

  resolvePermissions.mockResolvedValue(PERMS.MANAGE_CHANNELS);
  auditLogsFind.mockReturnValue(cursor([]));
  findByIds.mockResolvedValue([]);
  rolesFindWhere.mockResolvedValue([]);

  // `mockImplementation` HEDEFIN imzasini ister; `(...a: never[])` her
  // ornekleme icin gecerli DEGILDIR. `jest.mocked` benzeri bir daraltma
  // yerine ikizin donus tipi `unknown` yapilip cagri dogrudan aktarilir.
  spies.push(jest.spyOn(Auth, 'auditLogsFind').mockImplementation(
    ((...a: unknown[]) => auditLogsFind(...a)) as typeof Auth.auditLogsFind));
  spies.push(jest.spyOn(Users, 'findByIds').mockImplementation(
    ((...a: unknown[]) => findByIds(...a)) as typeof Users.findByIds));
  spies.push(jest.spyOn(Roles, 'findWhere').mockImplementation(
    ((...a: unknown[]) => rolesFindWhere(...a)) as typeof Roles.findWhere));
});

afterEach(() => { for (const spy of spies) spy.mockRestore(); });

const auditLog = (query = '') => request(app)
  .get(`/api/servers/${SID}/channels/${CID}/permissions/audit-log${query}`)
  .set('Authorization', `Bearer ${tok(USER)}`);

describe('access control', () => {
  it('requires MANAGE_CHANNELS', async () => {
    resolvePermissions.mockResolvedValue(0);
    const res = await auditLog();
    expect(res.status).toBe(403);
    expect(auditLogsFind).not.toHaveBeenCalled();
  });

  it('requires the channel to belong to this server', async () => {
    await db.channels.update({ _id: CID }, { $set: { serverId: 'some-other-server' } });
    const res = await auditLog();
    expect(res.status).toBe(404);
    expect(auditLogsFind).not.toHaveBeenCalled();
  });
});

describe('query filters', () => {
  it('queries only this server and channel when nothing is filtered', async () => {
    await auditLog();
    expect(auditLogsFind).toHaveBeenCalledWith({ serverId: SID, channelId: CID });
  });

  it('adds an action filter when one is given', async () => {
    await auditLog('?action=OVERRIDE_UPDATE');
    expect(auditLogsFind).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'OVERRIDE_UPDATE' }));
  });

  it('adds a target filter when one is given', async () => {
    await auditLog('?targetId=role-1');
    expect(auditLogsFind).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'role-1' }));
  });

  const invalidFilters = [
    '?action=' + 'a'.repeat(129),
    '?targetId=' + 'b'.repeat(161),
    '?action=a&action=b',
    '?targetId=a&targetId=b',
  ];
  for (const query of invalidFilters) {
    it(`refuses "${query.slice(0, 30)}…"`, async () => {
      const res = await auditLog(query);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid audit filter');
      expect(auditLogsFind).not.toHaveBeenCalled();
    });
  }

  it('refuses an unusable limit', async () => {
    for (const query of ['?limit=abc', '?limit=0', '?limit=-1', '?limit=1.5']) {
      const res = await auditLog(query);
      expect(res.status).toBe(400);
    }
    expect(auditLogsFind).not.toHaveBeenCalled();
  });

  it('refuses unusable timestamps', async () => {
    for (const query of ['?since=abc', '?until=abc', '?since=-1']) {
      const res = await auditLog(query);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/epoch-millis/);
    }
  });

  it('refuses a reversed time range', async () => {
    const res = await auditLog('?since=2000&until=1000');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/since, until değerinden büyük olamaz/);
    expect(auditLogsFind).not.toHaveBeenCalled();
  });

  const ranges: Array<[string, Record<string, number>]> = [
    ['?since=1000', { $gte: 1000 }],
    ['?until=2000', { $lte: 2000 }],
    ['?since=1000&until=2000', { $gte: 1000, $lte: 2000 }],
  ];
  for (const [query, createdAt] of ranges) {
    it(`renders the range for "${query}"`, async () => {
      await auditLog(query);
      expect(auditLogsFind).toHaveBeenCalledWith(expect.objectContaining({ createdAt }));
    });
  }

  it('adds no time clause when neither bound is given', async () => {
    await auditLog('?limit=5');
    expect(auditLogsFind).toHaveBeenCalledWith({ serverId: SID, channelId: CID });
  });
});

describe('rendering the entries', () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    _id: 'a1', serverId: SID, channelId: CID, action: 'OVERRIDE_UPDATE',
    actorId: 'actor-1', targetId: 'role-1', createdAt: 10,
    old: JSON.stringify({ allow: 0 }), new: JSON.stringify({ allow: 1 }),
    ...overrides,
  });

  it('resolves actor and role names from their own tables', async () => {
    auditLogsFind.mockReturnValue(cursor([entry()]));
    findByIds.mockResolvedValue([{ _id: 'actor-1', username: 'ada' }]);
    rolesFindWhere.mockResolvedValue([{ _id: 'role-1', name: 'Moderator' }]);

    const res = await auditLog();

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      actorName: 'ada', targetName: 'Moderator',
      old: { allow: 0 }, new: { allow: 1 },
    });
    expect(rolesFindWhere).toHaveBeenCalledWith({ _id: { $in: ['role-1'] }, serverId: SID });
  });

  it('falls back to the display name, then to the stored name, then to the id', async () => {
    auditLogsFind.mockReturnValue(cursor([
      entry({ _id: 'a1', actorId: 'actor-1', targetId: 'role-1' }),
      entry({ _id: 'a2', actorId: 'actor-gone', targetId: 'role-gone', actorName: 'Eski Ad', targetName: 'Eski Rol' }),
      entry({ _id: 'a3', actorId: 'actor-nameless', targetId: 'role-nameless' }),
    ]));
    findByIds.mockResolvedValue([{ _id: 'actor-1', displayName: 'Ada Lovelace' }]);
    rolesFindWhere.mockResolvedValue([{ _id: 'role-1' }]);

    const res = await auditLog();

    expect(res.body[0]).toMatchObject({ actorName: 'Ada Lovelace', targetName: 'role-1' });
    // Deleted rows keep whatever the audit entry itself recorded...
    expect(res.body[1]).toMatchObject({ actorName: 'Eski Ad', targetName: 'Eski Rol' });
    // ...and with nothing recorded, the raw id is shown rather than undefined.
    expect(res.body[2]).toMatchObject({ actorName: 'actor-nameless', targetName: 'role-nameless' });
  });

  it('@everyone is labelled without being looked up as a role', async () => {
    auditLogsFind.mockReturnValue(cursor([entry({ targetId: '__everyone__' })]));

    const res = await auditLog();

    expect(res.body[0].targetName).toBe('@everyone');
    expect(rolesFindWhere).not.toHaveBeenCalled();
  });

  it('unparseable state fields render as null instead of breaking the log', async () => {
    auditLogsFind.mockReturnValue(cursor([entry({ old: '{not json', new: '{also not json' })]));
    const res = await auditLog();
    expect(res.body[0].old).toBeNull();
    expect(res.body[0].new).toBeNull();
  });

  it('non-string state fields are passed through untouched', async () => {
    auditLogsFind.mockReturnValue(cursor([entry({ old: { allow: 0 }, new: null })]));
    const res = await auditLog();
    expect(res.body[0].old).toEqual({ allow: 0 });
    expect(res.body[0].new).toBeNull();
  });

  it('an entry with no actor or target does not trigger lookups', async () => {
    auditLogsFind.mockReturnValue(cursor([entry({ actorId: null, targetId: null })]));
    await auditLog();
    expect(findByIds).not.toHaveBeenCalled();
    expect(rolesFindWhere).not.toHaveBeenCalled();
  });

  it('a repository that returns nothing for the lookups still renders the log', async () => {
    auditLogsFind.mockReturnValue(cursor([entry()]));
    findByIds.mockResolvedValue(undefined);
    rolesFindWhere.mockResolvedValue(undefined);

    const res = await auditLog();

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ actorName: 'actor-1', targetName: 'role-1' });
  });

  it('an absent audit cursor renders an empty log rather than failing', async () => {
    auditLogsFind.mockReturnValue(null);
    const res = await auditLog();
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('a failing audit query is reported as temporarily unavailable', async () => {
    auditLogsFind.mockImplementation(() => { throw new Error('audit table offline'); });
    const res = await auditLog();
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/temporarily unavailable/);
  });

  it('a failing name lookup is also reported rather than rendering half a log', async () => {
    auditLogsFind.mockReturnValue(cursor([entry()]));
    findByIds.mockRejectedValue(new Error('user store offline'));
    const res = await auditLog();
    expect(res.status).toBe(503);
  });
});
