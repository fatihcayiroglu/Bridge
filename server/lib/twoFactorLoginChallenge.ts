import crypto from 'crypto';
import { cache, isRedisAvailable } from './redisAdapter';
import { parsePersistedNonNegativeInteger } from './persistedInteger';

type Challenge = { userId: string; tokenVersion: number; issuedAt: number };
const TTL_SECONDS = 5 * 60;
const REDIS_CONFIGURED = Boolean(process.env.REDIS_URL);
const locks = new Map<string, Promise<void>>();


function decodeChallenge(value: unknown): Challenge | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.userId !== 'string' || row.userId.length < 1 || row.userId.length > 256) return null;
  try {
    const tokenVersion = parsePersistedNonNegativeInteger(row.tokenVersion, 'two-factor challenge tokenVersion');
    const issuedAt = parsePersistedNonNegativeInteger(row.issuedAt, 'two-factor challenge issuedAt');
    const now = Date.now();
    if (issuedAt > now + 60_000 || now - issuedAt > TTL_SECONDS * 1000 + 60_000) return null;
    return { userId: row.userId, tokenVersion, issuedAt };
  } catch {
    return null;
  }
}

function requireChallengeAuthority(): void {
  if (REDIS_CONFIGURED && !isRedisAvailable()) {
    throw new Error('Two-factor challenge store unavailable');
  }
}

function tokenKey(token: string): string {
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  return `2fa:login:${digest}`;
}

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  locks.set(key, tail);
  await previous;
  try { return await fn(); }
  finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

export async function issueTwoFactorLoginChallenge(userId: string, tokenVersion: number): Promise<string> {
  requireChallengeAuthority();
  const canonicalVersion = parsePersistedNonNegativeInteger(tokenVersion, 'two-factor challenge tokenVersion');
  if (typeof userId !== 'string' || userId.length < 1 || userId.length > 256) throw new TypeError('Invalid two-factor challenge userId');
  const token = crypto.randomBytes(32).toString('base64url');
  await cache.setAuthoritative(tokenKey(token), { userId, tokenVersion: canonicalVersion, issuedAt: Date.now() } satisfies Challenge, TTL_SECONDS);
  return token;
}

/** Peek does not consume: a mistyped TOTP may be retried subject to rate limiting. */
export async function peekTwoFactorLoginChallenge(token: string): Promise<Challenge | null> {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
  requireChallengeAuthority();
  return decodeChallenge(await cache.getAuthoritative<unknown>(tokenKey(token)));
}

/**
 * Atomically consume a successful challenge. Redis uses GET+DEL in one Lua
 * script; the single-node fallback serializes get/delete in-process.
 */
export async function claimTwoFactorLoginChallenge(token: string): Promise<Challenge | null> {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
  requireChallengeAuthority();
  const key = tokenKey(token);
  const raw = await cache.luaEvalAuthoritative(
    "local v=redis.call('GET',KEYS[1]); if v then redis.call('DEL',KEYS[1]); end; return v",
    [key], [],
  );
  if (typeof raw === 'string') {
    try { return decodeChallenge(JSON.parse(raw)); } catch { return null; }
  }
  // In configured Redis mode a null Lua result means the authoritative key is
  // absent; never consult process-local memory and accidentally resurrect a
  // consumed challenge. Explicit single-node mode retains the local fallback.
  if (REDIS_CONFIGURED) return null;
  return withLock(key, async () => {
    const value = decodeChallenge(await cache.get<unknown>(key));
    if (!value) return null;
    await cache.del(key);
    return value;
  });
}
