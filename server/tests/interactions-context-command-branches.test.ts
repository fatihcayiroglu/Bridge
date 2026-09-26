// server/tests/interactions-context-command-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// BOT ETKİLEŞİMLERİ — BAĞLAM KOMUTLARI VE SUNUCU OTORİTESİ
// ════════════════════════════════════════════════════════════════════════════
//
// Etkileşim yükü İSTEMCİDEN gelir; kanal/sunucu kimliği ondan OKUNMAZ.
// Ölçülmemiş 30 dalın taşıdığı riskler:
import type { ServerDouble } from './helpers/socketDoubles';
//
//   · SAHTE HEDEF — istemci `channelId`/`serverId` gönderebilir; bunlar
//     yalnızca sunucudan çözülen kanonik değerlerle KARŞILAŞTIRILIR, onların
//     yerine geçmez. Uyuşmazlık isteği düşürür.
//   · YAYIN KAPSAMI — etkileşim asla küresel yayımlanmaz; yalnız kanonik
//     kanal/sunucu odasına ve botun ÖZEL odasına gider.
//   · KURULU OLMAYAN BOT — sunucuda kurulu olmayan bota etkileşim iletilmez.
//   · BOZUK ÜSTVERİ — bir botun bozuk `contextCommands` JSON'u tüm komut
//     listesini düşürmemelidir.
//   · ÜYELİK — bağlam komutları için hem çağıranın hem HEDEFİN üyeliği aranır.

process.env.NODE_ENV = 'test';

const repos = {
  Messages: { findById: jest.fn() },
  Bots: { findInstalledForServer: jest.fn() },
  Channels: { findById: jest.fn() },
  Members: { findOne: jest.fn() },
};
const resolvePerms = jest.fn();
const fetchT = jest.fn();

jest.mock('../db/repositories', () => repos);
jest.mock('../lib/fetch', () => ({ fetchT: (...args: unknown[]) => fetchT(...args) }));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (
    req: import('express').Request & { user?: unknown },
    _res: import('express').Response,
    next: import('express').NextFunction,
  ) => { req.user = { id: 'user-1', _id: 'user-1', displayName: 'Ada', username: 'ada', v: 0 }; next(); },
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: {
    write: () => (
      _req: import('express').Request,
      _res: import('express').Response,
      next: import('express').NextFunction,
    ) => next(),
  },
}));
jest.mock('../lib/permissions', () => {
  const actual = jest.requireActual('../lib/permissions');
  return { ...actual, resolvePermissions: (...args: unknown[]) => resolvePerms(...args) };
});
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import { PERMS } from '../lib/permissions';
import router from '../routes/interactions';

const emitted: Array<{ room: string; event: string; data: unknown }> = [];
const io = {
  to(room: string) {
    return { emit(event: string, data: unknown) { emitted.push({ room, event, data }); } };
  },
} satisfies ServerDouble;

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/interactions', router);

const CH = 'ch-1';
const SRV = 'srv-1';
const BOT = 'bot-1';
const ALLOWED = PERMS.VIEW_CHANNELS | PERMS.USE_BOT_COMMANDS;

const post = (body: unknown) => request(app).post('/api/interactions').send(body as object);

beforeEach(() => {
  jest.clearAllMocks();
  emitted.length = 0;
  resolvePerms.mockResolvedValue(ALLOWED);
  repos.Channels.findById.mockResolvedValue({ _id: CH, serverId: SRV });
  repos.Messages.findById.mockResolvedValue({ _id: 'msg-1', botId: BOT, channelId: CH, serverId: SRV });
  repos.Members.findOne.mockResolvedValue({ userId: 'user-1', serverId: SRV });
  repos.Bots.findInstalledForServer.mockResolvedValue([
    { _id: BOT, username: 'yardimci', contextCommands: JSON.stringify([{ name: 'ozet' }]) },
  ]);
  fetchT.mockResolvedValue({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
describe('POST / — yük doğrulama', () => {
  it.each([
    ['gövde yok', undefined, 'Invalid interaction type'],
    ['gövde dizi', [], 'Invalid interaction type'],
    ['tür bilinmiyor', { type: 'ping' }, 'Invalid interaction type'],
    ['bileşende mesaj yok', { type: 'button', customId: 'c' }, 'messageId required'],
    ['bileşende customId yok', { type: 'button', messageId: 'm' }, 'customId required'],
    ['bağlamda customId yok', { type: 'user_command', targetUserId: 'u' }, 'customId required'],
    ['mesaj komutunda hedef yok', { type: 'message_command', customId: 'c' }, 'targetMessageId required'],
    ['kullanıcı komutunda hedef yok', { type: 'user_command', customId: 'c' }, 'targetUserId required'],
  ])('%s reddedilir', async (_label, body, error) => {
    const res = await post(body ?? {});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
    expect(emitted).toHaveLength(0);
  });

  it.each([
    ['null', null],
    ['dizi', [1]],
    ['metin', 'veri'],
  ])('modal verisi %s ise reddedilir', async (_label, modalData) => {
    const res = await post({ type: 'modal_submit', messageId: 'msg-1', customId: 'c', modalData });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('modalData must be an object');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('POST / — bileşen etkileşimleri', () => {
  const button = (over: Record<string, unknown> = {}) =>
    post({ type: 'button', messageId: 'msg-1', customId: 'onayla', ...over });

  it('bilinmeyen mesaj 404 verir', async () => {
    repos.Messages.findById.mockResolvedValue(null);
    expect((await button()).status).toBe(404);
  });

  it('kanal/sunucu OTORİTESİ olmayan mesaj 409 verir', async () => {
    repos.Messages.findById.mockResolvedValue({ _id: 'msg-1', botId: BOT });
    expect((await button()).status).toBe(409);
  });

  it('İSTEMCİ iddiası kanonik değerlerle uyuşmazsa reddedilir', async () => {
    expect((await button({ channelId: 'baska-kanal' })).status).toBe(400);
    expect((await button({ serverId: 'baska-sunucu' })).status).toBe(400);
  });

  it('kanal görünürlüğü yoksa reddedilir', async () => {
    resolvePerms.mockResolvedValue(PERMS.VIEW_CHANNELS);
    expect((await button()).status).toBe(403);
  });

  it('kanal SUNUCUYA ait değilse reddedilir', async () => {
    repos.Channels.findById.mockResolvedValue({ _id: CH, serverId: 'baska' });
    expect((await button()).status).toBe(403);
  });

  it('kanal kaydı yoksa reddedilir', async () => {
    repos.Channels.findById.mockResolvedValue(null);
    expect((await button()).status).toBe(403);
  });

  it('yetki çözümü PATLARSA reddedilir (fail-closed)', async () => {
    resolvePerms.mockRejectedValue(new Error('perm store down'));
    expect((await button()).status).toBe(403);
  });

  it('bot mesajı OLMAYAN satırda etkileşim yoktur', async () => {
    repos.Messages.findById.mockResolvedValue({ _id: 'msg-1', channelId: CH, serverId: SRV });
    expect((await button()).status).toBe(400);
  });

  it('bot sunucuda KURULU değilse reddedilir', async () => {
    repos.Bots.findInstalledForServer.mockResolvedValue([{ _id: 'baska-bot' }]);
    expect((await button()).status).toBe(403);
  });

  it('meşru etkileşim yalnız KANAL ve BOT odasına yayılır', async () => {
    const res = await button({ value: 'evet' });

    expect(res.body).toEqual({ ok: true });
    expect(emitted.map(e => e.room)).toEqual([`channel:${CH}`, `bot:${BOT}`]);
    expect(emitted[0]!.data).toMatchObject({
      type: 'button', customId: 'onayla', value: 'evet',
      messageId: 'msg-1', channelId: CH, serverId: SRV, userId: 'user-1', botId: BOT,
      targetUserId: null, targetMessageId: null, modalData: null,
    });
  });

  it('webhook adresi olan bota AYRICA istek gönderilir', async () => {
    repos.Bots.findInstalledForServer.mockResolvedValue([
      { _id: BOT, webhookUrl: 'https://bot.test/hook' },
    ]);

    await button();

    expect(fetchT).toHaveBeenCalledWith('https://bot.test/hook', expect.objectContaining({ method: 'POST' }));
  });

  it('webhook PATLASA da istek başarılı sayılır', async () => {
    repos.Bots.findInstalledForServer.mockResolvedValue([
      { _id: BOT, webhookUrl: 'https://bot.test/hook' },
    ]);
    fetchT.mockRejectedValue(new Error('offline'));

    expect((await button()).status).toBe(200);
  });

  it('webhook adresi yoksa dış istek YAPILMAZ', async () => {
    await button();
    expect(fetchT).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('POST / — bağlam komutları', () => {
  const messageCommand = (over: Record<string, unknown> = {}) =>
    post({ type: 'message_command', customId: 'ozet', targetMessageId: 'msg-9', ...over });
  const userCommand = (over: Record<string, unknown> = {}) =>
    post({ type: 'user_command', customId: 'ozet', targetUserId: 'user-2', serverId: SRV, ...over });

  it('hedef mesaj yoksa 404 verir', async () => {
    repos.Messages.findById.mockResolvedValue(null);
    expect((await messageCommand()).status).toBe(404);
  });

  it('hedef mesajın kanal/sunucusu İSTEMCİ iddiasıyla uyuşmalıdır', async () => {
    repos.Messages.findById.mockResolvedValue({ _id: 'msg-9', channelId: CH, serverId: SRV });

    expect((await messageCommand({ channelId: 'baska' })).status).toBe(400);
    expect((await messageCommand({ serverId: 'baska' })).status).toBe(400);
  });

  it('hedef mesajın kanalına erişim yoksa reddedilir', async () => {
    repos.Messages.findById.mockResolvedValue({ _id: 'msg-9', channelId: CH, serverId: SRV });
    resolvePerms.mockResolvedValue(0);

    expect((await messageCommand()).status).toBe(403);
  });

  it('kanal/sunucu bilgisi eksik hedef mesaj erişim denetimini geçemez', async () => {
    repos.Messages.findById.mockResolvedValue({ _id: 'msg-9' });
    repos.Channels.findById.mockResolvedValue(null);

    expect((await messageCommand()).status).toBe(403);
  });

  it('meşru mesaj komutu kanonik hedefle yayılır', async () => {
    repos.Messages.findById.mockResolvedValue({ _id: 'msg-9', channelId: CH, serverId: SRV });

    const res = await messageCommand();

    expect(res.body).toEqual({ ok: true });
    expect(emitted[0]!.data).toMatchObject({
      type: 'message_command', messageId: 'msg-9', targetMessageId: 'msg-9', targetUserId: null,
    });
  });

  it('kullanıcı komutunda sunucu kimliği zorunludur', async () => {
    const res = await post({ type: 'user_command', customId: 'ozet', targetUserId: 'user-2' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('serverId required');
  });

  it('ÇAĞIRANIN üyeliği yoksa reddedilir', async () => {
    repos.Members.findOne.mockResolvedValue(null);
    expect((await userCommand()).status).toBe(403);
  });

  it('HEDEFİN üyeliği yoksa 404 verir', async () => {
    repos.Members.findOne
      .mockResolvedValueOnce({ userId: 'user-1' })
      .mockResolvedValue(null);

    expect((await userCommand()).status).toBe(404);
  });

  it('kanal verilmezse SUNUCU düzeyinde bot komut yetkisi aranır', async () => {
    resolvePerms.mockResolvedValue(PERMS.VIEW_CHANNELS);

    const res = await userCommand();

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('No USE_BOT_COMMANDS permission');
  });

  it('kanal verilirse O KANALIN erişimi aranır', async () => {
    const res = await userCommand({ channelId: CH });

    expect(res.status).toBe(200);
    expect(emitted[0]!.room).toBe(`channel:${CH}`);
  });

  it('kanal verilen komutta erişim yoksa reddedilir', async () => {
    resolvePerms.mockResolvedValue(PERMS.VIEW_CHANNELS);

    expect((await userCommand({ channelId: CH })).status).toBe(403);
  });

  it('kanal yoksa yayın SUNUCU odasına yapılır', async () => {
    const res = await userCommand();

    expect(res.status).toBe(200);
    expect(emitted.map(e => e.room)).toEqual([`server:${SRV}`, `bot:${BOT}`]);
    expect(emitted[0]!.data).toMatchObject({
      targetUserId: 'user-2', targetMessageId: null, channelId: null, messageId: null,
    });
  });

  it('komutu SAĞLAYAN bot yoksa 404 verir', async () => {
    repos.Bots.findInstalledForServer.mockResolvedValue([
      { _id: 'bot-2', contextCommands: JSON.stringify([{ name: 'baska' }]) },
    ]);

    expect((await userCommand()).status).toBe(404);
  });

  it('BOZUK komut üstverisi bir botu atlar, diğerini bulur', async () => {
    repos.Bots.findInstalledForServer.mockResolvedValue([
      { _id: 'bot-bozuk', contextCommands: '{bozuk' },
      { _id: 'bot-iyi', contextCommands: [{ name: 'ozet' }] },
    ]);

    const res = await userCommand();

    expect(res.status).toBe(200);
    expect(emitted.some(e => e.room === 'bot:bot-iyi')).toBe(true);
  });

  it('komut üstverisi hiç yoksa bot atlanır', async () => {
    repos.Bots.findInstalledForServer.mockResolvedValue([{ _id: 'bot-bos' }]);

    expect((await userCommand()).status).toBe(404);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('GET /context-commands', () => {
  const list = (query = `?serverId=${SRV}`) =>
    request(app).get(`/api/interactions/context-commands${query}`);

  it('sunucu kimliği yoksa 400 verir', async () => {
    expect((await list('')).status).toBe(400);
    expect(repos.Members.findOne).not.toHaveBeenCalled();
  });

  it('ÜYE olmayan komutları göremez', async () => {
    repos.Members.findOne.mockResolvedValue(null);
    expect((await list()).status).toBe(403);
  });

  it('bot komut yetkisi olmayan göremez', async () => {
    resolvePerms.mockResolvedValue(PERMS.VIEW_CHANNELS);
    expect((await list()).status).toBe(403);
  });

  it('yetki çözümü patlarsa da göremez', async () => {
    resolvePerms.mockRejectedValue(new Error('perm store down'));
    expect((await list()).status).toBe(403);
  });

  it('komutlar BOT bilgisiyle zenginleştirilir', async () => {
    const res = await list();

    expect(res.body).toEqual([{ name: 'ozet', botId: BOT, botName: 'yardimci' }]);
  });

  it('BOZUK üstveri tüm listeyi DÜŞÜRMEZ', async () => {
    repos.Bots.findInstalledForServer.mockResolvedValue([
      { _id: 'bot-bozuk', username: 'bozuk', contextCommands: '{bozuk' },
      { _id: 'bot-iyi', username: 'iyi', contextCommands: [{ name: 'ozet' }] },
    ]);

    const res = await list();

    expect(res.body).toEqual([{ name: 'ozet', botId: 'bot-iyi', botName: 'iyi' }]);
  });

  it('dizi olmayan üstveri boş sayılır ve nesne olmayan girdiler süzülür', async () => {
    repos.Bots.findInstalledForServer.mockResolvedValue([
      { _id: 'b1', username: 'a', contextCommands: '{"name":"tek"}' },
      { _id: 'b2', username: 'b', contextCommands: [null, 'metin', [], { name: 'gecerli' }] },
    ]);

    const res = await list();

    expect(res.body).toEqual([{ name: 'gecerli', botId: 'b2', botName: 'b' }]);
  });
});
