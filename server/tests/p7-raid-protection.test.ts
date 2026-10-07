'use strict';

const mockServerUpdate = jest.fn();
const mockServerFindById = jest.fn();
const mockAuditInsert = jest.fn();
const mockClaimCooldown = jest.fn();
const mockSlidingWindowCount = jest.fn();
const mockHoldCohort = jest.fn();
const mockUserFindById = jest.fn();
const mockMemberFindOne = jest.fn();
const mockMemberSetTimeout = jest.fn();
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../db/repositories', () => ({
  Servers: {
    update: (...args: unknown[]) => mockServerUpdate(...args),
    findById: (...args: unknown[]) => mockServerFindById(...args),
  },
  Auth: { insertAuditLog: (...args: unknown[]) => mockAuditInsert(...args) },
  Members: {
    holdRecentYoungJoiners: (...args: unknown[]) => mockHoldCohort(...args),
    findOne: (...args: unknown[]) => mockMemberFindOne(...args),
    setTimeout: (...args: unknown[]) => mockMemberSetTimeout(...args),
  },
  Users: { findById: (...args: unknown[]) => mockUserFindById(...args) },
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
  applyRaidJoinHold,
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
    mockHoldCohort.mockResolvedValue(0);
    mockServerFindById.mockResolvedValue({ raidMitigationLevel: 'balanced', raidLockdownUntil: null });
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
      hold: null,
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
      hold: null,
    });
    expect(mockSlidingWindowCount).toHaveBeenCalledTimes(1);
    const coordinationKey = String(mockClaimCooldown.mock.calls[0]?.[0] ?? '');
    expect(coordinationKey).toMatch(/^raid:join-actor:server-a:[a-f0-9]{24}$/);
    expect(coordinationKey).not.toContain('sensitive-user-id');
  });

  it('balanced admits every join and, on crossing the threshold, holds the young surge cohort from posting', async () => {
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
        hold: null,
      });
    }

    mockSlidingWindowCount.mockResolvedValueOnce(policy.maxUniqueAccounts + 1);
    mockHoldCohort.mockResolvedValueOnce(30);
    const crossing = await checkServerJoinRaid({
      serverId: 'server-balanced',
      actorId: 'attack-31',
      server,
      source: 'invite',
      now: 60_000,
    });

    // The join itself is NOT refused (measured: refusing cost a 40-person launch
    // 10 joins and still let the first 30 raiders post).
    expect(crossing).toEqual({
      allowed: true,
      level: 'balanced',
      counted: true,
      uniqueAccounts: policy.maxUniqueAccounts + 1,
      hold: { until: 60_000 + policy.lockdownMs, youngAccountMs: policy.youngAccountMs },
    });
    expect(mockServerUpdate).toHaveBeenCalledWith('server-balanced', { raidLockdownUntil: 60_000 + policy.lockdownMs });
    // Retroactive: the cohort that triggered the surge is held too.
    expect(mockHoldCohort).toHaveBeenCalledWith('server-balanced', {
      joinedSince: 60_000 - policy.windowMs,
      accountCreatedSince: 0,
      holdUntil: 60_000 + policy.lockdownMs,
    });
    expect(mockAuditInsert).toHaveBeenCalledTimes(1);
    expect(mockAuditInsert).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'server-balanced',
      actorId: 'system',
      action: 'raid_lockdown_auto',
      extra: expect.objectContaining({
        level: 'balanced',
        uniqueAccounts: policy.maxUniqueAccounts + 1,
        maxUniqueAccounts: policy.maxUniqueAccounts,
        refuseJoins: false,
        heldMembers: 30,
      }),
    }));
    // The audit names how many were held, never who.
    expect(JSON.stringify(mockAuditInsert.mock.calls[0][0].extra)).not.toContain('attack-31');
  });

  it('balanced raid mode admits later joins with the same hold and does not count them', async () => {
    const result = await checkServerJoinRaid({
      serverId: 'server-raid-mode',
      actorId: 'late-joiner',
      server: { raidMitigationLevel: 'balanced', raidLockdownUntil: 500_000 },
      source: 'discoverable',
      now: 400_000,
    });
    expect(result).toEqual({
      allowed: true, level: 'balanced', counted: false, uniqueAccounts: null,
      hold: { until: 500_000, youngAccountMs: RAID_POLICIES.balanced.youngAccountMs },
    });
    expect(mockSlidingWindowCount).not.toHaveBeenCalled();
  });

  it('strict refuses the join that crosses its threshold and still holds the cohort already in', async () => {
    const policy = RAID_POLICIES.strict;
    mockSlidingWindowCount.mockResolvedValueOnce(policy.maxUniqueAccounts + 1);
    const crossing = await checkServerJoinRaid({
      serverId: 'server-strict', actorId: 'attack-11', server: { raidMitigationLevel: 'strict' }, source: 'invite', now: 70_000,
    });
    expect(crossing).toMatchObject({ allowed: false, code: 'RAID_LOCKDOWN', retryAfterMs: policy.lockdownMs });
    expect(mockHoldCohort).toHaveBeenCalledWith('server-strict', expect.objectContaining({ holdUntil: 70_000 + policy.lockdownMs }));
  });

  it('applyRaidJoinHold holds only young accounts and never shortens a longer timeout', async () => {
    const hold = { until: 900_000, youngAccountMs: 86_400_000 };
    const now = 100_000_000;
    mockMemberFindOne.mockResolvedValue({ timeoutUntil: null });

    mockUserFindById.mockResolvedValueOnce({ createdAt: now - 60_000 });          // 1 minute old
    await expect(applyRaidJoinHold('s', 'young', { ...hold, until: now + 600_000 }, now)).resolves.toBe(true);
    expect(mockMemberSetTimeout).toHaveBeenCalledWith('s', 'young', now + 600_000);

    mockMemberSetTimeout.mockClear();
    mockUserFindById.mockResolvedValueOnce({ createdAt: now - 30 * 86_400_000 }); // 30 days old
    await expect(applyRaidJoinHold('s', 'established', { ...hold, until: now + 600_000 }, now)).resolves.toBe(false);

    mockUserFindById.mockResolvedValueOnce({ createdAt: now - 60_000 });
    mockMemberFindOne.mockResolvedValueOnce({ timeoutUntil: now + 9_999_999 });    // moderator timeout is longer
    await expect(applyRaidJoinHold('s', 'timed-out', { ...hold, until: now + 600_000 }, now)).resolves.toBe(false);

    await expect(applyRaidJoinHold('s', 'any', null, now)).resolves.toBe(false);   // no raid mode right now
    await expect(applyRaidJoinHold('s', 'any', { ...hold, until: now - 1 }, now)).resolves.toBe(false);
    expect(mockMemberSetTimeout).not.toHaveBeenCalled();
  });

  it('a join counted below the threshold but inserted after raid mode began is still held', async () => {
    const now = 100_000_000;
    // The decision carried no hold, but by the time the insert landed the
    // crossing join had persisted raid mode.
    mockServerFindById.mockResolvedValueOnce({ raidMitigationLevel: 'balanced', raidLockdownUntil: now + 600_000 });
    mockUserFindById.mockResolvedValueOnce({ createdAt: now - 5_000 });
    mockMemberFindOne.mockResolvedValueOnce({ timeoutUntil: null });
    await expect(applyRaidJoinHold('s', 'late-insert', null, now)).resolves.toBe(true);
    expect(mockMemberSetTimeout).toHaveBeenCalledWith('s', 'late-insert', now + 600_000);

    // Level off: never held, whatever the stored deadline.
    mockServerFindById.mockResolvedValueOnce({ raidMitigationLevel: 'off', raidLockdownUntil: now + 600_000 });
    await expect(applyRaidJoinHold('s', 'off-server', null, now)).resolves.toBe(false);
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

  it('keeps durable lockdown active even when audit logging fails', async () => {
    const policy = RAID_POLICIES.balanced;
    mockSlidingWindowCount.mockResolvedValueOnce(policy.maxUniqueAccounts + 1);
    mockHoldCohort.mockResolvedValueOnce(4);
    mockAuditInsert.mockRejectedValueOnce(new Error('audit store unavailable'));

    const result = await checkServerJoinRaid({
      serverId: 'server-audit-down',
      actorId: 'surge-user',
      server: { raidMitigationLevel: 'balanced' },
      source: 'discoverable',
      now: 200_000,
    });

    expect(result).toMatchObject({
      allowed: true,
      level: 'balanced',
      uniqueAccounts: policy.maxUniqueAccounts + 1,
    });
    expect(mockServerUpdate).toHaveBeenCalled();
    expect(mockHoldCohort).toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'raid.audit.failed', serverId: 'server-audit-down' }),
      expect.any(String),
    );
  });

  it('fails closed when the threshold crossing cannot persist durable raid mode', async () => {
    const policy = RAID_POLICIES.strict;
    mockSlidingWindowCount.mockResolvedValueOnce(policy.maxUniqueAccounts + 1);
    mockServerUpdate.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(checkServerJoinRaid({
      serverId: 'server-persist-down',
      actorId: 'surge-user',
      server: { raidMitigationLevel: 'strict' },
      source: 'invite',
      now: 300_000,
    })).resolves.toEqual({
      allowed: false,
      level: 'strict',
      code: 'RAID_LOCKDOWN',
      retryAfterMs: policy.windowMs,
      lockdownUntil: null,
      uniqueAccounts: policy.maxUniqueAccounts + 1,
    });

    expect(mockHoldCohort).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'raid.lockdown.persist_failed', serverId: 'server-persist-down' }),
      expect.any(String),
    );
  });

  it('uses the bounded single-node counter fallback when shared sliding windows are unavailable by design', async () => {
    mockSlidingWindowCount.mockResolvedValue(null);
    const server = { raidMitigationLevel: 'balanced' };

    const first = await checkServerJoinRaid({
      serverId: 'single-node',
      actorId: 'one',
      server,
      source: 'discoverable',
      now: 1_000,
    });
    const second = await checkServerJoinRaid({
      serverId: 'single-node',
      actorId: 'two',
      server,
      source: 'discoverable',
      now: 1_001,
    });

    expect(first).toMatchObject({ allowed: true, counted: true, uniqueAccounts: 1 });
    expect(second).toMatchObject({ allowed: true, counted: true, uniqueAccounts: 2 });
  });

  it('rejects malformed identities/time and treats invalid persisted lockdown data as inactive', async () => {
    await expect(checkServerJoinRaid({
      serverId: '',
      actorId: 'u',
      server: { raidMitigationLevel: 'balanced' },
      source: 'discoverable',
      now: 1,
    })).rejects.toThrow('serverId');

    await expect(checkServerJoinRaid({
      serverId: 's',
      actorId: '',
      server: { raidMitigationLevel: 'balanced' },
      source: 'discoverable',
      now: 1,
    })).rejects.toThrow('actorId');

    await expect(checkServerJoinRaid({
      serverId: 's',
      actorId: 'u',
      server: { raidMitigationLevel: 'balanced' },
      source: 'discoverable',
      now: -1,
    })).rejects.toThrow('now');

    mockSlidingWindowCount.mockResolvedValueOnce(1);
    await expect(checkServerJoinRaid({
      serverId: 's',
      actorId: 'u',
      server: { raidMitigationLevel: 'balanced', raidLockdownUntil: 'corrupt' },
      source: 'discoverable',
      now: 10,
    })).resolves.toMatchObject({ allowed: true, counted: true, uniqueAccounts: 1 });
  });

  it('does not hold when raid state/user metadata is missing or already expired', async () => {
    const now = 1_000_000;
    mockServerFindById.mockResolvedValueOnce(null);
    await expect(applyRaidJoinHold('s', 'u', null, now)).resolves.toBe(false);

    mockUserFindById.mockResolvedValueOnce(null);
    await expect(applyRaidJoinHold('s', 'u', {
      until: now + 10_000,
      youngAccountMs: 86_400_000,
    }, now)).resolves.toBe(false);

    expect(raidProtectionStatus({
      raidMitigationLevel: 'off',
      raidLockdownUntil: now + 10_000,
    }, now)).toEqual({
      level: 'off',
      active: false,
      lockdownUntil: now + 10_000,
      policy: null,
    });
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
