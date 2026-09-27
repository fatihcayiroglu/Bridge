import type { Response } from 'express';
import { Auth, Users } from '../db/repositories';
import { _invalidateTokenCache, makeRefreshToken, makeToken } from '../middleware/auth';
import { setRefreshCookie } from './authCookies';
import { setMediaCookie } from './mediaCookie';
import { disconnectLiveUserSessions } from './sessionRevocation';

/**
 * Rotate all credentials after a security-policy change (2FA enable/disable,
 * similar account protection changes). Existing access tokens are invalidated
 * via tokenVersion, refresh sessions are revoked, live sockets are closed, and
 * the caller receives one replacement browser session.
 */
export async function rotateSecuritySession(userId: string, res: Response, reason: string) {
  await Users.incrementTokenVersion(userId);
  await Auth.revokeAllForUser(userId);
  _invalidateTokenCache(userId);

  const updated = await Users.findById(userId);
  if (!updated) throw new Error('User disappeared during security session rotation');

  const refreshToken = await makeRefreshToken(updated);
  setRefreshCookie(res, refreshToken);
  setMediaCookie(res, updated);
  await disconnectLiveUserSessions(userId, reason);

  return { token: makeToken(updated), user: updated };
}
