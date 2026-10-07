'use strict';

const mockServerUpdate = jest.fn();
const mockAuditInsert = jest.fn();
const mockClaimCooldown = jest.fn();
const mockSlidingWindowCount = jest.fn();
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../db/repositories', () => ({
  Servers: { update: (...args: unknown[]) => mockServerUpdate(...args) },
  Auth: { insertAuditLog: (...args: unknown[]) => mockAuditInsert(...args) },
}));
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    claimCooldown: (...args: unknown[]) => mockClaimCooldown(...args),
    slidingWindowCount: (...args: unknown[]) => mockSlidingWindowCount(...args),
  },
}));
jest.mock('../lib/logger', () => ({ __esModule: true, default: mockLogger }));

import {
  RAID_POLICIES,
  checkServerJoinRaid,
  parseRaidMitigationLevel,
  raidProtectionStatus,
} from '../lib/raidProtection';

describe('P7 B1 bounded join-raid policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClaimCooldown.mockResolvedValue(0);
    mockSlidingWindowCount.mockResolvedValue(1);
    mockServerUpdate.mockResolvedValue(undefined);
    mockAuditInsert.mockResolvedValue(undefined);
  });

  it('off disables only raid aggregation and creates no hidden user score', async () => {
    const result = await checkServerJoinRaid({
      serverId: 'server-off',
      actorId: 'user-a',
      server: { raidMitigationLevel: 'off' },
      source: 'discoverable',
      now: 1_000,
    });

    expect(result).toEqual({
      allowed: true,
      level: 'off',
      counted: false,
      uniqueAccounts: null,
    });
    expect(mockClaimCooldown).not.toHaveBeenCalled();
    expect(mockSlidingWindowCount).not.toHaveBeenCalled();
    expect(mockServerUpdate).not.toHaveBeenCalled();
  });

  it('the same account contributes at most once per short policy window and raw id is not retained in the key', async () => {
    mockClaimCooldown
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(8_000);
    mockSlidingWindowCount.mockResolvedValueOnce(7);

    const server = { raidMitigationLevel: 'balanced' };
    const first = await checkServerJoinRaid({
      serverId: 'server-a',
      actorId: 'sensitive-user-id',
      server,
      source: 'discoverable',
      now: 10_000,
    });
    const replay = await checkServerJoinRaid({
      serverId: 'server-a',
      actorId: 'sensitive-user-id',
      server,
      source: 'invite',
      now: 12_000,
    });

    expect(first).toMatchObject({ allowed: true, counted: true, uniqueAccounts: 7 });
    expect(replay).toEqual({
      allowed: true,
      level: 'balanced',
      counted: false,
      uniqueAccounts: null,
    });
    expect(mockSlidingWindowCount).toHaveBeenCalledTimes(1);
    const coordinationKey = String(mockClaimCooldown.mock.calls[0]?.[0] ?? '');
    expect(coordinationKey).toMatch(/^raid:join-actor:server-a:[a-f0-9]{24}$/);
    expect(coordinationKey).not.toContain('sensitive-user-id');
  });

  it('balanced permits the measured legitimate control and locks on the first account beyond the aggregate threshold', async () => {
    const policy = RAID_POLICIES.balanced;
    const server = { raidMitigationLevel: 'balanced' };

    for (let index = 1; index <= policy.maxUniqueAccounts; index += 1) {
      mockSlidingWindowCount.mockResolvedValueOnce(index);
      await expect(checkServerJoinRaid({
        serverId: 'server-balanced',
        actorId: 'legit-' + index,
        server,
        source: index % 2 === 0 ? 'invite' : 'discoverable',
        now: 50_000 + index,
      })).resolves.toMatchObject({
        allowed: true,
        level: 'balanced',
        counted: true,
        uniqueAccounts: index,
      });
    }

    mockSlidingWindowCount.mockResolvedValueOnce(policy.maxUniqueAccounts + 1);
    const blocked = await checkServerJoinRaid({
      serverId: 'server-balanced',
      actorId: 'attack-31',
      server,
      source: 'invite',
      now: 60_000,
    });

    expect(blocked).toMatchObject({
      allowed: false,
      code: 'RAID_LOCKDOWN',
      level: 'balanced',
      uniqueAccounts: policy.maxUniqueAccounts + 1,
      retryAfterMs: policy.lockdownMs,
    });
    expect(mockServerUpdate).toHaveBeenCalledTimes(1);
    expect(mockServerUpdate).toHaveBeenCalledWith(
      'server-balanced',
      { raidLockdownUntil: 60_000 + policy.lockdownMs },
    );
    expect(mockAuditInsert).toHaveBeenCalledTimes(1);
    expect(mockAuditInsert).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'server-balanced',
      actorId: 'system',
      action: 'raid_lockdown_auto',
      extra: expect.objectContaining({
        level: 'balanced',
        uniqueAccounts: policy.maxUniqueAccounts + 1,
        maxUniqueAccounts: policy.maxUniqueAccounts,
      }),
    }));
  });

  it('an existing bounded lockdown blocks before touching any aggregate counter', async () => {
    const result = await checkServerJoinRaid({
      serverId: 'server-locked',
      actorId: 'user-a',
      server: {
        raidMitigationLevel: 'strict',
        raidLockdownUntil: 99_000,
      },
      source: 'invite',
      now: 90_000,
    });

    expect(result).toEqual({
      allowed: false,
      level: 'strict',
      code: 'RAID_LOCKDOWN',
      retryAfterMs: 9_000,
      lockdownUntil: 99_000,
      uniqueAccounts: null,
    });
    expect(mockClaimCooldown).not.toHaveBeenCalled();
    expect(mockSlidingWindowCount).not.toHaveBeenCalled();
  });

  it('counter authority failure is explicit and fail-closed instead of diluting multi-node protection', async () => {
    mockClaimCooldown.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(checkServerJoinRaid({
      serverId: 'server-ha',
      actorId: 'user-a',
      server: { raidMitigationLevel: 'balanced' },
      source: 'discoverable',
      now: 123_000,
    })).resolves.toEqual({
      allowed: false,
      level: 'balanced',
      code: 'RAID_AUTHORITY_UNAVAILABLE',
      retryAfterMs: 1_000,
      lockdownUntil: null,
      uniqueAccounts: null,
    });

    expect(mockServerUpdate).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('status is explainable and an expired lockdown is inactive', () => {
    expect(raidProtectionStatus({
      raidMitigationLevel: 'strict',
      raidLockdownUntil: 2_000,
    }, 3_000)).toEqual({
      level: 'strict',
      active: false,
      lockdownUntil: 2_000,
      policy: RAID_POLICIES.strict,
    });
    expect(parseRaidMitigationLevel(undefined)).toBe('balanced');
    expect(parseRaidMitigationLevel('corrupt')).toBe('strict');
  });
});
