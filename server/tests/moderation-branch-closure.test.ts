// server/tests/moderation-branch-closure.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// MODERASYON YÜZEYİ — KARAR DALLARI
// ════════════════════════════════════════════════════════════════════════════
//
// `routes/moderation.ts` ifade düzeyinde büyük ölçüde ölçülüydü ama KARAR
// dalları değildi: mutlu yollar test ediliyor, reddetme/eksik-satır/çakışma
// yolları ölçülmüyordu. Bu dosyanın kapattığı riskler:
//
//   · GÖRÜNÜRLÜK SIZINTISI — `/reports`, moderatörün MANAGE_MESSAGES yetkisi
//     OLMAYAN kanallardaki şikâyetleri sızdırmamalıdır. Yetki çözümü PATLARSA
//     sonuç "yetki yok" olmalıdır (fail-closed), "hepsini göster" değil.
//   · SEYREK SATIR — silinmiş mesaj/kanal işaret eden şikâyet satırları
//     listeyi çökertmemeli, `undefined` sızdırmamalı, atlanmalıdır.
//   · GERİ ALMA (undo) — yalnız kanal izin override'ı, yalnız durum
//     doğrulandığında. Denetim kaydından sonra bir şey değiştiyse geri alma
//     UYGULANMAMALIDIR.
//   · CSV DIŞA AKTARIM — hücreler kullanıcı denetimli; formül enjeksiyonu
//     (`=`,`+`,`-`,`@`) ve tırnak/satırsonu kaçışı bozulmamalıdır.
//   · KENDİNE/SAHİBE/ÜST YETKİLİYE moderasyon engelleri.
//   · YARIŞ — üyelik işlem sırasında değişirse 409, sessiz başarı değil.

process.env.JWT_SECRET = 'moderation-branch-secretxxxxxxxx';
process.env.NODE_ENV = 'test';

const repos = {
  Auth: {
    insertAuditLog: jest.fn(),
    findAuditLogsWhere: jest.fn(),
    getAuditLog: jest.fn(),
  },
  Users: { findById: jest.fn() },
  Members: {
    findOne: jest.fn(),
    setTimeout: jest.fn(),
    removeMember: jest.fn(),
    getBans: jest.fn(),
    banMember: jest.fn(),
    unbanMember: jest.fn(),
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
  emitPermsUpdated: jest.fn(),
  sendPermLogMessage: jest.fn(),
  writePermAudit: jest.fn(),
};
const evictUser = jest.fn();

jest.mock('../db/repositories', () => repos);
jest.mock('../middleware/auth', () => ({
  authMiddleware: (
    req: import('express').Request & { user?: unknown },
    res: import('express').Response,
    next: import('express').NextFunction,
  ) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'No token' }); return; }
    try {
      req.user = require('jsonwebtoken').verify(header.slice(7), 'moderation-branch-secretxxxxxxxx');
      next();
    } catch { res.status(401).json({ error: 'Invalid token' }); }
  },
}));
// `hasPermission` ve `PERMS` GERÇEK kalır: yetki maskesi mantığı taklit
// edilirse "yetki kontrolü var" iddiası boşa çıkar. Yalnız veri okuyan
// `getMemberPerms` / `canActOn` taklit edilir.
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
  limits: {
    moderation: () => (
      _req: import('express').Request,
      _res: import('express').Response,
      next: import('express').NextFunction,
    ) => next(),
  },
}));

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { PERMS } from '../lib/permissions';
import router from '../routes/moderation';

const SRV = 'srv-mod';
const MOD = 'mod-1';
const TARGET = 'target-1';

const app = express();
app.use(express.json());
app.use('/api/servers/:serverId', router);
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err.message });
});

const token = (id: string, extra: Record<string, unknown> = {}) =>
  jwt.sign({ id, username: 'moderator', displayName: 'Moderatör', v: 0, ...extra },
    'moderation-branch-secretxxxxxxxx', { expiresIn: '1h' });

const auth = (id = MOD, extra: Record<string, unknown> = {}) => `Bearer ${token(id, extra)}`;

const ALL = PERMS.ADMIN | PERMS.MANAGE_MESSAGES | PERMS.MANAGE_CHANNELS
  | PERMS.TIMEOUT_MEMBERS | PERMS.KICK_MEMBERS | PERMS.BAN_MEMBERS;

beforeEach(() => {
  jest.clearAllMocks();
  memberPerms.mockResolvedValue(ALL);
  actOn.mockResolvedValue(true);
  effectivePerms.mockResolvedValue(PERMS.MANAGE_MESSAGES);
  repos.Auth.insertAuditLog.mockResolvedValue(undefined);
  repos.Auth.findAuditLogsWhere.mockResolvedValue([]);
  repos.Auth.getAuditLog.mockResolvedValue({ entries: [], total: 0 });
  repos.Users.findById.mockResolvedValue({ _id: TARGET, username: 'kurban', displayName: 'Kurban' });
  repos.Members.findOne.mockResolvedValue({ userId: TARGET, serverId: SRV });
  repos.Members.setTimeout.mockResolvedValue({ updated: 1 });
  repos.Members.removeMember.mockResolvedValue({ deleted: 1 });
  repos.Members.getBans.mockResolvedValue([]);
  repos.Members.banMember.mockResolvedValue(undefined);
  repos.Members.unbanMember.mockResolvedValue({ deleted: 1 });
  repos.Servers.findById.mockResolvedValue({ _id: SRV, ownerId: 'sahip' });
  repos.Messages.findById.mockResolvedValue({ _id: 'm1', content: 'merhaba', displayName: 'Yazar', username: 'yazar' });
  repos.Messages.deleteUserMessages.mockResolvedValue(undefined);
  repos.Channels.findByIdAndServer.mockResolvedValue({ _id: 'ch1', name: 'genel' });
  repos.Channels.findWhere.mockResolvedValue([]);
  repos.Roles.findByIdAndServer.mockResolvedValue({ _id: 'r1' });
  repos.Roles.findWhere.mockResolvedValue([]);
  repos.ChannelPermissions.findOne.mockResolvedValue(null);
  repos.ChannelPermissions.update.mockResolvedValue({ updated: 1 });
  repos.ChannelPermissions.remove.mockResolvedValue({ deleted: 1 });
  repos.ChannelPermissions.insert.mockResolvedValue(undefined);
  repos.MessageReports.findOpenForServer.mockResolvedValue([]);
  repos.MessageReports.findById.mockResolvedValue(null);
  repos.MessageReports.resolveTargetState.mockResolvedValue({ kind: 'updated', row: { _id: 'rep1' } });
  evictUser.mockResolvedValue(undefined);
  permHelpers.writePermAudit.mockResolvedValue(undefined);
  permHelpers.sendPermLogMessage.mockResolvedValue(undefined);
});

// ════════════════════════════════════════════════════════════════════════════
describe('GET /reports — kanal bazlı görünürlük', () => {
  const report = (over: Record<string, unknown> = {}) => ({
    _id: 'rep1', messageId: 'm1', channelId: 'ch1', reporterId: 'u-rep',
    reason: 'spam', detail: 'çok tekrar', createdAt: 1700, ...over,
  });

  it('MANAGE_MESSAGES olmayan kanalın şikâyeti LİSTELENMEZ', async () => {
    repos.MessageReports.findOpenForServer.mockResolvedValue([report()]);
    effectivePerms.mockResolvedValue(PERMS.SEND_MESSAGES);

    const res = await request(app).get(`/api/servers/${SRV}/reports`).set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reports: [], count: 0 });
    expect(repos.Messages.findById).not.toHaveBeenCalled();
  });

  it('yalnız ADMIN yetkisi de yeterlidir', async () => {
    repos.MessageReports.findOpenForServer.mockResolvedValue([report()]);
    effectivePerms.mockResolvedValue(PERMS.ADMIN);

    const res = await request(app).get(`/api/servers/${SRV}/reports`).set('Authorization', auth());

    expect(res.body.count).toBe(1);
  });

  it('yetki ÇÖZÜMÜ PATLARSA satır GİZLENİR (fail-closed)', async () => {
    repos.MessageReports.findOpenForServer.mockResolvedValue([report()]);
    effectivePerms.mockRejectedValue(new Error('permission store down'));

    const res = await request(app).get(`/api/servers/${SRV}/reports`).set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  it('silinmiş MESAJ işaret eden şikâyet atlanır', async () => {
    repos.MessageReports.findOpenForServer.mockResolvedValue([report()]);
    repos.Messages.findById.mockResolvedValue(null);

    const res = await request(app).get(`/api/servers/${SRV}/reports`).set('Authorization', auth());

    expect(res.body.count).toBe(0);
  });

  it('silinmiş KANAL işaret eden şikâyet atlanır', async () => {
    repos.MessageReports.findOpenForServer.mockResolvedValue([report()]);
    repos.Channels.findByIdAndServer.mockResolvedValue(null);

    const res = await request(app).get(`/api/servers/${SRV}/reports`).set('Authorization', auth());

    expect(res.body.count).toBe(0);
  });

  it('SEYREK satırlar güvenli yedeklerle sunulur, "undefined" sızmaz', async () => {
    repos.MessageReports.findOpenForServer.mockResolvedValue([
      { _id: 'rep1', messageId: 'm1', channelId: 'ch1' },
    ]);
    repos.Channels.findByIdAndServer.mockResolvedValue({ _id: 'ch1' });
    repos.Messages.findById.mockResolvedValue({ _id: 'm1', username: 'yalnız-kullanıcı-adı' });
    repos.Users.findById.mockResolvedValue(null);

    const res = await request(app).get(`/api/servers/${SRV}/reports`).set('Authorization', auth());

    expect(res.body.reports[0]).toMatchObject({
      reason: 'other',
      detail: '',
      createdAt: 0,
      channel: { _id: 'ch1', name: 'ch1' },
      message: { displayName: 'yalnız-kullanıcı-adı', preview: '' },
      reporter: { _id: '', displayName: 'Bridge user' },
    });
    expect(JSON.stringify(res.body)).not.toContain('undefined');
  });

  it('adı da kullanıcı adı da olmayan yazar için sabit yedek kullanılır', async () => {
    repos.MessageReports.findOpenForServer.mockResolvedValue([report()]);
    repos.Messages.findById.mockResolvedValue({ _id: 'm1', content: '  çok\n\n  boşluklu   ' });
    repos.Users.findById.mockResolvedValue({ _id: 'u-rep', username: 'sikayetci' });

    const res = await request(app).get(`/api/servers/${SRV}/reports`).set('Authorization', auth());

    expect(res.body.reports[0].message.displayName).toBe('Bridge user');
    expect(res.body.reports[0].message.preview).toBe('çok boşluklu');
    expect(res.body.reports[0].reporter.displayName).toBe('sikayetci');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PUT /reports/:reportId — karar yazma', () => {
  const put = (body: object, id = 'rep1') =>
    request(app).put(`/api/servers/${SRV}/reports/${id}`).set('Authorization', auth()).send(body);

  it.each([
    [{ resolution: 'kapat' }],
    [{}],
    [{ resolution: 42 }],
  ])('geçersiz karar 400 verir: %j', async (body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid resolution');
    expect(repos.MessageReports.resolveTargetState).not.toHaveBeenCalled();
  });

  it('bulunamayan şikâyet 404 verir', async () => {
    const res = await put({ resolution: 'resolved' });
    expect(res.status).toBe(404);
  });

  it('kanal yetkisi olmayan moderatör 403 alır', async () => {
    repos.MessageReports.findById.mockResolvedValue({ _id: 'rep1', channelId: 'ch1', messageId: 'm1' });
    effectivePerms.mockResolvedValue(PERMS.SEND_MESSAGES);

    const res = await put({ resolution: 'resolved' });

    expect(res.status).toBe(403);
    expect(repos.MessageReports.resolveTargetState).not.toHaveBeenCalled();
  });

  it('yarışta kaybolan şikâyet 404, çoktan işlenmiş şikâyet 409 verir', async () => {
    repos.MessageReports.findById.mockResolvedValue({ _id: 'rep1', channelId: 'ch1', messageId: 'm1' });

    repos.MessageReports.resolveTargetState.mockResolvedValue({ kind: 'missing' });
    expect((await put({ resolution: 'resolved' })).status).toBe(404);

    repos.MessageReports.resolveTargetState.mockResolvedValue({ kind: 'conflict', row: null });
    expect((await put({ resolution: 'dismissed' })).status).toBe(409);

    expect(repos.Auth.insertAuditLog).not.toHaveBeenCalled();
  });

  it.each([
    ['resolved', 'REPORT_RESOLVED'],
    ['dismissed', 'REPORT_DISMISSED'],
  ])('%s kararı %s denetim kaydı yazar', async (resolution, action) => {
    repos.MessageReports.findById.mockResolvedValue({ _id: 'rep1', channelId: 'ch1', messageId: 'm9' });

    const res = await put({ resolution });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ resolved: true, resolution });
    expect(repos.Auth.insertAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action, targetId: 'rep1', targetName: 'm9', detail: 'channel:ch1',
    }));
  });

  it('mesajı silinmiş şikâyetin denetim kaydında boş hedef adı kullanılır', async () => {
    repos.MessageReports.findById.mockResolvedValue({ _id: 'rep1', channelId: 'ch1' });

    await put({ resolution: 'resolved' });

    expect(repos.Auth.insertAuditLog).toHaveBeenCalledWith(expect.objectContaining({ targetName: '' }));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('GET /audit-log — filtre doğrulama ve dışa aktarım', () => {
  const get = (query = '') =>
    request(app).get(`/api/servers/${SRV}/audit-log${query}`).set('Authorization', auth());

  it('yetkisiz istek 403 alır ve sorgu çalıştırılmaz', async () => {
    memberPerms.mockResolvedValue(PERMS.SEND_MESSAGES);
    const res = await get();
    expect(res.status).toBe(403);
    expect(repos.Auth.getAuditLog).not.toHaveBeenCalled();
  });

  it.each([
    ['?limit=abc', 'Geçersiz sayfalama değeri'],
    ['?limit=0', 'Geçersiz sayfalama değeri'],
    ['?offset=-1', 'Geçersiz sayfalama değeri'],
    ['?action=' + 'a'.repeat(65), 'Geçersiz action filtresi'],
    ['?action=a&action=b', 'Geçersiz action filtresi'],
    ['?format=xml', 'format json veya csv olmalı'],
    ['?after=bozuk-tarih', 'Geçersiz tarih aralığı'],
    ['?before=bozuk-tarih', 'Geçersiz tarih aralığı'],
    ['?after=2026-02-01&before=2026-01-01', 'Geçersiz tarih aralığı'],
  ])('%s reddedilir', async (query, error) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
    expect(repos.Auth.getAuditLog).not.toHaveBeenCalled();
  });

  it('gün biçimli tarih aralığı gün SONUNA kadar kapsar', async () => {
    await get('?after=2026-01-01&before=2026-01-31&limit=5&offset=2&action=ban');

    expect(repos.Auth.getAuditLog).toHaveBeenCalledWith(SRV, {
      limit: 5, offset: 2, action: 'ban',
      after: Date.parse('2026-01-01T00:00:00.000Z'),
      before: Date.parse('2026-01-31T23:59:59.999Z'),
    });
  });

  it('CSV dışa aktarımı formül enjeksiyonunu ve tırnakları KAÇIRIR', async () => {
    repos.Auth.getAuditLog.mockResolvedValue({
      total: 1,
      entries: [{
        createdAt: 1700, actorName: '=CMD()|calc', action: 'ban',
        targetName: 'ali "the" veli', detail: 'satır1\nsatır2',
      }],
    });

    const res = await get('?format=csv');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="audit-${SRV}.csv"`);
    const [header, row] = res.text.split('\n');
    expect(header).toBe('timestamp,actor,action,target,detail');
    expect(row).toBe('"1700","\'=CMD()|calc","ban","ali ""the"" veli","satır1 satır2"');
  });

  it('CSV boş hücreleri "undefined" değil boş dize yazar', async () => {
    repos.Auth.getAuditLog.mockResolvedValue({ total: 1, entries: [{ action: 'kick' }] });

    const res = await get('?format=csv');

    expect(res.text.split('\n')[1]).toBe('"","","kick","",""');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('GET /audit-log?ui=1 — geri alma değerlendirmesi', () => {
  const uiGet = () =>
    request(app).get(`/api/servers/${SRV}/audit-log?ui=1`).set('Authorization', auth());

  const permEntry = (over: Record<string, unknown> = {}) => ({
    _id: 'a1', action: 'PERM_UPDATE', channelId: 'ch1', targetId: 'r1',
    targetName: 'Eski Rol Adı', createdAt: 1000,
    old: JSON.stringify({ allow: 1, deny: 0 }),
    new: JSON.stringify({ allow: 0, deny: 1 }),
    extra: '{"note":"x"}',
    ...over,
  });

  it('kanal/rol adları çözülür ve JSON alanları AÇILIR', async () => {
    repos.Auth.getAuditLog.mockResolvedValue({ total: 1, entries: [permEntry()] });
    repos.Channels.findWhere.mockResolvedValue([{ _id: 'ch1', name: 'genel' }]);
    repos.Roles.findWhere.mockResolvedValue([{ _id: 'r1', name: 'Yöneticiler' }]);
    repos.ChannelPermissions.findOne.mockResolvedValue({ allow: 0, deny: 1 });

    const res = await uiGet();

    const entry = res.body.entries[0];
    expect(entry.channelName).toBe('genel');
    expect(entry.targetName).toBe('Yöneticiler');
    expect(entry.old).toEqual({ allow: 1, deny: 0 });
    expect(entry.extra).toEqual({ note: 'x' });
    expect(entry.undo).toEqual({ supported: true, canUndo: true });
  });

  it('adı olmayan kanal/rol satırları KİMLİĞE düşer', async () => {
    repos.Auth.getAuditLog.mockResolvedValue({ total: 1, entries: [permEntry()] });
    repos.Channels.findWhere.mockResolvedValue([{ _id: 'ch1' }]);
    repos.Roles.findWhere.mockResolvedValue([{ _id: 'r1' }]);

    const res = await uiGet();

    expect(res.body.entries[0].channelName).toBe('ch1');
    expect(res.body.entries[0].targetName).toBe('r1');
  });

  it('silinmiş rol için denetim kaydındaki AD korunur', async () => {
    repos.Auth.getAuditLog.mockResolvedValue({ total: 1, entries: [permEntry()] });
    repos.Roles.findWhere.mockResolvedValue([]);

    const res = await uiGet();

    expect(res.body.entries[0].targetName).toBe('Eski Rol Adı');
  });

  it('@everyone hedefi rol sorgusuna KATILMAZ ve okunur adla gösterilir', async () => {
    repos.Auth.getAuditLog.mockResolvedValue({
      total: 2,
      entries: [permEntry({ _id: 'a1', targetId: '__everyone__' }), permEntry({ _id: 'a2', targetId: SRV })],
    });

    const res = await uiGet();

    expect(repos.Roles.findWhere).not.toHaveBeenCalled();
    expect(res.body.entries[0].targetName).toBe('@everyone');
    expect(res.body.entries[1].targetName).toBe('@everyone');
  });

  it('MANAGE_CHANNELS olmadan geri alma DESTEKLENMEZ ve nedeni söylenir', async () => {
    memberPerms.mockResolvedValue(PERMS.MANAGE_MESSAGES);
    repos.Auth.getAuditLog.mockResolvedValue({
      total: 2,
      entries: [permEntry(), permEntry({ _id: 'a2', action: 'ban' })],
    });

    const res = await uiGet();

    expect(res.body.entries[0].undo).toEqual({
      supported: true, canUndo: false,
      reason: 'Geri alma için kanalları yönetme yetkisi gerekir.',
    });
    expect(res.body.entries[1].undo).toEqual({ supported: false, canUndo: false });
    expect(repos.ChannelPermissions.findOne).not.toHaveBeenCalled();
  });

  it('kayıt yoksa zenginleştirme hiç çalışmaz', async () => {
    repos.Auth.getAuditLog.mockResolvedValue({ total: 0, entries: [] });

    const res = await uiGet();

    expect(res.body).toEqual({ entries: [], total: 0 });
    expect(repos.Channels.findWhere).not.toHaveBeenCalled();
    expect(repos.Roles.findWhere).not.toHaveBeenCalled();
  });

  it.each([
    ['hedef bilgisi eksikse', { channelId: '' }, 'Denetim kaydında güvenli geri alma için gereken hedef bilgileri eksik.'],
    ['zaman damgası bozuksa', { createdAt: 'dun' }, 'Denetim kaydında güvenli geri alma için gereken hedef bilgileri eksik.'],
    ['önceki durum çözülemiyorsa', { old: '42' }, 'Denetim kaydındaki önceki durum doğrulanamıyor.'],
    ['allow/deny çakışıyorsa', { old: JSON.stringify({ allow: 3, deny: 1 }) }, 'Denetim kaydındaki önceki durum doğrulanamıyor.'],
    ['güncellemenin son durumu yoksa', { new: null }, 'Güncellemenin son durumu doğrulanamıyor.'],
  ])('geri alma %s reddedilir', async (_label, over, reason) => {
    repos.Auth.getAuditLog.mockResolvedValue({ total: 1, entries: [permEntry(over)] });

    const res = await uiGet();

    expect(res.body.entries[0].undo).toMatchObject({ supported: true, canUndo: false, reason });
  });

  it('silinen override kaydında önceki durum yoksa geri alınamaz', async () => {
    repos.Auth.getAuditLog.mockResolvedValue({
      total: 1, entries: [permEntry({ action: 'PERM_DELETE', old: null })],
    });

    const res = await uiGet();

    expect(res.body.entries[0].undo.reason).toBe('Silinen override’ın önceki durumu kayıtta yok.');
  });

  it('kanal veya rol artık yoksa geri alınamaz', async () => {
    repos.Auth.getAuditLog.mockResolvedValue({ total: 1, entries: [permEntry()] });
    repos.Channels.findByIdAndServer.mockResolvedValue(null);

    expect((await uiGet()).body.entries[0].undo.reason).toBe('Kanal veya rol artık mevcut değil.');

    repos.Channels.findByIdAndServer.mockResolvedValue({ _id: 'ch1' });
    repos.Roles.findByIdAndServer.mockResolvedValue(null);

    expect((await uiGet()).body.entries[0].undo.reason).toBe('Kanal veya rol artık mevcut değil.');
  });

  it('daha YENİ bir yönetici değişikliği varsa geri alınamaz', async () => {
    repos.Auth.getAuditLog.mockResolvedValue({ total: 1, entries: [permEntry()] });
    repos.Auth.findAuditLogsWhere.mockResolvedValue([{ _id: 'a2' }]);

    expect((await uiGet()).body.entries[0].undo.reason)
      .toBe('Bu hedefte daha yeni bir yönetici değişikliği var.');
  });

  it('mevcut izin durumu kayıttan sonra değiştiyse geri alınamaz', async () => {
    repos.Auth.getAuditLog.mockResolvedValue({ total: 1, entries: [permEntry()] });
    repos.ChannelPermissions.findOne.mockResolvedValue({ allow: 8, deny: 0 });

    expect((await uiGet()).body.entries[0].undo.reason)
      .toBe('Mevcut izin durumu denetim kaydından sonra değişmiş.');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('POST /audit-log/:auditId/undo — dar kapsamlı geri alma', () => {
  const undo = (auditId = 'a1') =>
    request(app).post(`/api/servers/${SRV}/audit-log/${auditId}/undo`).set('Authorization', auth()).send({});

  const entry = (over: Record<string, unknown> = {}) => ({
    _id: 'a1', action: 'PERM_UPDATE', channelId: 'ch1', targetId: 'r1',
    targetName: 'Rol', createdAt: 1000,
    old: { allow: 1, deny: 0 },
    new: { allow: 0, deny: 1 },
    ...over,
  });

  // `Auth.findAuditLogsWhere` iki AYRI soruya yanıt verir: önce kaydın
  // kendisi, sonra "bu hedefte daha yeni değişiklik var mı". İkisi aynı
  // yanıtı verirse kayıt kendini "daha yeni değişiklik" sanır.
  const prime = (over: Record<string, unknown> = {}, later: unknown[] = []) => {
    repos.Auth.findAuditLogsWhere
      .mockResolvedValueOnce([entry(over)])
      .mockResolvedValue(later);
  };

  it('MANAGE_CHANNELS olmadan 403', async () => {
    memberPerms.mockResolvedValue(PERMS.MANAGE_MESSAGES);
    const res = await undo();
    expect(res.status).toBe(403);
    expect(repos.Auth.findAuditLogsWhere).not.toHaveBeenCalled();
  });

  it('kayıt yoksa 404', async () => {
    expect((await undo()).status).toBe(404);
  });

  it('kapsam dışı işlem 400 verir', async () => {
    prime({ action: 'ban' });
    const res = await undo();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bu işlem güvenli geri alma kapsamına dahil değil.');
  });

  it('değerlendirme olumsuzsa 409 ve NEDEN döner', async () => {
    prime({}, [{ _id: 'a9' }]);
    const res = await undo();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Bu hedefte daha yeni bir yönetici değişikliği var.');
    expect(repos.ChannelPermissions.update).not.toHaveBeenCalled();
  });

  it('güncelleme geri alınırken MEVCUT durum WHERE koşuluna konur', async () => {
    prime();
    repos.ChannelPermissions.findOne.mockResolvedValue({ allow: 0, deny: 1 });

    const res = await undo();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, scope: 'channel_permission' });
    expect(repos.ChannelPermissions.update).toHaveBeenCalledWith(
      { channelId: 'ch1', roleId: 'r1', allow: 0, deny: 1 },
      { $set: expect.objectContaining({ allow: 1, deny: 0 }) },
    );
    expect(permHelpers.writePermAudit).toHaveBeenCalledWith(
      SRV, MOD, 'ch1', 'r1', 'PERM_UNDO', { allow: 0, deny: 1 }, { allow: 1, deny: 0 },
      expect.objectContaining({ sourceAuditId: 'a1', targetName: 'Rol' }),
    );
    expect(permCache.invalidatePerms).toHaveBeenCalledWith(SRV, null, 'ch1');
    expect(permHelpers.emitPermsUpdated).toHaveBeenCalled();
  });

  it('karşılaştırmalı güncelleme 0 satır etkilerse 409', async () => {
    prime();
    repos.ChannelPermissions.findOne.mockResolvedValue({ allow: 0, deny: 1 });
    repos.ChannelPermissions.update.mockResolvedValue({ updated: 0 });

    const res = await undo();

    expect(res.status).toBe(409);
    expect(permHelpers.writePermAudit).not.toHaveBeenCalled();
  });

  it('önceki durum YOKSA override KALDIRILIR; kaldırma tutmazsa 409', async () => {
    prime({ old: null });
    repos.ChannelPermissions.findOne.mockResolvedValue({ allow: 0, deny: 1 });

    expect((await undo()).status).toBe(200);
    expect(repos.ChannelPermissions.remove).toHaveBeenCalledWith({
      channelId: 'ch1', roleId: 'r1', allow: 0, deny: 1,
    });

    prime({ old: null });
    repos.ChannelPermissions.remove.mockResolvedValue({ deleted: 0 });
    expect((await undo()).status).toBe(409);
  });

  it('SİLİNMİŞ override geri eklenir ve YAZIM DOĞRULANIR', async () => {
    prime({ action: 'PERM_DELETE', new: null });
    repos.ChannelPermissions.findOne
      .mockResolvedValueOnce(null)                    // değerlendirme: override yok
      .mockResolvedValueOnce({ allow: 1, deny: 0 });  // yazımdan sonra: doğrulandı

    const res = await undo();

    expect(res.status).toBe(200);
    expect(repos.ChannelPermissions.insert).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: SRV, channelId: 'ch1', roleId: 'r1', allow: 1, deny: 0 }),
    );
    expect(permHelpers.writePermAudit).toHaveBeenCalledWith(
      SRV, MOD, 'ch1', 'r1', 'PERM_UNDO', null, { allow: 1, deny: 0 }, expect.anything(),
    );
  });

  it('geri ekleme doğrulaması TUTMAZSA 409', async () => {
    prime({ action: 'PERM_DELETE', new: null });
    repos.ChannelPermissions.findOne
      .mockResolvedValueOnce(null)                    // değerlendirme: beklenen "yok"
      .mockResolvedValueOnce({ allow: 9, deny: 0 });  // yazımdan sonra: uyuşmuyor

    const res = await undo();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('İzin durumu işlem sırasında değişti; geri alma uygulanmadı.');
    expect(permHelpers.writePermAudit).not.toHaveBeenCalled();
  });

  it('depo yazma sırasında PATLARSA 409 verilir, 500 değil', async () => {
    prime();
    repos.ChannelPermissions.findOne.mockResolvedValue({ allow: 0, deny: 1 });
    repos.ChannelPermissions.update.mockRejectedValue(new Error('deadlock'));

    const res = await undo();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('İzin durumu işlem sırasında değişti; geri alma uygulanmadı.');
  });

  it('aktör kaydı yoksa JETONDAKİ ad kullanılır', async () => {
    prime({ targetName: undefined });
    repos.ChannelPermissions.findOne.mockResolvedValue({ allow: 0, deny: 1 });
    repos.Users.findById.mockResolvedValue(null);

    await undo();

    expect(permHelpers.writePermAudit).toHaveBeenCalledWith(
      SRV, MOD, 'ch1', 'r1', 'PERM_UNDO', expect.anything(), expect.anything(),
      expect.objectContaining({ actorName: 'Moderatör', targetName: 'r1' }),
    );
  });

  it('depodaki aktör adı jetondakine TERCİH edilir', async () => {
    prime();
    repos.ChannelPermissions.findOne.mockResolvedValue({ allow: 0, deny: 1 });
    repos.Users.findById.mockResolvedValue({ _id: MOD, username: 'mod', displayName: 'Depodaki Ad' });

    await undo();

    expect(permHelpers.writePermAudit).toHaveBeenCalledWith(
      SRV, MOD, 'ch1', 'r1', 'PERM_UNDO', expect.anything(), expect.anything(),
      expect.objectContaining({ actorName: 'Depodaki Ad' }),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('POST /members/:userId/timeout', () => {
  const timeout = (body: object, userId = TARGET, actor = MOD) =>
    request(app).post(`/api/servers/${SRV}/members/${userId}/timeout`)
      .set('Authorization', auth(actor)).send(body);

  it.each([
    [{ durationMs: '600000' }],
    [{ durationMs: -1 }],
    [{ durationMs: 1.5 }],
    [{ durationMs: 29 * 24 * 60 * 60 * 1000 }],
    [{}],
  ])('güvenli olmayan süre 400 verir: %j', async (body) => {
    const res = await timeout(body);
    expect(res.status).toBe(400);
    expect(repos.Members.setTimeout).not.toHaveBeenCalled();
  });

  it('metin olmayan gerekçe 400 verir', async () => {
    const res = await timeout({ durationMs: 1000, reason: { a: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('reason must be a string');
  });

  it('dizi gövde nesne sayılmaz ve süre eksik kabul edilir', async () => {
    const res = await request(app).post(`/api/servers/${SRV}/members/${TARGET}/timeout`)
      .set('Authorization', auth()).send([{ durationMs: 1000 }]);
    expect(res.status).toBe(400);
  });

  it('KENDİNE timeout 400 verir', async () => {
    const res = await timeout({ durationMs: 1000 }, MOD);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Kendinize timeout uygulayamazsınız');
  });

  it('yetkisiz moderatör 403 alır', async () => {
    memberPerms.mockResolvedValue(PERMS.SEND_MESSAGES);
    expect((await timeout({ durationMs: 1000 })).status).toBe(403);
  });

  it('SUNUCU SAHİBİNE timeout 403 verir', async () => {
    repos.Servers.findById.mockResolvedValue({ _id: SRV, ownerId: TARGET });
    const res = await timeout({ durationMs: 1000 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Sunucu sahibine timeout uygulanamaz');
  });

  it('üye olmayan kullanıcı 404 verir', async () => {
    repos.Members.findOne.mockResolvedValue(null);
    expect((await timeout({ durationMs: 1000 })).status).toBe(404);
  });

  it('ÜST yetkili üyeye timeout 403 verir', async () => {
    actOn.mockResolvedValue(false);
    expect((await timeout({ durationMs: 1000 })).status).toBe(403);
  });

  it('kullanıcı kaydı silinmişse 404 verir', async () => {
    repos.Users.findById.mockResolvedValue(null);
    expect((await timeout({ durationMs: 1000 })).status).toBe(404);
  });

  it('üyelik işlem sırasında değişirse 409 verir', async () => {
    repos.Members.setTimeout.mockResolvedValue({ updated: 0 });
    const res = await timeout({ durationMs: 1000 });
    expect(res.status).toBe(409);
    expect(repos.Auth.insertAuditLog).not.toHaveBeenCalled();
  });

  it('süre uygulanır ve denetim kaydı yazılır', async () => {
    const res = await timeout({ durationMs: 60_000, reason: 'spam' });

    expect(res.status).toBe(200);
    expect(typeof res.body.until).toBe('string');
    expect(repos.Auth.insertAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'timeout', targetId: TARGET, targetName: 'kurban', detail: 'spam',
    }));
    expect(permCache.invalidatePerms).toHaveBeenCalledWith(SRV, TARGET);
  });

  it('SIFIR süre timeout KALDIRIR ve ayrı bir eylem olarak kaydedilir', async () => {
    const res = await timeout({ durationMs: 0 });

    expect(res.body.until).toBeNull();
    expect(repos.Members.setTimeout).toHaveBeenCalledWith(SRV, TARGET, null);
    expect(repos.Auth.insertAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'timeout_remove', detail: '',
    }));
  });

  it('jetonda görünen ad yoksa kullanıcı adı kaydedilir', async () => {
    await request(app).post(`/api/servers/${SRV}/members/${TARGET}/timeout`)
      .set('Authorization', `Bearer ${jwt.sign({ id: MOD, username: 'sadece-kullanici-adi', v: 0 }, 'moderation-branch-secretxxxxxxxx')}`)
      .send({ durationMs: 1000 });

    expect(repos.Auth.insertAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      actorName: 'sadece-kullanici-adi',
    }));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('POST /members/:userId/kick', () => {
  const kick = (body: object = {}, userId = TARGET) =>
    request(app).post(`/api/servers/${SRV}/members/${userId}/kick`)
      .set('Authorization', auth()).send(body);

  it('metin olmayan gerekçe 400, kendini kick 400 verir', async () => {
    expect((await kick({ reason: 5 })).body.error).toBe('reason must be a string');
    expect((await kick({}, MOD)).body.error).toBe('Kendinizi kickleyemezsiniz');
    expect(repos.Members.removeMember).not.toHaveBeenCalled();
  });

  it('yetki, sahiplik, üyelik ve hiyerarşi sırayla korunur', async () => {
    memberPerms.mockResolvedValue(PERMS.SEND_MESSAGES);
    expect((await kick()).status).toBe(403);

    memberPerms.mockResolvedValue(ALL);
    repos.Servers.findById.mockResolvedValue({ _id: SRV, ownerId: TARGET });
    expect((await kick()).body.error).toBe('Sunucu sahibi kicklenemez');

    repos.Servers.findById.mockResolvedValue({ _id: SRV, ownerId: 'sahip' });
    repos.Members.findOne.mockResolvedValue(null);
    expect((await kick()).status).toBe(404);

    repos.Members.findOne.mockResolvedValue({ userId: TARGET });
    actOn.mockResolvedValue(false);
    expect((await kick()).status).toBe(403);

    expect(repos.Members.removeMember).not.toHaveBeenCalled();
  });

  it('kullanıcı kaydı yoksa 404, üyelik yarışında 409 verir', async () => {
    repos.Users.findById.mockResolvedValue(null);
    expect((await kick()).status).toBe(404);

    repos.Users.findById.mockResolvedValue({ _id: TARGET, username: 'kurban' });
    repos.Members.removeMember.mockResolvedValue({ deleted: 0 });
    expect((await kick()).status).toBe(409);
    expect(evictUser).not.toHaveBeenCalled();
  });

  it('başarılı kick canlı odalardan DA çıkarır', async () => {
    const res = await kick({ reason: 'kural ihlali' });

    expect(res.status).toBe(200);
    expect(repos.Auth.insertAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'kick', detail: 'kural ihlali',
    }));
    expect(permCache.invalidatePerms).toHaveBeenCalledWith(SRV, TARGET);
    expect(evictUser).toHaveBeenCalledWith(undefined, TARGET, SRV);
  });

  it('gerekçesiz kick boş gerekçe kaydeder', async () => {
    await kick({});
    expect(repos.Auth.insertAuditLog).toHaveBeenCalledWith(expect.objectContaining({ detail: '' }));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ban listesi ve ban/unban', () => {
  it('GET /bans yetki ister', async () => {
    memberPerms.mockResolvedValue(PERMS.SEND_MESSAGES);
    expect((await request(app).get(`/api/servers/${SRV}/bans`).set('Authorization', auth())).status).toBe(403);

    memberPerms.mockResolvedValue(PERMS.BAN_MEMBERS);
    repos.Members.getBans.mockResolvedValue([{ userId: TARGET }]);
    const res = await request(app).get(`/api/servers/${SRV}/bans`).set('Authorization', auth());
    expect(res.body).toEqual([{ userId: TARGET }]);
  });

  const ban = (body: object) =>
    request(app).post(`/api/servers/${SRV}/bans`).set('Authorization', auth()).send(body);

  it.each([
    [{}, 'userId required'],
    [{ userId: '   ' }, 'userId required'],
    [{ userId: 42 }, 'userId required'],
    [{ userId: TARGET, reason: 7 }, 'reason must be a string'],
    [{ userId: TARGET, deleteMessageDays: 8 }, 'deleteMessageDays must be an integer between 0 and 7'],
    [{ userId: TARGET, deleteMessageDays: '3' }, 'deleteMessageDays must be an integer between 0 and 7'],
    [{ userId: TARGET, deleteMessageDays: -1 }, 'deleteMessageDays must be an integer between 0 and 7'],
  ])('geçersiz ban gövdesi reddedilir: %j', async (body, error) => {
    const res = await ban(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
    expect(repos.Members.banMember).not.toHaveBeenCalled();
  });

  it('kendini banlama, yetkisizlik, sahiplik ve hiyerarşi engellenir', async () => {
    expect((await ban({ userId: MOD })).body.error).toBe('Kendinizi banlayamazsınız');

    memberPerms.mockResolvedValue(PERMS.SEND_MESSAGES);
    expect((await ban({ userId: TARGET })).status).toBe(403);

    memberPerms.mockResolvedValue(ALL);
    repos.Servers.findById.mockResolvedValue({ _id: SRV, ownerId: TARGET });
    expect((await ban({ userId: TARGET })).body.error).toBe('Sunucu sahibi banlanamaz');

    repos.Servers.findById.mockResolvedValue({ _id: SRV, ownerId: 'sahip' });
    actOn.mockResolvedValue(false);
    expect((await ban({ userId: TARGET })).status).toBe(403);

    expect(repos.Members.banMember).not.toHaveBeenCalled();
  });

  it('bilinmeyen kullanıcı 404 verir', async () => {
    repos.Users.findById.mockResolvedValue(null);
    expect((await ban({ userId: TARGET })).status).toBe(404);
  });

  it('geçmiş silme SIFIRKEN mesajlara dokunulmaz', async () => {
    const res = await ban({ userId: TARGET });

    expect(res.status).toBe(200);
    expect(repos.Messages.deleteUserMessages).not.toHaveBeenCalled();
    expect(repos.Auth.insertAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ban', detail: '' }));
    expect(evictUser).toHaveBeenCalledWith(undefined, TARGET, SRV);
  });

  it('geçmiş silme istenirse SINIRLI bir pencere silinir', async () => {
    const before = Date.now();
    await ban({ userId: TARGET, deleteMessageDays: 7, reason: 'kalıcı ihlal' });

    expect(repos.Messages.deleteUserMessages).toHaveBeenCalledTimes(1);
    const call = repos.Messages.deleteUserMessages.mock.calls[0] as [string, string, Date];
    expect(call[0]).toBe(TARGET);
    expect(call[1]).toBe(SRV);
    expect(before - call[2].getTime()).toBeGreaterThanOrEqual(7 * 864e5 - 5000);
    expect(repos.Auth.insertAuditLog).toHaveBeenCalledWith(expect.objectContaining({ detail: 'kalıcı ihlal' }));
  });

  const unban = (userId = TARGET) =>
    request(app).delete(`/api/servers/${SRV}/bans/${userId}`).set('Authorization', auth());

  it('unban yetki ister, kayıt yoksa 404 verir', async () => {
    memberPerms.mockResolvedValue(PERMS.SEND_MESSAGES);
    expect((await unban()).status).toBe(403);

    memberPerms.mockResolvedValue(ALL);
    repos.Members.unbanMember.mockResolvedValue({ deleted: 0 });
    expect((await unban()).status).toBe(404);
    expect(repos.Auth.insertAuditLog).not.toHaveBeenCalled();
  });

  it('silinmiş kullanıcının banı KİMLİKLE kaydedilerek kaldırılır', async () => {
    repos.Users.findById.mockResolvedValue(null);

    const res = await unban();

    expect(res.status).toBe(200);
    expect(repos.Auth.insertAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'unban', targetName: TARGET,
    }));
  });

  it('bilinen kullanıcının banı ADIYLA kaydedilerek kaldırılır', async () => {
    await unban();
    expect(repos.Auth.insertAuditLog).toHaveBeenCalledWith(expect.objectContaining({ targetName: 'kurban' }));
  });
});
