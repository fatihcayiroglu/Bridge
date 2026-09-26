// server/tests/notification-prefs-unread-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// BİLDİRİM TERCİHLERİ — OKUNMAMIŞ ÖZETİ VE TAKİP KELİMESİ YAZIMI
// ════════════════════════════════════════════════════════════════════════════
//
// Ölçülmemiş 28 dalın taşıdığı riskler:
//
//   · SIZINTI — okunmamış özeti `(userId, channelId)` sayaçlarından üretilir.
//     Kullanıcı bir kanalı GÖRME yetkisini sonradan kaybetmiş olabilir; ham
//     liste, göremediği kanalların VARLIĞINI ve mesaj HACMİNİ ele verirdi.
//     Kanal silinmişse veya sunucusu çözülemiyorsa da GÖSTERİLMEZ.
//   · SESSİZE ALMA TUTARSIZLIĞI — susturulmuş kanal bildirim/push üretmezken
//     rozet üretmeye devam ederse kullanıcı susturmayı "çalışmıyor" sanır.
//   · TERCİH YAZIMI — istemcinin gönderdiği kanal/sunucu kimliği YETKİ DEĞİLDİR;
//     kanonik kiracı önce çözülür, sonra GÜNCEL görünürlük istenir.
//   · DEPO ARIZASI — tercih durumu politikadır; hata durumunda uydurma
//     varsayılan döndürmek kullanıcının ayarlarını bildiğini YANLIŞ iddia eder.

process.env.NODE_ENV = 'test';

const repos = {
  Notifications: {
    findPrefsForUserInServer: jest.fn(),
    findPrefsForUser: jest.fn(),
    findServerPref: jest.fn(),
    listWatchWords: jest.fn(),
    replaceWatchWords: jest.fn(),
    unreadFind: jest.fn(),
    upsertPref: jest.fn(),
    deletePref: jest.fn(),
  },
  Channels: { findById: jest.fn(), findWhere: jest.fn() },
  Members: { findOne: jest.fn() },
};
const resolvePerms = jest.fn();
const canViewChannel = jest.fn();

jest.mock('../db/repositories', () => repos);
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', _id: 'u1', username: 'alice' };
    next();
  },
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: {
    messages: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    general: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  },
}));
jest.mock('../lib/permissions', () => {
  const actual = jest.requireActual('../lib/permissions');
  return {
    ...actual,
    resolvePermissions: (...args: unknown[]) => resolvePerms(...args),
    canViewChannel: (...args: unknown[]) => canViewChannel(...args),
  };
});

import express from 'express';
import request from 'supertest';
import { PERMS } from '../lib/permissions';
import router from '../routes/notificationPrefs';

const app = express();
app.use(express.json());
app.use('/api/notification-prefs', router);

const SRV = 'srv-1';
const CH = 'ch-1';

beforeEach(() => {
  jest.clearAllMocks();
  repos.Members.findOne.mockResolvedValue({ userId: 'u1', serverId: SRV });
  repos.Notifications.findPrefsForUserInServer.mockResolvedValue([]);
  repos.Notifications.findPrefsForUser.mockResolvedValue([]);
  repos.Notifications.findServerPref.mockResolvedValue(null);
  repos.Notifications.listWatchWords.mockResolvedValue([]);
  repos.Notifications.replaceWatchWords.mockResolvedValue(undefined);
  repos.Notifications.unreadFind.mockResolvedValue([]);
  repos.Notifications.upsertPref.mockResolvedValue({});
  repos.Notifications.deletePref.mockResolvedValue({});
  repos.Channels.findById.mockResolvedValue({ _id: CH, serverId: SRV });
  repos.Channels.findWhere.mockResolvedValue([{ _id: CH, serverId: SRV }]);
  resolvePerms.mockResolvedValue(PERMS.VIEW_CHANNELS);
  canViewChannel.mockResolvedValue(true);
});

// ════════════════════════════════════════════════════════════════════════════
describe('GET / — sunucu tercihleri', () => {
  const get = (query = `?serverId=${SRV}`) =>
    request(app).get(`/api/notification-prefs${query}`);

  it('serverId olmadan 400 verir', async () => {
    expect((await get('')).status).toBe(400);
  });

  it('ÜYE olmayan tercih okuyamaz', async () => {
    repos.Members.findOne.mockResolvedValue(null);
    expect((await get()).status).toBe(403);
  });

  it('sunucuya özgü sorgu yoksa GENEL tercih listesine düşülür', async () => {
    repos.Notifications.findPrefsForUserInServer.mockResolvedValue(null);
    repos.Notifications.findPrefsForUser.mockResolvedValue([{ channelId: CH, level: 'mute' }]);

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual([{ channelId: CH, level: 'mute' }]);
  });

  it('iki sorgu da sonuç vermezse boş liste döner', async () => {
    repos.Notifications.findPrefsForUserInServer.mockResolvedValue(null);
    repos.Notifications.findPrefsForUser.mockResolvedValue(null);

    const res = await get();

    expect(res.body.channels).toEqual([]);
    expect(res.body.serverLevel).toBe('default');
    expect(res.body.serverMuteUntil).toBeNull();
  });

  it('sunucu düzeyi tercih ve susturma bitişi sunulur', async () => {
    repos.Notifications.findServerPref.mockResolvedValue({ level: 'mute', muteUntil: 5000 });
    repos.Notifications.listWatchWords.mockResolvedValue(['sürüm']);

    const res = await get();

    expect(res.body).toMatchObject({ serverLevel: 'mute', serverMuteUntil: 5000, watchWords: ['sürüm'] });
  });

  it('depo çökerse UYDURMA varsayılan değil 503 döner', async () => {
    repos.Notifications.listWatchWords.mockRejectedValue(new Error('db down'));

    const res = await get();

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Notification preferences unavailable' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('GET /unread — görünürlük ve susturma', () => {
  const unread = () => request(app).get('/api/notification-prefs/unread');

  it('sayaç yoksa boş özet döner ve kanal sorgusu YAPILMAZ', async () => {
    const res = await unread();

    expect(res.body).toEqual({ channels: [], total: 0 });
    expect(repos.Channels.findWhere).not.toHaveBeenCalled();
  });

  it('depo NULL dönerse boş özet döner', async () => {
    repos.Notifications.unreadFind.mockResolvedValue(null);

    expect((await unread()).body).toEqual({ channels: [], total: 0 });
  });

  it('SIFIR sayaçlı satırlar özete girmez', async () => {
    repos.Notifications.unreadFind.mockResolvedValue([
      { channelId: CH, count: 0 }, { channelId: 'ch-2', count: -1 },
    ]);

    expect((await unread()).body).toEqual({ channels: [], total: 0 });
  });

  it('görünür kanalın sayacı toplanır', async () => {
    repos.Notifications.unreadFind.mockResolvedValue([{ channelId: CH, count: 3 }]);

    const res = await unread();

    expect(res.body).toEqual({ channels: [{ channelId: CH, count: 3 }], total: 3 });
  });

  it('bozuk sayaç değeri SIFIRA indirilir', async () => {
    repos.Notifications.unreadFind.mockResolvedValue([{ channelId: CH, count: '3' }]);

    const res = await unread();

    expect(res.body.channels[0]).toEqual({ channelId: CH, count: 3 });
  });

  it('KİMLİKSİZ sayaç satırı kanal sorgusuna girmez', async () => {
    repos.Notifications.unreadFind.mockResolvedValue([{ count: 3 }, { channelId: '', count: 2 }]);

    const res = await unread();

    expect(repos.Channels.findWhere).not.toHaveBeenCalled();
    expect(res.body).toEqual({ channels: [], total: 0 });
  });

  it('SİLİNMİŞ kanal (eşleme yok) özette görünmez', async () => {
    repos.Notifications.unreadFind.mockResolvedValue([{ channelId: 'ch-silinmis', count: 5 }]);
    repos.Channels.findWhere.mockResolvedValue([]);

    expect((await unread()).body).toEqual({ channels: [], total: 0 });
  });

  it('sunucusu çözülemeyen kanal özette görünmez', async () => {
    repos.Notifications.unreadFind.mockResolvedValue([{ channelId: CH, count: 5 }]);
    repos.Channels.findWhere.mockResolvedValue([{ _id: CH }]);

    expect((await unread()).body).toEqual({ channels: [], total: 0 });
  });

  it('kimliksiz kanal satırı eşlemeyi bozmaz', async () => {
    repos.Notifications.unreadFind.mockResolvedValue([{ channelId: CH, count: 5 }]);
    repos.Channels.findWhere.mockResolvedValue([{ serverId: SRV }, { _id: CH, serverId: SRV }]);

    expect((await unread()).body.channels).toEqual([{ channelId: CH, count: 5 }]);
  });

  it('GÖRME yetkisi kaybedilmiş kanal özette görünmez', async () => {
    repos.Notifications.unreadFind.mockResolvedValue([{ channelId: CH, count: 5 }]);
    resolvePerms.mockResolvedValue(0);

    expect((await unread()).body).toEqual({ channels: [], total: 0 });
  });

  it('yetki çözümü PATLARSA kanal özette görünmez (fail-closed)', async () => {
    repos.Notifications.unreadFind.mockResolvedValue([{ channelId: CH, count: 5 }]);
    resolvePerms.mockRejectedValue(new Error('perm store down'));

    expect((await unread()).body).toEqual({ channels: [], total: 0 });
  });

  it('SUSTURULMUŞ kanal rozet üretmez', async () => {
    repos.Notifications.unreadFind.mockResolvedValue([{ channelId: CH, count: 5 }]);
    repos.Notifications.findPrefsForUser.mockResolvedValue([{ channelId: CH, level: 'mute', muteUntil: null }]);

    expect((await unread()).body).toEqual({ channels: [], total: 0 });
  });

  it('SUNUCU düzeyinde susturma da rozet üretmez', async () => {
    repos.Notifications.unreadFind.mockResolvedValue([{ channelId: CH, count: 5 }]);
    repos.Notifications.findPrefsForUser.mockResolvedValue([
      { channelId: `server:${SRV}`, level: 'mute', muteUntil: null },
    ]);

    expect((await unread()).body).toEqual({ channels: [], total: 0 });
  });

  it('SÜRESİ GEÇMİŞ susturma rozeti engellemez', async () => {
    repos.Notifications.unreadFind.mockResolvedValue([{ channelId: CH, count: 5 }]);
    repos.Notifications.findPrefsForUser.mockResolvedValue([
      { channelId: CH, level: 'mute', muteUntil: Date.now() - 1000 },
    ]);

    expect((await unread()).body.channels).toEqual([{ channelId: CH, count: 5 }]);
  });

  it('kimliksiz tercih satırı eşlemeye girmez', async () => {
    repos.Notifications.unreadFind.mockResolvedValue([{ channelId: CH, count: 5 }]);
    repos.Notifications.findPrefsForUser.mockResolvedValue([{ level: 'mute' }, {}]);

    expect((await unread()).body.channels).toEqual([{ channelId: CH, count: 5 }]);
  });

  it('tercih deposu NULL dönerse rozet yine hesaplanır', async () => {
    repos.Notifications.unreadFind.mockResolvedValue([{ channelId: CH, count: 5 }]);
    repos.Notifications.findPrefsForUser.mockResolvedValue(null);

    expect((await unread()).body.channels).toEqual([{ channelId: CH, count: 5 }]);
  });

  it('hata durumunda sayaç SIZDIRILMAZ', async () => {
    repos.Notifications.unreadFind.mockRejectedValue(new Error('db down'));

    expect((await unread()).body).toEqual({ channels: [], total: 0 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PUT /keywords', () => {
  const put = (body: unknown) =>
    request(app).put('/api/notification-prefs/keywords').send(body as object);

  it.each([
    ['serverId yok', {}],
    ['serverId boş', { serverId: '   ' }],
    ['serverId metin değil', { serverId: 42 }],
  ])('%s ise 400 verir', async (_label, body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('serverId required');
    expect(repos.Members.findOne).not.toHaveBeenCalled();
  });

  it('geçersiz kelime kümesi açıkça reddedilir', async () => {
    const res = await put({ serverId: SRV, keywords: ['a'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('at most 10 literal words');
    expect(repos.Notifications.replaceWatchWords).not.toHaveBeenCalled();
  });

  it('ÜYE olmayan kelime yazamaz', async () => {
    repos.Members.findOne.mockResolvedValue(null);

    const res = await put({ serverId: SRV, keywords: ['sürüm'] });

    expect(res.status).toBe(403);
    expect(repos.Notifications.replaceWatchWords).not.toHaveBeenCalled();
  });

  it('geçerli küme yazılır ve NORMALLEŞTİRİLMİŞ hâli döner', async () => {
    const res = await put({ serverId: SRV, keywords: ['Sürüm', 'sürüm', 'yayın'] });

    expect(res.status).toBe(200);
    expect(repos.Notifications.replaceWatchWords).toHaveBeenCalledWith('u1', SRV, res.body.watchWords);
    expect(res.body.watchWords).toEqual(expect.arrayContaining(['sürüm']));
  });

  it('yazma çökerse 503 döner', async () => {
    repos.Notifications.replaceWatchWords.mockRejectedValue(new Error('db down'));

    const res = await put({ serverId: SRV, keywords: ['sürüm'] });

    expect(res.status).toBe(503);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PUT / ve PUT /server — tercih yazımı', () => {
  const putChannel = (body: unknown) => request(app).put('/api/notification-prefs').send(body as object);
  const putServer = (body: unknown) => request(app).put('/api/notification-prefs/server').send(body as object);

  it.each([
    ['channelId yok', {}, 'channelId required'],
    ['düzey geçersiz', { channelId: CH, level: 'bazen' }, 'Invalid level. Must be: all | mentions | mute | default'],
    ['muteUntil kesirli', { channelId: CH, level: 'mute', muteUntil: 1.5 }, 'muteUntil must be a non-negative safe integer timestamp or null'],
    ['muteUntil negatif', { channelId: CH, level: 'mute', muteUntil: -1 }, 'muteUntil must be a non-negative safe integer timestamp or null'],
  ])('kanal tercihi %s ise reddedilir', async (_label, body, error) => {
    const res = await putChannel(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
    expect(repos.Notifications.upsertPref).not.toHaveBeenCalled();
  });

  it('bilinmeyen kanal 404 verir', async () => {
    repos.Channels.findById.mockResolvedValue(null);
    expect((await putChannel({ channelId: CH, level: 'all' })).status).toBe(404);
  });

  it('kanal okunamıyorsa 404 verir', async () => {
    repos.Channels.findById.mockRejectedValue(new Error('db down'));
    expect((await putChannel({ channelId: CH, level: 'all' })).status).toBe(404);
  });

  it('sunucusu çözülemeyen kanal 403 verir', async () => {
    repos.Channels.findById.mockResolvedValue({ _id: CH });
    const res = await putChannel({ channelId: CH, level: 'all' });

    expect(res.status).toBe(403);
    expect(canViewChannel).not.toHaveBeenCalled();
  });

  it('GÖRÜNÜRLÜĞÜ olmayan kanala tercih yazılamaz', async () => {
    canViewChannel.mockResolvedValue(false);
    expect((await putChannel({ channelId: CH, level: 'all' })).status).toBe(403);
  });

  it('susturma dışındaki düzeylerde muteUntil TEMİZLENİR', async () => {
    const res = await putChannel({ channelId: CH, level: 'mentions', muteUntil: 5000 });

    expect(res.status).toBe(200);
    expect(repos.Notifications.upsertPref).toHaveBeenCalledWith('u1', CH,
      expect.objectContaining({ level: 'mentions', muteUntil: null }));
  });

  it('susturmada verilmeyen bitiş SÜRESİZ (null) olur', async () => {
    await putChannel({ channelId: CH, level: 'mute' });

    expect(repos.Notifications.upsertPref).toHaveBeenCalledWith('u1', CH,
      expect.objectContaining({ level: 'mute', muteUntil: null }));
  });

  it('susturmada verilen bitiş korunur', async () => {
    const res = await putChannel({ channelId: CH, level: 'mute', muteUntil: 5000 });

    expect(res.body.muteUntil).toBe(5000);
  });

  it.each([
    ['serverId yok', {}, 'serverId required'],
    ['düzey geçersiz', { serverId: SRV, level: 'bazen' }, 'Invalid level'],
    ['muteUntil kesirli', { serverId: SRV, level: 'mute', muteUntil: 1.5 }, 'muteUntil must be a non-negative safe integer timestamp or null'],
  ])('sunucu tercihi %s ise reddedilir', async (_label, body, error) => {
    const res = await putServer(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
  });

  it('ÜYE olmayan sunucu tercihi yazamaz', async () => {
    repos.Members.findOne.mockResolvedValue(null);
    expect((await putServer({ serverId: SRV, level: 'all' })).status).toBe(403);
  });

  it('sunucu tercihi AD ALANI anahtarıyla yazılır ve fazla sütun üretmez', async () => {
    const res = await putServer({ serverId: SRV, level: 'mute', muteUntil: 7000 });

    expect(res.status).toBe(200);
    const [, key, fields] = repos.Notifications.upsertPref.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(key).toBe(`server:${SRV}`);
    expect(Object.keys(fields).sort()).toEqual(['level', 'muteUntil', 'updatedAt']);
    expect(fields.muteUntil).toBe(7000);
  });

  it('sunucu tercihinde susturma dışı düzey bitişi temizler', async () => {
    await putServer({ serverId: SRV, level: 'all', muteUntil: 7000 });

    const [, , fields] = repos.Notifications.upsertPref.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(fields.muteUntil).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('DELETE /:channelId', () => {
  it('tercih silinir', async () => {
    const res = await request(app).delete(`/api/notification-prefs/${CH}`);

    expect(res.body).toEqual({ deleted: true, channelId: CH });
    expect(repos.Notifications.deletePref).toHaveBeenCalledWith('u1', CH);
  });

  it('depo hatası BAŞARILI olarak bildirilmez', async () => {
    repos.Notifications.deletePref.mockRejectedValue(new Error('db down'));

    const res = await request(app).delete(`/api/notification-prefs/${CH}`);

    expect(res.status).toBe(503);
  });
});
