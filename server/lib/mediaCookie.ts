import type { Response } from 'express';
import { makeMediaToken } from '../middleware/auth';

export interface MediaCookieUser {
  _id?: string;
  id?: string;
  username?: string;
  tokenVersion?: number;
}

const DEFAULT_MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Keep the browser cookie and its signed JWT on the same lifetime. JWT accepts
 * compact duration strings; deployment configuration currently uses `7d`.
 */
export function mediaTokenTtlMs(value = process.env.MEDIA_TOKEN_TTL || '7d'): number {
  const match = /^(\d+)(ms|s|m|h|d|w)$/i.exec(value.trim());
  if (!match) return DEFAULT_MEDIA_TTL_MS;
  const amount = Number(match[1]);
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  const unitKey = (match[2] ?? '').toLowerCase();
  const unitMs = units[unitKey];
  // Bilinmeyen/eksik birim: uydurma bir süre yerine güvenli varsayılan.
  if (unitMs === undefined) return DEFAULT_MEDIA_TTL_MS;
  const duration = amount * unitMs;
  return Number.isSafeInteger(duration) && duration > 0 ? duration : DEFAULT_MEDIA_TTL_MS;
}

/**
 * Canonical owner of the private-attachment identity cookie.
 *
 * The token contains identity + tokenVersion only. File permission is resolved
 * again by uploadAuthz for every request; no role/admin claim is copied here.
 */
export function setMediaCookie(res: Response, user: MediaCookieUser): void {
  const id = String(user._id ?? user.id ?? '');
  if (!id) return;

  const token = makeMediaToken({
    _id: id,
    username: String(user.username ?? ''),
    tokenVersion: user.tokenVersion,
  });

  res.cookie('bridge_media', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/uploads',
    maxAge: mediaTokenTtlMs(),
  });
}

export function clearMediaCookie(res: Response): void {
  res.clearCookie('bridge_media', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/uploads',
  });
}
