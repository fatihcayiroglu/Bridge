// P7 D2: live media ends at the channel's expiry instant (socket/mediaExpiryEviction.ts).
// The authoritative read and the all-node eviction are mocked here; the real
// PostgreSQL + Socket.IO behaviour is pinned in
// tests/pg-integration/media-channel-expiry.pgtest.ts.
jest.mock('../lib/channelContentAvailability', () => ({ channelMediaLiveWindow: jest.fn() }));
jest.mock('../lib/liveMembership', () => ({ evictSocketsWithoutChannelAccessBestEffort: jest.fn() }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn() } }));

import { channelMediaLiveWindow } from '../lib/channelContentAvailability';
import { evictSocketsWithoutChannelAccessBestEffort } from '../lib/liveMembership';
import logger from '../lib/logger';
import {
  armMediaExpiryEviction, __armedMediaExpiryForTest, __resetMediaExpiryEvictionForTest,
} from '../socket/mediaExpiryEviction';

const readWindow = jest.mocked(channelMediaLiveWindow);
const evict = jest.mocked(evictSocketsWithoutChannelAccessBestEffort);
const io = { in: jest.fn() };
const HOUR = 60 * 60 * 1000;
const live = (remainingMs: number | null) => ({ live: true, remainingMs });
const GONE = { live: false, remainingMs: 0 };
/** Run due timers and let the async fire() settle. */
async function advance(ms: number) {
  await jest.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.resetAllMocks();
  evict.mockResolvedValue(undefined);
});
afterEach(() => {
  __resetMediaExpiryEvictionForTest();
  jest.useRealTimers();
});

it('evicts every member at the authoritative expiry instant, not before', async () => {
  readWindow.mockResolvedValueOnce(live(1_500)).mockResolvedValueOnce(GONE);
  await armMediaExpiryEviction(io, 'ch', 'srv');
  expect(__armedMediaExpiryForTest()).toEqual(['ch']);

  await advance(1_499);
  expect(evict).not.toHaveBeenCalled();
  await advance(1);
  expect(readWindow).toHaveBeenCalledTimes(2);               // re-read at the instant
  expect(evict).toHaveBeenCalledWith(io, 'srv', 'ch', { channelGone: true });
  expect(__armedMediaExpiryForTest()).toEqual([]);
  expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'media.expiry_evicted', channelId: 'ch' }), expect.any(String));
});

it('re-arms for a later expiry instead of evicting a channel that is still live', async () => {
  readWindow.mockResolvedValueOnce(live(1_000)).mockResolvedValueOnce(live(HOUR)).mockResolvedValueOnce(GONE);
  await armMediaExpiryEviction(io, 'ch', 'srv');
  await advance(1_000);
  expect(evict).not.toHaveBeenCalled();
  expect(__armedMediaExpiryForTest()).toEqual(['ch']);
  await advance(HOUR);
  expect(evict).toHaveBeenCalledTimes(1);
});

it('an expiry removed before the instant (channel made permanent) leaves no timer and evicts nobody', async () => {
  readWindow.mockResolvedValueOnce(live(1_000)).mockResolvedValueOnce(live(null));
  await armMediaExpiryEviction(io, 'ch', 'srv');
  await advance(1_000);
  expect(evict).not.toHaveBeenCalled();
  expect(__armedMediaExpiryForTest()).toEqual([]);
});

it('keeps one timer per channel, at the earliest deadline', async () => {
  readWindow.mockResolvedValueOnce(live(5_000)).mockResolvedValueOnce(live(9_000)).mockResolvedValueOnce(live(2_000))
    .mockResolvedValue(GONE);
  await armMediaExpiryEviction(io, 'ch', 'srv');
  await armMediaExpiryEviction(io, 'ch', 'srv');              // later: ignored
  await armMediaExpiryEviction(io, 'ch', 'srv');              // earlier: replaces
  expect(__armedMediaExpiryForTest()).toEqual(['ch']);
  await advance(2_000);
  expect(evict).toHaveBeenCalledTimes(1);
  await advance(10_000);
  expect(evict).toHaveBeenCalledTimes(1);                     // the replaced timers never fire
});

it('caps a far expiry at six hours and re-reads then', async () => {
  readWindow.mockResolvedValueOnce(live(30 * 24 * HOUR)).mockResolvedValueOnce(live(30 * 24 * HOUR - 6 * HOUR));
  await armMediaExpiryEviction(io, 'ch', 'srv');
  await advance(6 * HOUR);
  expect(readWindow).toHaveBeenCalledTimes(2);
  expect(evict).not.toHaveBeenCalled();
  expect(__armedMediaExpiryForTest()).toEqual(['ch']);
});

it('arms nothing for a permanent channel, a group DM, a closed channel or an io without rooms', async () => {
  readWindow.mockResolvedValueOnce(live(null)).mockResolvedValueOnce(GONE);
  await armMediaExpiryEviction(io, 'permanent', 'srv');
  await armMediaExpiryEviction(io, 'closed', 'srv');
  await armMediaExpiryEviction(io, 'gdm', null);
  await armMediaExpiryEviction(io, 'gdm', undefined);
  await armMediaExpiryEviction({}, 'ch', 'srv');
  await armMediaExpiryEviction(null, 'ch', 'srv');
  expect(readWindow).toHaveBeenCalledTimes(2);                 // no read without a server or an io
  expect(__armedMediaExpiryForTest()).toEqual([]);
});

it('an eviction failure is logged and never escapes the timer', async () => {
  readWindow.mockResolvedValueOnce(live(10)).mockRejectedValueOnce(new Error('pool gone'));
  await armMediaExpiryEviction(io, 'ch', 'srv');
  await advance(10);
  expect(evict).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'media.expiry_evict_failed', channelId: 'ch' }), expect.any(String));
  expect(__armedMediaExpiryForTest()).toEqual([]);
});
