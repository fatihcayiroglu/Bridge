/**
 * Import before Bridge modules in HTTP/handler integration suites that need
 * Redis authority. Merely configuring REDIS_URL does not connect the singleton;
 * production correctly refuses rate limits and mutations until it is ready.
 * The test service must be explicit; never silently select the local fallback.
 */
if (process.env.PG_TEST_URL) {
  if (!process.env.REDIS_TEST_URL) {
    throw new Error('This PostgreSQL integration fixture requires REDIS_TEST_URL');
  }
  process.env.REDIS_URL = process.env.REDIS_TEST_URL;

  let adapter: typeof import('../../lib/redisAdapter') | undefined;
  beforeAll(async () => {
    // Load after the suite's production modules, sharing their singleton.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const active = require('../../lib/redisAdapter') as typeof import('../../lib/redisAdapter');
    adapter = active;
    expect(await active.applyAdapter({})).toBe(true);
    expect(active.isRedisAvailable()).toBe(true);
    const client = active.redisClient();
    if (!client) throw new Error('Redis integration fixture has no connected client');
    expect(await client.ping()).toBe('PONG');
  });
  afterAll(async () => { await adapter?.disconnect(); });
}

export {};
