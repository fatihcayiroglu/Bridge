// server/tests/chunk-upload-quota.test.ts
//
// Unit contract for lib/chunkUploadQuota.ts. The single-node backend is
// exercised directly; the Redis backend's wire contract (script arguments,
// reply parsing, fail-closed propagation) is exercised with a stubbed
// authoritative Lua call. The Lua scripts themselves are proven against a real
// Redis in tests/pg-integration/chunk-upload-quota-redis.pgtest.ts.

import crypto from 'crypto';

const MB = 1024 * 1024;
const sk = (label: string) => crypto.createHash('sha256').update(label).digest('hex');

type QuotaModule = typeof import('../lib/chunkUploadQuota');

function loadQuota(env: Record<string, string | undefined> = {}, luaEval?: jest.Mock): QuotaModule {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  let mod!: QuotaModule;
  // `jest.doMock` is registry-wide; clear a previous scenario's override.
  jest.dontMock('../lib/redisAdapter');
  try {
    jest.isolateModules(() => {
      if (luaEval) {
        jest.doMock('../lib/redisAdapter', () => ({ cache: { luaEvalAuthoritative: luaEval } }));
      }
      mod = require('../lib/chunkUploadQuota');
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return mod;
}

const LOCAL = { REDIS_URL: undefined };

describe('configuration', () => {
  it('defaults keep max sessions × max boost file within the user total', () => {
    const q = loadQuota(LOCAL);
    expect(q.chunkQuotaConfig()).toEqual({
      maxSessions: 4,
      userMaxBytes: 400 * MB,
      sessionTtlMs: 60 * 60_000,
      leaseTtlMs: 15 * 60_000,
    });
    // Highest boost tier allows 100 MB files: four concurrent maximum-size
    // uploads must fit in the default total, or legitimate users deadlock.
    expect(q.chunkQuotaConfig().maxSessions * 100 * MB).toBeLessThanOrEqual(q.chunkQuotaConfig().userMaxBytes);
  });

  it('the operator limits report shows the enforced defaults', () => {
    const q = loadQuota(LOCAL);
    const { collectLimits } = jest.requireActual('../lib/limitsReport') as typeof import('../lib/limitsReport');
    const rows = collectLimits();
    expect(rows.find(r => r.env === 'CHUNK_UPLOAD_MAX_SESSIONS')?.fallback).toBe(q.chunkQuotaConfig().maxSessions);
    expect((rows.find(r => r.env === 'CHUNK_UPLOAD_MAX_TEMP_MB')?.fallback ?? 0) * MB).toBe(q.chunkQuotaConfig().userMaxBytes);
  });

  it.each([
    ['CHUNK_UPLOAD_MAX_SESSIONS', '0'],
    ['CHUNK_UPLOAD_MAX_TEMP_MB', '-5'],
    ['CHUNK_UPLOAD_SESSION_TTL_MIN', '10m'],
  ])('malformed %s=%s is a startup error, not a silently weakened limit', (name, value) => {
    expect(() => loadQuota({ ...LOCAL, [name]: value })).toThrow(name);
  });
});

describe('input validation', () => {
  const q = loadQuota(LOCAL);
  const base = { userId: 'u', sessionKey: sk('a'), bytes: 1, retry: false, sessionMaxBytes: MB };

  it('rejects a session key that could forge another field', async () => {
    await expect(q.reserveChunkQuota({ ...base, sessionKey: `${sk('a')}:evil` })).rejects.toThrow('Invalid chunk session key');
    await expect(q.reserveChunkQuota({ ...base, sessionKey: 'A'.repeat(64) })).rejects.toThrow('Invalid chunk session key');
    await expect(q.releaseChunkQuotaSession('u', 'x')).rejects.toThrow('Invalid chunk session key');
  });

  it.each([[-1], [1.5], [Number.NaN], [Number.MAX_SAFE_INTEGER + 2]])('rejects byte count %p', async (bytes) => {
    await expect(q.reserveChunkQuota({ ...base, bytes })).rejects.toThrow('Invalid chunk byte count');
  });

  it('rejects an invalid session limit and an anonymous caller', async () => {
    await expect(q.reserveChunkQuota({ ...base, sessionMaxBytes: -1 })).rejects.toThrow('Invalid session byte limit');
    await expect(q.reserveChunkQuota({ ...base, userId: '' })).rejects.toThrow('authenticated user');
  });
});

describe('single-node backend', () => {
  let q: QuotaModule;
  beforeEach(() => {
    q = loadQuota({ ...LOCAL, CHUNK_UPLOAD_MAX_SESSIONS: '2', CHUNK_UPLOAD_MAX_TEMP_MB: '10', CHUNK_UPLOAD_SESSION_TTL_MIN: '1' });
  });
  const reserve = (over: Partial<Parameters<QuotaModule['reserveChunkQuota']>[0]> = {}) => q.reserveChunkQuota({
    userId: 'user-1', sessionKey: sk('s1'), bytes: MB, retry: false, sessionMaxBytes: 8 * MB, ...over,
  });

  it('caps concurrent sessions but keeps existing sessions resumable', async () => {
    const a = await reserve({ sessionKey: sk('s1') });
    const b = await reserve({ sessionKey: sk('s2') });
    expect(a).toMatchObject({ ok: true, newSession: true });
    expect(b).toMatchObject({ ok: true, newSession: true });
    expect(await reserve({ sessionKey: sk('s3') })).toEqual({ ok: false, reason: 'SESSIONS', sessionInflight: 0 });
    expect(await reserve({ sessionKey: sk('s1') })).toMatchObject({ ok: true, newSession: false });
    // Another account is independent.
    expect(await reserve({ userId: 'user-2', sessionKey: sk('s3') })).toMatchObject({ ok: true, newSession: true });
  });

  it('counts committed and in-flight bytes against the per-session entitlement', async () => {
    const first = await reserve({ bytes: 3 * MB });
    if (!first.ok) throw new Error('expected reservation');
    expect(await first.lease.commit()).toBe('committed');
    const inflight = await reserve({ bytes: 3 * MB });
    expect(inflight.ok).toBe(true);
    // 3 committed + 3 in flight + 3 = 9 > 8
    expect(await reserve({ bytes: 3 * MB })).toEqual({ ok: false, reason: 'SESSION_BYTES', sessionInflight: 1 });
    // A retry of an already committed chunk is not a new distinct chunk.
    expect((await reserve({ bytes: 3 * MB, retry: true })).ok).toBe(true);
  });

  it('counts every live lease and committed byte against the user total', async () => {
    const a = await reserve({ sessionKey: sk('s1'), bytes: 4 * MB });
    if (!a.ok) throw new Error('expected reservation');
    await a.lease.commit();
    await reserve({ sessionKey: sk('s2'), bytes: 4 * MB, retry: true });
    expect(await reserve({ sessionKey: sk('s1'), bytes: 3 * MB })).toEqual({ ok: false, reason: 'USER_BYTES', sessionInflight: 0 });
    expect((await reserve({ sessionKey: sk('s1'), bytes: 2 * MB })).ok).toBe(true);
  });

  it('settles each lease exactly once', async () => {
    const r = await reserve({ bytes: 2 * MB });
    if (!r.ok) throw new Error('expected reservation');
    expect(await r.lease.commit()).toBe('committed');
    await expect(r.lease.commit()).rejects.toThrow('already settled');
    await r.lease.refund(); // no-op after commit
    expect(q._chunkQuotaFieldsForTest('user-1')[`s:${sk('s1')}`]).toBe(String(2 * MB));
    await r.lease.uncommit();
    await r.lease.uncommit(); // idempotent
    expect(q._chunkQuotaFieldsForTest('user-1')[`s:${sk('s1')}`]).toBe('0');

    const refunded = await reserve({ bytes: MB });
    if (!refunded.ok) throw new Error('expected reservation');
    await refunded.lease.refund();
    await refunded.lease.refund();
    await refunded.lease.uncommit(); // nothing was committed
    const fields = q._chunkQuotaFieldsForTest('user-1');
    expect(Object.keys(fields).filter(f => f.startsWith('l:'))).toEqual([]);
    expect(fields[`s:${sk('s1')}`]).toBe('0');
  });

  it('uncommit of a stale lease clamps at zero instead of granting negative usage', async () => {
    const r = await reserve({ bytes: MB });
    if (!r.ok) throw new Error('expected reservation');
    await r.lease.commit();
    // The session is released and immediately re-created (same upload id);
    // the old lease's correction must not push the new session below zero,
    // which would let it store more than its entitlement.
    await q.releaseChunkQuotaSession('user-1', sk('s1'));
    expect(await reserve({ bytes: 0 })).toMatchObject({ ok: true, newSession: true });
    await r.lease.uncommit();
    expect(q._chunkQuotaFieldsForTest('user-1')[`s:${sk('s1')}`]).toBe('0');
  });

  it('a lease whose session was released commits nothing', async () => {
    const r = await reserve({ bytes: MB });
    if (!r.ok) throw new Error('expected reservation');
    await q.releaseChunkQuotaSession('user-1', sk('s1'));
    expect(await r.lease.commit()).toBe('gone');
    await r.lease.uncommit(); // must not subtract anything after `gone`
    expect(q._chunkQuotaFieldsForTest('user-1')).toEqual({});
  });

  it('release frees the slot and the bytes', async () => {
    const a = await reserve({ sessionKey: sk('s1'), bytes: 5 * MB });
    const b = await reserve({ sessionKey: sk('s2'), bytes: 5 * MB });
    if (!a.ok || !b.ok) throw new Error('expected reservations');
    await a.lease.commit();
    await b.lease.commit();
    expect(await reserve({ sessionKey: sk('s3') })).toMatchObject({ ok: false, reason: 'SESSIONS' });
    await q.releaseChunkQuotaSession('user-1', sk('s1'));
    expect(await reserve({ sessionKey: sk('s3'), bytes: 5 * MB })).toMatchObject({ ok: true, newSession: true });
  });

  it('idle sessions stop counting; in-flight leases count until they expire', async () => {
    const t0 = 1_800_000_000_000;
    const a = await reserve({ sessionKey: sk('s1'), bytes: 5 * MB, now: t0 });
    if (!a.ok) throw new Error('expected reservation');
    await a.lease.commit(t0);
    await reserve({ sessionKey: sk('s2'), bytes: 5 * MB, now: t0 }); // never settled (crashed worker)
    expect(await reserve({ sessionKey: sk('s3'), now: t0 })).toMatchObject({ ok: false, reason: 'SESSIONS' });

    // After the session TTL (1 min) both sessions and s1's committed bytes are
    // forgotten, but the unsettled lease still holds 5 MB of real temp bytes.
    const afterTtl = t0 + 60_001;
    expect(await reserve({ sessionKey: sk('s3'), bytes: 6 * MB, now: afterTtl })).toMatchObject({ ok: false, reason: 'USER_BYTES' });
    expect(await reserve({ sessionKey: sk('s3'), bytes: 5 * MB, now: afterTtl })).toMatchObject({ ok: true, newSession: true });

    // After the 15 min lease TTL the crashed worker's lease is gone; the s3
    // lease taken at afterTtl is still live.
    const afterLease = t0 + 15 * 60_000 + 1;
    expect(await reserve({ sessionKey: sk('s4'), bytes: 5 * MB, now: afterLease })).toMatchObject({ ok: true, newSession: true });
    expect(await reserve({ sessionKey: sk('s5'), bytes: MB, now: afterLease })).toMatchObject({ ok: false, reason: 'USER_BYTES' });
  });

  it('corrupt fields are dropped and never become capacity (parity with the Redis script)', async () => {
    const t0 = 1_800_000_000_000;
    const r = await reserve({ bytes: 2 * MB, now: t0 });
    if (!r.ok) throw new Error('expected reservation');
    await r.lease.commit(t0);
    q._setChunkQuotaFieldForTest('user-1', `a:${sk('bad')}`, 'not-a-number', t0);
    q._setChunkQuotaFieldForTest('user-1', `s:${sk('bad')}`, '999999999', t0);
    q._setChunkQuotaFieldForTest('user-1', `l:${sk('bad')}:x`, 'garbage', t0);
    q._setChunkQuotaFieldForTest('user-1', `s:${sk('s1')}`, 'NaN', t0);

    // Corrupt committed bytes read as 0, the corrupt session is not a session.
    expect(await reserve({ sessionKey: sk('s2'), bytes: 8 * MB, now: t0 })).toMatchObject({ ok: true, newSession: true });
    const fields = q._chunkQuotaFieldsForTest('user-1');
    expect(Object.keys(fields).some(f => f.includes(sk('bad')))).toBe(false);
  });

  it('no reservation state outlives the longest TTL', async () => {
    const t0 = 1_800_000_000_000;
    await reserve({ bytes: MB, now: t0 });
    await reserve({ sessionKey: sk('s2'), bytes: MB, now: t0 });
    // Key TTL = max(session TTL, lease TTL) + 60 s.
    expect(await reserve({ sessionKey: sk('s3'), bytes: 8 * MB, now: t0 + 16 * 60_000 + 1 })).toMatchObject({ ok: true, newSession: true });
  });

});

describe('Redis backend wire contract', () => {
  it('sends one atomic script per decision with exact integer arguments under an opaque user key', async () => {
    const lua = jest.fn()
      .mockResolvedValueOnce(['OK', 1])
      .mockResolvedValueOnce('COMMITTED')
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    const q = loadQuota({ REDIS_URL: 'redis://quota.invalid:6379' }, lua);
    const r = await q.reserveChunkQuota({ userId: 'alice@example', sessionKey: sk('s1'), bytes: 3 * MB, retry: false, sessionMaxBytes: 25 * MB, now: 1_800_000_000_000 });
    expect(r).toMatchObject({ ok: true, newSession: true });

    const [script, keys, args] = lua.mock.calls[0];
    expect(script).toContain("redis.call('HGETALL', key)");
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^chunk-quota:\{[a-f0-9]{32}\}$/);
    expect(keys[0]).not.toContain('alice');
    expect(args).toEqual([
      '1800000000000',
      String(1_800_000_000_000 - 60 * 60_000),
      sk('s1'),
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      String(3 * MB),
      String(1_800_000_000_000 + 15 * 60_000),
      '4',
      String(25 * MB),
      String(400 * MB),
      '0',
      String(61 * 60_000),
    ]);

    if (!r.ok) throw new Error('expected reservation');
    expect(await r.lease.commit()).toBe('committed');
    await r.lease.uncommit();
    await q.releaseChunkQuotaSession('alice@example', sk('s1'));
    expect(lua.mock.calls.map(c => c[1][0])).toEqual(Array(4).fill(keys[0]));
  });

  it.each([
    [['SESSIONS', 0], { ok: false, reason: 'SESSIONS', sessionInflight: 0 }],
    [['SESSION_BYTES', 2], { ok: false, reason: 'SESSION_BYTES', sessionInflight: 2 }],
    [['USER_BYTES', 'x'], { ok: false, reason: 'USER_BYTES', sessionInflight: 0 }],
    [['OK', 0], { ok: true, newSession: false }],
  ])('maps reply %p', async (reply, expected) => {
    const q = loadQuota({ REDIS_URL: 'redis://quota.invalid:6379' }, jest.fn().mockResolvedValue(reply));
    expect(await q.reserveChunkQuota({ userId: 'u', sessionKey: sk('s'), bytes: 1, retry: false, sessionMaxBytes: MB }))
      .toMatchObject(expected);
  });

  it.each([[null], [['OK']], [['WAT', 1]], ['OK']])('a malformed reply %p is an error, never a grant', async (reply) => {
    const q = loadQuota({ REDIS_URL: 'redis://quota.invalid:6379' }, jest.fn().mockResolvedValue(reply));
    await expect(q.reserveChunkQuota({ userId: 'u', sessionKey: sk('s'), bytes: 1, retry: false, sessionMaxBytes: MB }))
      .rejects.toThrow(/chunk quota reply/);
  });

  it('an unexpected commit reply is an error', async () => {
    const lua = jest.fn().mockResolvedValueOnce(['OK', 1]).mockResolvedValueOnce('MAYBE');
    const q = loadQuota({ REDIS_URL: 'redis://quota.invalid:6379' }, lua);
    const r = await q.reserveChunkQuota({ userId: 'u', sessionKey: sk('s'), bytes: 1, retry: false, sessionMaxBytes: MB });
    if (!r.ok) throw new Error('expected reservation');
    await expect(r.lease.commit()).rejects.toThrow('commit reply');
  });

  it('maps a GONE commit and refunds through the authority', async () => {
    const lua = jest.fn().mockResolvedValueOnce(['OK', 0]).mockResolvedValueOnce('GONE')
      .mockResolvedValueOnce(['OK', 0]).mockResolvedValueOnce(1);
    const q = loadQuota({ REDIS_URL: 'redis://quota.invalid:6379' }, lua);
    const a = await q.reserveChunkQuota({ userId: 'u', sessionKey: sk('s'), bytes: 1, retry: false, sessionMaxBytes: MB });
    if (!a.ok) throw new Error('expected reservation');
    expect(await a.lease.commit()).toBe('gone');
    const b = await q.reserveChunkQuota({ userId: 'u', sessionKey: sk('s'), bytes: 1, retry: true, sessionMaxBytes: MB });
    if (!b.ok) throw new Error('expected reservation');
    await b.lease.refund();
    expect(lua.mock.calls[3][0]).toContain('HDEL');
    expect(lua.mock.calls[3][2]).toEqual([sk('s'), expect.stringMatching(/^[0-9a-f-]{36}$/)]);
  });

  it('an unreachable authority propagates (fail closed) and never falls back to process memory', async () => {
    const lua = jest.fn().mockRejectedValue(new Error('Redis authoritative cache unavailable'));
    const q = loadQuota({ REDIS_URL: 'redis://quota.invalid:6379' }, lua);
    for (let i = 0; i < 3; i++) {
      await expect(q.reserveChunkQuota({ userId: 'u', sessionKey: sk(`s${i}`), bytes: 1, retry: false, sessionMaxBytes: MB }))
        .rejects.toThrow('unavailable');
    }
    expect(q._chunkQuotaFieldsForTest('u')).toEqual({});
  });
});
