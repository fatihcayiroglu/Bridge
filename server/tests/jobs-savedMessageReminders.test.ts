// server/tests/jobs-savedMessageReminders.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// KAYDEDİLEN MESAJ HATIRLATICI İŞİ — TESLİM SIRASI VE İPTAL YARIŞI
// ════════════════════════════════════════════════════════════════════════════
//
// Hatırlatıcı işi kullanıcının AÇIKÇA istediği bir sözü yerine getirir. İki
// yanlış yön de kullanıcıya doğrudan yansır:
//
//   · KAYIP HATIRLATICI — kalıcı gelen kutusu satırı yazılamazsa iş, satırı
//     "teslim edildi" işaretlememelidir; aksi hâlde hatırlatıcı sessizce
//     kaybolur ve bir daha asla gelmez.
//   · ÇİFT/İSTENMEYEN HATIRLATICI — kullanıcı teslim sırasında hatırlatıcıyı
//     iptal ederse (ya da zamanı değiştirirse) push GÖNDERİLMEMELİDİR.
//     Sıra bu yüzden "önce gelen kutusu, sonra atomik işaretle, en son push".
//   · ÜST ÜSTE ÇALIŞMA — 30 saniyelik zamanlayıcı, bir tur hâlâ sürerken
//     yeniden tetiklenebilir; ikinci tur aynı satırları İKİNCİ kez
//     işlememelidir.
//   · BOZUK SATIR — kimliksiz/kullanıcısız/geçersiz zamanlı satır turu
//     düşürmemeli, yalnızca atlanmalıdır.

process.env.NODE_ENV = 'test';

const savedMessages = { findDueReminders: jest.fn(), markReminded: jest.fn() };
const notifications = { insertSavedReminder: jest.fn() };
const sendPushToUser = jest.fn();
const warn = jest.fn();
const error = jest.fn();

jest.mock('../db/repositories', () => ({ SavedMessages: savedMessages, Notifications: notifications }));
jest.mock('../lib/pushSender', () => ({ sendPushToUser: (...a: unknown[]) => sendPushToUser(...a) }));
jest.mock('../lib/logger', () => {
  const logger = { info: jest.fn(), debug: jest.fn(), fatal: jest.fn(), warn, error, child: () => logger };
  return { __esModule: true, default: logger, logger, createLogger: () => logger };
});

import {
  runSavedMessageReminderTick,
  startSavedMessageReminderJob,
  stopSavedMessageReminderJob,
} from '../jobs/savedMessageReminders';

const NOW = 1_800_000_000_000;

function due(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { _id: 'saved-1', userId: 'u-1', remindAt: NOW - 1_000, ...over };
}

beforeEach(() => {
  jest.clearAllMocks();
  savedMessages.findDueReminders.mockResolvedValue([]);
  savedMessages.markReminded.mockResolvedValue({ updated: 1 });
  notifications.insertSavedReminder.mockResolvedValue(undefined);
  sendPushToUser.mockResolvedValue(undefined);
});

afterEach(() => { stopSavedMessageReminderJob(); jest.useRealTimers(); });

describe('teslim sırası', () => {
  it('kalıcı gelen kutusu satırı önce yazılır, sonra atomik işaretlenir, en son push gider', async () => {
    savedMessages.findDueReminders.mockResolvedValue([due()]);
    const order: string[] = [];
    notifications.insertSavedReminder.mockImplementation(async () => { order.push('inbox'); });
    savedMessages.markReminded.mockImplementation(async () => { order.push('mark'); return { updated: 1 }; });
    sendPushToUser.mockImplementation(async () => { order.push('push'); });

    await runSavedMessageReminderTick(NOW);

    expect(order).toEqual(['inbox', 'mark', 'push']);
    expect(notifications.insertSavedReminder).toHaveBeenCalledWith('u-1', 'saved-1', NOW - 1_000);
    expect(savedMessages.markReminded).toHaveBeenCalledWith('saved-1', NOW - 1_000, NOW);
    expect(sendPushToUser).toHaveBeenCalledWith('u-1', expect.objectContaining({
      data: { type: 'saved:reminder', savedId: 'saved-1', url: '/app?saved=1' },
    }));
  });

  it('varsayılan zaman parametresi şimdiki zamandır', async () => {
    savedMessages.findDueReminders.mockResolvedValue([]);

    await runSavedMessageReminderTick();

    const [, limit] = savedMessages.findDueReminders.mock.calls[0]!;
    expect(limit).toBe(100);
    expect(typeof savedMessages.findDueReminders.mock.calls[0]![0]).toBe('number');
  });

  it('gelen kutusu satırı yazılamazsa satır "teslim edildi" işaretlenmez', async () => {
    savedMessages.findDueReminders.mockResolvedValue([due()]);
    notifications.insertSavedReminder.mockRejectedValue(new Error('inbox store offline'));

    await runSavedMessageReminderTick(NOW);

    expect(savedMessages.markReminded).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-1', savedId: 'saved-1' }),
      'Saved reminder inbox row could not be created',
    );
  });

  it('teslim sırasında iptal edilen hatırlatıcı için push gönderilmez', async () => {
    savedMessages.findDueReminders.mockResolvedValue([due()]);
    savedMessages.markReminded.mockResolvedValue({ updated: 0 });

    await runSavedMessageReminderTick(NOW);

    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it('işaretleme sonucu hiç dönmezse de push gönderilmez', async () => {
    savedMessages.findDueReminders.mockResolvedValue([due()]);
    savedMessages.markReminded.mockResolvedValue(null);

    await runSavedMessageReminderTick(NOW);

    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it('push başarısızlığı turu düşürmez; gelen kutusu satırı kalır', async () => {
    savedMessages.findDueReminders.mockResolvedValue([due(), due({ _id: 'saved-2' })]);
    sendPushToUser.mockRejectedValue(new Error('push endpoint gone'));

    await expect(runSavedMessageReminderTick(NOW)).resolves.toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));

    expect(notifications.insertSavedReminder).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ savedId: 'saved-1' }), 'Saved reminder push failed');
  });
});

describe('bozuk satırlar ve arıza', () => {
  it('kimliksiz, kullanıcısız ve geçersiz zamanlı satırlar atlanır', async () => {
    savedMessages.findDueReminders.mockResolvedValue([
      due({ _id: undefined }),
      due({ _id: '' }),
      due({ userId: undefined }),
      due({ remindAt: undefined }),
      due({ remindAt: 0 }),
      due({ remindAt: -5 }),
      due({ remindAt: 1.5 }),
      due({ remindAt: 'yarın' }),
      due({ _id: 'saved-gecerli' }),
    ]);

    await runSavedMessageReminderTick(NOW);

    expect(notifications.insertSavedReminder).toHaveBeenCalledTimes(1);
    expect(notifications.insertSavedReminder).toHaveBeenCalledWith('u-1', 'saved-gecerli', NOW - 1_000);
  });

  it('sorgu çökerse tur sessizce kapanır ve bir sonraki tur çalışabilir', async () => {
    savedMessages.findDueReminders.mockRejectedValueOnce(new Error('db offline'));

    await expect(runSavedMessageReminderTick(NOW)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), 'Saved reminder job failed');

    savedMessages.findDueReminders.mockResolvedValue([due()]);
    await runSavedMessageReminderTick(NOW);
    expect(notifications.insertSavedReminder).toHaveBeenCalledTimes(1);
  });

  it('bir tur sürerken ikinci tetikleme aynı satırları tekrar işlemez', async () => {
    let release!: () => void;
    savedMessages.findDueReminders.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve([due()]);
    }));

    const first = runSavedMessageReminderTick(NOW);
    const second = runSavedMessageReminderTick(NOW);
    await second;

    // Ikinci tur HIC sorgu yapmaz.
    expect(savedMessages.findDueReminders).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(notifications.insertSavedReminder).toHaveBeenCalledTimes(1);
  });
});

describe('zamanlayıcı yaşam döngüsü', () => {
  it('iş bir kez başlar, ikinci çağrı yeni zamanlayıcı kurmaz', async () => {
    jest.useFakeTimers();
    savedMessages.findDueReminders.mockResolvedValue([]);

    startSavedMessageReminderJob();
    startSavedMessageReminderJob();
    await Promise.resolve();

    // Baslangicta bir kez calisir.
    expect(savedMessages.findDueReminders).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(savedMessages.findDueReminders).toHaveBeenCalledTimes(2);

    // Ikinci `start` cagrisi ikinci bir zamanlayici kursaydi burada 4 olurdu.
    await jest.advanceTimersByTimeAsync(30_000);
    expect(savedMessages.findDueReminders).toHaveBeenCalledTimes(3);
  });

  it('durdurma zamanlayıcıyı kapatır ve tekrar durdurmak güvenlidir', async () => {
    jest.useFakeTimers();
    savedMessages.findDueReminders.mockResolvedValue([]);

    startSavedMessageReminderJob();
    await Promise.resolve();
    stopSavedMessageReminderJob();
    expect(() => stopSavedMessageReminderJob()).not.toThrow();

    const before = savedMessages.findDueReminders.mock.calls.length;
    await jest.advanceTimersByTimeAsync(120_000);
    expect(savedMessages.findDueReminders.mock.calls).toHaveLength(before);

    // Durdurulduktan sonra yeniden baslatilabilir.
    startSavedMessageReminderJob();
    await Promise.resolve();
    expect(savedMessages.findDueReminders.mock.calls.length).toBe(before + 1);
  });
});
