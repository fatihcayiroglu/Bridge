// JWT auth + refresh token rotation (stored in DB)
// JWT_SECRET / REFRESH_SECRET hiçbir zaman hardcoded default kullanmıyor.
// REFRESH_SECRET: refresh token'ları DB'de HMAC-SHA256 ile pepper'lar (plain text saklanmaz).

import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import logger from '../lib/logger';
import { Auth, Users } from '../db/repositories';
import { Request, Response, NextFunction } from 'express';
import type { AuthedRequest as _AuthedRequest } from '../types/express.d';

export interface JwtPayload {
  id: string;
  _id?: string;
  username: string;
  v: number;
  isAdmin?: boolean;
  displayName?: string;
  avatarColor?: string;
  role?: string;
  flags?: string[];
  iat?: number;
  exp?: number;
}

export interface AuthRequest extends Request {
  user: JwtPayload;
  headers: Request['headers'] & { authorization?: string };
}

export type { AuthedRequest } from '../types/express.d';

export function castAuthed(req: Request): _AuthedRequest {
  return req as _AuthedRequest;
}

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
    console.error('\n' + '█'.repeat(60));
    console.error('█  ⚠️  GÜVENSİZ VARSAYILAN SECRET KULLANILIYOR' + ' '.repeat(13) + '█');
    console.error('█  ' + name.padEnd(55) + '█');
    console.error('█  Production\'a bu değerle ÇIKMA!'.padEnd(59) + '█');
    console.error('█'.repeat(60) + '\n');
    logger.warn({ secretName: name, event: 'auth.secret.insecure_default' }, msg);
    if (process.env.CI !== 'true' && process.env.NODE_ENV !== 'test') {
      const start = Date.now();
      while (Date.now() - start < 3000) { /* intentional busy-wait */ }
    }
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
const REFRESH_SECRET = process.env.REFRESH_SECRET as string;
const ACCESS_TOKEN_TTL = (process.env.ACCESS_TOKEN_TTL || '15m') as import('jsonwebtoken').SignOptions['expiresIn'];
const REFRESH_TOKEN_TTL = process.env.REFRESH_TOKEN_TTL || '30d';

const REFRESH_TTL_MS = (() => {
  const t = REFRESH_TOKEN_TTL;
  const n = parseInt(t);
  if (t.endsWith('d')) return n * 86400000;
  if (t.endsWith('h')) return n * 3600000;
  return 30 * 86400000;
})();

function _hashRefreshToken(rawToken: string): string {
  return crypto.createHmac('sha256', REFRESH_SECRET).update(rawToken).digest('hex');
}

async function _findRefreshTokenRow(rawToken: string) {
  const hashed = _hashRefreshToken(rawToken);
  let row = await Auth.findRefreshToken(hashed);
  if (!row && process.env.NODE_ENV !== 'production') {
    row = await Auth.findRefreshToken(rawToken);
  }
  return row;
}

export interface UserLike {
  _id: string;
  username: string;
  tokenVersion?: number;
  isAdmin?: boolean | 0 | 1;
  role?: string;
  flags?: string[];
}

export function makeToken(user: UserLike): string {
  const flags = Array.isArray(user.flags) ? user.flags : [];
  const adminByClaims = Boolean(user.isAdmin) || user.role === 'admin' || flags.includes('admin');

  return jwt.sign(
    {
      id: user._id,
      username: user.username,
      v: user.tokenVersion || 0,
      ...(adminByClaims && { isAdmin: true as const }),
      ...(user.role && { role: user.role }),
      ...(flags.length && { flags }),
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

export async function makeRefreshToken(user: UserLike): Promise<string> {
  const token = crypto.randomBytes(48).toString('hex');
  const family = crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  await Auth.insertRefreshTokenRow({
    token: _hashRefreshToken(token),
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

export type RotateError = 'reuse' | 'expired' | 'not_found' | 'user_not_found';
export type RotateResultOrError = RotateResult | { error: RotateError };

export async function rotateRefreshToken(oldToken: string): Promise<RotateResultOrError | null> {
  const row = await _findRefreshTokenRow(oldToken);

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
    return { error: 'reuse' as RotateError };
  }

  if (!row) return { error: 'not_found' as RotateError };
  if (row.expiresAt < Date.now()) {
    await Auth.revokeRefreshToken(row.token as string);
    return { error: 'expired' as RotateError };
  }

  // SECURITY: compare-and-set is the single-use boundary. A plain
  // "read used=false -> write used=true" sequence is racy: two concurrent
  // refresh requests could both observe the unused row and mint two tokens.
  // The DB UPDATE must win exactly once; the loser is treated as reuse.
  const markedUsed = await Auth.updateRefreshTokenWhere(
    { token: row.token, used: false },
    { $set: { used: true, usedAt: Date.now() } }
  );
  if (!markedUsed || markedUsed.updated !== 1) {
    logger.warn(
      { userId: row.userId, family: row.family, event: 'auth.refresh_token.concurrent_reuse' },
      'Refresh token was already consumed by a concurrent request.'
    );
    if (row.family) {
      await Auth.revokeByFamily(row.family);
    } else {
      await Auth.revokeAllForUser(row.userId);
    }
    return { error: 'reuse' as RotateError };
  }

  const user = await Users.findById(row.userId);
  if (!user) return { error: 'user_not_found' as RotateError };

  const newToken = crypto.randomBytes(48).toString('hex');
  await Auth.insertRefreshTokenRow({
    token: _hashRefreshToken(newToken),
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

let _authCleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startAuthCleanup(): void {
  if (_authCleanupTimer !== null) return;
  _authCleanupTimer = setInterval(async () => {
    try {
      const now = Date.now();
      await Auth.removeRefreshTokensWhere({ expiresAt: { $lt: now } });
      await Auth.removeRefreshTokensWhere({ used: true, usedAt: { $lt: now - 5 * 60_000 } });
    } catch { /* ignore */ }
  }, 5 * 60 * 1000);
  _authCleanupTimer.unref?.();
}

export function stopAuthCleanup(): void {
  if (_authCleanupTimer !== null) {
    clearInterval(_authCleanupTimer);
    _authCleanupTimer = null;
  }
}

/** @internal — sadece testlerde kullanılır */
export function _resetAuthCleanupForTest(): void {
  stopAuthCleanup();
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

const TOKEN_CACHE_TTL = 30_000;
const MAX_TOKEN_CACHE_ENTRIES = 50_000;

type TokenCacheEntry = { version: number; expiresAt: number };

class LruTokenCache {
  private readonly map = new Map<string, TokenCacheEntry>();

  constructor(private readonly max: number) {}

  get(userId: string): TokenCacheEntry | undefined {
    const entry = this.map.get(userId);
    if (!entry) return undefined;
    this.map.delete(userId);
    this.map.set(userId, entry);
    return entry;
  }

  set(userId: string, entry: TokenCacheEntry): void {
    if (this.map.has(userId)) this.map.delete(userId);
    else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
    this.map.set(userId, entry);
  }

  delete(userId: string): void {
    this.map.delete(userId);
  }
}

const _cache = new LruTokenCache(MAX_TOKEN_CACHE_ENTRIES);

export function _invalidateTokenCache(userId: string): void {
  _cache.delete(userId);
}

function _setTokenCache(userId: string, version: number): void {
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

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthRequest).user;
  if (!user?.isAdmin && user?.role !== 'admin' && !user?.flags?.includes('admin')) {
    res.status(403).json({ error: 'Admin required' });
    return;
  }
  next();
}
