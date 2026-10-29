// P7 D2 (#321): writes into an expired or tombstoned channel are refused, and an unverifiable store fails closed.
import { channelWriteAvailability } from '../lib/channelWriteGuard';

const CH = { _id: 'c1', serverId: 's1' };
const NOW = 2_000_000_000_000;
const row = (over: Record<string, unknown> = {}) => ({
  _id: 'c1', serverId: 's1', expiresAt: null, expiryVersion: '0', hasTombstone: false, nowMs: String(NOW), ...over,
});
const pool = (rows: unknown[] | Error) => ({
  query: jest.fn(async () => { if (rows instanceof Error) throw rows; return { rows }; }),
});

describe('channelWriteAvailability', () => {
  it('permanent channel is live', async () => {
    expect(await channelWriteAvailability({ _pool: pool([row()]) as any }, CH)).toBe('live');
  });
  it('a future expiry is live, a past expiry is gone (database clock, not the caller clock)', async () => {
    expect(await channelWriteAvailability({ _pool: pool([row({ expiresAt: String(NOW + 60_000), expiryVersion: '1' })]) as any }, CH)).toBe('live');
    expect(await channelWriteAvailability({ _pool: pool([row({ expiresAt: String(NOW - 1), expiryVersion: '1' })]) as any }, CH)).toBe('gone');
  });
  it('a tombstone denies even for a channel row that was recreated under the same id', async () => {
    expect(await channelWriteAvailability({ _pool: pool([row({ hasTombstone: true })]) as any }, CH)).toBe('gone');
  });
  it('missing row, another tenant and a corrupt expiry are gone', async () => {
    expect(await channelWriteAvailability({ _pool: pool([]) as any }, CH)).toBe('gone');
    expect(await channelWriteAvailability({ _pool: pool([row({ serverId: 'other' })]) as any }, CH)).toBe('gone');
    expect(await channelWriteAvailability({ _pool: pool([row({ expiresAt: 'x', expiryVersion: '1' })]) as any }, CH)).toBe('gone');
  });
  it('a database failure is unverifiable, never live, and does not throw', async () => {
    expect(await channelWriteAvailability({ _pool: pool(new Error('down')) as any }, CH)).toBe('unverifiable');
  });
  it('no pool outside the test environment is unverifiable (fail closed)', async () => {
    expect(await channelWriteAvailability({}, CH, { NODE_ENV: 'production' } as any)).toBe('unverifiable');
    expect(await channelWriteAvailability(null, CH, { NODE_ENV: 'production' } as any)).toBe('unverifiable');
  });
  it('test fallback judges the record itself: legacy permanent live, expired or half-set gone', async () => {
    const env = { NODE_ENV: 'test' } as any;
    expect(await channelWriteAvailability({}, CH, env)).toBe('live');
    expect(await channelWriteAvailability({}, { ...CH, expiresAt: 1, expiryVersion: 1 }, env)).toBe('gone');
    expect(await channelWriteAvailability({}, { ...CH, expiresAt: Date.now() + 3_600_000 }, env)).toBe('gone'); // no version evidence
  });
  it('a missing or malformed channel is gone', async () => {
    expect(await channelWriteAvailability({ _pool: pool([row()]) as any }, null)).toBe('gone');
    expect(await channelWriteAvailability({ _pool: pool([row()]) as any }, { _id: 5 as any, serverId: 's1' })).toBe('gone');
  });
});
