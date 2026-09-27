import type { Response } from 'express';

const REFRESH_COOKIE = 'bridge_refresh';
const REFRESH_COOKIE_PATH = '/api/refresh';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Canonical browser refresh-session cookie owner.
 * Refresh tokens must not be exposed to browser JavaScript/localStorage.
 */
export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
  });
}

export const refreshCookiePath = REFRESH_COOKIE_PATH;
