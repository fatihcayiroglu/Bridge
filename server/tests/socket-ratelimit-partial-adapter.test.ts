'use strict';

// Regression: several isolated route suites replace redisAdapter with the subset
// they actually use. socketRateLimit has a long-lived maintenance timer; a
// missing optional availability export must not crash the Jest worker later.
//
// Production semantics stay fail-closed: REDIS_URL is configured here, so an
// unavailable/missing shared authority must reject traffic rather than fall
// back to process-local quota.

process.env.NODE_ENV = 'test';
process.env.REDIS_URL = 'redis://configured.test:6379';

jest.useFakeTimers();

const slidingWindowCount = jest.fn();

jest.mock('../lib/redisAdapter', () => ({
  cache: {
    slidingWindowCount: (...args: unknown[]) => slidingWindowCount(...args),
  },
  // Intentionally NO isRedisAvailable export.
}));

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { _socketRateStore, socketRateCheck } from '../socket/socketRateLimit';

describe('socket rate-limit partial adapter regression', () => {
  beforeEach(() => {
    _socketRateStore.clear();
    slidingWindowCount.mockReset();
  });

  afterAll(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    delete process.env.REDIS_URL;
  });

  it('fails closed without calling a missing Redis authority export', async () => {
    await expect(socketRateCheck('u-partial', 'message:send')).resolves.toBe(false);
    expect(slidingWindowCount).not.toHaveBeenCalled();
    expect(_socketRateStore.size).toBe(0);
  });

  it('maintenance sweep cannot crash when the adapter shape is partial', () => {
    expect(() => {
      jest.advanceTimersByTime(2 * 60_000);
    }).not.toThrow();
    expect(_socketRateStore.size).toBe(0);
  });
});
