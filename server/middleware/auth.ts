// @ts-nocheck
// server/middleware/auth.ts
// JWT auth + refresh token rotation (stored in DB)
// JWT_SECRET / REFRESH_SECRET hiçbir zaman hardcoded default kullanmıyor.
//      Eksik veya güvensiz değer → production'da process.exit(1), dev'de hata fırlatır.

import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import logger from '../lib/logger';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Auth, Users } = require('../db/repositories') as { Auth: any; Users: any };
import { Request, Response, NextFunction } from 'express';

export interface JwtPayload {
  id: string;
  username: string;
  v: number;
  iat?: number;
  exp?: number;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
  headers: Request['headers'] & { authorization?: string };
}

/**
 * AuthedRequest — authMiddleware'den geçtiği garantili route'lar için.
 * user alanı non-optional'dır; null check gerektirmez.
 *
 * @example
 *   router.get('/profile', authMiddleware, asyncHandler(async (req: AuthedRequest, res) => {
 *     const id = req.user.id; // ✅ tip hatası yok
 *   }));
 */
export interface AuthedRequest extends Request {
  user: JwtPayload; // non-optional — authMiddleware garantisi
  headers: Request['headers'] & { authorization?: string };
}

/**
 * castAuthed — require()-style route'lar için tip dönüşüm yardımcısı.
 * authMiddleware zaten user'ı doldurduğundan bu cast güvenlidir.
 *
 * @example
 *   router.get('/me', authMiddleware, asyncHandler(async (req, res) => {
 *     const { id } = castAuthed(req).user;
 *   }));
 */
export function castAuthed(req: Request): AuthedRequest {
  return req as AuthedRequest;
}

// ── SECRET VALIDATION ────────────────────────────────────────
const INSECURE_DEFAULTS = new Set([
  'bridge-dev-secret-CHANGE-IN-PRODUCTION',
  'bridge-refresh-secret-CHANGE-IN-PRODUCTION',
  'CHANGE_ME_LONG_RANDOM_STRING',
  'CHANGE_ME_DIFFERENT_LONG_STRING',
  'secret',
  'changeme',
]);

function _validateSecret(name: string, value: string | undefined): void {
  if (!value) {
    const msg =
      `[Auth] FATAL: ${name} environment variable is missing.\n` +
      `       Generate one with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`;
    if (process.env.NODE_ENV === 'production') {
      logger.fatal({ secretName: name, event: 'auth.secret.missing' }, msg);
      process.exit(1);
    }
    throw new Error(msg);
  }
  if (INSECURE_DEFAULTS.has(value)) {
    const msg =
      `[Auth] FATAL: ${name} uses an insecure default value.\n` +
      `       Never use this in production. Generate a secure value:\n` +
      `       node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`;
    if (process.env.NODE_ENV === 'production') {
      logger.fatal({ secretName: name, event: 'auth.secret.insecure_default' }, msg);
      process.exit(1);
    }
    logger.warn({ secretName: name, event: 'auth.secret.insecure_default' }, msg);
  }
  if (value.length < 32) {
    const msg = `[Auth] WARNING: ${name} is too short (${value.length} chars). At least 32 chars are recommended.`;
    if (process.env.NODE_ENV === 'production') {
      logger.fatal({ secretName: name, length: value.length, event: 'auth.secret.too_short' }, msg);
      process.exit(1);
    }
    logger.warn({ secretName: name, length: value.length, event: 'auth.secret.too_short' }, msg);
  }
}

_validateSecret('JWT_SECRET', process.env.JWT_SECRET);
_validateSecret('REFRESH_SECRET', process.env.REFRESH_SECRET);

const JWT_SECRET = process.env.JWT_SECRET as string;
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
const REFRESH_TOKEN_TTL = process.env.REFRESH_TOKEN_TTL || '30d';

// TTL in ms for refresh token DB rows
const REFRESH_TTL_MS = (() => {
  const t = REFRESH_TOKEN_TTL;
  const n = parseInt(t);
  if (t.endsWith('d')) return n * 86400000;
  if (t.endsWith('h')) return n * 3600000;
  return 30 * 86400000;
})();

export interface UserLike {
  _id: string;
  username: string;
  tokenVersion?: number;
}

export function makeToken(user: UserLike): string {
  return jwt.sign(
    { id: user._id, username: user.username, v: user.tokenVersion || 0 },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

// Each refresh token is a random opaque string stored in the DB
// This allows true rotation: using a token once invalidates it.
// family: her giriş oturumuna yeni bir UUID atanır — token zinciri izlenir.
export async function makeRefreshToken(user: UserLike): Promise<string> {
  const token = crypto.randomBytes(48).toString('hex');
  const family = crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  await Auth.insertRefreshTokenRow({
    token,
    userId: user._id,
    expiresAt: now + REFRESH_TTL_MS,
    createdAt: now,
    used: false,
    family,
  });
  return token;
}

export interface RotateResult {
  user: UserLike;
  newToken: string;
}

export async function rotateRefreshToken(oldToken: string): Promise<RotateResult | null> {
  const row = await Auth.findRefreshToken(oldToken);

  // ── TOKEN REUSE DETECTION — AİLE BAZLI İPTAL ─────────────────
  if (row && row.used) {
    logger.warn(
      { userId: row.userId, family: row.family, event: 'auth.refresh_token.reuse_detected' },
      'Refresh token reuse detected. Revoking token family.'
    );
    if (row.family) {
      await Auth.revokeByFamily(row.family);
    } else {
      await Auth.revokeAllForUser(row.userId);
    }
    return null;
  }

  if (!row) return null;
  if (row.expiresAt < Date.now()) {
    await Auth.revokeRefreshToken(oldToken);
    return null;
  }

  await Auth.updateRefreshTokenWhere(
    { token: oldToken },
    { $set: { used: true, usedAt: Date.now() } }
  );

  const user = await Users.findById(row.userId);
  if (!user) return null;

  const newToken = crypto.randomBytes(48).toString('hex');
  await Auth.insertRefreshTokenRow({
    token: newToken,
    userId: user._id,
    expiresAt: Date.now() + REFRESH_TTL_MS,
    createdAt: Date.now(),
    used: false,
    family: row.family || oldToken.slice(0, 16),
  });
  return { user, newToken };
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await Auth.revokeAllForUser(userId);
}

// Clean expired + used refresh tokens periodically
setInterval(async () => {
  try {
    const now = Date.now();
    await Auth.removeRefreshTokensWhere({ expiresAt: { $lt: now } });
    await Auth.removeRefreshTokensWhere({ used: true, usedAt: { $lt: now - 5 * 60_000 } });
  } catch { /* ignore */ }
}, 60 * 60 * 1000); // every hour

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

// Token version cache (avoids DB hit on every request)
const TOKEN_CACHE_TTL = 30_000;
const _cache = new Map<string, { version: number; expiresAt: number }>();
const MAX_TOKEN_CACHE_ENTRIES = 50_000;

export function _invalidateTokenCache(userId: string): void {
  _cache.delete(userId);
}

function _setTokenCache(userId: string, version: number): void {
  if (!_cache.has(userId) && _cache.size >= MAX_TOKEN_CACHE_ENTRIES) {
    _cache.delete(_cache.keys().next().value as string);
  }
  _cache.set(userId, { version, expiresAt: Date.now() + TOKEN_CACHE_TTL });
}

async function _getTokenVersion(userId: string): Promise<number | null> {
  const cached = _cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.version;
  const user = await Users.findById(userId);
  if (!user) return null;
  const version = (user as UserLike & { tokenVersion?: number }).tokenVersion || 0;
  _setTokenCache(userId, version);
  return version;
}

export async function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const decoded = verifyToken(header.slice(7));
  if (!decoded) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  try {
    const currentVersion = await _getTokenVersion(decoded.id);
    if (currentVersion === null) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    if ((decoded.v ?? 0) !== currentVersion) {
      res.status(401).json({ error: 'Token revoked. Please log in again.' });
      return;
    }
    req.user = decoded;
    next();
  } catch {
    res.status(500).json({ error: 'Auth check failed' });
  }
}
