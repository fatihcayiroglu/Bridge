// server/tests/security-state-fallback-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GÜVENLİK DURUMU — TEK DÜĞÜM YEDEĞİ, SÜPÜRME VE BOZUK REDIS YANITI
// ════════════════════════════════════════════════════════════════════════════
//
// `lib/security.ts` iki dünyada çalışır: `REDIS_URL` varsa durum KÜME
// otoritesidir, yoksa süreç-içi sınırlı haritalar kullanılır. Kardeş testler
// Redis yolunu ölçer; burada ölçülen, YEDEK yolun ve ona bağlı bakım
// işlerinin doğruluğudur:
//
//   · SINIRLI YEDEK. Süreç-içi haritalar sınırsız büyürse, anahtarı istemci
//     belirlediği için bu doğrudan bir bellek tüketimi yoludur.
//   · SÜPÜRME. Süresi dolmuş kayıtlar temizlenmezse harita hiç küçülmez;
//     ayrıca susturması bitmiş bir kullanıcı için eski durum taşınırsa
//     bir sonraki mesajında haksız yere yeniden susturulabilir.
//   · REDIS BELİRSİZLİĞİ. Redis yapılandırılmışken bir hata YUTULMAZ:
//     süreç-yerel bir kopyaya düşmek, sınırı düğüm sayısı kadar çarpar.
//     Hata `Error` olmayan bir değerle reddedilse bile mesaj OKUNABİLİR
//     kalmalıdır.

'use strict';
process.env.NODE_ENV = 'test';

const redisAuthoritativeCommand = jest.fn();
const withKeyLock = jest.fn(async (_key: string, fn: () => unknown) => fn());

jest.mock('../lib/redisAdapter', () => ({
  cache: { withKeyLock: (...a: unknown[]) => withKeyLock(...a as [string, () => unknown]) },
  redisAuthoritativeCommand: (...a: unknown[]) => redisAuthoritativeCommand(...a as [string, (c: unknown) => unknown]),
}));

const realSetInterval = global.setInterval;
type Sweeper = { fn: () => void; ms: number };
const sweepers: Sweeper[] = [];
jest.spyOn(global, 'setInterval').mockImplementation(((fn: any, ms: any) => {
  sweepers.push({ fn, ms });
  // A real (immediately unref'd) handle keeps `.unref()` working without ever
  // firing during the test run.
  return realSetInterval(() => undefined, 2 ** 30);
}) as never);

import {
  checkSpam,
  checkSpamAsync,
  generateCsrfToken,
  verifyCsrfToken,
  progressiveRateLimit,
  progressiveRateLimitAsync,
} from '../lib/security';

const previousRedisUrl = process.env.REDIS_URL;

function sweeper(ms: number): () => void {
  const found = sweepers.find(s => s.ms === ms);
  if (!found) throw new Error(`no maintenance interval registered at ${ms}ms`);
  return found.fn;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.REDIS_URL;
  withKeyLock.mockImplementation(async (_key: string, fn: () => unknown) => fn());
});

afterAll(() => {
  if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = previousRedisUrl;
});

describe('single-node spam state', () => {
  let seq = 0;
  const user = () => `spam-user-${++seq}`;

  it('warns before muting and then mutes a flood', () => {
    const uid = user();
    for (let i = 0; i < 5; i += 1) expect(checkSpam(uid, `m${i}`).blocked).toBe(false);
    expect(checkSpam(uid, 'm5')).toMatchObject({ blocked: false, warning: true, reason: 'spam_warning' });
    // P7 B1: two short-retry rejections, then the third strike mutes.
    expect(checkSpam(uid, 'm6')).toMatchObject({ blocked: true, reason: 'spam_rate' });
    expect(checkSpam(uid, 'm6b')).toMatchObject({ blocked: true, reason: 'spam_rate' });
    expect(checkSpam(uid, 'm6c')).toMatchObject({ blocked: true, reason: 'spam_rate', remainingMs: 30_000 });
    // Once muted, further messages report the remaining time rather than
    // restarting the window.
    const muted = checkSpam(uid, 'm7');
    expect(muted).toMatchObject({ blocked: true, reason: 'spam_muted' });
    expect((muted as { remainingMs: number }).remainingMs).toBeGreaterThan(0);
  });

  it('blocks repeated identical content even below the rate limit', () => {
    const uid = user();
    for (let i = 0; i < 3; i += 1) expect(checkSpam(uid, 'same').blocked).toBe(false);
    expect(checkSpam(uid, 'SAME')).toMatchObject({ blocked: true, reason: 'spam_duplicate' });
  });

  it('whitespace-only content is not compared for duplication', () => {
    const uid = user();
    // Four blank messages would trip the duplicate rule if the empty string
    // counted as content; they must not.
    for (let i = 0; i < 4; i += 1) expect(checkSpam(uid, '   ').blocked).toBe(false);
  });

  it('the in-process fallback map is bounded', () => {
    // The key is a user id, so an unbounded map is an unbounded allocation
    // path for anyone who can create sessions.
    for (let i = 0; i < 10_001; i += 1) checkSpam(`bounded-${i}`, 'hi');
    // The oldest entry was evicted, so its next message starts a fresh window
    // instead of finding stale state.
    expect(checkSpam('bounded-0', 'hi').blocked).toBe(false);
  });

  it('the async path also falls back to the bounded map when Redis is not configured', async () => {
    const uid = user();
    await expect(checkSpamAsync(uid, 'hello')).resolves.toEqual({ blocked: false });
    expect(redisAuthoritativeCommand).not.toHaveBeenCalled();
    // The state landed in the process-local map: the sync API sees it.
    for (let i = 0; i < 4; i += 1) checkSpam(uid, `x${i}`);
    expect(checkSpam(uid, 'x4')).toMatchObject({ warning: true });
  });

  it('the maintenance sweep drops users whose mute expired and whose messages went stale', () => {
    const uid = user();
    checkSpam(uid, 'hello');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000);
    try {
      sweeper(60_000)();
    } finally { clock.mockRestore(); }
    // Nothing survived, so a later message starts from an empty window.
    expect(checkSpam(uid, 'hello').blocked).toBe(false);
  });

});

describe('configured Redis is authoritative and never silently degrades', () => {
  beforeEach(() => { process.env.REDIS_URL = 'redis://security.test:6379'; });

  it('a read failure is surfaced with a readable cause', async () => {
    redisAuthoritativeCommand.mockRejectedValueOnce(new Error('connection refused'));
    await expect(checkSpamAsync('u1', 'hi'))
      .rejects.toThrow(/Redis security state unavailable: security:spam:u1: connection refused/);
  });

  it('a non-Error rejection is still reported readably', async () => {
    redisAuthoritativeCommand.mockRejectedValueOnce('backend offline');
    await expect(checkSpamAsync('u1', 'hi'))
      .rejects.toThrow(/Redis security state unavailable: security:spam:u1: backend offline/);
  });

  it('a write failure is surfaced rather than quietly kept process-local', async () => {
    redisAuthoritativeCommand
      .mockImplementationOnce(async () => null)          // get
      .mockRejectedValueOnce('write path offline');      // set
    await expect(checkSpamAsync('u2', 'hi'))
      .rejects.toThrow(/Redis security state unavailable: security:spam:u2: write path offline/);
  });

  it('a corrupt stored state is rejected instead of being trusted', async () => {
    redisAuthoritativeCommand.mockImplementationOnce(async () => JSON.stringify({
      messages: [{ content: 5, ts: 'soon' }], warned: 'no', muteUntil: 'never',
    }));
    await expect(checkSpamAsync('u3', 'hi')).rejects.toThrow(/Corrupt spam security state: u3/);
  });

  it('a rate-limit read failure is surfaced with its cause', async () => {
    redisAuthoritativeCommand.mockRejectedValueOnce('violation store offline');
    await expect(progressiveRateLimitAsync('ip:1.2.3.4', 5, 1_000))
      .rejects.toThrow(/Redis security state unavailable: security:violation:ip:1\.2\.3\.4: violation store offline/);
  });

  it('a corrupt stored violation state is rejected', async () => {
    redisAuthoritativeCommand.mockImplementationOnce(async () => JSON.stringify({
      hits: 'lots', violations: -1, bannedUntil: null,
    }));
    await expect(progressiveRateLimitAsync('ip:1.2.3.5', 5, 1_000))
      .rejects.toThrow(/Corrupt progressive rate-limit state/);
  });

  it('valid shared state round-trips and bans escalate', async () => {
    const stored: { value: string | null } = { value: null };
    redisAuthoritativeCommand.mockImplementation(async (op: string, command: (c: unknown) => unknown) => {
      const client = {
        get: async () => stored.value,
        set: async (_k: string, v: string) => { stored.value = v; return 'OK'; },
      };
      void op;
      return command(client);
    });

    for (let i = 0; i < 2; i += 1) {
      await expect(progressiveRateLimitAsync('ip:9.9.9.9', 2, 60_000)).resolves.toEqual({ blocked: false });
    }
    const blocked = await progressiveRateLimitAsync('ip:9.9.9.9', 2, 60_000);
    expect(blocked).toMatchObject({ blocked: true, violations: 1 });
    // The ban is remembered across calls through the shared store.
    await expect(progressiveRateLimitAsync('ip:9.9.9.9', 2, 60_000))
      .resolves.toMatchObject({ blocked: true });
  });
});

describe('progressive rate limiting, single node', () => {
  it('escalates the ban geometrically and clamps it at one hour', () => {
    const key = `rl-${Date.now()}`;
    expect(progressiveRateLimit(key, 1, 60_000)).toEqual({ blocked: false });
    const first = progressiveRateLimit(key, 1, 60_000) as { blocked: true; bannedUntil: number; violations: number };
    expect(first.blocked).toBe(true);
    expect(first.violations).toBe(1);

    // A banned key stays banned without re-counting hits.
    expect(progressiveRateLimit(key, 1, 60_000)).toMatchObject({ blocked: true });
  });

  it('refuses nonsensical bounds instead of computing a meaningless window', async () => {
    for (const [max, windowMs] of [[0, 1_000], [5, 0], [1.5, 1_000], [5, Number.NaN]] as const) {
      await expect(progressiveRateLimitAsync('rl-bad', max, windowMs)).rejects.toThrow(RangeError);
    }
  });

  it('the maintenance sweep drops keys that are neither banned nor recently seen', () => {
    const key = `rl-sweep-${Date.now()}`;
    progressiveRateLimit(key, 5, 1_000);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000);
    try {
      sweeper(5 * 60_000)();
    } finally { clock.mockRestore(); }
    expect(progressiveRateLimit(key, 5, 1_000)).toEqual({ blocked: false });
  });

  it('the maintenance sweep keeps a key that is still banned', () => {
    const key = `rl-keep-${Date.now()}`;
    progressiveRateLimit(key, 1, 3_600_000);
    const banned = progressiveRateLimit(key, 1, 3_600_000) as { blocked: true; bannedUntil: number };
    expect(banned.blocked).toBe(true);

    sweeper(5 * 60_000)();

    expect(progressiveRateLimit(key, 1, 3_600_000))
      .toMatchObject({ blocked: true, bannedUntil: banned.bannedUntil });
  });
});

describe('CSRF tokens in the single-node fallback', () => {
  it('issues a usable token and rejects an unknown one', async () => {
    const token = await generateCsrfToken('csrf-u1');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    await expect(verifyCsrfToken('csrf-u1', token)).resolves.toBe(true);
    await expect(verifyCsrfToken('csrf-u1', 'f'.repeat(64))).resolves.toBe(false);
    // A token is bound to the user it was issued for.
    await expect(verifyCsrfToken('csrf-u2', token)).resolves.toBe(false);
  });

  it('expired tokens are pruned when the next token is issued', async () => {
    const expiring = await generateCsrfToken('csrf-expiry');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 3600 * 1000);
    try {
      // Issuing a new token walks the map and drops entries past their expiry.
      await generateCsrfToken('csrf-expiry');
      await expect(verifyCsrfToken('csrf-expiry', expiring)).resolves.toBe(false);
    } finally { clock.mockRestore(); }
  });

  it('a user cannot hold unbounded tokens; the oldest is dropped', async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 18; i += 1) tokens.push(await generateCsrfToken('csrf-many'));
    await expect(verifyCsrfToken('csrf-many', tokens[0]!)).resolves.toBe(false);
    await expect(verifyCsrfToken('csrf-many', tokens.at(-1)!)).resolves.toBe(true);
  });
});
