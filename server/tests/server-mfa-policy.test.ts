process.env.NODE_ENV = 'test';

jest.mock('../db/repositories', () => ({
  Auth: { findCredentialsByUser: jest.fn() },
}));

import { Auth } from '../db/repositories';
import {
  parseServerMfaLevelWrite,
  effectiveServerMfaLevel,
  checkServerJoinMfa,
} from '../lib/serverMfaPolicy';

describe('serverMfaPolicy', () => {
  beforeEach(() => jest.clearAllMocks());

  it('accepts only the exact numeric write enum', () => {
    expect([0, 1, 2].map(parseServerMfaLevelWrite)).toEqual([0, 1, 2]);
    for (const bad of ['0', '1', '2', -1, 3, 1.5, NaN, Infinity, {}, []]) {
      expect(parseServerMfaLevelWrite(bad)).toBeNull();
    }
  });

  it('keeps missing historical value at 0 but fails closed on corrupt persisted values', () => {
    expect(effectiveServerMfaLevel(undefined)).toBe(0);
    expect(effectiveServerMfaLevel(null)).toBe(0);
    expect(effectiveServerMfaLevel(0)).toBe(0);
    expect(effectiveServerMfaLevel(1)).toBe(1);
    expect(effectiveServerMfaLevel(2)).toBe(2);
    expect(effectiveServerMfaLevel('2')).toBe(2);
    expect(effectiveServerMfaLevel(99)).toBe(2);
  });

  it('does not touch credential storage when MFA is disabled', async () => {
    const result = await checkServerJoinMfa('u', 's', 0);
    expect(result).toEqual({ level: 0, required: false, satisfied: true, unavailable: false });
    expect(Auth.findCredentialsByUser).not.toHaveBeenCalled();
  });

  it('requires a passkey when configured', async () => {
    (Auth.findCredentialsByUser as jest.Mock).mockResolvedValueOnce([]);
    await expect(checkServerJoinMfa('u', 's', 1)).resolves.toMatchObject({
      level: 1, required: true, satisfied: false, unavailable: false,
    });
    (Auth.findCredentialsByUser as jest.Mock).mockResolvedValueOnce([{ _id: 'c' }]);
    await expect(checkServerJoinMfa('u', 's', 2)).resolves.toMatchObject({
      level: 2, required: true, satisfied: true, unavailable: false,
    });
  });

  it('fails closed when passkey authority is unavailable', async () => {
    (Auth.findCredentialsByUser as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    await expect(checkServerJoinMfa('u', 's', 2)).resolves.toMatchObject({
      level: 2, required: true, satisfied: false, unavailable: true,
    });
  });
});
