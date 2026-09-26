// server/tests/bot-marketplace-install-lifecycle.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// MARKETPLACE KURULUM YAŞAM DÖNGÜSÜ
// ════════════════════════════════════════════════════════════════════════════
//
// Kurulum uçları (`/installed`, `POST /:botId/install`,
// `DELETE /:botId/install/:serverId`) hiç ölçülmemişti. Bunlar bir sunucuya
// ÇALIŞTIRILABİLİR kod bağlar; sessiz bir hata gerçek bir yetki yükseltmesidir:
//
//   · Sunucuya bot kurmak MANAGE_SERVER (veya ADMIN) ister. Yetki çözümü
//     PATLARSA sonuç "izin yok" olmalıdır — yetki hesaplanamadığı için kurulum
//     serbest kalmamalıdır.
//   · Yalnız ONAYLANMIŞ ve çalıştırılabilir eşlemesi olan liste kurulabilir;
//     onaysız/eşlemesiz kayıt 409 vermelidir.
//   · Hedef bot pasif ya da özel ise kurulmamalıdır.
//   · Sunucunun KENDİ botu marketplace kurulumu gibi eklenmemeli, marketplace
//     kaldırması ile de silinememelidir.
//   · Eşzamanlı iki kurulum isteği: benzersizlik ihlali (23505) BAŞARILI
//     yinelenen istek sayılır; başka her hata yutulmamalıdır.
//   · Kurulum sayacı her iki yönde de eşitlenmelidir.

process.env.NODE_ENV = 'test';

const marketplaceRepo = {
  findById: jest.fn(),
  findInstalledMarketplaceIds: jest.fn(),
  syncInstallCount: jest.fn(),
  update: jest.fn(),
  addReview: jest.fn(),
};
const bots = { findById: jest.fn(), findServerBot: jest.fn(), addToServer: jest.fn(), removeFromServer: jest.fn(), updateServerGrant: jest.fn() };
const members = { findOne: jest.fn() };
const resolvePerms = jest.fn();

jest.mock('../middleware/auth', () => ({
  authMiddleware: (
    req: { headers: Record<string, unknown>; user?: Record<string, unknown> },
    _res: unknown,
    next: () => void,
  ) => {
    req.user = req.headers['x-user-mode'] === 'id-only'
      ? { id: 'eski-kimlik' }
      : { _id: 'user-1', id: 'eski-kimlik', username: 'alice' };
    next();
  },
  castAuthed: (req: unknown) => req,
}));
jest.mock('../lib/adminAuthority', () => ({
  databaseAdminOnly: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: {
    general: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    bots: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  },
}));
jest.mock('../db/repositories/BotMarketplaceRepository.js', () => ({ BotMarketplace: marketplaceRepo }));
jest.mock('../db/repositories', () => ({ Bots: bots, Members: members }));
// İzin BİTİ mantığı gerçek kalır; yalnız veriye giden çözümleme taklit edilir.
jest.mock('../lib/permissions', () => {
  const actual = jest.requireActual('../lib/permissions');
  return { ...actual, resolvePermissions: (...args: unknown[]) => resolvePerms(...args) };
});

import express from 'express';
import request from 'supertest';
import { PERMS } from '../lib/permissions';
import router from '../routes/bot-marketplace';

const app = express();
app.use(express.json());
app.use('/api/bots/marketplace', router);

const SRV = 'srv-1';
const LISTING = 'cool-bot';
const EXEC = 'exec-bot-1';

const listing = (over: Record<string, unknown> = {}) => ({
  id: LISTING, name: 'Cool', approved: true, executableBotId: EXEC, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  members.findOne.mockResolvedValue({ userId: 'user-1', serverId: SRV });
  resolvePerms.mockResolvedValue(PERMS.MANAGE_SERVER);
  marketplaceRepo.findById.mockResolvedValue(listing());
  marketplaceRepo.findInstalledMarketplaceIds.mockResolvedValue([]);
  marketplaceRepo.syncInstallCount.mockResolvedValue(undefined);
  bots.findById.mockResolvedValue({ _id: EXEC, serverId: 'baska-sunucu', active: true, isPublic: true });
  bots.findServerBot.mockResolvedValue(null);
  bots.addToServer.mockResolvedValue(undefined);
  bots.removeFromServer.mockResolvedValue(undefined);
});

// ════════════════════════════════════════════════════════════════════════════
describe('GET /installed', () => {
  const installed = (query: string, mode?: string) => {
    const req = request(app).get(`/api/bots/marketplace/installed${query}`);
    return mode ? req.set('x-user-mode', mode) : req;
  };

  it('serverId olmadan 400 verir ve depoya sorulmaz', async () => {
    const res = await installed('');
    expect(res.status).toBe(400);
    expect(members.findOne).not.toHaveBeenCalled();
  });

  it('dizi biçimli serverId de eksik sayılır', async () => {
    expect((await installed('?serverId=a&serverId=b')).status).toBe(400);
  });

  it('sunucu ÜYESİ olmayan 403 alır', async () => {
    members.findOne.mockResolvedValue(null);
    const res = await installed(`?serverId=${SRV}`);
    expect(res.status).toBe(403);
    expect(marketplaceRepo.findInstalledMarketplaceIds).not.toHaveBeenCalled();
  });

  it('üye kurulu listeyi görür', async () => {
    marketplaceRepo.findInstalledMarketplaceIds.mockResolvedValue([LISTING]);
    const res = await installed(`?serverId=${SRV}`);
    // Each installed listing reports what the bot may do here (Final21 Phase 14).
    expect(res.body).toEqual({ installed: [LISTING], grants: { [LISTING]: ['commands'] } });
  });

  it('yalnız eski `id` alanı olan jeton da tanınır', async () => {
    await installed(`?serverId=${SRV}`, 'id-only');
    expect(members.findOne).toHaveBeenCalledWith('eski-kimlik', SRV);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('POST /:botId/install', () => {
  // Final21 Phase 14: installing requires consent to exactly what the listing declares.
  const install = (body: unknown = { serverId: SRV, acceptedPermissions: ['commands'] }, mode?: string) => {
    const req = request(app).post(`/api/bots/marketplace/${LISTING}/install`);
    return (mode ? req.set('x-user-mode', mode) : req).send(body as object);
  };

  it('serverId yoksa 400 verir', async () => {
    expect((await install({})).status).toBe(400);
    expect((await install({ serverId: 42 })).status).toBe(400);
    expect(members.findOne).not.toHaveBeenCalled();
  });

  it('üye olmayan kullanıcı kuramaz', async () => {
    members.findOne.mockResolvedValue(null);
    expect((await install()).status).toBe(403);
    expect(marketplaceRepo.findById).not.toHaveBeenCalled();
  });

  it('MANAGE_SERVER/ADMIN olmadan kuramaz', async () => {
    resolvePerms.mockResolvedValue(PERMS.SEND_MESSAGES);
    expect((await install()).status).toBe(403);
  });

  it('yalnız ADMIN yetkisi de yeterlidir', async () => {
    resolvePerms.mockResolvedValue(PERMS.ADMIN);
    expect((await install()).status).toBe(200);
  });

  it('yetki ÇÖZÜMÜ PATLARSA kurulum REDDEDİLİR (fail-closed)', async () => {
    resolvePerms.mockRejectedValue(new Error('permission store down'));
    const res = await install();
    expect(res.status).toBe(403);
    expect(bots.addToServer).not.toHaveBeenCalled();
  });

  it.each([
    ['liste yoksa', null],
    ['liste onaysızsa', { id: LISTING, approved: false, executableBotId: EXEC }],
    ['çalıştırılabilir eşleme yoksa', { id: LISTING, approved: true, executableBotId: null }],
    ['eşleme metin değilse', { id: LISTING, approved: true, executableBotId: 7 }],
  ])('%s 409 verir', async (_label, row) => {
    marketplaceRepo.findById.mockResolvedValue(row);
    const res = await install();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Marketplace bot is not installable');
    expect(bots.findById).not.toHaveBeenCalled();
  });

  it.each([
    ['bot kaydı yoksa', null],
    ['bot pasifse', { _id: EXEC, serverId: 'x', active: false, isPublic: true }],
    ['bot özel ise', { _id: EXEC, serverId: 'x', active: true, isPublic: false }],
  ])('%s 409 verir', async (_label, row) => {
    bots.findById.mockResolvedValue(row);
    const res = await install();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Executable bot is unavailable');
    expect(bots.addToServer).not.toHaveBeenCalled();
  });

  it('sunucunun KENDİ botu için kurulum kaydı OLUŞTURULMAZ', async () => {
    bots.findById.mockResolvedValue({ _id: EXEC, serverId: SRV, active: true, isPublic: true });

    const res = await install();

    expect(res.body).toEqual({ ok: true, installed: true, owned: true, grantedScopes: ['commands', 'messages:reply'] });
    expect(bots.addToServer).not.toHaveBeenCalled();
    expect(marketplaceRepo.syncInstallCount).not.toHaveBeenCalled();
  });

  it('kurulum yapılır ve sayaç EŞİTLENİR', async () => {
    const res = await install();

    expect(res.body).toEqual({ ok: true, installed: true, owned: false, grantedScopes: ['commands'] });
    expect(bots.addToServer).toHaveBeenCalledWith(EXEC, SRV, 'user-1', ['commands']);
    expect(marketplaceRepo.syncInstallCount).toHaveBeenCalledWith(EXEC);
  });

  it('zaten kuruluysa yeniden EKLENMEZ ama sayaç yine eşitlenir', async () => {
    bots.findServerBot.mockResolvedValue({ botId: EXEC, serverId: SRV });

    const res = await install();

    expect(res.status).toBe(200);
    expect(bots.addToServer).not.toHaveBeenCalled();
    expect(marketplaceRepo.syncInstallCount).toHaveBeenCalledWith(EXEC);
  });

  it('YARIŞTA benzersizlik ihlali başarı sayılır', async () => {
    bots.addToServer.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));

    const res = await install();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, installed: true, owned: false, grantedScopes: ['commands'] });
    expect(marketplaceRepo.syncInstallCount).toHaveBeenCalledWith(EXEC);
  });

  it('BAŞKA bir veritabanı hatası YUTULMAZ', async () => {
    bots.addToServer.mockRejectedValue(Object.assign(new Error('disk full'), { code: '53100' }));

    const res = await install().catch((err: Error) => err);

    expect((res as request.Response).status).toBe(500);
    expect(marketplaceRepo.syncInstallCount).not.toHaveBeenCalled();
  });

  it('eski `id` alanlı jeton kurulum sahibi olarak yazılır', async () => {
    await install({ serverId: SRV, acceptedPermissions: ['commands'] }, 'id-only');
    expect(bots.addToServer).toHaveBeenCalledWith(EXEC, SRV, 'eski-kimlik', ['commands']);
  });

  // ── Final21 Phase 14: consent and scopes ─────────────────────────────────
  it.each([
    ['onay hiç yoksa', { serverId: SRV }],
    ['onay eksikse', { serverId: SRV, acceptedPermissions: ['commands'] }],
    ['onay FAZLA ise', { serverId: SRV, acceptedPermissions: ['commands', 'messages:reply', 'members:ban'] }],
    ['onay dizi değilse', { serverId: SRV, acceptedPermissions: 'commands,messages:reply' }],
  ])('%s kurulum REDDEDİLİR ve istenen izinler bildirilir', async (_label, body) => {
    marketplaceRepo.findById.mockResolvedValue(listing({ permissions: ['commands', 'messages:reply'] }));
    const res = await install(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'consent_required', permissions: ['commands', 'messages:reply'] });
    expect(bots.addToServer).not.toHaveBeenCalled();
  });

  it('tam onayla kurulur ve verilen izinler KAYDEDİLİR', async () => {
    marketplaceRepo.findById.mockResolvedValue(listing({ permissions: ['messages:reply', 'commands'] }));
    const res = await install({ serverId: SRV, acceptedPermissions: ['messages:reply', 'commands'] });
    expect(res.body.grantedScopes).toEqual(['commands', 'messages:reply']);
    expect(bots.addToServer).toHaveBeenCalledWith(EXEC, SRV, 'user-1', ['commands', 'messages:reply']);
  });

  it('desteklenmeyen izin bildiren liste KURULAMAZ', async () => {
    marketplaceRepo.findById.mockResolvedValue(listing({ permissions: ['messages:read', 'members:ban'] }));
    const res = await install({ serverId: SRV, acceptedPermissions: ['messages:read', 'members:ban'] });
    expect(res.status).toBe(409);
    expect(res.body.unsupported).toEqual(['members:ban', 'messages:read']);
    expect(bots.findById).not.toHaveBeenCalled();
  });

  it('liste daha fazla izin isterse YENİ onay eski yetkinin yerine yazılır', async () => {
    marketplaceRepo.findById.mockResolvedValue(listing({ permissions: ['commands', 'messages:reply'] }));
    bots.findServerBot.mockResolvedValue({ botId: EXEC, serverId: SRV, grantedScopes: ['commands'] });
    const res = await install({ serverId: SRV, acceptedPermissions: ['commands', 'messages:reply'] });
    expect(res.status).toBe(200);
    expect(bots.addToServer).not.toHaveBeenCalled();
    expect(bots.updateServerGrant).toHaveBeenCalledWith(EXEC, SRV, ['commands', 'messages:reply']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('DELETE /:botId/install/:serverId', () => {
  const uninstall = (serverId = SRV) =>
    request(app).delete(`/api/bots/marketplace/${LISTING}/install/${serverId}`);

  it('yetkisiz kaldırma 403 verir', async () => {
    resolvePerms.mockResolvedValue(0);
    const res = await uninstall();
    expect(res.status).toBe(403);
    expect(bots.removeFromServer).not.toHaveBeenCalled();
  });

  it('üye olmayan kaldıramaz', async () => {
    members.findOne.mockResolvedValue(null);
    expect((await uninstall()).status).toBe(403);
  });

  it('kurulabilir eşlemesi olmayan liste için 404 verir', async () => {
    marketplaceRepo.findById.mockResolvedValue(listing({ approved: false }));
    const res = await uninstall();
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Marketplace bot not installed');
  });

  it('SUNUCUNUN KENDİ botu marketplace kaldırmasıyla SİLİNEMEZ', async () => {
    bots.findById.mockResolvedValue({ serverId: SRV });

    const res = await uninstall();

    expect(res.status).toBe(409);
    expect(bots.removeFromServer).not.toHaveBeenCalled();
  });

  it('silinmiş çalıştırılabilir bot kaldırmayı engellemez', async () => {
    bots.findById.mockResolvedValue(null);

    const res = await uninstall();

    expect(res.status).toBe(200);
    expect(bots.removeFromServer).toHaveBeenCalledWith(EXEC, SRV);
  });

  it('kaldırma yapılır ve sayaç EŞİTLENİR', async () => {
    const res = await uninstall();

    expect(res.body).toEqual({ ok: true, installed: false });
    expect(bots.removeFromServer).toHaveBeenCalledWith(EXEC, SRV);
    expect(marketplaceRepo.syncInstallCount).toHaveBeenCalledWith(EXEC);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /:botId — çalıştırılabilir eşleme doğrulaması', () => {
  const patch = (body: unknown) =>
    request(app).patch(`/api/bots/marketplace/${LISTING}`).send(body as object);

  beforeEach(() => {
    marketplaceRepo.update.mockResolvedValue(listing({ approved: true }));
    marketplaceRepo.addReview.mockResolvedValue(undefined);
  });

  it('bilinmeyen bot 404 verir', async () => {
    marketplaceRepo.findById.mockResolvedValue(null);
    expect((await patch({ name: 'x' })).status).toBe(404);
  });

  it('metin/null olmayan eşleme 400 verir', async () => {
    const res = await patch({ executableBotId: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('executableBotId must be a string or null');
    expect(marketplaceRepo.update).not.toHaveBeenCalled();
  });

  it.each([
    ['pasif bot', { active: false, isPublic: true }],
    ['özel bot', { active: true, isPublic: false }],
    ['silinmiş bot', null],
  ])('%s eşlemesi 400 verir', async (_label, row) => {
    bots.findById.mockResolvedValue(row);
    const res = await patch({ executableBotId: EXEC });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Executable bot must be active and public');
  });

  it('BOŞLUKTAN ibaret eşleme NULL olarak yazılır ve bot doğrulanmaz', async () => {
    const res = await patch({ executableBotId: '   ' });

    expect(res.status).toBe(200);
    expect(bots.findById).not.toHaveBeenCalled();
    expect(marketplaceRepo.update).toHaveBeenCalledWith(LISTING, { executableBotId: null });
  });

  it('null eşleme kabul edilir', async () => {
    await patch({ executableBotId: null });
    expect(marketplaceRepo.update).toHaveBeenCalledWith(LISTING, { executableBotId: null });
  });

  it('geçerli eşleme KIRPILARAK yazılır', async () => {
    const res = await patch({ executableBotId: `  ${EXEC}  ` });

    expect(res.status).toBe(200);
    expect(marketplaceRepo.update).toHaveBeenCalledWith(LISTING, { executableBotId: EXEC });
  });

  it('güncellenecek alan yoksa 400 verir', async () => {
    marketplaceRepo.update.mockResolvedValue(null);
    expect((await patch({ name: 'x' })).status).toBe(400);
    expect(marketplaceRepo.addReview).not.toHaveBeenCalled();
  });

  it.each([
    [true, 'approve'],
    [false, 'reject'],
  ])('onay kararı %s inceleme kaydı yazar', async (approved, action) => {
    await patch({ approved, note: 'gerekçe' });

    expect(marketplaceRepo.addReview).toHaveBeenCalledWith(expect.objectContaining({
      botId: LISTING, reviewerId: 'user-1', action, note: 'gerekçe',
    }));
  });

  it('metin olmayan not BOŞ dizeye indirgenir', async () => {
    await patch({ approved: true, note: { a: 1 } });
    expect(marketplaceRepo.addReview).toHaveBeenCalledWith(expect.objectContaining({ note: '' }));
  });

  it('onaylanan liste `installable` olarak sunulur', async () => {
    marketplaceRepo.update.mockResolvedValue(listing({ approved: true, executableBotId: EXEC }));
    const res = await patch({ approved: true });
    expect(res.body.installable).toBe(true);
  });

  it('eşlemesi olmayan onaylı liste `installable` DEĞİLDİR', async () => {
    marketplaceRepo.update.mockResolvedValue(listing({ approved: true, executableBotId: '' }));
    const res = await patch({ approved: true });
    expect(res.body.installable).toBe(false);
  });
});
