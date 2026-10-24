/** P7 D2: the periodic driver is safe without PostgreSQL and never throws. */
const log = { error: jest.fn(), info: jest.fn(), warn: jest.fn() };
jest.mock('../lib/logger', () => ({ __esModule: true, default: log, ...log }));
const dbMock: { _pool?: unknown } = {};
jest.mock('../db/loader', () => ({ __esModule: true, default: dbMock }));
const tick = jest.fn();
jest.mock('../lib/channelExpiryWorker', () => ({ runChannelExpiryTick: (...a: unknown[]) => tick(...a) }));
const invalidateList = jest.fn();
const invalidateMessages = jest.fn();
jest.mock('../routes/servers/channels', () => ({ invalidateChannelList: (...a: unknown[]) => invalidateList(...a) }));
jest.mock('../lib/messageCache', () => ({ invalidateChannelMessages: (...a: unknown[]) => invalidateMessages(...a) }));
const evict = jest.fn();
jest.mock('../lib/liveMembership', () => ({ evictSocketsWithoutChannelAccessBestEffort: (...a: unknown[]) => evict(...a) }));

import { runChannelExpiryJobTick, startChannelExpiryJob, stopChannelExpiryJob } from '../jobs/channelExpiry';

beforeEach(() => { jest.clearAllMocks(); delete dbMock._pool; });
afterEach(() => stopChannelExpiryJob());

it('does nothing without a PostgreSQL pool', async () => {
  await runChannelExpiryJobTick();
  expect(tick).not.toHaveBeenCalled();
});

it('logs only when a tick did work, and contains failures', async () => {
  dbMock._pool = {};
  tick.mockResolvedValueOnce({ claimed: [], converged: [], deleted: 0 });
  await runChannelExpiryJobTick();
  expect(log.info).not.toHaveBeenCalled();
  tick.mockResolvedValueOnce({ claimed: ['c1'], converged: [], deleted: 4 });
  await runChannelExpiryJobTick();
  expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ claimed: 1, deleted: 4 }), expect.any(String));
  tick.mockRejectedValueOnce(new Error('db down'));
  await expect(runChannelExpiryJobTick()).resolves.toBeUndefined();
  expect(log.error).toHaveBeenCalled();
});

it('never runs two ticks at once and starts only one timer', async () => {
  dbMock._pool = {};
  let release!: () => void;
  tick.mockReturnValueOnce(new Promise(r => { release = () => r({ claimed: [], converged: [], deleted: 0 }); }));
  const first = runChannelExpiryJobTick();
  await runChannelExpiryJobTick();
  expect(tick).toHaveBeenCalledTimes(1);
  release(); await first;
  startChannelExpiryJob(); startChannelExpiryJob();
  stopChannelExpiryJob();
  expect(() => stopChannelExpiryJob()).not.toThrow();
});

it('announces each claimed channel to its server room, carrying only the server id, after invalidating caches', async () => {
  dbMock._pool = {};
  const emit = jest.fn();
  const io = { to: jest.fn(() => ({ emit })) };
  startChannelExpiryJob(io);
  tick.mockResolvedValueOnce({ claimed: ['c1', 'c2'], converged: [], deleted: 0,
    claimedChannels: [{ channelId: 'c1', serverId: 's1' }, { channelId: 'c2', serverId: 's2' }] });
  await runChannelExpiryJobTick();
  expect(invalidateList.mock.calls).toEqual([['s1'], ['s2']]);
  expect(invalidateMessages.mock.calls).toEqual([['c1'], ['c2']]);
  expect(io.to.mock.calls).toEqual([['server:s1'], ['server:s2']]);
  expect(emit.mock.calls).toEqual([['channel:expired', { serverId: 's1' }], ['channel:expired', { serverId: 's2' }]]);
});

it('keeps announcing the rest when one announcement fails, and is silent without a socket server', async () => {
  dbMock._pool = {};
  const emit = jest.fn();
  startChannelExpiryJob({ to: () => ({ emit }) });
  invalidateList.mockRejectedValueOnce(new Error('redis down'));
  tick.mockResolvedValueOnce({ claimed: ['c1', 'c2'], converged: [], deleted: 0,
    claimedChannels: [{ channelId: 'c1', serverId: 's1' }, { channelId: 'c2', serverId: 's2' }] });
  await expect(runChannelExpiryJobTick()).resolves.toBeUndefined();
  expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'channel.expiry.announce_failed', channelId: 'c1' }), expect.any(String));
  expect(emit.mock.calls).toEqual([['channel:expired', { serverId: 's2' }]]);
  stopChannelExpiryJob();
  tick.mockResolvedValueOnce({ claimed: ['c3'], converged: [], deleted: 0, claimedChannels: [{ channelId: 'c3', serverId: 's3' }] });
  await runChannelExpiryJobTick();
  expect(emit).toHaveBeenCalledTimes(1);
});

it('evicts the claimed channel\'s live room members when it has a full socket server, and only then', async () => {
  dbMock._pool = {};
  const emit = jest.fn();
  const full = { to: jest.fn(() => ({ emit })), in: jest.fn() };
  startChannelExpiryJob(full);
  tick.mockResolvedValueOnce({ claimed: ['c1'], claimedChannels: [{ channelId: 'c1', serverId: 's1' }], converged: [], deleted: 0 });
  await runChannelExpiryJobTick();
  expect(emit).toHaveBeenCalledWith('channel:expired', { serverId: 's1' });
  expect(evict).toHaveBeenCalledWith(full, 's1', 'c1', { channelGone: true });
  stopChannelExpiryJob();

  const emitOnly = { to: jest.fn(() => ({ emit: jest.fn() })) };
  startChannelExpiryJob(emitOnly);
  tick.mockResolvedValueOnce({ claimed: ['c2'], claimedChannels: [{ channelId: 'c2', serverId: 's1' }], converged: [], deleted: 0 });
  await runChannelExpiryJobTick();
  expect(evict).toHaveBeenCalledTimes(1);
});
