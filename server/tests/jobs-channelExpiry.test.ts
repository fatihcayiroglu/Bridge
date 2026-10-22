/** P7 D2: the periodic driver is safe without PostgreSQL and never throws. */
const log = { error: jest.fn(), info: jest.fn() };
jest.mock('../lib/logger', () => ({ __esModule: true, default: log, ...log }));
const dbMock: { _pool?: unknown } = {};
jest.mock('../db/loader', () => ({ __esModule: true, default: dbMock }));
const tick = jest.fn();
jest.mock('../lib/channelExpiryWorker', () => ({ runChannelExpiryTick: (...a: unknown[]) => tick(...a) }));

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
