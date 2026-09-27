// server/tests/automod-alert-composition-and-logging.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// OTOMATİK MODERASYON — UYARI METNİ VE ÜRETİM GÜNLÜĞÜ
// ════════════════════════════════════════════════════════════════════════════
//
// Kardeş testler tarama yolunu `NODE_ENV=test` altında ölçer; o modda işin
// TÜM hata günlükleri susturulmuştur. Yani "arıza görünür kalır" iddiası
// hiçbir yerde ölçülmüyordu. Bu dosya işi ÜRETİM modunda çalıştırır ve iki
// şeyi ölçer:
//
//   · GÖRÜNÜRLÜK. Kalıcılık hatası, idempotency belirsizliği ve veritabanı
//     arızası üretimde YAZILIR. Tek istisna, rakip bir işçinin ürettiği
//     yinelenen anahtar (23505) hatasıdır: o zararsızdır ve gürültü yapmaz.
//   · UYARI METNİ. Moderatörün gördüğü tek şey bu metindir. Skor eşiğine göre
//     ikon, kategori listesi, kesilmiş mesaj alıntısı ve kaynak (kural/AI)
//     doğru olmalıdır; eksik alanlar `undefined` olarak sızmamalıdır.

'use strict';
process.env.NODE_ENV = 'test';

const repo = {
  Channels: { findWhere: jest.fn(), insert: jest.fn() },
  Servers: { findById: jest.fn() },
  Messages: { findWhere: jest.fn(), create: jest.fn() },
  Users: { findById: jest.fn() },
};
const dbState: { _pool?: unknown } = {};
const callAI = jest.fn();
const rulesMod = jest.fn();

jest.mock('../db/repositories', () => repo);
jest.mock('../db/loader', () => ({ __esModule: true, default: dbState }));
jest.mock('../lib/aiProvider', () => ({ AI_ENABLED: true, callAI }));
jest.mock('../lib/modRules', () => ({ rulesMod }));

import { runScan, startAutoModerationJob, stopAutoModerationJob } from '../jobs/autoModeration';

const message = (overrides: Record<string, unknown> = {}) => ({
  _id: 'm1', channelId: 'c1', serverId: 's1', userId: 'u1',
  content: 'bad', displayName: 'Display', username: 'user', type: 'normal',
  ...overrides,
});

/** Queues one flagged message and an empty idempotency lookup. */
function oneFlagged(msg = message()) {
  repo.Messages.findWhere
    .mockResolvedValueOnce([msg])
    .mockResolvedValueOnce([]);
  repo.Servers.findById.mockResolvedValue({ _id: 's1', autoModerate: true });
  repo.Users.findById.mockResolvedValue(null);
  repo.Messages.create.mockImplementation(async (d: Record<string, unknown>) => ({ ...d }));
  repo.Channels.findWhere.mockResolvedValue([]);
  repo.Channels.insert.mockResolvedValue({ _id: 'mod1', serverId: 's1', name: 'mod-log' });
  rulesMod.mockReturnValue({ safe: false, score: 75, reason: 'rules', categories: { spam: true } });
}

const alertText = () => String((repo.Messages.create.mock.calls.at(-1)![0] as { content: string }).content);

let stderr: jest.SpyInstance;
let stdout: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  delete dbState._pool;
  callAI.mockResolvedValue('{"safe":true,"score":1,"reason":"clean"}');
  stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
});

afterEach(() => {
  stopAutoModerationJob();
  process.env.NODE_ENV = 'test';
  stderr.mockRestore();
  stdout.mockRestore();
  jest.useRealTimers();
});

/** Runs `fn` with the process presenting itself as production. */
async function inProduction(fn: () => Promise<void> | void): Promise<void> {
  process.env.NODE_ENV = 'production';
  try { await fn(); } finally { process.env.NODE_ENV = 'test'; }
}

const stderrText = () => stderr.mock.calls.map(call => String(call[0])).join('');

describe('failures stay visible in production', () => {
  it('a failing recent-message query is written to stderr', async () => {
    repo.Messages.findWhere.mockRejectedValueOnce(new Error('db down'));
    await inProduction(() => runScan());
    expect(stderrText()).toMatch(/\[AutoMod\] DB hatası: db down/);
  });

  it('the same failure is silent under test, so suites stay readable', async () => {
    repo.Messages.findWhere.mockRejectedValueOnce(new Error('db down'));
    await runScan();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('an idempotency lookup failure is reported and the message is skipped', async () => {
    repo.Messages.findWhere
      .mockResolvedValueOnce([message()])
      .mockRejectedValueOnce(new Error('index unavailable'));
    repo.Servers.findById.mockResolvedValue({ _id: 's1', autoModerate: true });

    await inProduction(() => runScan());

    expect(stderrText()).toMatch(/idempotency lookup failed: index unavailable/);
    // Fail closed: no alert is created when duplication cannot be ruled out.
    expect(repo.Messages.create).not.toHaveBeenCalled();
  });

  it('a durable persistence failure is reported', async () => {
    oneFlagged();
    repo.Messages.create.mockRejectedValue(Object.assign(new Error('disk full'), { code: '53100' }));
    await inProduction(() => runScan());
    expect(stderrText()).toMatch(/alert persistence failed: disk full/);
  });

  it('a competing worker\'s duplicate key is NOT reported', async () => {
    // 23505 means another node already wrote the same alert; that is the
    // idempotency guard working, not an incident.
    oneFlagged();
    repo.Messages.create.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));
    await inProduction(() => runScan());
    expect(stderrText()).not.toMatch(/alert persistence failed/);
  });

  it('a persistence failure with no message still produces a readable line', async () => {
    oneFlagged();
    repo.Messages.create.mockRejectedValue({ code: '53100' });
    await inProduction(() => runScan());
    expect(stderrText()).toMatch(/alert persistence failed: \[object Object\]/);
  });
});

describe('the alert a moderator actually reads', () => {
  it('carries the author, a bounded quote, the score, categories and the source', async () => {
    oneFlagged(message({ content: 'x'.repeat(500) }));
    repo.Users.findById.mockResolvedValue({ _id: 'u1', displayName: 'Resolved User', username: 'resolved' });

    await runScan();

    const text = alertText();
    expect(text).toContain('👤 Kullanıcı: Resolved User');
    expect(text).toContain('📊 Risk skoru: 75/100');
    expect(text).toContain('🏷️ Kategori: spam');
    expect(text).toContain('📝 Sebep: rules');
    expect(text).toContain('📏 Kaynak: Kural tabanlı');
    expect(text).toContain('🔗 Mesaj ID: `m1`');
    // The quote is capped so one long message cannot flood the mod channel.
    expect(text).toContain(`\`${'x'.repeat(200)}\``);
    expect(text).not.toContain('x'.repeat(201));
  });

  it('a very low score is marked as the more urgent icon', async () => {
    oneFlagged();
    rulesMod.mockReturnValue({ safe: false, score: 20, reason: 'severe', categories: { threat: true } });
    await runScan();
    expect(alertText()).toContain('🚨');
  });

  it('a borderline score uses the softer icon', async () => {
    oneFlagged();
    rulesMod.mockReturnValue({ safe: false, score: 75, reason: 'borderline', categories: { spam: true } });
    await runScan();
    expect(alertText()).toContain('⚠️');
  });

  it('a result with no categories reads as "genel", never as empty', async () => {
    oneFlagged();
    rulesMod.mockReturnValue({ safe: false, score: 80, reason: 'r' });
    await runScan();
    expect(alertText()).toContain('🏷️ Kategori: genel');
  });

  it('categories that are all false also read as "genel"', async () => {
    oneFlagged();
    rulesMod.mockReturnValue({ safe: false, score: 80, reason: 'r', categories: { spam: false } });
    await runScan();
    expect(alertText()).toContain('🏷️ Kategori: genel');
  });

  it('a result with no reason shows a dash rather than "undefined"', async () => {
    oneFlagged();
    rulesMod.mockReturnValue({ safe: false, score: 80, categories: { spam: true } });
    await runScan();
    expect(alertText()).toContain('📝 Sebep: —');
    expect(alertText()).not.toContain('undefined');
  });

  it('a message with no content still produces a well-formed alert', async () => {
    oneFlagged(message({ content: undefined }));
    await runScan();
    expect(alertText()).toContain('💬 Mesaj: ``');
    expect(rulesMod).toHaveBeenCalledWith('');
  });

  it('an AI verdict that is worse than the rules verdict is used and labelled', async () => {
    oneFlagged();
    rulesMod.mockReturnValue({ safe: false, score: 75, reason: 'rules', categories: { spam: true } });
    callAI.mockResolvedValue('{"safe":false,"score":95,"reason":"ai says worse"}');

    await runScan();

    const text = alertText();
    expect(text).toContain('🤖 Kaynak: [AI]');
    expect(text).toContain('📊 Risk skoru: 95/100');
    expect(callAI).toHaveBeenCalledWith(expect.any(String), '"bad"', 80);
  });

  it('an unusable AI response falls back to the rules verdict', async () => {
    oneFlagged();
    callAI.mockResolvedValue('not json at all');
    await runScan();
    expect(alertText()).toContain('📏 Kaynak: Kural tabanlı');
  });

  it('an AI call that throws falls back to the rules verdict', async () => {
    oneFlagged();
    callAI.mockRejectedValue(new Error('provider offline'));
    await runScan();
    expect(alertText()).toContain('📏 Kaynak: Kural tabanlı');
  });

  it('falls back to the message author name when the user row is gone', async () => {
    oneFlagged(message({ displayName: undefined, username: 'sender' }));
    repo.Users.findById.mockResolvedValue(null);
    await runScan();
    expect(alertText()).toContain('👤 Kullanıcı: sender');
  });

  it('falls back to a placeholder when neither name is known', async () => {
    oneFlagged(message({ displayName: undefined, username: undefined }));
    repo.Users.findById.mockResolvedValue(null);
    await runScan();
    expect(alertText()).toContain('👤 Kullanıcı: Bilinmiyor');
  });

  it('a failing user lookup does not stop the alert', async () => {
    oneFlagged();
    repo.Users.findById.mockRejectedValue(new Error('user store offline'));
    await runScan();
    expect(alertText()).toContain('👤 Kullanıcı: Display');
  });

  it('a user row with no display name uses the username', async () => {
    oneFlagged();
    repo.Users.findById.mockResolvedValue({ _id: 'u1', username: 'row-username' });
    await runScan();
    expect(alertText()).toContain('👤 Kullanıcı: row-username');
  });
});

describe('messages that must never be scanned', () => {
  it('system messages and existing alerts are skipped', async () => {
    repo.Messages.findWhere.mockResolvedValueOnce([
      message({ _id: 'sys', type: 'system' }),
      message({ _id: 'alert', autoModAlert: true }),
    ]);
    repo.Servers.findById.mockResolvedValue({ _id: 's1', autoModerate: true });

    await runScan();

    expect(rulesMod).not.toHaveBeenCalled();
    expect(repo.Messages.create).not.toHaveBeenCalled();
  });

  it('a message that already has an alert is skipped', async () => {
    repo.Messages.findWhere
      .mockResolvedValueOnce([message()])
      .mockResolvedValueOnce([{ _id: 'existing-alert' }]);
    repo.Servers.findById.mockResolvedValue({ _id: 's1', autoModerate: true });

    await runScan();

    expect(repo.Messages.create).not.toHaveBeenCalled();
  });

  it('servers with auto-moderation switched off are skipped entirely', async () => {
    repo.Messages.findWhere.mockResolvedValueOnce([message()]);
    repo.Servers.findById.mockResolvedValue({ _id: 's1', autoModerate: false });
    await runScan();
    expect(rulesMod).not.toHaveBeenCalled();
  });

  it('messages with no server are skipped', async () => {
    repo.Messages.findWhere.mockResolvedValueOnce([message({ serverId: undefined })]);
    await runScan();
    expect(repo.Servers.findById).not.toHaveBeenCalled();
  });

  it('an empty scan window does no further work', async () => {
    repo.Messages.findWhere.mockResolvedValueOnce([]);
    await runScan();
    expect(repo.Servers.findById).not.toHaveBeenCalled();
  });
});

describe('job lifecycle', () => {
  it('announces itself in production and starts exactly one timer chain', () => {
    jest.useFakeTimers();
    inProduction(() => { startAutoModerationJob({} as never); });
    expect(String(stdout.mock.calls.at(-1)?.[0])).toMatch(/Auto Moderation Job/);

    stdout.mockClear();
    startAutoModerationJob({} as never);
    // Already running: no second announcement and no second timer chain.
    expect(stdout).not.toHaveBeenCalled();
  });

  it('is silent under test', () => {
    jest.useFakeTimers();
    startAutoModerationJob({} as never);
    expect(stdout).not.toHaveBeenCalled();
  });

  it('stopping before the first run cancels the pending start', () => {
    jest.useFakeTimers();
    startAutoModerationJob({} as never);
    stopAutoModerationJob();
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(repo.Messages.findWhere).not.toHaveBeenCalled();
  });

  it('stopping a running job reports it in production', () => {
    jest.useFakeTimers();
    startAutoModerationJob({} as never);
    jest.advanceTimersByTime(30_000);
    stdout.mockClear();

    inProduction(() => { stopAutoModerationJob(); });

    expect(String(stdout.mock.calls.at(-1)?.[0])).toMatch(/Job durduruldu/);
  });

  it('stopping a job that was never started is a no-op', () => {
    stopAutoModerationJob();
    expect(stdout).not.toHaveBeenCalled();
  });
});
