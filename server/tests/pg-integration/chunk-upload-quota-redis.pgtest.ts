// server/tests/pg-integration/chunk-upload-quota-redis.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GERÇEK REDIS — PARÇALI YÜKLEME KOTASI ÇOK DÜĞÜMDE ATOMİKTİR
// ════════════════════════════════════════════════════════════════════════════
// `lib/chunkUploadQuota.ts` çok düğümlü dağıtımda kullanıcı başına oturum ve
// geçici bayt sınırını Redis'te Lua ile tutar. Mock'lanmış bir test yalnızca
// "şu betik şu argümanlarla çağrıldı" diyebilir; iki düğüm SON oturum yuvası
// ya da SON baytlar için yarıştığında tam olarak birinin kazandığını,
// betiğin gerçek Redis'te derlendiğini ve tek düğüm arka ucuyla AYNI kararları
// verdiğini KANITLAYAMAZ. Bu süit bunları gerçek Redis'e karşı kanıtlar.
//
// NOT: `PG_TEST_URL` harness'ında çalışır ama PostgreSQL kullanmaz; yalnızca
// `REDIS_TEST_URL` gerektirir.

import crypto from 'crypto';

const REDIS_URL = process.env.REDIS_TEST_URL;
const RUN = REDIS_URL ? describe : describe.skip;

const MB = 1024 * 1024;
const sk = (label: string) => crypto.createHash('sha256').update(label).digest('hex');

type QuotaModule = typeof import('../../lib/chunkUploadQuota');
type AdapterModule = typeof import('../../lib/redisAdapter');

interface Node { quota: QuotaModule; adapter: AdapterModule }

const QUOTA_ENV = {
  CHUNK_UPLOAD_MAX_SESSIONS: '3',
  CHUNK_UPLOAD_MAX_TEMP_MB: '10',
  CHUNK_UPLOAD_SESSION_TTL_MIN: '1',
};

function loadNode(redisUrl: string): Node {
  const saved: Record<string, string | undefined> = {};
  const env: Record<string, string> = { ...QUOTA_ENV, REDIS_URL: redisUrl };
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  let node!: Node;
  try {
    jest.isolateModules(() => {
      node = {
        adapter: require('../../lib/redisAdapter'),
        quota: require('../../lib/chunkUploadQuota'),
      };
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return node;
}

RUN('gerçek Redis — parçalı yükleme kotası', () => {
  const nodes: Node[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any;
  const users: string[] = [];

  const user = (label: string): string => {
    const id = `pgtest-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    users.push(id);
    return id;
  };
  const redisKey = (userId: string): string => {
    const digest = crypto.createHash('sha256').update('chunk-quota\0').update(userId).digest('hex').slice(0, 32);
    return `bridge:cache:chunk-quota:{${digest}}`;
  };

  beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
      const node = loadNode(REDIS_URL!);
      await node.adapter.applyAdapter({});
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !node.adapter.isRedisAvailable()) {
        await new Promise(r => setTimeout(r, 100));
      }
      // GERÇEK Redis şart: bağlantı yoksa bu süit hiçbir şey kanıtlamaz.
      expect(node.adapter.isRedisAvailable()).toBe(true);
      nodes.push(node);
    }
    const { createClient } = require('redis');
    raw = createClient({ url: REDIS_URL });
    await raw.connect();
  }, 60_000);

  afterAll(async () => {
    for (const u of users) { try { await raw.del(redisKey(u)); } catch { /* yok */ } }
    for (const node of nodes) { try { await node.adapter.disconnect(); } catch { /* kapalı */ } }
    try { await raw.quit(); } catch { /* kapalı */ }
  });

  it('two nodes racing for session slots: exactly the cap wins', async () => {
    const u = user('slots');
    const attempts = Array.from({ length: 20 }, (_, i) => nodes[i % 2].quota.reserveChunkQuota({
      userId: u, sessionKey: sk(`slot-${i}`), bytes: 1, retry: false, sessionMaxBytes: MB,
    }));
    const results = await Promise.all(attempts);
    expect(results.filter(r => r.ok)).toHaveLength(3);
    expect(results.filter(r => !r.ok && r.reason === 'SESSIONS')).toHaveLength(17);
    const fields: Record<string, string> = await raw.hGetAll(redisKey(u));
    expect(Object.keys(fields).filter(f => f.startsWith('a:'))).toHaveLength(3);
  }, 30_000);

  it('two nodes racing for the last bytes: the user total is never exceeded', async () => {
    const u = user('bytes');
    const attempts = Array.from({ length: 30 }, (_, i) => nodes[i % 2].quota.reserveChunkQuota({
      userId: u, sessionKey: sk('one-session'), bytes: MB, retry: false, sessionMaxBytes: 100 * MB,
    }));
    const results = await Promise.all(attempts);
    expect(results.filter(r => r.ok)).toHaveLength(10);
    expect(results.filter(r => !r.ok && r.reason === 'USER_BYTES')).toHaveLength(20);
  }, 30_000);

  it('lease lifecycle is exact on real Redis, including cross-node settlement', async () => {
    const u = user('lifecycle');
    const [a, b] = nodes;
    const r1 = await a.quota.reserveChunkQuota({ userId: u, sessionKey: sk('s'), bytes: 3 * MB, retry: false, sessionMaxBytes: 8 * MB });
    const r2 = await b.quota.reserveChunkQuota({ userId: u, sessionKey: sk('s'), bytes: 3 * MB, retry: false, sessionMaxBytes: 8 * MB });
    if (!r1.ok || !r2.ok) throw new Error('expected reservations');
    expect(r1.newSession).toBe(true);
    expect(r2.newSession).toBe(false);

    // 3 committed + 3 in flight + 3 > 8 → the distinct chunk is refused.
    expect(await r1.lease.commit()).toBe('committed');
    expect(await b.quota.reserveChunkQuota({ userId: u, sessionKey: sk('s'), bytes: 3 * MB, retry: false, sessionMaxBytes: 8 * MB }))
      .toEqual({ ok: false, reason: 'SESSION_BYTES', sessionInflight: 1 });

    expect(await r2.lease.commit()).toBe('committed');
    await r2.lease.uncommit(); // e.g. duplicate chunk
    let fields: Record<string, string> = await raw.hGetAll(redisKey(u));
    expect(fields[`s:${sk('s')}`]).toBe(String(3 * MB));
    expect(Object.keys(fields).filter(f => f.startsWith('l:'))).toEqual([]);
    expect(await raw.pTTL(redisKey(u))).toBeGreaterThan(0);

    const r3 = await a.quota.reserveChunkQuota({ userId: u, sessionKey: sk('s'), bytes: MB, retry: true, sessionMaxBytes: 8 * MB });
    if (!r3.ok) throw new Error('expected reservation');
    await r3.lease.refund();
    fields = await raw.hGetAll(redisKey(u));
    expect(Object.keys(fields).filter(f => f.startsWith('l:'))).toEqual([]);

    // Released on node B; a lease taken on node A before release commits nothing.
    const r4 = await a.quota.reserveChunkQuota({ userId: u, sessionKey: sk('s'), bytes: MB, retry: false, sessionMaxBytes: 8 * MB });
    if (!r4.ok) throw new Error('expected reservation');
    await b.quota.releaseChunkQuotaSession(u, sk('s'));
    expect(await r4.lease.commit()).toBe('gone');
    fields = await raw.hGetAll(redisKey(u));
    expect(fields).toEqual({});
  }, 30_000);

  it('uncommit clamps at zero on real Redis', async () => {
    const u = user('clamp');
    const node = nodes[0];
    const r = await node.quota.reserveChunkQuota({ userId: u, sessionKey: sk('s'), bytes: 2 * MB, retry: false, sessionMaxBytes: 8 * MB });
    if (!r.ok) throw new Error('expected reservation');
    await r.lease.commit();
    await node.quota.releaseChunkQuotaSession(u, sk('s'));
    await node.quota.reserveChunkQuota({ userId: u, sessionKey: sk('s'), bytes: 0, retry: false, sessionMaxBytes: 8 * MB });
    await r.lease.uncommit();
    expect(await raw.hGet(redisKey(u), `s:${sk('s')}`)).toBe('0');
  }, 30_000);

  it('stale sessions, expired leases and corrupt fields are dropped by the script', async () => {
    const u = user('stale');
    const node = nodes[0];
    const t0 = Date.now();
    const a = await node.quota.reserveChunkQuota({ userId: u, sessionKey: sk('s1'), bytes: 5 * MB, retry: false, sessionMaxBytes: 8 * MB, now: t0 });
    if (!a.ok) throw new Error('expected reservation');
    await a.lease.commit(t0);
    await node.quota.reserveChunkQuota({ userId: u, sessionKey: sk('s2'), bytes: 5 * MB, retry: false, sessionMaxBytes: 8 * MB, now: t0 });
    // Corruption injected directly into the shared hash must never become capacity.
    await raw.hSet(redisKey(u), { [`a:${sk('bad')}`]: 'not-a-number', [`s:${sk('bad')}`]: '999999999', [`l:${sk('bad')}:x`]: 'garbage' });

    const afterTtl = t0 + 60_001;
    expect(await node.quota.reserveChunkQuota({ userId: u, sessionKey: sk('s3'), bytes: 6 * MB, retry: false, sessionMaxBytes: 8 * MB, now: afterTtl }))
      .toMatchObject({ ok: false, reason: 'USER_BYTES' });
    const fields: Record<string, string> = await raw.hGetAll(redisKey(u));
    expect(Object.keys(fields).some(f => f.includes(sk('bad')))).toBe(false);
    expect(fields[`s:${sk('s1')}`]).toBeUndefined();

    const afterLease = t0 + 15 * 60_000 + 1;
    expect(await node.quota.reserveChunkQuota({ userId: u, sessionKey: sk('s4'), bytes: 8 * MB, retry: false, sessionMaxBytes: 8 * MB, now: afterLease }))
      .toMatchObject({ ok: true, newSession: true });
  }, 30_000);

  it('differential: the single-node backend makes the same decisions as the Redis script', async () => {
    const saved = process.env.REDIS_URL;
    let local!: QuotaModule;
    try {
      Object.assign(process.env, QUOTA_ENV, { REDIS_URL: '' });
      jest.isolateModules(() => { local = require('../../lib/chunkUploadQuota'); });
    } finally {
      if (saved === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = saved;
    }
    const redis = nodes[0].quota;
    const u = user('differential');
    const t0 = Date.now();
    type Step = { s: string; bytes: number; retry?: boolean; at?: number; commit?: boolean; uncommit?: boolean; release?: boolean };
    const steps: Step[] = [
      { s: 'a', bytes: 2 * MB, commit: true },
      { s: 'a', bytes: 3 * MB },
      { s: 'a', bytes: 4 * MB },                 // session bytes (2 + 3 + 4 > 8)
      { s: 'a', bytes: 4 * MB, retry: true },    // retry bypasses session cap
      { s: 'b', bytes: MB, commit: true, uncommit: true },
      { s: 'c', bytes: MB },
      { s: 'd', bytes: MB },                     // sessions
      { s: 'c', bytes: 2 * MB },                 // user bytes (2+3+4+0+1+2 > 10), c has 1 lease
      { s: 'b', bytes: 0, release: true },
      { s: 'd', bytes: MB, at: 70_000 },         // after session TTL
      { s: 'e', bytes: 8 * MB, at: 16 * 60_000 }, // after lease TTL; d's newer 1 MB lease still counts
    ];
    const run = async (q: QuotaModule) => {
      const out: string[] = [];
      for (const step of steps) {
        const now = t0 + (step.at ?? 0);
        const r = await q.reserveChunkQuota({ userId: u, sessionKey: sk(step.s), bytes: step.bytes, retry: Boolean(step.retry), sessionMaxBytes: 8 * MB, now });
        out.push(r.ok ? `ok:${r.newSession}` : `${r.reason}:${r.sessionInflight}`);
        if (r.ok && step.commit) out.push(await r.lease.commit(now));
        if (r.ok && step.uncommit) await r.lease.uncommit();
        if (step.release) await q.releaseChunkQuotaSession(u, sk(step.s));
      }
      return out;
    };
    const localOut = await run(local);
    const redisOut = await run(redis);
    expect(redisOut).toEqual(localOut);
    expect(localOut).toEqual([
      'ok:true', 'committed', 'ok:false', 'SESSION_BYTES:1', 'ok:false',
      'ok:true', 'committed', 'ok:true', 'SESSIONS:0', 'USER_BYTES:1', 'ok:false', 'ok:true', 'ok:true',
    ]);
  }, 30_000);

  it('an unreachable authority fails closed instead of granting from process memory', async () => {
    const dead = loadNode('redis://127.0.0.1:1');
    for (let i = 0; i < 3; i++) {
      await expect(dead.quota.reserveChunkQuota({ userId: 'dead', sessionKey: sk(`d${i}`), bytes: 1, retry: false, sessionMaxBytes: MB }))
        .rejects.toThrow(/unavailable/i);
    }
    await dead.adapter.disconnect().catch(() => undefined);
  }, 30_000);
});

export {};
