// P7 B3, owner decision 2026-10-24: an ordinary new-device sign-in must not
// write the username or the IP address to the logs. The alert to the account
// holder and the bounded known-device record are unchanged.

process.env.NODE_ENV = 'test';

const mockCache = { setIfAbsentAuthoritative: jest.fn(), get: jest.fn(), set: jest.fn(), del: jest.fn() };
jest.mock('../lib/redisAdapter', () => ({ cache: mockCache, isRedisAvailable: jest.fn(() => false) }));
const mockSendAlert = jest.fn();
jest.mock('../lib/mailer', () => ({ sendSuspiciousLoginAlert: (...a: unknown[]) => mockSendAlert(...a) }));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../lib/logger', () => ({ __esModule: true, default: mockLog }));

import type { Request } from 'express';
import { checkSuspiciousLogin } from '../lib/captcha';

const IP = '203.0.113.77';
const USER = { _id: 'user-id-42', username: 'alice-private', displayName: 'Alice Private', email: 'alice@example.com' };
const req = () => ({
  headers: { 'user-agent': 'Mozilla/5.0 TestBrowser', 'accept-language': 'tr-TR', 'x-forwarded-for': IP },
  method: 'POST', ip: IP, socket: { remoteAddress: IP },
} as unknown as Request);
const allLogged = () => JSON.stringify([...mockLog.info.mock.calls, ...mockLog.warn.mock.calls, ...mockLog.error.mock.calls, ...mockLog.debug.mock.calls]);

beforeEach(() => {
  jest.clearAllMocks();
  mockCache.setIfAbsentAuthoritative.mockResolvedValue(true); // a device not seen before
  mockSendAlert.mockResolvedValue(undefined);
});

describe('P7 B3: new-device sign-in telemetry', () => {
  // Integration note (P7 closure candidate): #402 already removed this INFO
  // line entirely, which is stricter than #384's identifier-free line, so the
  // routine sign-in writes nothing to INFO here.
  it('writes no INFO line and no username, IP, e-mail or user id anywhere', async () => {
    await checkSuspiciousLogin(req(), USER);
    expect(mockLog.info).not.toHaveBeenCalled();
    for (const value of ['alice-private', 'Alice Private', 'alice@example.com', 'user-id-42', IP]) {
      expect(allLogged()).not.toContain(value);
    }
  });

  it('still alerts the account holder, who is the one entitled to the IP and device', async () => {
    await checkSuspiciousLogin(req(), USER);
    expect(mockSendAlert).toHaveBeenCalledWith(expect.objectContaining({ to: 'alice@example.com', ip: IP }));
  });

  it('still records the device per account with the configured retention (30 days by default)', async () => {
    await checkSuspiciousLogin(req(), USER);
    const [key, value, ttl] = mockCache.setIfAbsentAuthoritative.mock.calls[0];
    expect(key).toMatch(/^captcha:known-device:user-id-42:[0-9a-f]{32}$/);
    expect(key).not.toContain(IP);
    expect([value, ttl]).toEqual([1, 30 * 24 * 3600]);
  });

  it('an account without an address writes no INFO line and no identifiers', async () => {
    await checkSuspiciousLogin(req(), { _id: 'user-id-42', username: 'alice-private' });
    expect(mockLog.info).not.toHaveBeenCalled();
    expect(allLogged()).not.toContain('alice-private');
    expect(mockSendAlert).not.toHaveBeenCalled();
  });

  it('a known device logs nothing at all', async () => {
    mockCache.setIfAbsentAuthoritative.mockResolvedValue(false);
    await checkSuspiciousLogin(req(), USER);
    expect(mockLog.info).not.toHaveBeenCalled();
  });
});
