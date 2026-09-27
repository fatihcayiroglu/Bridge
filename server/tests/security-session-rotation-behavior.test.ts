const incrementTokenVersion = jest.fn();
const revokeAllForUser = jest.fn();
const findById = jest.fn();
const invalidateTokenCache = jest.fn();
const makeRefreshToken = jest.fn();
const makeToken = jest.fn();
const setRefreshCookie = jest.fn();
const setMediaCookie = jest.fn();
const disconnectLiveUserSessions = jest.fn();

jest.mock('../db/repositories', () => ({
  Users: { incrementTokenVersion, findById },
  Auth: { revokeAllForUser },
}));
jest.mock('../middleware/auth', () => ({ _invalidateTokenCache: invalidateTokenCache, makeRefreshToken, makeToken }));
jest.mock('../lib/authCookies', () => ({ setRefreshCookie }));
jest.mock('../lib/mediaCookie', () => ({ setMediaCookie }));
jest.mock('../lib/sessionRevocation', () => ({ disconnectLiveUserSessions }));

import { rotateSecuritySession } from '../lib/securitySession';

beforeEach(() => {
  jest.clearAllMocks();
  incrementTokenVersion.mockResolvedValue(undefined);
  revokeAllForUser.mockResolvedValue(undefined);
  makeRefreshToken.mockResolvedValue('refresh-new');
  makeToken.mockReturnValue('access-new');
  disconnectLiveUserSessions.mockResolvedValue(undefined);
});

describe('security-policy credential rotation', () => {
  it('increments tokenVersion, revokes refresh state, replaces cookies, and disconnects live sessions', async () => {
    const user = { _id: 'u-1', username: 'alice', tokenVersion: 4 };
    findById.mockResolvedValue(user);
    const res = {} as any;
    await expect(rotateSecuritySession('u-1', res, 'mfa changed')).resolves.toEqual({ token: 'access-new', user });
    expect(incrementTokenVersion).toHaveBeenCalledWith('u-1');
    expect(revokeAllForUser).toHaveBeenCalledWith('u-1');
    expect(invalidateTokenCache).toHaveBeenCalledWith('u-1');
    expect(makeRefreshToken).toHaveBeenCalledWith(user);
    expect(setRefreshCookie).toHaveBeenCalledWith(res, 'refresh-new');
    expect(setMediaCookie).toHaveBeenCalledWith(res, user);
    expect(disconnectLiveUserSessions).toHaveBeenCalledWith('u-1', 'mfa changed');
    expect(makeToken).toHaveBeenCalledWith(user);
  });

  it('fails closed if the user disappears after revocation and does not mint replacement credentials', async () => {
    findById.mockResolvedValue(null);
    await expect(rotateSecuritySession('u-1', {} as any, 'security change')).rejects.toThrow('User disappeared');
    expect(incrementTokenVersion).toHaveBeenCalled();
    expect(revokeAllForUser).toHaveBeenCalled();
    expect(makeRefreshToken).not.toHaveBeenCalled();
    expect(setRefreshCookie).not.toHaveBeenCalled();
    expect(disconnectLiveUserSessions).not.toHaveBeenCalled();
  });

  it('does not continue to credential minting when revocation storage fails', async () => {
    revokeAllForUser.mockRejectedValue(new Error('refresh store down'));
    await expect(rotateSecuritySession('u-1', {} as any, 'security change')).rejects.toThrow('refresh store down');
    expect(findById).not.toHaveBeenCalled();
    expect(makeToken).not.toHaveBeenCalled();
  });
});
