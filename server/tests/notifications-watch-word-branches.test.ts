// server/tests/notifications-watch-word-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// TAKİP KELİMESİ (WATCH WORD) DİKKAT AKIŞI
// ════════════════════════════════════════════════════════════════════════════
//
// Takip kelimesi, `@mention` olmadan da bildirim üreten İKİNCİ bir dikkat
// kaynağıdır. Ölçülmemiş dallar bu kaynağın sınırlarıydı ve her biri ya
import { ServerDouble, findEmitted, requireEmitted } from './helpers/socketDoubles';
// gizlilik ya erişilebilirlik sorunudur:
//
//   · ESKİ ÜYE — sunucudan ayrılmış bir kullanıcının tercih satırı kalmış
//     olabilir. Teslimat anında ÜYELİK yeniden doğrulanmazsa, o kişi artık
//     göremediği bir kanalın mesaj ÖNİZLEMESİNİ almaya devam eder.
//   · KENDİ MESAJIN — yazarın kendi kelimesi kendisine bildirim üretmemelidir.
//   · TERCİH DEPOSU — okunamıyorsa "hepsi" varsayılmaz (fail-closed); ama
//     takip kelimesi deposu okunamıyorsa AÇIK mention'lar çalışmaya devam eder.
//   · "YALNIZ MENTION" — takip kelimesi bu düzeyde de geçerlidir (kullanıcının
//     açık tercihidir), ama SUSTURMA her zaman kazanır.
//   · PUSH BAŞLIĞI — takip kelimesiyle gelen bildirim "seni mention etti"
//     diye sunulmamalıdır; kullanıcı neden bildirim aldığını görmelidir.

process.env.NODE_ENV = 'test';

const repos = {
  Users: { findByUsernames: jest.fn(), findByIds: jest.fn() },
  Channels: { findById: jest.fn() },
  Members: { findByServer: jest.fn() },
  Notifications: {
    findMatchingWatchWords: jest.fn(),
    prefsFind: jest.fn(),
    insertChannelAttention: jest.fn(),
    unreadIncrementAtomic: jest.fn(),
    unreadFindOne: jest.fn(),
    unreadUpdate: jest.fn(),
    unreadInsert: jest.fn(),
  },
};
const sendPushToUser = jest.fn();
const canViewChannel = jest.fn();

jest.mock('../db/repositories', () => repos);
jest.mock('../lib/pushSender', () => ({ sendPushToUser: (...args: unknown[]) => sendPushToUser(...args) }));
jest.mock('../lib/permissions', () => {
  const actual = jest.requireActual('../lib/permissions');
  return { ...actual, canViewChannel: (...args: unknown[]) => canViewChannel(...args) };
});
jest.mock('../lib/redisAdapter', () => ({
  cache: { get: jest.fn(async () => null), set: jest.fn(async () => undefined), del: jest.fn(async () => undefined) },
}));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { id: 'u1' }; next(); },
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  __PUSH_DEBOUNCE_MS,
  __pendingPushForTest,
  deliverPushBatched,
  processNotifications,
} from '../lib/notifications';

const SRV = 'srv-1';
const CH = 'ch-1';
const AUTHOR = 'author-1';
const WATCHER = 'watcher-1';

type Emission = { room: string; event: string; payload: unknown };
const emissions: Emission[] = [];
const io = {
  to(room: string) {
    return { emit(event: string, payload: unknown) { emissions.push({ room, event, payload }); } };
  },
} satisfies ServerDouble;

const message = (over: Record<string, unknown> = {}) => ({
  _id: 'm-1', channelId: CH, serverId: SRV, userId: AUTHOR,
  displayName: 'Yazar', username: 'yazar', content: 'sürüm yayına çıkıyor',
  createdAt: 1_700_000, ...over,
});

const run = (over: Record<string, unknown> = {}, excluded = new Set<string>()) =>
  processNotifications(message(over), io, new Map<string, { id: string }>(), excluded);

beforeEach(() => {
  jest.clearAllMocks();
  emissions.length = 0;
  __pendingPushForTest.clear();
  repos.Channels.findById.mockResolvedValue({ _id: CH, serverId: SRV, name: 'genel' });
  repos.Members.findByServer.mockResolvedValue([{ userId: AUTHOR }, { userId: WATCHER }]);
  repos.Notifications.findMatchingWatchWords.mockResolvedValue([]);
  repos.Notifications.prefsFind.mockResolvedValue([]);
  repos.Notifications.insertChannelAttention.mockResolvedValue({ _id: 'n-1' });
  repos.Notifications.unreadIncrementAtomic.mockResolvedValue(true);
  repos.Users.findByUsernames.mockResolvedValue([]);
  repos.Users.findByIds.mockResolvedValue([{ _id: WATCHER, username: 'izleyen' }]);
  canViewChannel.mockResolvedValue(true);
  sendPushToUser.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const pending of __pendingPushForTest.values()) {
    if (pending.timer) clearTimeout(pending.timer);
  }
  __pendingPushForTest.clear();
});

// ════════════════════════════════════════════════════════════════════════════
describe('takip kelimesi eşleşmesi', () => {
  it('eşleşen kelime MENTION olmadan da dikkat kaydı üretir', async () => {
    repos.Notifications.findMatchingWatchWords.mockResolvedValue([{ userId: WATCHER, keyword: 'sürüm' }]);

    await run();

    expect(repos.Notifications.insertChannelAttention).toHaveBeenCalledWith(expect.objectContaining({
      userId: WATCHER, type: 'watch', serverId: SRV, channelId: CH, messageId: 'm-1', actorId: AUTHOR,
    }));
    const realtime = requireEmitted(emissions, 'notification:mention');
    expect(realtime?.payload).toMatchObject({ reason: 'watch-word', matchedKeyword: 'sürüm' });
    expect(emissions.some(e => e.event === 'inbox:changed')).toBe(true);
  });

  it('AÇIK mention takip kelimesine göre önceliklidir', async () => {
    repos.Notifications.findMatchingWatchWords.mockResolvedValue([{ userId: WATCHER, keyword: 'sürüm' }]);

    await run({ content: `sürüm <@${WATCHER}>` });

    expect(repos.Notifications.insertChannelAttention).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mention' }),
    );
    expect(findEmitted(emissions, 'notification:mention')?.payload)
      .toMatchObject({ reason: 'mention' });
  });

  it.each([
    ['kullanıcı kimliği yoksa', { keyword: 'sürüm' }],
    ['kelime yoksa', { userId: WATCHER }],
    ['kimlik boşsa', { userId: '', keyword: 'sürüm' }],
  ])('bozuk tercih satırı (%s) bildirim üretmez', async (_label, row) => {
    repos.Notifications.findMatchingWatchWords.mockResolvedValue([row]);

    await run();

    expect(repos.Notifications.insertChannelAttention).not.toHaveBeenCalled();
  });

  it('YAZARIN KENDİ takip kelimesi kendisine bildirim üretmez', async () => {
    repos.Notifications.findMatchingWatchWords.mockResolvedValue([{ userId: AUTHOR, keyword: 'sürüm' }]);

    await run();

    expect(repos.Notifications.insertChannelAttention).not.toHaveBeenCalled();
  });

  it('SUNUCUDAN AYRILMIŞ kullanıcının eski tercihi önizleme sızdırmaz', async () => {
    repos.Members.findByServer.mockResolvedValue([{ userId: AUTHOR }]);
    repos.Notifications.findMatchingWatchWords.mockResolvedValue([{ userId: 'eski-uye', keyword: 'sürüm' }]);

    await run();

    expect(repos.Notifications.insertChannelAttention).not.toHaveBeenCalled();
    expect(emissions).toHaveLength(0);
  });

  it('aynı kullanıcı için İLK eşleşen kelime korunur', async () => {
    repos.Notifications.findMatchingWatchWords.mockResolvedValue([
      { userId: WATCHER, keyword: 'sürüm' },
      { userId: WATCHER, keyword: 'yayına' },
    ]);

    await run();

    expect(findEmitted(emissions, 'notification:mention')?.payload)
      .toMatchObject({ matchedKeyword: 'sürüm' });
  });

  it('takip kelimesi deposu ÇÖKERSE açık mention’lar çalışmayı SÜRDÜRÜR', async () => {
    repos.Notifications.findMatchingWatchWords.mockRejectedValue(new Error('prefs store down'));

    await run({ content: `sürüm <@${WATCHER}>` });

    expect(repos.Notifications.insertChannelAttention).toHaveBeenCalledWith(
      expect.objectContaining({ userId: WATCHER, type: 'mention' }),
    );
  });

  it('takip kelimesi deposu çökerse ve mention da yoksa sessiz kalınır', async () => {
    repos.Notifications.findMatchingWatchWords.mockRejectedValue(new Error('prefs store down'));

    await run();

    expect(repos.Notifications.insertChannelAttention).not.toHaveBeenCalled();
  });

  it('kanalı GÖREMEYEN kullanıcıya takip bildirimi gitmez', async () => {
    repos.Notifications.findMatchingWatchWords.mockResolvedValue([{ userId: WATCHER, keyword: 'sürüm' }]);
    canViewChannel.mockResolvedValue(false);

    await run();

    expect(repos.Notifications.insertChannelAttention).not.toHaveBeenCalled();
  });

  it('DIŞLANAN kullanıcıya bildirim gitmez', async () => {
    repos.Notifications.findMatchingWatchWords.mockResolvedValue([{ userId: WATCHER, keyword: 'sürüm' }]);

    await run({}, new Set([WATCHER]));

    expect(repos.Notifications.insertChannelAttention).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('tercih düzeyleri', () => {
  beforeEach(() => {
    repos.Notifications.findMatchingWatchWords.mockResolvedValue([{ userId: WATCHER, keyword: 'sürüm' }]);
  });

  it('SUSTURMA takip kelimesini de bastırır', async () => {
    repos.Notifications.prefsFind.mockResolvedValue([
      { userId: WATCHER, channelId: CH, level: 'none' },
    ]);

    await run();

    expect(repos.Notifications.insertChannelAttention).not.toHaveBeenCalled();
  });

  it('SUNUCU düzeyi tercih kanal tercihi yokken uygulanır', async () => {
    repos.Notifications.prefsFind.mockResolvedValue([
      { userId: WATCHER, channelId: `server:${SRV}`, level: 'none' },
      { userId: WATCHER, channelId: 'baska-kanal', level: 'all' },
    ]);

    await run();

    expect(repos.Notifications.insertChannelAttention).not.toHaveBeenCalled();
  });

  it('KANAL tercihi sunucu tercihini geçersiz kılar', async () => {
    repos.Notifications.prefsFind.mockResolvedValue([
      { userId: WATCHER, channelId: `server:${SRV}`, level: 'none' },
      { userId: WATCHER, channelId: CH, level: 'all' },
    ]);

    await run();

    expect(repos.Notifications.insertChannelAttention).toHaveBeenCalled();
  });

  it('"yalnız mention" düzeyinde takip kelimesi YİNE teslim edilir', async () => {
    repos.Notifications.prefsFind.mockResolvedValue([
      { userId: WATCHER, channelId: CH, level: 'mentions' },
    ]);

    await run();

    expect(repos.Notifications.insertChannelAttention).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'watch' }),
    );
  });

  it('"yalnız mention" düzeyinde sıradan mesaj teslim EDİLMEZ', async () => {
    repos.Notifications.findMatchingWatchWords.mockResolvedValue([]);
    repos.Users.findByIds.mockResolvedValue([{ _id: WATCHER, username: 'izleyen' }]);
    repos.Notifications.prefsFind.mockResolvedValue([
      { userId: WATCHER, channelId: CH, level: 'mentions' },
    ]);

    await run({ content: 'sıradan mesaj' });

    expect(repos.Notifications.insertChannelAttention).not.toHaveBeenCalled();
  });

  it('tercih deposu okunamazsa teslimat BASTIRILIR (fail-closed)', async () => {
    repos.Notifications.prefsFind.mockRejectedValue(new Error('prefs down'));

    await run();

    expect(repos.Notifications.insertChannelAttention).not.toHaveBeenCalled();
    expect(emissions).toHaveLength(0);
  });

  it('aynı dikkat kaydı İKİNCİ kez eklenmezse teslimat yapılmaz', async () => {
    repos.Notifications.insertChannelAttention.mockResolvedValue(null);

    await run();

    expect(emissions).toHaveLength(0);
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it('bir alıcının teslimatı PATLARSA diğerleri etkilenmez', async () => {
    repos.Members.findByServer.mockResolvedValue([{ userId: AUTHOR }, { userId: WATCHER }, { userId: 'w2' }]);
    repos.Notifications.findMatchingWatchWords.mockResolvedValue([
      { userId: WATCHER, keyword: 'sürüm' },
      { userId: 'w2', keyword: 'yayına' },
    ]);
    repos.Notifications.insertChannelAttention
      .mockRejectedValueOnce(new Error('insert failed'))
      .mockResolvedValue({ _id: 'n-2' });

    await run();

    expect(emissions.some(e => e.room === 'user:w2')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('push başlıkları', () => {
  const flushTimer = async () => {
    jest.advanceTimersByTime(__PUSH_DEBOUNCE_MS + 10);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('TEK takip kelimesi bildirimi "mention etti" demez', async () => {
    await deliverPushBatched('u1', message(), 'watch-word');
    await flushTimer();

    expect(sendPushToUser).toHaveBeenCalledWith('u1', expect.objectContaining({
      title: 'Yazar — takip ettiğin kelime',
    }));
  });

  it('TEK mention bildirimi mention başlığı kullanır', async () => {
    await deliverPushBatched('u1', message());
    await flushTimer();

    expect(sendPushToUser).toHaveBeenCalledWith('u1', expect.objectContaining({
      title: 'Yazar seni mention etti',
      data: expect.objectContaining({ reason: 'mention' }),
    }));
  });

  it('görünen adı olmayan gönderende kullanıcı adı kullanılır', async () => {
    await deliverPushBatched('u1', message({ displayName: '' }));
    await flushTimer();

    expect(sendPushToUser).toHaveBeenCalledWith('u1', expect.objectContaining({
      title: 'yazar seni mention etti',
    }));
  });

  it('KARIŞIK nedenli toplu bildirim nötr başlık kullanır', async () => {
    await deliverPushBatched('u1', message({ _id: 'm-1' }), 'mention');
    await deliverPushBatched('u1', message({ _id: 'm-2' }), 'watch-word');
    await flushTimer();

    expect(sendPushToUser).toHaveBeenCalledWith('u1', expect.objectContaining({
      title: '2 yeni bildirim — #genel',
    }));
  });

  it('yalnız mention’lardan oluşan toplu bildirim mention başlığı kullanır', async () => {
    await deliverPushBatched('u1', message({ _id: 'm-1' }));
    await deliverPushBatched('u1', message({ _id: 'm-2' }));
    await flushTimer();

    expect(sendPushToUser).toHaveBeenCalledWith('u1', expect.objectContaining({
      title: '2 yeni mention — #genel',
    }));
  });

  it('kanal adı çözülemezse KİMLİK gösterilir', async () => {
    repos.Channels.findById.mockRejectedValue(new Error('db down'));

    await deliverPushBatched('u1', message({ _id: 'm-1' }));
    await deliverPushBatched('u1', message({ _id: 'm-2' }));
    await flushTimer();

    expect(sendPushToUser).toHaveBeenCalledWith('u1', expect.objectContaining({
      title: `2 yeni mention — ${CH}`,
    }));
  });

  it('kanal kaydı yoksa KİMLİK gösterilir', async () => {
    repos.Channels.findById.mockResolvedValue(null);

    await deliverPushBatched('u1', message({ _id: 'm-1' }));
    await deliverPushBatched('u1', message({ _id: 'm-2' }));
    await flushTimer();

    expect(sendPushToUser).toHaveBeenCalledWith('u1', expect.objectContaining({
      title: `2 yeni mention — ${CH}`,
    }));
  });

  it('tampon SABİT boyuttadır ama toplam sayı korunur', async () => {
    for (let i = 0; i < 6; i += 1) {
      await deliverPushBatched('u1', message({ _id: `m-${i}`, content: `mesaj ${i}` }));
    }
    expect(__pendingPushForTest.get(`u1:${CH}`)?.msgs).toHaveLength(3);

    await flushTimer();

    const payload = sendPushToUser.mock.calls[0]?.[1] as { title: string; body: string };
    expect(payload.title).toBe('6 yeni mention — #genel');
    expect(payload.body.split('\n')).toHaveLength(3);
    expect(payload.body).toContain('mesaj 5');
    expect(payload.body).not.toContain('mesaj 0');
  });

  it('SÜREKLİ AKAN sohbette bildirim açlığa düşmez', async () => {
    // Saf debounce olsaydı, aralar 3 saniyeden kısa olduğu sürece zamanlayıcı
    // HİÇ ateşlenmez ve kullanıcı en çok ihtiyaç duyduğu anda hiçbir push
    // ALMAZDI. Azami bekleme penceresi bu açlığı kırar.
    await deliverPushBatched('u1', message({ _id: 'm-0' }));
    for (let i = 1; i <= 8; i += 1) {
      jest.advanceTimersByTime(2_000);
      await deliverPushBatched('u1', message({ _id: `m-${i}` }));
      await Promise.resolve(); await Promise.resolve();
    }

    // Akış hâlâ sürerken (son bir sessizlik penceresi BEKLENMEDEN) teslimat
    // gerçekleşmiş olmalıdır.
    expect(sendPushToUser).toHaveBeenCalled();
    const [, payload] = sendPushToUser.mock.calls[0] as [string, { title: string }];
    expect(payload.title).toContain('yeni mention');
  });

  it('push gönderimi PATLARSA çağıran etkilenmez', async () => {
    sendPushToUser.mockRejectedValue(new Error('push down'));

    await deliverPushBatched('u1', message());

    await expect(flushTimer()).resolves.toBeUndefined();
  });
});
