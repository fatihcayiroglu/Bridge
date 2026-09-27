// server/tests/moderation-undo-and-report-shapes.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// MODERASYON — GERİ ALMA KAPSAMI VE ŞİKÂYET SATIRI ŞEKLİ
// ════════════════════════════════════════════════════════════════════════════
//
// `tests/moderation-branch-closure.test.ts` yetki ve yarış sınırlarını ölçer.
// Bu tamamlayıcı takım geri alma (undo) DEĞERLENDİRMESİNİN her reddetme
// gerekçesini ve şikâyet listesinin seyrek satır davranışını ölçer:
//
//   · KAPSAM. Geri alma YALNIZ kanal izin override'ı içindir. Başka bir
//     denetim eylemi "desteklenmiyor" der; kapsamı genişletmek, kick/ban gibi
//     işlemleri de tek tıkla tersine çevirilebilir yapardı.
//   · KANIT. Denetim kaydındaki önceki/sonraki durum doğrulanamıyorsa geri
//     alma UYGULANMAZ. Doğrulanmamış bir maskeyi geri yazmak, izinleri
//     rastgele bir duruma taşımak demektir.
//   · SIRA. Aynı hedefte daha yeni bir yönetici değişikliği varsa geri alma
//     reddedilir; aksi hâlde eski bir kayıt yeni kararı sessizce ezerdi.
//   · ŞİKÂYET SATIRI. Silinmiş mesaj/kanal işaret eden satır listeden düşer;
//     eksik alanlar `undefined` olarak değil, okunabilir yedeklerle gösterilir.

process.env.JWT_SECRET = 'moderation-undo-secretxxxxxxxxxx';
process.env.NODE_ENV = 'test';

const repos = {
  Auth: { insertAuditLog: jest.fn(), findAuditLogsWhere: jest.fn(), getAuditLog: jest.fn() },
  Users: { findById: jest.fn() },
  Members: {
    findOne: jest.fn(), setTimeout: jest.fn(), removeMember: jest.fn(),
    getBans: jest.fn(), banMember: jest.fn(), unbanMember: jest.fn(),
  },
  Servers: { findById: jest.fn() },
  Messages: { findById: jest.fn(), deleteUserMessages: jest.fn() },
  Channels: { findByIdAndServer: jest.fn(), findWhere: jest.fn() },
  Roles: { findByIdAndServer: jest.fn(), findWhere: jest.fn() },
  ChannelPermissions: { findOne: jest.fn(), update: jest.fn(), remove: jest.fn(), insert: jest.fn() },
  MessageReports: { findOpenForServer: jest.fn(), findById: jest.fn(), resolveTargetState: jest.fn() },
};

const memberPerms = jest.fn();
const actOn = jest.fn();
const effectivePerms = jest.fn();
const permCache = { invalidatePerms: jest.fn() };
const permHelpers = {
  emitPermsUpdated: jest.fn(), sendPermLogMessage: jest.fn(), writePermAudit: jest.fn(),
};
const evictUser = jest.fn();

jest.mock('../db/repositories', () => repos);
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'No token' }); return; }
    try {
      req.user = require('jsonwebtoken').verify(header.slice(7), 'moderation-undo-secretxxxxxxxxxx');
      next();
    } catch { res.status(401).json({ error: 'Invalid token' }); }
  },
}));
jest.mock('../routes/roles', () => {
  const actual = jest.requireActual('../lib/permissions');
  return {
    PERMS: actual.PERMS,
    hasPermission: actual.hasPermission,
    getMemberPerms: (...args: unknown[]) => memberPerms(...args),
    canActOn: (...args: unknown[]) => actOn(...args),
  };
});
jest.mock('../lib/permissions', () => {
  const actual = jest.requireActual('../lib/permissions');
  return { ...actual, resolvePermissions: (...args: unknown[]) => effectivePerms(...args) };
});
jest.mock('../lib/permCache', () => permCache);
jest.mock('../routes/channelPerms/helpers', () => permHelpers);
jest.mock('../lib/liveMembership', () => ({ evictUserFromServerRooms: (...a: unknown[]) => evictUser(...a) , evictSocketsWithoutChannelAccessBestEffort: jest.fn().mockResolvedValue(undefined), evictSocketsWithoutChannelAccess: jest.fn().mockResolvedValue(0) }));
jest.mock('../middleware/rateLimit', () => ({
  limits: { moderation: () => (_req: unknown, _res: unknown, next: () => void) => next() },
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { PERMS } from '../lib/permissions';
import router from '../routes/moderation';

const SRV = 'srv-mod';
const MOD = 'mod-1';
const CHANNEL = 'ch-1';
const ROLE = 'role-1';
const AUDIT = 'audit-1';

const app = express();
app.use(express.json());
app.use('/api/servers/:serverId', router);
app.use((err: Error, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }));

const token = (id: string, extra: Record<string, unknown> = {}) =>
  jwt.sign({ id, username: 'moderator', displayName: 'Moderatör', v: 0, ...extra },
    'moderation-undo-secretxxxxxxxxxx', { expiresIn: '1h' });
const auth = (id = MOD, extra: Record<string, unknown> = {}) => `Bearer ${token(id, extra)}`;

const ALL = PERMS.ADMIN | PERMS.MANAGE_MESSAGES | PERMS.MANAGE_CHANNELS;

function auditEntry(overrides: Record<string, unknown> = {}) {
  return {
    _id: AUDIT, serverId: SRV, channelId: CHANNEL, targetId: ROLE,
    action: 'PERM_UPDATE', createdAt: 1_000,
    old: JSON.stringify({ allow: 1, deny: 0 }),
    new: JSON.stringify({ allow: 0, deny: 1 }),
    ...overrides,
  };
}

beforeEach(() => {
  // `clearAllMocks` yalnizca KAYITLI CAGRILARI siler; siraya alinmis
  // `mockResolvedValueOnce` degerleri KALIR. Erken donen bir test kuyrukta
  // tuketilmemis bir deger birakirsa, sonraki testin ilk sorgusu yanlis satiri
  // alir ve hata bu dosyanin geri kalanina yayilir. `resetAllMocks` kuyrugu da
  // bosaltir; her davranis asagida yeniden kurulur.
  jest.resetAllMocks();
  memberPerms.mockResolvedValue(ALL);
  actOn.mockResolvedValue(true);
  effectivePerms.mockResolvedValue(PERMS.MANAGE_MESSAGES);
  repos.Auth.insertAuditLog.mockResolvedValue(undefined);
  repos.Auth.findAuditLogsWhere.mockResolvedValue([]);
  repos.Users.findById.mockResolvedValue({ _id: MOD, username: 'moderator', displayName: 'Moderatör' });
  repos.Channels.findByIdAndServer.mockResolvedValue({ _id: CHANNEL, name: 'genel', serverId: SRV });
  repos.Roles.findByIdAndServer.mockResolvedValue({ _id: ROLE, name: 'Üye' });
  repos.ChannelPermissions.findOne.mockResolvedValue({ allow: 0, deny: 1 });
  repos.ChannelPermissions.update.mockResolvedValue({ updated: 1 });
  repos.ChannelPermissions.remove.mockResolvedValue({ deleted: 1 });
  repos.ChannelPermissions.insert.mockResolvedValue(undefined);
  repos.MessageReports.findOpenForServer.mockResolvedValue([]);
});

/** Queues the lookup for the entry itself, then the "anything newer?" query. */
function withEntry(entry: Record<string, unknown>, later: unknown[] = []) {
  repos.Auth.findAuditLogsWhere
    .mockResolvedValueOnce([entry])
    .mockResolvedValueOnce(later);
}

const undo = () => request(app)
  .post(`/api/servers/${SRV}/audit-log/${AUDIT}/undo`).set('Authorization', auth());

describe('undo scope', () => {
  it('requires channel-management permission', async () => {
    memberPerms.mockResolvedValue(0);
    const res = await undo();
    expect(res.status).toBe(403);
    expect(repos.Auth.findAuditLogsWhere).not.toHaveBeenCalled();
  });

  it('an unknown audit entry is a 404', async () => {
    repos.Auth.findAuditLogsWhere.mockResolvedValue([]);
    const res = await undo();
    expect(res.status).toBe(404);
  });

  const unsupported = ['MEMBER_KICK', 'MEMBER_BAN', 'ROLE_PROFILE_VISIBILITY_UPDATE', 'PERM_UNDO', ''];
  for (const action of unsupported) {
    it(`refuses to undo "${action || 'an entry with no action'}"`, async () => {
      withEntry(auditEntry({ action: action || undefined }));
      const res = await undo();
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/güvenli geri alma kapsamına dahil değil/);
      expect(repos.ChannelPermissions.update).not.toHaveBeenCalled();
    });
  }

  const incompleteTargets: Array<[string, Record<string, unknown>]> = [
    ['no channel', { channelId: undefined }],
    ['no role', { targetId: undefined }],
    ['no id', { _id: undefined }],
    ['no timestamp', { createdAt: 'yesterday' }],
  ];
  for (const [name, overrides] of incompleteTargets) {
    it(`refuses an entry with ${name}`, async () => {
      withEntry(auditEntry(overrides));
      const res = await undo();
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/gereken hedef bilgileri eksik/);
    });
  }

  // Kanal ve rol AYRI redlerdir ve ayri testlerde olculur: tek testte pes pese
  // iki istek yapmak, ilk istegin tuketmedigi `...Once` degerini ikinci istege
  // tasir (bkz. beforeEach'teki gerekce).
  it('refuses when the channel no longer exists', async () => {
    withEntry(auditEntry());
    repos.Channels.findByIdAndServer.mockResolvedValue(null);
    const res = await undo();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Kanal veya rol artık mevcut değil/);
    expect(repos.ChannelPermissions.update).not.toHaveBeenCalled();
  });

  it('refuses when the role no longer exists', async () => {
    withEntry(auditEntry());
    repos.Channels.findByIdAndServer.mockResolvedValue({ _id: CHANNEL, serverId: SRV });
    repos.Roles.findByIdAndServer.mockResolvedValue(null);
    const res = await undo();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Kanal veya rol artık mevcut değil/);
    expect(repos.ChannelPermissions.update).not.toHaveBeenCalled();
  });

  it('accepts the @everyone pseudo-role without a role lookup', async () => {
    withEntry(auditEntry({ targetId: '__everyone__' }));
    const res = await undo();
    expect(repos.Roles.findByIdAndServer).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  const undecodable: Array<[string, Record<string, unknown>]> = [
    ['an unparseable previous state', { old: '{not json' }],
    ['a non-object previous state', { old: JSON.stringify(5) }],
    ['a negative allow mask', { old: JSON.stringify({ allow: -1, deny: 0 }) }],
    ['overlapping allow and deny bits', { old: JSON.stringify({ allow: 3, deny: 1 }) }],
    ['an unparseable resulting state', { new: '{not json' }],
  ];
  for (const [name, overrides] of undecodable) {
    it(`refuses ${name}`, async () => {
      withEntry(auditEntry(overrides));
      const res = await undo();
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/doğrulanamıyor/);
      expect(repos.ChannelPermissions.update).not.toHaveBeenCalled();
    });
  }

  it('an update whose resulting state is absent cannot be undone', async () => {
    withEntry(auditEntry({ new: null }));
    const res = await undo();
    expect(res.body.error).toMatch(/Güncellemenin son durumu doğrulanamıyor/);
  });

  it('a delete whose previous state is absent cannot be undone', async () => {
    withEntry(auditEntry({ action: 'PERM_DELETE', old: null, new: null }));
    const res = await undo();
    expect(res.body.error).toMatch(/önceki durumu kayıtta yok/);
  });

  it('a newer administrative change on the same target blocks the undo', async () => {
    withEntry(auditEntry(), [{ _id: 'audit-2' }]);
    const res = await undo();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/daha yeni bir yönetici değişikliği/);
    expect(repos.ChannelPermissions.update).not.toHaveBeenCalled();
  });

  it('a current state that no longer matches the audit entry blocks the undo', async () => {
    withEntry(auditEntry());
    repos.ChannelPermissions.findOne.mockResolvedValue({ allow: 8, deny: 0 });
    const res = await undo();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/denetim kaydından sonra değişmiş/);
  });
});

describe('applying the undo', () => {
  it('restores the previous mask with a compare-and-set on the current one', async () => {
    withEntry(auditEntry());

    const res = await undo();

    expect(res.status).toBe(200);
    expect(repos.ChannelPermissions.update).toHaveBeenCalledWith(
      { channelId: CHANNEL, roleId: ROLE, allow: 0, deny: 1 },
      { $set: expect.objectContaining({ allow: 1, deny: 0 }) });
    expect(permHelpers.writePermAudit).toHaveBeenCalledWith(
      SRV, MOD, CHANNEL, ROLE, 'PERM_UNDO', { allow: 0, deny: 1 }, { allow: 1, deny: 0 },
      expect.objectContaining({ actorName: 'Moderatör', sourceAuditId: AUDIT }));
  });

  it('a losing compare-and-set is a conflict, not a silent success', async () => {
    withEntry(auditEntry());
    repos.ChannelPermissions.update.mockResolvedValue({ updated: 0 });
    const res = await undo();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/işlem sırasında değişti/);
  });

  it('an update that had no previous override removes the current one', async () => {
    withEntry(auditEntry({ old: null }));

    const res = await undo();

    expect(res.status).toBe(200);
    expect(repos.ChannelPermissions.remove).toHaveBeenCalledWith({
      channelId: CHANNEL, roleId: ROLE, allow: 0, deny: 1,
    });
  });

  it('a losing delete is also a conflict', async () => {
    withEntry(auditEntry({ old: null }));
    repos.ChannelPermissions.remove.mockResolvedValue({ deleted: 0 });
    expect((await undo()).status).toBe(409);
  });

  it('undoing a delete re-inserts the override and verifies what landed', async () => {
    withEntry(auditEntry({ action: 'PERM_DELETE', new: null }));
    repos.ChannelPermissions.findOne
      .mockResolvedValueOnce(null)                    // assessment: nothing there now
      .mockResolvedValueOnce({ allow: 1, deny: 0 });  // verification after insert

    const res = await undo();

    expect(res.status).toBe(200);
    expect(repos.ChannelPermissions.insert).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: CHANNEL, roleId: ROLE, allow: 1, deny: 0 }));
  });

  it('a re-insert that did not land as expected is a conflict', async () => {
    withEntry(auditEntry({ action: 'PERM_DELETE', new: null }));
    repos.ChannelPermissions.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ allow: 99, deny: 0 });
    expect((await undo()).status).toBe(409);
  });

  it('a storage failure during the undo is a conflict rather than a 500', async () => {
    withEntry(auditEntry());
    repos.ChannelPermissions.update.mockRejectedValue(new Error('permission store offline'));
    const res = await undo();
    expect(res.status).toBe(409);
  });

  it('falls back through the actor name chain when the row is gone', async () => {
    withEntry(auditEntry());
    repos.Users.findById.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/servers/${SRV}/audit-log/${AUDIT}/undo`)
      .set('Authorization', auth(MOD, { displayName: undefined, username: 'token-username' }));

    expect(res.status).toBe(200);
    expect(permHelpers.writePermAudit).toHaveBeenCalledWith(
      SRV, MOD, CHANNEL, ROLE, 'PERM_UNDO', expect.anything(), expect.anything(),
      expect.objectContaining({ actorName: 'token-username' }));
  });

  it('a user row with only a username uses it', async () => {
    withEntry(auditEntry());
    repos.Users.findById.mockResolvedValue({ _id: MOD, username: 'row-username' });
    await undo();
    expect(permHelpers.writePermAudit).toHaveBeenCalledWith(
      SRV, MOD, CHANNEL, ROLE, 'PERM_UNDO', expect.anything(), expect.anything(),
      expect.objectContaining({ actorName: 'row-username' }));
  });

  it('the target name falls back to the role id when the entry recorded none', async () => {
    withEntry(auditEntry({ targetName: undefined }));
    await undo();
    expect(permHelpers.writePermAudit).toHaveBeenCalledWith(
      SRV, MOD, CHANNEL, ROLE, 'PERM_UNDO', expect.anything(), expect.anything(),
      expect.objectContaining({ targetName: ROLE }));
  });
});

describe('the open-report list', () => {
  const reportRow = (overrides: Record<string, unknown> = {}) => ({
    _id: 'rep-1', channelId: CHANNEL, messageId: 'msg-1', reporterId: 'user-2',
    reason: 'spam', detail: 'çok fazla', createdAt: 50, ...overrides,
  });

  const reports = () => request(app)
    .get(`/api/servers/${SRV}/reports`).set('Authorization', auth());

  it('drops a report whose message has been deleted', async () => {
    repos.MessageReports.findOpenForServer.mockResolvedValue([reportRow()]);
    repos.Messages.findById.mockResolvedValue(null);

    const res = await reports();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reports: [], count: 0 });
  });

  it('drops a report whose channel has been deleted', async () => {
    repos.MessageReports.findOpenForServer.mockResolvedValue([reportRow()]);
    repos.Messages.findById.mockResolvedValue({ _id: 'msg-1', content: 'hi' });
    repos.Channels.findByIdAndServer.mockResolvedValue(null);

    const res = await reports();

    expect(res.body.count).toBe(0);
  });

  it('renders readable fallbacks for a sparse row', async () => {
    repos.MessageReports.findOpenForServer.mockResolvedValue([
      reportRow({ reason: undefined, detail: undefined, createdAt: undefined, reporterId: undefined }),
    ]);
    repos.Messages.findById.mockResolvedValue({ _id: 'msg-1', content: '  bir   mesaj  ' });
    repos.Channels.findByIdAndServer.mockResolvedValue({ _id: CHANNEL, serverId: SRV });
    repos.Users.findById.mockResolvedValue(null);

    const res = await reports();

    expect(res.body.reports[0]).toMatchObject({
      reason: 'other', detail: '', createdAt: 0,
      channel: { _id: CHANNEL, name: CHANNEL },
      message: { displayName: 'Bridge user', preview: 'bir mesaj' },
      reporter: { _id: '', displayName: 'Bridge user' },
    });
  });

  it('bounds the message preview', async () => {
    repos.MessageReports.findOpenForServer.mockResolvedValue([reportRow()]);
    repos.Messages.findById.mockResolvedValue({ _id: 'msg-1', content: 'x'.repeat(500) });
    const res = await reports();
    expect(res.body.reports[0].message.preview).toHaveLength(240);
  });

  it('hides reports from channels the moderator cannot manage', async () => {
    repos.MessageReports.findOpenForServer.mockResolvedValue([reportRow()]);
    effectivePerms.mockResolvedValue(0);
    const res = await reports();
    expect(res.body.count).toBe(0);
    expect(repos.Messages.findById).not.toHaveBeenCalled();
  });

  it('a failing permission lookup hides the report rather than exposing it', async () => {
    repos.MessageReports.findOpenForServer.mockResolvedValue([reportRow()]);
    effectivePerms.mockRejectedValue(new Error('permission store offline'));
    const res = await reports();
    expect(res.body.count).toBe(0);
  });
});

describe('resolving a report', () => {
  const resolve = (body: object) => request(app)
    .put(`/api/servers/${SRV}/reports/rep-1`).set('Authorization', auth()).send(body);

  beforeEach(() => {
    repos.MessageReports.findById.mockResolvedValue({
      _id: 'rep-1', channelId: CHANNEL, messageId: 'msg-1',
    });
  });

  it('writes an audit entry only when the row actually changed', async () => {
    repos.MessageReports.resolveTargetState.mockResolvedValue({ kind: 'updated', row: { _id: 'rep-1' } });
    const res = await resolve({ resolution: 'resolved' });
    expect(res.status).toBe(200);
    expect(repos.Auth.insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REPORT_RESOLVED', detail: `channel:${CHANNEL}` }));
  });

  it('records the dismissal action distinctly', async () => {
    repos.MessageReports.resolveTargetState.mockResolvedValue({ kind: 'updated', row: { _id: 'rep-1' } });
    await resolve({ resolution: 'dismissed' });
    expect(repos.Auth.insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REPORT_DISMISSED' }));
  });

  it('an unchanged row writes no audit entry', async () => {
    repos.MessageReports.resolveTargetState.mockResolvedValue({ kind: 'unchanged', row: { _id: 'rep-1' } });
    const res = await resolve({ resolution: 'resolved' });
    expect(res.status).toBe(200);
    expect(repos.Auth.insertAuditLog).not.toHaveBeenCalled();
  });

  it('a missing or already-handled report is reported distinctly', async () => {
    repos.MessageReports.resolveTargetState.mockResolvedValue({ kind: 'missing' });
    expect((await resolve({ resolution: 'resolved' })).status).toBe(404);

    repos.MessageReports.resolveTargetState.mockResolvedValue({ kind: 'conflict' });
    expect((await resolve({ resolution: 'resolved' })).status).toBe(409);
  });

  it('refuses an unknown resolution before reading anything', async () => {
    const res = await resolve({ resolution: 'maybe' });
    expect(res.status).toBe(400);
    expect(repos.MessageReports.findById).not.toHaveBeenCalled();
  });
});

describe('moderation bodies that are not objects', () => {
  beforeEach(() => {
    repos.Members.findOne.mockResolvedValue({ userId: 'target-1', serverId: SRV });
    repos.Servers.findById.mockResolvedValue({ _id: SRV, ownerId: 'someone-else' });
    repos.Users.findById.mockResolvedValue({ _id: 'target-1', username: 'kurban' });
    repos.Members.removeMember.mockResolvedValue({ removed: 1 });
    repos.Members.banMember.mockResolvedValue({ banned: 1 });
  });

  it('a kick with an array body is read as an empty body', async () => {
    const res = await request(app).post(`/api/servers/${SRV}/members/target-1/kick`)
      .set('Authorization', auth()).send([]);
    // The body is ignored, so the request proceeds on its route rules alone.
    expect(res.status).not.toBe(400);
  });

  it('a ban with an array body still requires a user id', async () => {
    const res = await request(app).post(`/api/servers/${SRV}/bans`)
      .set('Authorization', auth()).send([]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('userId required');
  });

  it('a non-string reason is refused', async () => {
    const res = await request(app).post(`/api/servers/${SRV}/bans`)
      .set('Authorization', auth()).send({ userId: 'target-1', reason: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason must be a string/);
  });

  it('an out-of-range history window is refused', async () => {
    const res = await request(app).post(`/api/servers/${SRV}/bans`)
      .set('Authorization', auth()).send({ userId: 'target-1', deleteMessageDays: 8 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 0 and 7/);
  });
});
