'use strict';

const mockServerFindById = jest.fn();
const mockMemberFindIncludingBanned = jest.fn();
const mockMemberInsertIfAbsent = jest.fn();
const mockCacheDel = jest.fn();
const mockInvalidateMemberships = jest.fn();
const mockCheckMfa = jest.fn();
const mockCheckRaid = jest.fn();

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
}));
jest.mock('../lib/_optional-require', () => ({
  tryRequire: () => null,
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { joinDiscoverableServer } from '../lib/serverMembership';

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
  mockCheckRaid.mockResolvedValue({
    allowed: true,
    level: 'balanced',
    counted: true,
    uniqueAccounts: 1,
  });
});

describe('P7 B1 discoverable join ordering', () => {
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
