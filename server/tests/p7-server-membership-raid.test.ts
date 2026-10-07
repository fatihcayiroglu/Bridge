'use strict';

const mockServerFindById = jest.fn();
const mockMemberFindIncludingBanned = jest.fn();
const mockMemberInsertIfAbsent = jest.fn();
const mockCacheDel = jest.fn();
const mockInvalidateMemberships = jest.fn();
const mockCheckMfa = jest.fn();
const mockCheckRaid = jest.fn();
const mockApplyHold = jest.fn(async () => false);
const mockTryRequire = jest.fn();
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../db/repositories', () => ({
  Servers: {
    findById: (...args: unknown[]) => mockServerFindById(...args),
  },
  Members: {
    findIncludingBanned: (...args: unknown[]) => mockMemberFindIncludingBanned(...args),
    insertIfAbsent: (...args: unknown[]) => mockMemberInsertIfAbsent(...args),
  },
}));
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    del: (...args: unknown[]) => mockCacheDel(...args),
  },
}));
jest.mock('../lib/presenceCache', () => ({
  invalidateMemberships: (...args: unknown[]) => mockInvalidateMemberships(...args),
}));
jest.mock('../lib/serverMfaPolicy', () => ({
  checkServerJoinMfa: (...args: unknown[]) => mockCheckMfa(...args),
}));
jest.mock('../lib/raidProtection', () => ({
  checkServerJoinRaid: (...args: unknown[]) => mockCheckRaid(...args),
  applyRaidJoinHold: (...args: unknown[]) => mockApplyHold(...(args as [])),
}));
jest.mock('../lib/_optional-require', () => ({
  tryRequire: (...args: unknown[]) => mockTryRequire(...args),
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: mockLogger,
}));

import { afterMemberJoined, joinDiscoverableServer } from '../lib/serverMembership';

const ACTOR = { id: 'user-a', username: 'alice', displayName: 'Alice' };

beforeEach(() => {
  jest.clearAllMocks();
  mockServerFindById.mockResolvedValue({
    _id: 'server-a',
    ownerId: 'owner',
    discoverable: true,
    mfaLevel: 0,
    raidMitigationLevel: 'balanced',
  });
  mockMemberFindIncludingBanned.mockResolvedValue(null);
  mockMemberInsertIfAbsent.mockResolvedValue(true);
  mockCacheDel.mockResolvedValue(undefined);
  mockInvalidateMemberships.mockResolvedValue(undefined);
  mockCheckMfa.mockResolvedValue({
    required: false,
    satisfied: true,
    level: 0,
    unavailable: false,
  });
  mockTryRequire.mockReturnValue(null);
  mockCheckRaid.mockResolvedValue({
    allowed: true,
    level: 'balanced',
    counted: true,
    uniqueAccounts: 1,
  });
});

describe('P7 B1 discoverable join ordering', () => {
  it('returns not_found/already_member before MFA or raid accounting', async () => {
    mockServerFindById.mockResolvedValueOnce(null);
    await expect(joinDiscoverableServer(ACTOR, 'missing'))
      .resolves.toEqual({ status: 'not_found' });
    expect(mockMemberFindIncludingBanned).not.toHaveBeenCalled();

    mockMemberFindIncludingBanned.mockResolvedValueOnce({ banned: false });
    await expect(joinDiscoverableServer(ACTOR, 'server-a'))
      .resolves.toMatchObject({ status: 'already_member' });
    expect(mockCheckMfa).not.toHaveBeenCalled();
    expect(mockCheckRaid).not.toHaveBeenCalled();
  });

  it('reports MFA authority outage without consuming raid capacity', async () => {
    mockCheckMfa.mockResolvedValueOnce({
      required: true,
      satisfied: false,
      level: 2,
      unavailable: true,
    });

    await expect(joinDiscoverableServer(ACTOR, 'server-a'))
      .resolves.toMatchObject({
        status: 'mfa_required',
        mfaLevel: 2,
        mfaUnavailable: true,
      });
    expect(mockCheckRaid).not.toHaveBeenCalled();
  });

  it('re-reads the canonical winner when a concurrent membership insert loses', async () => {
    mockMemberInsertIfAbsent.mockResolvedValueOnce(false);
    mockMemberFindIncludingBanned
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ banned: true });

    await expect(joinDiscoverableServer(ACTOR, 'server-a'))
      .resolves.toMatchObject({ status: 'banned' });
    expect(mockApplyHold).not.toHaveBeenCalled();

    jest.clearAllMocks();
    mockServerFindById.mockResolvedValue({
      _id: 'server-a', ownerId: 'owner', discoverable: true, mfaLevel: 0,
      raidMitigationLevel: 'balanced',
    });
    mockMemberFindIncludingBanned
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ banned: false });
    mockMemberInsertIfAbsent.mockResolvedValueOnce(false);
    mockCheckMfa.mockResolvedValue({
      required: false, satisfied: true, level: 0, unavailable: false,
    });
    mockCheckRaid.mockResolvedValue({
      allowed: true, level: 'balanced', counted: true, uniqueAccounts: 1, hold: null,
    });

    await expect(joinDiscoverableServer(ACTOR, 'server-a'))
      .resolves.toMatchObject({ status: 'already_member' });
    expect(mockApplyHold).not.toHaveBeenCalled();
  });

  it('post-commit cache/webhook/plugin failures never roll back a committed membership', async () => {
    const webhook = { dispatchEvent: jest.fn().mockRejectedValue(new Error('webhook down')) };
    const plugin = { hooks: { emit: jest.fn().mockRejectedValue(new Error('plugin down')) } };
    mockTryRequire.mockImplementation((request: string) =>
      request.includes('outgoingWebhooks') ? webhook : plugin);
    mockCacheDel.mockRejectedValueOnce(new Error('cache down'));

    await expect(afterMemberJoined(ACTOR, 'server-a')).resolves.toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));

    expect(mockInvalidateMemberships).toHaveBeenCalledWith('user-a');
    expect(webhook.dispatchEvent).toHaveBeenCalledWith('server-a', 'member:join', { userId: 'user-a' });
    expect(plugin.hooks.emit).toHaveBeenCalledWith('member:joined', expect.objectContaining({
      userId: 'user-a', serverId: 'server-a',
    }));
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'server_join.member_count_cache_invalidate_failed' }),
      expect.any(String),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'server_join.webhook_enqueue_failed' }),
      expect.any(String),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'server_join.plugin_hook_failed' }),
      expect.any(String),
    );
  });

  it('synchronous plugin exceptions are isolated after membership commit', async () => {
    mockTryRequire.mockImplementation((request: string) => {
      if (request.includes('outgoingWebhooks')) return null;
      return { hooks: { emit: () => { throw new Error('plugin sync throw'); } } };
    });

    await expect(afterMemberJoined(ACTOR, 'server-a')).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'server_join.plugin_hook_failed' }),
      expect.any(String),
    );
  });

  it('banned actors are rejected before raid accounting', async () => {
    mockMemberFindIncludingBanned.mockResolvedValueOnce({ banned: true });

    await expect(joinDiscoverableServer(ACTOR, 'server-a'))
      .resolves.toMatchObject({ status: 'banned' });

    expect(mockCheckMfa).not.toHaveBeenCalled();
    expect(mockCheckRaid).not.toHaveBeenCalled();
    expect(mockMemberInsertIfAbsent).not.toHaveBeenCalled();
  });

  it('private/invite-required servers do not consume the raid window', async () => {
    mockServerFindById.mockResolvedValueOnce({
      _id: 'server-a',
      discoverable: false,
      mfaLevel: 0,
      raidMitigationLevel: 'balanced',
    });

    await expect(joinDiscoverableServer(ACTOR, 'server-a'))
      .resolves.toMatchObject({ status: 'invite_required' });

    expect(mockCheckMfa).not.toHaveBeenCalled();
    expect(mockCheckRaid).not.toHaveBeenCalled();
  });

  it('failed MFA is not counted as a raid join attempt', async () => {
    mockCheckMfa.mockResolvedValueOnce({
      required: true,
      satisfied: false,
      level: 2,
      unavailable: false,
    });

    await expect(joinDiscoverableServer(ACTOR, 'server-a'))
      .resolves.toMatchObject({ status: 'mfa_required', mfaLevel: 2 });

    expect(mockCheckRaid).not.toHaveBeenCalled();
    expect(mockMemberInsertIfAbsent).not.toHaveBeenCalled();
  });

  it('during balanced raid mode the join commits and THEN the surge hold is applied to the new member', async () => {
    const hold = { until: 999_000, youngAccountMs: 86_400_000 };
    mockCheckRaid.mockResolvedValueOnce({ allowed: true, level: 'balanced', counted: false, uniqueAccounts: null, hold });

    await expect(joinDiscoverableServer(ACTOR, 'server-a')).resolves.toMatchObject({ status: 'joined' });

    expect(mockMemberInsertIfAbsent).toHaveBeenCalledTimes(1);
    expect(mockApplyHold).toHaveBeenCalledWith('server-a', 'user-a', hold);
    expect(mockMemberInsertIfAbsent.mock.invocationCallOrder[0]).toBeLessThan(mockApplyHold.mock.invocationCallOrder[0]);
  });

  it('an eligible actor is blocked before membership mutation when raid lockdown is active', async () => {
    mockCheckRaid.mockResolvedValueOnce({
      allowed: false,
      level: 'strict',
      code: 'RAID_LOCKDOWN',
      retryAfterMs: 30_000,
      lockdownUntil: 90_000,
      uniqueAccounts: 11,
    });

    await expect(joinDiscoverableServer(ACTOR, 'server-a')).resolves.toEqual(
      expect.objectContaining({
        status: 'raid_lockdown',
        retryAfterMs: 30_000,
        lockdownUntil: 90_000,
        raidLevel: 'strict',
      }),
    );

    expect(mockCheckRaid).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'server-a',
      actorId: 'user-a',
      source: 'discoverable',
    }));
    expect(mockMemberInsertIfAbsent).not.toHaveBeenCalled();
  });

  it('authority loss is explicit and no membership is written', async () => {
    mockCheckRaid.mockResolvedValueOnce({
      allowed: false,
      level: 'balanced',
      code: 'RAID_AUTHORITY_UNAVAILABLE',
      retryAfterMs: 1_000,
      lockdownUntil: null,
      uniqueAccounts: null,
    });

    await expect(joinDiscoverableServer(ACTOR, 'server-a')).resolves.toMatchObject({
      status: 'raid_authority_unavailable',
      retryAfterMs: 1_000,
    });
    expect(mockMemberInsertIfAbsent).not.toHaveBeenCalled();
  });

  it('eligible legitimate join still commits once and runs post-commit invalidation', async () => {
    await expect(joinDiscoverableServer(ACTOR, 'server-a'))
      .resolves.toMatchObject({ status: 'joined' });

    expect(mockCheckRaid).toHaveBeenCalledTimes(1);
    expect(mockMemberInsertIfAbsent).toHaveBeenCalledWith('user-a', 'server-a', []);
    expect(mockInvalidateMemberships).toHaveBeenCalledWith('user-a');
    expect(mockCacheDel).toHaveBeenCalledWith('discover:memberCount:server-a');
  });
});
