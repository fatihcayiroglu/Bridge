jest.mock('node:perf_hooks', () => ({ performance: { now: jest.fn() } }));
import { performance } from 'node:perf_hooks';
import { liveChannelIdsForRead, channelLiveWindowForRead } from '../lib/channelReadExpiryGuard';

const monotonic = jest.mocked(performance.now);
const row = (id: string, lifetime: number | null) => ({
  _id: id, serverId: 's', hasTombstone: false, nowMs: '1000',
  expiresAt: lifetime === null ? null : String(1000 + lifetime), expiryVersion: lifetime === null ? '0' : '1',
});
beforeEach(() => monotonic.mockReturnValue(100));
afterEach(() => jest.clearAllMocks());

it.each([149, 150, 151])('drops elapsed DB lifetimes at monotonic return time %i, preserving permanent channels', async at => {
  const pool = { query: async () => {
    monotonic.mockReturnValue(at);
    return { rows: [row('short', 50), row('permanent', null), row('long', 500)] };
  } };
  const live = await liveChannelIdsForRead(pool, ['short', 'permanent', 'long'].map(channelId => ({ channelId, serverId: 's' })));
  expect([...live].sort()).toEqual(at < 150 ? ['long', 'permanent', 'short'] : ['long', 'permanent']);
});

it('rechecks earlier chunks after a later query consumes their remaining lifetime', async () => {
  let calls = 0;
  const ids = Array.from({ length: 501 }, (_, i) => 'c' + i);
  const pool = { query: async (_sql: string, args: unknown[]) => {
    const batch = args[0] as string[];
    if (++calls === 2) monotonic.mockReturnValue(151);
    return { rows: batch.map(id => row(id, id === 'c0' ? 50 : null)) };
  } };
  const live = await liveChannelIdsForRead(pool, ids.map(channelId => ({ channelId, serverId: 's' })));
  expect(calls).toBe(2); expect(live.has('c0')).toBe(false); expect(live.size).toBe(500);
});

it.each([149, 150, 151])('debits query time from a single read/media window at monotonic return time %i', async at => {
  const pool = { query: async () => {
    monotonic.mockReturnValue(at);
    return { rows: [row('short', 50)] };
  } };
  expect(await channelLiveWindowForRead(pool, 'short', 's')).toEqual(at < 150
    ? { live: true, remainingMs: 1 } : { live: false, remainingMs: 0 });
});
