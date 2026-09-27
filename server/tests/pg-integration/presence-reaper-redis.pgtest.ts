// server/tests/pg-integration/presence-reaper-redis.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GERÇEK REDIS — ÖLÜ DÜĞÜMÜN SOKETİ KULLANICIYI SONSUZA DEK ÇEVRİMİÇİ TUTMAZ
// ════════════════════════════════════════════════════════════════════════════
// Çok-düğüm düzeneğinde (scripts/multinode, ND-07) ölçüldü: düğümü SIGKILL
// edilen kullanıcının yeni soketi kapandığında, ölü düğümün soket kaydı henüz
// bayat olmadığı için sayım 1 kaldı; sonra kayıt bayatlasa bile kimse yeniden
// bakmadı. Kullanıcı (veritabanı durumu ve tüm gözlemciler için) çevrimiçi kaldı.
//
// Burada iki "düğüm", aynı gerçek Redis'e bağlı iki ayrı modül kopyasıdır.
// Zaman, `reapStalePresence(now)` ile ileri alınır (90 sn beklenmez).

const REDIS_URL = process.env.REDIS_TEST_URL;
const RUN = REDIS_URL ? describe : describe.skip;
const STALE_MS = 90_000;

type PresenceModule = typeof import('../../lib/presenceCache');
type AdapterModule = typeof import('../../lib/redisAdapter');
interface Node { presence: PresenceModule; adapter: AdapterModule }

function loadNode(redisUrl: string, instanceId: string): Node {
  const saved = { REDIS_URL: process.env.REDIS_URL, INSTANCE_ID: process.env.INSTANCE_ID };
  process.env.REDIS_URL = redisUrl;
  process.env.INSTANCE_ID = instanceId;
  let node!: Node;
  try {
    jest.isolateModules(() => {
      node = { adapter: require('../../lib/redisAdapter'), presence: require('../../lib/presenceCache') };
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return node;
}

RUN('gerçek Redis — bayat soket varlığı biçme', () => {
  const nodes: Node[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any;
  const users: string[] = [];
  const user = (label: string): string => {
    const id = `pgtest-presence-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    users.push(id);
    return id;
  };

  beforeAll(async () => {
    for (const id of ['node-a', 'node-b']) {
      const node = loadNode(REDIS_URL!, id);
      await node.adapter.applyAdapter({});
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !node.adapter.isRedisAvailable()) await new Promise(r => setTimeout(r, 100));
      expect(node.adapter.isRedisAvailable()).toBe(true);
      nodes.push(node);
    }
    const { createClient } = require('redis');
    raw = createClient({ url: REDIS_URL });
    await raw.connect();
  }, 60_000);

  afterAll(async () => {
    for (const u of users) {
      try {
        await raw.del([`bridge:cache:presence:sockets:${u}`, `bridge:cache:presence:visibility:${u}`, `bridge:cache:presence:online:${u}`]);
        await raw.zRem('bridge:cache:presence:users', u);
      } catch { /* yok */ }
    }
    for (const node of nodes) { node.presence.stopPresenceReaper(); try { await node.adapter.disconnect(); } catch { /* kapalı */ } }
    try { await raw.quit(); } catch { /* kapalı */ }
  });

  it('a user whose last live socket closed while a dead node still listed one is reaped exactly once', async () => {
    const [a, b] = nodes;
    const u = user('dead-node');
    await a.presence.trackSocket(u, 'sock-on-dead-node');   // node A dies: never released
    await b.presence.trackSocket(u, 'sock-replacement');
    expect(await b.presence.releaseSocket(u, 'sock-replacement')).toBe(1); // the dead socket still counts

    // Negative control: nothing is stale yet.
    expect(await b.presence.reapStalePresence(Date.now())).not.toContain(u);

    const later = Date.now() + STALE_MS + 1_000;
    const [first, second] = await Promise.all([a.presence.reapStalePresence(later), b.presence.reapStalePresence(later)]);
    const winners = [...first, ...second].filter(id => id === u);
    expect(winners).toHaveLength(1);
    expect(await raw.zScore('bridge:cache:presence:users', u)).toBeNull();
    expect(await raw.exists(`bridge:cache:presence:sockets:${u}`)).toBe(0);
    expect(await b.presence.reapStalePresence(later)).not.toContain(u);
  });

  it('a user with ANY live socket is never reaped, and the index follows the newest heartbeat', async () => {
    const [a, b] = nodes;
    const u = user('live');
    await a.presence.trackSocket(u, 'sock-live');
    const later = Date.now() + STALE_MS + 1_000;
    // The live socket heartbeats "later" (node B also tracks one then).
    await raw.zAdd(`bridge:cache:presence:sockets:${u}`, { score: later, value: 'sock-live' });
    await raw.zAdd('bridge:cache:presence:users', { score: Date.now() - STALE_MS * 2, value: u }); // stale index entry
    expect(await b.presence.reapStalePresence(later)).not.toContain(u);
    expect(Number(await raw.zScore('bridge:cache:presence:users', u))).toBe(later);
  });

  it('an ordinary last-socket disconnect removes the user from the reaper index (no double offline)', async () => {
    const [a] = nodes;
    const u = user('normal');
    await a.presence.trackSocket(u, 'only-socket');
    expect(await raw.zScore('bridge:cache:presence:users', u)).not.toBeNull();
    expect(await a.presence.releaseSocket(u, 'only-socket')).toBe(0);
    expect(await raw.zScore('bridge:cache:presence:users', u)).toBeNull();
  });
});
