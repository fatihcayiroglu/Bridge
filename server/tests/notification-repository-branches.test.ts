// server/tests/notification-repository-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// BİLDİRİM DEPOSU — YAZMA SAHİPLİĞİ, YARIŞ VE MONOTON OKUMA İMLECİ
// ════════════════════════════════════════════════════════════════════════════
//
// Ölçülmemiş 41 dalın taşıdığı riskler:
//
//   · YARIŞ — iki düğüm aynı anda "tercih yok" görüp INSERT deneyebilir.
//     Benzersizlik ihlali kullanıcıya 500 olarak dönmemeli, UPDATE'e
//     yakınsamalıdır; ama BAŞKA hiçbir yazma hatası yutulmamalıdır.
//   · ALAN SIZINTISI — çağıranın gönderdiği rastgele alanlar satır kimliğini
//     (userId/channelId) EZEMEZ ve tabloya ait olmayan sütun uyduramaz.
//   · GERİYE GİDEN İMLEÇ — yavaş bir sekmenin yanıtı okuma imlecini GERİYE
//     taşımamalıdır; aksi hâlde okunmuş mesajlar yeniden okunmamış görünür.
//   · YİNELENEN DİKKAT KAYDI — soket/işçi yeniden denemeleri tek kanonik satır
//     üretmelidir.
//   · EKSİK DEPO — bir koleksiyon yoksa sessizce boş sonuç ÜRETİLMEZ, açık
//     hata verilir.

process.env.NODE_ENV = 'test';

type Store = Record<string, jest.Mock>;

function makeStore(): Store {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };
}

const db: Record<string, unknown> = {};
const poolOrFallback = jest.fn();

jest.mock('../db/loader', () => ({ __esModule: true, default: db }));
jest.mock('../db/repositories/postgresInvariant', () => ({
  postgresPoolOrTestFallback: (...args: unknown[]) => poolOrFallback(...args),
}));

import Notifications from '../db/repositories/NotificationRepository';

let prefs: Store;
let keywords: Store;
let inbox: Store;
let push: Store;
let native: Store;
let fcm: Store;
let unread: Store;
let readPositions: Store;
let channels: Store;

function chain(rows: unknown[]) {
  const limit = jest.fn(async () => rows);
  const sort = jest.fn(() => ({ limit }));
  return { root: { sort }, sort, limit };
}

/** NODE_ENV'i geçici olarak üretim yoluna çevirir. */
async function inProduction<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { return await fn(); }
  finally { process.env.NODE_ENV = previous; }
}

beforeEach(() => {
  jest.clearAllMocks();
  prefs = makeStore(); keywords = makeStore(); inbox = makeStore();
  push = makeStore(); native = makeStore(); fcm = makeStore();
  unread = makeStore(); readPositions = makeStore(); channels = makeStore();
  for (const key of Object.keys(db)) delete db[key];
  Object.assign(db, {
    notificationPrefs: prefs, notificationKeywords: keywords, notifications: inbox,
    pushSubscriptions: push, nativePushTokens: native, fcmTokens: fcm,
    unreadCounts: unread, channelReadPositions: readPositions, channels,
  });
  prefs.findOne.mockResolvedValue(null);
  prefs.find.mockResolvedValue([]);
  prefs.insert.mockResolvedValue({ ok: true });
  prefs.update.mockResolvedValue({ updated: 1 });
  keywords.find.mockResolvedValue([]);
  keywords.remove.mockResolvedValue({ deleted: 0 });
  keywords.insert.mockResolvedValue({});
  inbox.findOne.mockResolvedValue(null);
  inbox.insert.mockResolvedValue({});
  inbox.find.mockResolvedValue([]);
  readPositions.findOne.mockResolvedValue(null);
  readPositions.insert.mockResolvedValue({});
  readPositions.update.mockResolvedValue({ updated: 1 });
  channels.find.mockResolvedValue([]);
});

// ════════════════════════════════════════════════════════════════════════════
describe('eksik koleksiyonlar SESSİZ kalmaz', () => {
  it.each([
    ['notificationPrefs', () => Notifications.findPref('u1', 'c1')],
    ['notificationKeywords', () => Notifications.listWatchWords('u1', 's1')],
    ['notifications', () => Notifications.findInbox({})],
    ['pushSubscriptions', () => Notifications.findPushSubscriptions('u1')],
    ['nativePushTokens', () => Notifications.findNativeTokensForUser('u1')],
    ['fcmTokens', () => Notifications.findFcmTokensForUser('u1')],
  ])('%s yoksa açık hata verilir', async (store, call) => {
    delete db[store];

    await expect(call()).rejects.toThrow(`${store} store unavailable`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('upsertPref', () => {
  it('yalnız İZİN VERİLEN alanlar yazılır; kimlik alanları ezilemez', async () => {
    await Notifications.upsertPref('u1', 'c1', {
      level: 'mentions', muteUntil: 123, updatedAt: 9,
      userId: 'saldirgan', channelId: 'baska', uydurma_sutun: 'x',
    });

    expect(prefs.insert).toHaveBeenCalledWith({
      userId: 'u1', channelId: 'c1', level: 'mentions', muteUntil: 123, updatedAt: 9,
    });
  });

  it('mevcut satır GÜNCELLENİR, ikinci satır oluşturulmaz', async () => {
    prefs.findOne.mockResolvedValue({ _id: 'p1' });

    await Notifications.upsertPref('u1', 'c1', { level: 'all' });

    expect(prefs.update).toHaveBeenCalledWith({ userId: 'u1', channelId: 'c1' }, { $set: { level: 'all' } });
    expect(prefs.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['PostgreSQL kodu', Object.assign(new Error('dup'), { code: '23505' })],
    ['DUPLICATE metni', new Error('duplicate key value violates unique constraint')],
    ['UNIQUE metni', new Error('UNIQUE constraint failed: notification_prefs')],
  ])('YARIŞTA %s güncellemeye yakınsar', async (_label, error) => {
    prefs.insert.mockRejectedValue(error);

    await Notifications.upsertPref('u1', 'c1', { level: 'none' });

    expect(prefs.update).toHaveBeenCalledWith({ userId: 'u1', channelId: 'c1' }, { $set: { level: 'none' } });
  });

  it('benzersizlik dışı yazma hatası YUTULMAZ', async () => {
    prefs.insert.mockRejectedValue(Object.assign(new Error('disk full'), { code: '53100' }));

    await expect(Notifications.upsertPref('u1', 'c1', { level: 'all' })).rejects.toThrow('disk full');
    expect(prefs.update).not.toHaveBeenCalled();
  });

  it('kodsuz/mesajsız hata da yutulmaz', async () => {
    prefs.insert.mockRejectedValue({});

    await expect(Notifications.upsertPref('u1', 'c1', {})).rejects.toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('takip kelimeleri', () => {
  it('boş/eksik kayıtlar süzülür ve sonuç SIRALANIR', async () => {
    keywords.find.mockResolvedValue([
      { keyword: 'zeta' }, { keyword: '' }, {}, { keyword: 'alfa' },
    ]);

    expect(await Notifications.listWatchWords('u1', 's1')).toEqual(['alfa', 'zeta']);
  });

  it('depo NULL dönerse boş liste verilir', async () => {
    keywords.find.mockResolvedValue(null);

    expect(await Notifications.listWatchWords('u1', 's1')).toEqual([]);
  });

  it('eşleştirme boş kelime kümesinde depoya SORMAZ', async () => {
    expect(await Notifications.findMatchingWatchWords('s1', [])).toEqual([]);
    expect(keywords.find).not.toHaveBeenCalled();
  });

  it('eşleştirme NULL sonucu boş listeye indirger', async () => {
    keywords.find.mockResolvedValue(null);

    expect(await Notifications.findMatchingWatchWords('s1', ['a'])).toEqual([]);
    expect(keywords.find).toHaveBeenCalledWith({ serverId: 's1', keyword: { $in: ['a'] } });
  });

  it('test uyarlamasında küme TAMAMEN değiştirilir', async () => {
    await Notifications.replaceWatchWords('u1', 's1', ['a', 'b'], 1000);

    expect(keywords.remove).toHaveBeenCalledWith({ userId: 'u1', serverId: 's1' });
    expect(keywords.insert).toHaveBeenCalledTimes(2);
    expect(keywords.insert).toHaveBeenCalledWith({ userId: 'u1', serverId: 's1', keyword: 'a', createdAt: 1000 });
  });

  it('üretimde TEK sorguyla değiştirilir (kısmi durum bırakmaz)', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    poolOrFallback.mockReturnValue({ query });

    await inProduction(() => Notifications.replaceWatchWords('u1', 's1', ['a'], 1000));

    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]![0])).toContain('DELETE FROM notification_keywords');
    expect(query.mock.calls[0]![1]).toEqual(['u1', 's1', ['a'], 1000]);
    expect(keywords.remove).not.toHaveBeenCalled();
  });

  it('üretimde havuz sorgulayamıyorsa açık hata verilir', async () => {
    poolOrFallback.mockReturnValue(null);

    await expect(inProduction(() => Notifications.replaceWatchWords('u1', 's1', ['a'])))
      .rejects.toThrow('PostgreSQL pool cannot query for notification watch-word replace');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('push jetonları ve tercih listeleri', () => {
  it.each([
    ['web push', () => Notifications.findPushSubscriptions('u1'), () => push],
    ['yerel jeton', () => Notifications.findNativeTokensForUser('u1'), () => native],
    ['FCM jetonu', () => Notifications.findFcmTokensForUser('u1'), () => fcm],
  ])('%s deposu NULL dönerse boş liste verilir', async (_label, call, store) => {
    store().find.mockResolvedValue(null);

    expect(await call()).toEqual([]);
  });

  it('kanal listesi boşken tercih sorgusu YAPILMAZ', async () => {
    expect(await Notifications.prefsFindForUserChannels('u1', [])).toEqual([]);
    expect(prefs.find).not.toHaveBeenCalled();
  });

  it('sunucudaki kanal yoksa tercih sorgusu yapılmaz', async () => {
    channels.find.mockResolvedValue([]);
    expect(await Notifications.findPrefsForUserInServer('u1', 's1')).toEqual([]);
    expect(prefs.find).not.toHaveBeenCalled();
  });

  it('kanal deposu NULL dönerse de tercih sorgusu yapılmaz', async () => {
    channels.find.mockResolvedValue(null);
    expect(await Notifications.findPrefsForUserInServer('u1', 's1')).toEqual([]);
  });

  it('kimliksiz kanal satırları süzülür', async () => {
    channels.find.mockResolvedValue([{ _id: 'c1' }, {}, { _id: '' }]);
    prefs.find.mockResolvedValue([{ _id: 'p1' }]);

    await Notifications.findPrefsForUserInServer('u1', 's1');

    expect(prefs.find).toHaveBeenCalledWith({ userId: 'u1', channelId: { $in: ['c1'] } });
  });

  it('kullanıcı tercihleri NULL dönerse boş liste verilir', async () => {
    prefs.find.mockResolvedValue(null);
    expect(await Notifications.findPrefsForUser('u1')).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('okuma imleci MONOTONDUR', () => {
  it('kayıt yoksa oluşturulur', async () => {
    await Notifications.advanceChannelReadPosition('u1', 'c1', 500, 'm-5', 9);

    expect(readPositions.insert).toHaveBeenCalledWith({
      userId: 'u1', channelId: 'c1', lastReadAt: 500, lastReadMessageId: 'm-5', updatedAt: 9,
    });
  });

  it('daha YENİ konum ilerletilir', async () => {
    readPositions.findOne.mockResolvedValue({ lastReadAt: 100, lastReadMessageId: 'm-1' });

    await Notifications.advanceChannelReadPosition('u1', 'c1', 500, 'm-5', 9);

    expect(readPositions.update).toHaveBeenCalledWith(
      { userId: 'u1', channelId: 'c1' },
      { $set: { lastReadAt: 500, lastReadMessageId: 'm-5', updatedAt: 9 } },
    );
  });

  it('daha ESKİ konum imleci GERİYE taşımaz', async () => {
    readPositions.findOne.mockResolvedValue({ lastReadAt: 900, lastReadMessageId: 'm-9' });

    await Notifications.advanceChannelReadPosition('u1', 'c1', 500, 'm-5');

    expect(readPositions.update).not.toHaveBeenCalled();
    expect(readPositions.insert).not.toHaveBeenCalled();
  });

  it('aynı anda gelen mesajlarda KİMLİK sırası belirleyicidir', async () => {
    readPositions.findOne.mockResolvedValue({ lastReadAt: 500, lastReadMessageId: 'm-9' });

    await Notifications.advanceChannelReadPosition('u1', 'c1', 500, 'm-5');
    expect(readPositions.update).not.toHaveBeenCalled();

    await Notifications.advanceChannelReadPosition('u1', 'c1', 500, 'm-z');
    expect(readPositions.update).toHaveBeenCalled();
  });

  it('üretimde tek KOŞULLU upsert kullanılır', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    poolOrFallback.mockReturnValue({ query });

    await inProduction(() => Notifications.advanceChannelReadPosition('u1', 'c1', 500, 'm-5', 9));

    expect(String(query.mock.calls[0]![0])).toContain('ON CONFLICT');
    expect(readPositions.update).not.toHaveBeenCalled();
  });

  it('üretimde havuz sorgulayamıyorsa açık hata verilir', async () => {
    poolOrFallback.mockReturnValue({});

    await expect(inProduction(() => Notifications.advanceChannelReadPosition('u1', 'c1', 1, 'm')))
      .rejects.toThrow('PostgreSQL pool cannot query for channel read-position upsert');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('okunmamış sayacı', () => {
  it('test uyarlamasında atomik yol DEVRE DIŞIDIR', async () => {
    expect(await Notifications.unreadIncrementAtomic('u1', 'c1', 1)).toBe(false);
  });

  it('üretimde tek ifadeyle artırılır', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    poolOrFallback.mockReturnValue({ query });

    expect(await inProduction(() => Notifications.unreadIncrementAtomic('u1', 'c1', 7))).toBe(true);
    expect(String(query.mock.calls[0]![0])).toContain('unread_counts.count + 1');
  });

  it('üretimde havuz sorgulayamıyorsa açık hata verilir', async () => {
    poolOrFallback.mockReturnValue(undefined);

    await expect(inProduction(() => Notifications.unreadIncrementAtomic('u1', 'c1', 1)))
      .rejects.toThrow('PostgreSQL pool cannot query for atomic unread increment');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('gelen kutusu kayıtları YİNELENMEZ', () => {
  it('kaydedilmiş hatırlatıcı belirlenimci kimlikle bir kez yazılır', async () => {
    expect(await Notifications.insertSavedReminder('u1', 'saved-1', 5000)).toBe(true);
    expect(inbox.insert).toHaveBeenCalledWith(expect.objectContaining({
      _id: 'inbox:saved-reminder:u1:saved-1:5000', type: 'saved_reminder', read: false,
    }));
  });

  it('zaten varsa yeniden yazılmaz', async () => {
    inbox.findOne.mockResolvedValue({ _id: 'x' });

    expect(await Notifications.insertSavedReminder('u1', 'saved-1', 5000)).toBe(false);
    expect(inbox.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['PostgreSQL kodu', Object.assign(new Error('dup'), { code: '23505' })],
    ['DUPLICATE metni', new Error('duplicate key')],
  ])('YARIŞTA %s yinelenen sayılır', async (_label, error) => {
    inbox.insert.mockRejectedValue(error);

    expect(await Notifications.insertSavedReminder('u1', 'saved-1', 5000)).toBe(false);
  });

  it('başka yazma hatası yutulmaz', async () => {
    inbox.insert.mockRejectedValue(new Error('disk full'));

    await expect(Notifications.insertSavedReminder('u1', 'saved-1', 5000)).rejects.toThrow('disk full');
  });

  it('kanal dikkat kaydı belirlenimci kimlik kullanır ve zaman damgasını korur', async () => {
    expect(await Notifications.insertChannelAttention({
      userId: 'u1', type: 'watch', serverId: 's1', channelId: 'c1', messageId: 'm-1',
      actorId: 'a1', createdAt: 1234,
    })).toBe(true);

    expect(inbox.insert).toHaveBeenCalledWith(expect.objectContaining({
      _id: 'inbox:u1:m-1', type: 'watch', createdAt: 1234, read: false,
    }));
  });

  it('zaman damgası verilmezse ŞİMDİ kullanılır', async () => {
    const before = Date.now();

    await Notifications.insertChannelAttention({
      userId: 'u1', type: 'mention', serverId: 's1', channelId: 'c1', messageId: 'm-2', actorId: 'a1',
    });

    const written = inbox.insert.mock.calls[0]![0] as { createdAt: number };
    expect(written.createdAt).toBeGreaterThanOrEqual(before);
  });

  it('aynı (alıcı, mesaj) çifti ikinci kez yazılmaz', async () => {
    inbox.findOne.mockResolvedValue({ _id: 'inbox:u1:m-1' });

    expect(await Notifications.insertChannelAttention({
      userId: 'u1', type: 'mention', serverId: 's1', channelId: 'c1', messageId: 'm-1', actorId: 'a1',
    })).toBe(false);
    expect(inbox.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['PostgreSQL kodu', Object.assign(new Error('dup'), { code: '23505' })],
    ['UNIQUE metni', new Error('unique violation')],
  ])('YARIŞTA %s yinelenen sayılır', async (_label, error) => {
    inbox.insert.mockRejectedValue(error);

    expect(await Notifications.insertChannelAttention({
      userId: 'u1', type: 'reply', serverId: 's1', channelId: 'c1', messageId: 'm-3', actorId: 'a1',
    })).toBe(false);
  });

  it('başka yazma hatası mesaj akışını sessizce bozmaz, YAYILIR', async () => {
    inbox.insert.mockRejectedValue(new Error('disk full'));

    await expect(Notifications.insertChannelAttention({
      userId: 'u1', type: 'mention', serverId: 's1', channelId: 'c1', messageId: 'm-4', actorId: 'a1',
    })).rejects.toThrow('disk full');
  });

  it('gelen kutusu NULL dönerse boş liste verilir', async () => {
    inbox.find.mockResolvedValue(null);
    expect(await Notifications.findInbox({ userId: 'u1' })).toEqual([]);
  });

  it.each([
    ['sıfır', 0, 1],
    ['üst sınırın üstünde', 5_000, 200],
    ['sınır içinde', 25, 25],
  ])('okunmamış hatırlatıcı limiti %s güvenli aralığa çekilir', async (_label, requested, expected) => {
    const { root, limit } = chain([]);
    inbox.find.mockReturnValue(root);

    await Notifications.findUnreadSavedReminders('u1', requested);

    expect(limit).toHaveBeenCalledWith(expected);
  });

  it.each([
    ['sıfır', 0, 1],
    ['üst sınırın üstünde', 5_000, 200],
  ])('okunmamış dikkat kaydı limiti %s güvenli aralığa çekilir', async (_label, requested, expected) => {
    const { root, limit } = chain([]);
    inbox.find.mockReturnValue(root);

    await Notifications.findUnreadChannelAttention('u1', requested);

    expect(limit).toHaveBeenCalledWith(expected);
  });
});
