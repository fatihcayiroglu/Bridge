// server/lib/nativeAuth.ts
//
// Native (Android/iOS) sign-in: authorization code + PKCE (S256) on top of the
// existing Bridge session. Threat model and contract: docs/NATIVE_AUTH.md.
//
// What this module owns
//   · The redirect-URI allowlist (exact match, configured, fail closed).
//   · PKCE value validation and the S256 check (constant time).
//   · Authorization codes: random, single use, 60 s, bound to the user, the
//     user's tokenVersion, the code challenge and the redirect URI. A code is
//     consumed by the FIRST exchange attempt whatever its outcome, so a code
//     intercepted without the verifier is burnt by a wrong guess.
//   · A short "redeemed" marker: presenting an already redeemed code revokes the
//     refresh family that code produced (RFC 6749 §4.1.2 / RFC 9700 §4.2.4).
//
// What it deliberately does NOT own: refresh tokens. Issue, rotation, reuse
// detection and revocation stay in middleware/auth.ts and refresh_tokens.
import crypto from 'crypto';
import { cache, isRedisAvailable } from './redisAdapter';
import { parsePersistedNonNegativeInteger } from './persistedInteger';

export const CODE_TTL_SECONDS = 60;
export const REDEEMED_MARKER_TTL_SECONDS = 10 * 60;

const REDIS_CONFIGURED = Boolean(process.env.REDIS_URL);

// RFC 7636 §4.1: 43–128 characters of [A-Z a-z 0-9 - . _ ~].
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
// BASE64URL(SHA-256(verifier)) without padding is exactly 43 characters.
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
// Opaque client state: echoed, never interpreted. Enough entropy is the
// client's job; the server only bounds it.
const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;

export type NativeAuthConfig =
  | { enabled: true; redirectUris: ReadonlySet<string>; formActionSources: readonly string[] }
  | { enabled: false; reason: 'not_configured' | 'invalid_configuration' };

/**
 * A redirect URI is accepted into the allowlist only if it is
 *  - an https URL with no query or fragment and a host that is NOT the Bridge
 *    web origin (a same-origin landing page would be readable by script on
 *    that origin; App Links / Universal Links use a dedicated host), or
 *  - a private-use scheme in reverse-domain form (RFC 8252 §7.1), e.g.
 *    `com.example.bridge:/oauth`, with no query or fragment.
 */
export function validateRedirectUri(raw: string, webOrigin: string | null): boolean {
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 512 || /[\s#?]/.test(raw)) return false;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === 'https:') {
    if (!url.hostname) return false;
    if (webOrigin && url.origin === webOrigin) return false;
    return true;
  }
  if (url.protocol === 'http:') return false;
  const scheme = url.protocol.slice(0, -1);
  // Reverse-domain private-use scheme: at least one dot, lowercase labels.
  return /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(scheme);
}

function originOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try { return new URL(raw).origin; } catch { return null; }
}

export function loadNativeAuthConfig(env: NodeJS.ProcessEnv = process.env): NativeAuthConfig {
  const rawList = (env.NATIVE_AUTH_REDIRECT_URIS ?? '').trim();
  if (!rawList) return { enabled: false, reason: 'not_configured' };
  const webOrigin = originOf(env.BASE_URL);
  const uris = rawList.split(',').map((s) => s.trim()).filter(Boolean);
  if (uris.length === 0 || uris.length > 8) return { enabled: false, reason: 'invalid_configuration' };
  for (const uri of uris) {
    // One bad entry disables the feature: a typo must never widen the allowlist.
    if (!validateRedirectUri(uri, webOrigin)) return { enabled: false, reason: 'invalid_configuration' };
  }
  const formActionSources = [...new Set(uris.map((u) => {
    const url = new URL(u);
    return url.protocol === 'https:' ? url.origin : url.protocol;
  }))];
  return { enabled: true, redirectUris: new Set(uris), formActionSources };
}

export function isValidCodeVerifier(v: unknown): v is string {
  return typeof v === 'string' && VERIFIER_RE.test(v);
}
export function isValidCodeChallenge(v: unknown): v is string {
  return typeof v === 'string' && CHALLENGE_RE.test(v);
}
export function isValidState(v: unknown): v is string {
  return typeof v === 'string' && STATE_RE.test(v);
}
export function isWellFormedCode(v: unknown): v is string {
  return typeof v === 'string' && CODE_RE.test(v);
}

export function s256(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Constant-time S256 check. */
export function verifierMatchesChallenge(verifier: string, challenge: string): boolean {
  const a = Buffer.from(s256(verifier), 'ascii');
  const b = Buffer.from(challenge, 'ascii');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

type CodeGrant = { userId: string; tokenVersion: number; challenge: string; redirectUri: string; issuedAt: number };

function digest(code: string): string {
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}
const codeKey = (code: string) => `native-auth:code:${digest(code)}`;
const redeemedKey = (code: string) => `native-auth:redeemed:${digest(code)}`;

function requireAuthority(): void {
  // In a Redis deployment a code issued on one node must be redeemable, and
  // consumable exactly once, on any node. Never fall back to process memory.
  if (REDIS_CONFIGURED && !isRedisAvailable()) throw new Error('Native authorization store unavailable');
}

function decodeGrant(value: unknown): CodeGrant | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.userId !== 'string' || row.userId.length < 1 || row.userId.length > 256) return null;
  if (!isValidCodeChallenge(row.challenge) || typeof row.redirectUri !== 'string') return null;
  try {
    const tokenVersion = parsePersistedNonNegativeInteger(row.tokenVersion, 'native code tokenVersion');
    const issuedAt = parsePersistedNonNegativeInteger(row.issuedAt, 'native code issuedAt');
    const now = Date.now();
    // The store TTL is the primary expiry; this rejects a stale value that
    // outlived it (clock skew tolerance 5 s).
    if (issuedAt > now + 5_000 || now - issuedAt > CODE_TTL_SECONDS * 1000) return null;
    return { userId: row.userId, tokenVersion, challenge: row.challenge, redirectUri: row.redirectUri, issuedAt };
  } catch {
    return null;
  }
}

export async function issueAuthorizationCode(input: {
  userId: string; tokenVersion: number; challenge: string; redirectUri: string;
}): Promise<string> {
  requireAuthority();
  if (!isValidCodeChallenge(input.challenge)) throw new TypeError('Invalid code challenge');
  const tokenVersion = parsePersistedNonNegativeInteger(input.tokenVersion, 'native code tokenVersion');
  const code = crypto.randomBytes(32).toString('base64url');
  const grant: CodeGrant = {
    userId: input.userId, tokenVersion, challenge: input.challenge, redirectUri: input.redirectUri, issuedAt: Date.now(),
  };
  await cache.setAuthoritative(codeKey(code), grant, CODE_TTL_SECONDS);
  return code;
}

/** Atomically consumes the code. Null when unknown, expired, already used or malformed. */
export async function claimAuthorizationCode(code: string): Promise<CodeGrant | null> {
  if (!isWellFormedCode(code)) return null;
  requireAuthority();
  return decodeGrant(await cache.takeAuthoritative<unknown>(codeKey(code)));
}

/** Records which refresh family a redeemed code produced, for replay revocation. */
export async function markCodeRedeemed(code: string, family: string): Promise<void> {
  requireAuthority();
  await cache.setAuthoritative(redeemedKey(code), { family }, REDEEMED_MARKER_TTL_SECONDS);
}

/** The refresh family a replayed code produced, if the replay is within the marker window. */
export async function takeRedeemedFamily(code: string): Promise<string | null> {
  if (!isWellFormedCode(code)) return null;
  requireAuthority();
  const marker = await cache.takeAuthoritative<{ family?: unknown }>(redeemedKey(code));
  return marker && typeof marker.family === 'string' && marker.family ? marker.family : null;
}
