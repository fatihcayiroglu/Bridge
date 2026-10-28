import type { Response } from 'express';

const REFRESH_COOKIE = 'bridge_refresh';
const REFRESH_COOKIE_PATH = '/api/refresh';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function secureCookie(): boolean {
  if (process.env.NODE_ENV === 'production') return true;
  // Staging/development can terminate real HTTPS too. Use operator config,
  // never a request's spoofable forwarding header, to preserve Secure there.
  try { return new URL(process.env.BASE_URL || '').protocol === 'https:'; }
  catch { return false; } // existing local HTTP development behavior
}

/**
 * Canonical browser refresh-session cookie owner.
 * Refresh tokens must not be exposed to browser JavaScript/localStorage.
 */
export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: secureCookie(),
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: secureCookie(),
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
  });
}

export const refreshCookiePath = REFRESH_COOKIE_PATH;
