// server/routes/sso.ts
// Kurumsal SSO: OIDC (OpenID Connect) ve SAML 2.0 desteği
//
// Güvenlik düzeltmeleri (Sprint 46):
//   1. OIDC callback: token'lar artık query param yerine HttpOnly cookie ile taşınır.
//      PKCE state parametresi session/cookie üzerinden doğrulanır.
//   2. OIDC id_token: imza artık jwks_uri üzerinden jsonwebtoken.verify ile doğrulanır.
//   3. SAML: imza doğrulama xml-crypto kütüphanesi ile gerçek XML-Dsig doğrulaması yapar.
//
// OIDC Akışı:
//   1. GET  /api/sso/oidc/start       → IdP'ye redirect (PKCE code flow)
//   2. GET  /api/sso/oidc/callback    → state doğrula, code'u token ile değiştir,
//                                       id_token imzasını doğrula, HttpOnly cookie set et
//
// SAML 2.0 Akışı:
//   1. GET  /api/sso/saml/metadata    → SP metadata XML (IdP'ye yükle)
//   2. GET  /api/sso/saml/start       → IdP'ye AuthnRequest ile redirect
//   3. POST /api/sso/saml/callback    → SAMLResponse xml-crypto ile imza doğrula,
//                                       kullanıcı oluştur/güncelle, HttpOnly cookie set et


import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router       = express.Router();
import crypto from 'crypto';
import zlib from 'zlib';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { fetchT, SSRFError } from '../lib/fetch';
import { Users, Servers } from '../db/repositories';
import { authMiddleware, makeToken, makeRefreshToken, revokeRefreshToken } from '../middleware/auth';
import logger from '../lib/logger';
import { envSafeInt } from '../lib/envNumbers';
import { cache } from '../lib/redisAdapter';
import { tryRequire } from '../lib/_optional-require';
import { setRefreshCookie } from '../lib/authCookies';

const BASE_URL            = process.env.BASE_URL || 'http://localhost:3001';
const SSO_FLOW_TTL_SECONDS = 10 * 60;
const SSO_HANDOFF_TTL_SECONDS = 60;
const SSO_HANDOFF_COOKIE = 'bridge_sso_handoff';
const IS_PROD = process.env.NODE_ENV === 'production';
const SAML_ASSERTION_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
const SAML_PROTOCOL_NS = 'urn:oasis:names:tc:SAML:2.0:protocol';
const SAML_BEARER_METHOD = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';
const SAML_SUCCESS_STATUS = 'urn:oasis:names:tc:SAML:2.0:status:Success';
// Discovery is on the interactive login path. The generic fetch ceiling is
// 10s, which can consume the entire request/test budget before Express can
// return a useful 503. Keep a separately configurable, bounded fail-fast
// ceiling; token exchange/JWKS retain the generic network policy.
const OIDC_DISCOVERY_TIMEOUT_MS = envSafeInt(
  'OIDC_DISCOVERY_TIMEOUT_MS', 5_000, { min: 500, max: 10_000 },
);
const SAML_MAX_RESPONSE_BYTES = envSafeInt('SAML_MAX_RESPONSE_BYTES', 1_048_576, { min: 16_384, max: 4_194_304 });
const SAML_CLOCK_SKEW_MS = envSafeInt('SAML_CLOCK_SKEW_MS', 120_000, { min: 0, max: 300_000 });
const SAML_FORM_LIMIT = `${Math.ceil((Math.ceil(SAML_MAX_RESPONSE_BYTES * 4 / 3) + 16) / 1024) + 8}kb`;
function samlRuntimeAvailable(): boolean {
  return Boolean(tryRequire('xml-crypto') && tryRequire('@xmldom/xmldom'));
}

// HTTP: fetchT (lib/fetch.ts) — SSRF korumalı, timeout'lu

// ── JWKS cache + id_token doğrulama ───────────────────────────
const _jwksCache = new Map<string, { keys: unknown[]; fetchedAt: number }>();
const JWKS_CACHE_TTL = 60 * 1000;
const JWKS_CACHE_MAX = 500;

function pruneJwksCache(now = Date.now()): void {
  for (const [uri, entry] of _jwksCache) {
    if (now - entry.fetchedAt >= JWKS_CACHE_TTL) _jwksCache.delete(uri);
  }
  while (_jwksCache.size >= JWKS_CACHE_MAX) {
    const oldest = _jwksCache.keys().next().value as string | undefined;
    if (!oldest) break;
    _jwksCache.delete(oldest);
  }
}

async function getJWKS(jwksUri: string, forceRefresh = false): Promise<unknown[]> {
  const cached = _jwksCache.get(jwksUri);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL) return cached.keys;
  const _jr = await fetchT(jwksUri);
  if (!_jr.ok) throw new Error(`JWKS endpoint failed: ${_jr.status}`);
  const data = await _jr.json() as { keys?: unknown[] };
  const keys = Array.isArray(data.keys) ? data.keys : [];
  pruneJwksCache();
  _jwksCache.set(jwksUri, { keys, fetchedAt: Date.now() });
  return keys;
}

/**
 * id_token imzasını JWKS endpoint'inden alınan public key ile doğrular.
 * jsonwebtoken.verify: imza + issuer + audience + expiry kontrolü yapar.
 */
async function verifyIdToken(
  idToken: string,
  jwksUri: string,
  expectedIssuer: string,
  expectedClientId: string,
): Promise<Record<string, unknown>> {
  if (typeof idToken !== 'string' || idToken.length < 32 || idToken.length > 32_768) {
    throw new Error('Malformed id_token');
  }
  const headerB64 = idToken.split('.')[0];
  if (!headerB64) throw new Error('Malformed id_token: missing header');
  let header: { kid?: string; alg?: string };
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as { kid?: string; alg?: string };
  } catch {
    throw new Error('Malformed id_token header');
  }
  if (header.kid !== undefined && (typeof header.kid !== 'string' || header.kid.length < 1 || header.kid.length > 256)) {
    throw new Error('Malformed id_token kid');
  }
  const allowedAlgorithms = new Set(['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512']);
  if (typeof header.alg !== 'string' || !allowedAlgorithms.has(header.alg)) throw new Error('Unsupported id_token algorithm');

  async function verifyAgainst(keys: unknown[]): Promise<Record<string, unknown>> {
    if (!keys.length) throw new Error('JWKS endpoint returned no keys');
    const matchingKeys = header.kid
      ? keys.filter((k: unknown) => (k as Record<string, unknown>)?.kid === header.kid)
      : keys;
    if (!matchingKeys.length) throw new Error(`No JWKS key found for kid=${header.kid}`);
    let lastErr: Error | null = null;
    for (const jwk of matchingKeys) {
      try {
        const row = jwk as Record<string, unknown>;
        if (row.use !== undefined && row.use !== 'sig') continue;
        if (row.alg !== undefined && row.alg !== header.alg) continue;
        if (typeof row.kty !== 'string' || !row.kty) continue;
        if (row.kty === 'RSA' && (typeof row.n !== 'string' || typeof row.e !== 'string')) continue;
        if (row.kty === 'EC' && (typeof row.crv !== 'string' || typeof row.x !== 'string' || typeof row.y !== 'string')) continue;
        const keyInput = { key: row, format: 'jwk' } as Parameters<typeof crypto.createPublicKey>[0];
        const keyObj = crypto.createPublicKey(keyInput);
        const pem = keyObj.export({ type: 'spki', format: 'pem' }) as string;
        return jwt.verify(idToken, pem, {
          algorithms: [header.alg as jwt.Algorithm],
          issuer: expectedIssuer,
          audience: expectedClientId,
          clockTolerance: 30,
        }) as Record<string, unknown>;
      } catch (err) { lastErr = err as Error; }
    }
    throw lastErr ?? new Error('id_token verification failed');
  }

  const cachedOrFresh = await getJWKS(jwksUri);
  try {
    return await verifyAgainst(cachedOrFresh);
  } catch (firstErr) {
    // Key rotation must not make logins fail for the whole cache TTL. Refresh
    // once on kid/signature mismatch; still fail closed if the fresh JWKS does
    // not validate the token.
    const fresh = await getJWKS(jwksUri, true);
    try { return await verifyAgainst(fresh); }
    catch { throw firstErr; }
  }
}

function enforceOidcClaims(claims: Record<string, unknown>, expectedClientId: string): void {
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(claims.exp) || !Number.isInteger(claims.iat)) {
    throw new Error('id_token must contain canonical exp and iat claims');
  }
  if ((claims.exp as number) <= now - 30) throw new Error('id_token is expired');
  if ((claims.iat as number) > now + 30) throw new Error('id_token iat is in the future');
  if (typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 1024) {
    throw new Error('id_token has invalid sub claim');
  }
  const audiences = typeof claims.aud === 'string'
    ? [claims.aud]
    : Array.isArray(claims.aud) && claims.aud.every((v) => typeof v === 'string')
      ? claims.aud as string[]
      : [];
  if (!audiences.includes(expectedClientId)) throw new Error('id_token audience mismatch');
  if ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== expectedClientId) {
    throw new Error('id_token authorized party mismatch');
  }
}

// ── One-time browser handoff helpers ──────────────────────────
// OAuth/SAML callbacks cannot place an access token in a query string, and an
// access-token cookie would silently change every API endpoint into a CSRF
// surface.  The callback therefore stores the access token behind an opaque,
// one-use HttpOnly cookie.  The first-party callback page exchanges it once.
function digestOpaque(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function flowKey(kind: 'oidc' | 'saml' | 'handoff', opaque: string): string {
  return `sso:${kind}:${digestOpaque(opaque)}`;
}

function flowBindingCookieName(kind: 'oidc' | 'saml', opaque: string): string {
  return `bridge_sso_${kind}_${opaque}`;
}

function flowBindingCookieOptions(kind: 'oidc' | 'saml') {
  return {
    httpOnly: true,
    secure: IS_PROD,
    // OIDC returns by top-level GET, for which Lax is sufficient. SAML's
    // HTTP-POST binding is cross-site and therefore needs None+Secure in prod.
    sameSite: kind === 'saml' && IS_PROD ? 'none' as const : 'lax' as const,
    path: `/api/sso/${kind}/callback`,
  };
}

function setFlowBindingCookie(
  res: import('express').Response,
  kind: 'oidc' | 'saml',
  opaque: string,
  binding: string,
): void {
  res.cookie(flowBindingCookieName(kind, opaque), binding, {
    ...flowBindingCookieOptions(kind),
    maxAge: SSO_FLOW_TTL_SECONDS * 1000,
  });
}

function takeFlowBinding(
  req: import('express').Request,
  res: import('express').Response,
  kind: 'oidc' | 'saml',
  opaque: string,
): string {
  const name = flowBindingCookieName(kind, opaque);
  const binding = String((req.cookies as Record<string, string> | undefined)?.[name] ?? '');
  res.clearCookie(name, flowBindingCookieOptions(kind));
  return /^[A-Za-z0-9_-]{43}$/.test(binding) ? binding : '';
}

function clearHandoffCookie(res: import('express').Response): void {
  res.clearCookie(SSO_HANDOFF_COOKIE, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'strict',
    path: '/api/sso/session',
  });
}

async function setAuthCookiesAndRedirect(
  res:          import('express').Response,
  accessToken:  string,
  refreshToken: string,
): Promise<void> {
  const handoff = crypto.randomBytes(32).toString('base64url');
  try {
    await cache.setAuthoritative(flowKey('handoff', handoff), { accessToken }, SSO_HANDOFF_TTL_SECONDS);
  } catch (err) {
    // makeRefreshToken has already persisted this token. If the one-time
    // browser handoff cannot be made durable, revoke the otherwise orphaned
    // refresh session before returning failure.
    try { await revokeRefreshToken(refreshToken); }
    catch (cleanupErr) {
      logger.error({
        event: 'sso.refresh_cleanup_failed',
        err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      }, 'Failed to revoke refresh token after SSO handoff failure');
    }
    throw err;
  }
  setRefreshCookie(res, refreshToken);
  res.cookie(SSO_HANDOFF_COOKIE, handoff, {
    httpOnly: true,
    secure:   IS_PROD,
    sameSite: 'strict',
    maxAge:   SSO_HANDOFF_TTL_SECONDS * 1000,
    path:     '/api/sso/session',
  });
  // No token or handoff secret appears in browser history or Referer headers.
  res.redirect(`${BASE_URL}/sso-callback`);
}

// ── Kullanıcı yardımcıları ─────────────────────────────────────
function legacyIssuerIsApproved(provider: 'oidc' | 'saml', issuer: string): boolean {
  const configured = provider === 'oidc'
    ? process.env.OIDC_LEGACY_ISSUER
    : process.env.SAML_LEGACY_IDP_ENTITY_ID;
  return typeof configured === 'string' && configured.length > 0 && configured === issuer;
}

function hasExactSsoBinding(user: { ssoProvider?: unknown; ssoIssuer?: unknown; ssoId?: unknown }, provider: string, issuer: string, externalId: string): boolean {
  return String(user.ssoProvider ?? '') === provider &&
    String(user.ssoIssuer ?? '') === issuer &&
    String(user.ssoId ?? '') === externalId;
}

async function findOrCreateSSOUser(
  email: string,
  displayName: string,
  provider: 'oidc' | 'saml',
  issuer: string,
  externalId: string,
  options: { emailVerified: boolean; allowEmailLink: boolean },
) {
  const norm = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm) || norm.length > 320) throw new Error('Invalid SSO email claim');
  if (!['oidc', 'saml'].includes(provider) || typeof issuer !== 'string' || issuer.length < 1 || issuer.length > 2048 ||
      issuer === `legacy:${provider}` ||
      typeof externalId !== 'string' || externalId.length < 1 || externalId.length > 1024) {
    throw new Error('Invalid SSO subject');
  }
  const boundedDisplayName = String(displayName || '').trim().slice(0, 100);

  // The provider subject is the durable identity.  Email is mutable at most
  // IdPs and must not create a second account (or silently select a different
  // local account) when the upstream address changes.
  const byIdentity = await Users.findBySsoIdentity(provider, issuer, externalId);
  if (byIdentity) return byIdentity;

  // Pre-issuer rows are never guessed into a namespace. Operators must name
  // the exact trusted legacy authority, after which the upgrade itself is a
  // conditional write so two issuers cannot race to inherit the same subject.
  if (legacyIssuerIsApproved(provider, issuer)) {
    const legacy = await Users.findLegacySsoIdentity(provider, externalId);
    if (legacy) {
      if (await Users.upgradeLegacySsoIdentity(legacy._id, provider, issuer, externalId)) {
        return { ...legacy, ssoIssuer: issuer };
      }
      const upgraded = await Users.findById(legacy._id);
      if (upgraded && hasExactSsoBinding(upgraded, provider, issuer, externalId)) return upgraded;
      throw new Error('Legacy SSO identity was claimed by another authority');
    }
  }

  let user = await Users.findByEmail(norm);
  if (!user) {
    const localPart = norm.split('@')[0] ?? norm;
    const username = localPart.replace(/[^a-z0-9_]/gi, '_').toLowerCase() + '_' + crypto.randomBytes(3).toString('hex');
    try {
      user = await Users.create({
        _id: uuidv4(), email: norm, username, displayName: boundedDisplayName || username, password: '',
        ssoProvider: provider, ssoIssuer: issuer, ssoId: externalId,
        emailVerified: options.emailVerified, isAdmin: false,
        avatarColor: `#${crypto.randomBytes(3).toString('hex')}`, createdAt: Date.now(),
      });
    } catch (err) {
      // The issuer-scoped unique index arbitrates concurrent first-login
      // inserts. Return only the exact identity that won the race.
      const winner = await Users.findBySsoIdentity(provider, issuer, externalId);
      if (winner) return winner;
      throw err;
    }
  } else if (user.ssoProvider || user.ssoIssuer || user.ssoId) {
    // Existing SSO identities are immutable bindings. Matching email alone is
    // not proof that another provider/subject owns the same Bridge account.
    if (!hasExactSsoBinding(user, provider, issuer, externalId)) {
      throw new Error('SSO identity does not match the existing account binding');
    }
  } else {
    if (!options.allowEmailLink) throw new Error('Verified email is required to link an existing account');
    const claimed = await Users.claimSsoIdentity(user._id, provider, issuer, externalId);
    if (claimed) return { ...user, ssoProvider: provider, ssoIssuer: issuer, ssoId: externalId };

    // A competing callback may have completed the same link. Accept that
    // idempotent winner, but never authenticate a differently claimed row.
    const owner = await Users.findById(user._id);
    if (owner && hasExactSsoBinding(owner, provider, issuer, externalId)) return owner;
    throw new Error('SSO account link lost a concurrent ownership race');
  }
  return user;
}

async function issueTokens(user: Parameters<typeof makeToken>[0]) {
  const accessToken  = makeToken(user);
  const refreshToken = await makeRefreshToken(user);
  return { accessToken, refreshToken };
}

// ── Config yardımcıları ────────────────────────────────────────
async function requireServerOwner(
  req:  import('express').Request,
  res:  import('express').Response,
  next?: import('express').NextFunction,
) {
  const server = await Servers.findById(String(req.params.serverId ?? ''));
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  if (server.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  req.server = server;
  next?.();
}

function getSystemSSOConfig() {
  return {
    oidc: {
      enabled:      process.env.OIDC_ENABLED === 'true',
      issuer:       process.env.OIDC_ISSUER,
      clientId:     process.env.OIDC_CLIENT_ID,
      clientSecret: process.env.OIDC_CLIENT_SECRET,
      redirectUri:  `${BASE_URL}/api/sso/oidc/callback`,
      scopes:       (process.env.OIDC_SCOPES || 'openid email profile').split(' '),
    },
    saml: {
      enabled:    process.env.SAML_ENABLED === 'true',
      entryPoint: process.env.SAML_ENTRY_POINT,
      issuer:     process.env.SAML_ISSUER || `${BASE_URL}/api/sso/saml/metadata`,
      cert:       process.env.SAML_IDP_CERT, // IdP imza sertifikası (PEM)
    },
  };
}

function requireOidcEndpoint(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) {
    throw new Error(`OIDC discovery response has invalid ${name}`);
  }
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error(`OIDC discovery response has invalid ${name}`); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`OIDC discovery response has invalid ${name}`);
  }
  if (IS_PROD && parsed.protocol !== 'https:') throw new Error(`OIDC ${name} must use HTTPS`);
  return parsed.toString();
}

function validateOidcDiscovery(
  raw: Record<string, unknown>,
  expectedIssuer: string,
  needsAuthorizationEndpoint: boolean,
): { issuer: string; authorization_endpoint?: string; token_endpoint: string; jwks_uri: string } {
  if (raw.issuer !== expectedIssuer) throw new Error('OIDC discovery issuer mismatch');
  const result = {
    issuer: expectedIssuer,
    token_endpoint: requireOidcEndpoint(raw.token_endpoint, 'token_endpoint'),
    jwks_uri: requireOidcEndpoint(raw.jwks_uri, 'jwks_uri'),
    ...(needsAuthorizationEndpoint
      ? { authorization_endpoint: requireOidcEndpoint(raw.authorization_endpoint, 'authorization_endpoint') }
      : {}),
  };
  return result;
}


// ── Startup doğrulama ──────────────────────────────────────────
// SAML etkin ama cert eksikse başlangıçta uyar
if (process.env.SAML_ENABLED === 'true') {
  const problems: string[] = [];
  if (!process.env.SAML_IDP_CERT) problems.push('SAML_IDP_CERT is missing');
  if (!process.env.SAML_IDP_ENTITY_ID) problems.push('SAML_IDP_ENTITY_ID is missing');
  if (!samlRuntimeAvailable()) problems.push('xml-crypto/@xmldom runtime is unavailable');
  if (problems.length) {
    const msg = `[SSO] SAML_ENABLED=true but ${problems.join(', ')}.`;
    if (process.env.NODE_ENV === 'production') {
      logger.fatal({ event: 'sso.saml.invalid_runtime', problems }, msg);
      process.exit(1);
    } else logger.warn({ event: 'sso.saml.invalid_runtime', problems }, msg);
  }
}

// ── OIDC ───────────────────────────────────────────────────────

/**
 * @openapi
 * /sso/oidc/start:
 *   get:
 *     tags: [Auth]
 *     summary: OIDC oturumu başlat — IdP'ye yönlendirme
 *     parameters:
 *       - in: query
 *         name: serverId
 *         schema: { type: string }
 *         description: Giriş sonrası yönlendirilecek sunucu
 *     responses:
 *       302: { description: IdP authorization URL'sine redirect }
 *       500: { description: OIDC yapılandırması eksik }
 */
router.get('/oidc/start', async (req: import('express').Request, res: import('express').Response) => {
  const cfg = getSystemSSOConfig().oidc;
  if (!cfg.enabled || !cfg.issuer || !cfg.clientId) {
    return res.status(503).json({ error: 'OIDC SSO is not configured' });
  }

  let discovery: ReturnType<typeof validateOidcDiscovery>;
  try {
    const _dr1 = await fetchT(`${cfg.issuer}/.well-known/openid-configuration`, {
      timeoutMs: OIDC_DISCOVERY_TIMEOUT_MS,
    });
    if (!_dr1.ok) throw new Error(`OIDC discovery failed: ${_dr1.status}`);
    discovery = validateOidcDiscovery(await _dr1.json() as Record<string, unknown>, cfg.issuer, true);
  } catch (err) {
    if (err instanceof SSRFError) return res.status(400).json({ error: 'SSRF: OIDC issuer URL is not allowed' });
    return res.status(503).json({ error: 'OIDC discovery failed' });
  }

  // State + nonce + RFC 7636 PKCE. All verifier material stays in HttpOnly
  // same-site cookies; only the SHA-256 challenge is sent to the IdP.
  const state = crypto.randomBytes(24).toString('base64url');
  const browserBinding = crypto.randomBytes(32).toString('base64url');
  const nonce = crypto.randomBytes(24).toString('base64url');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  try {
    await cache.setAuthoritative(flowKey('oidc', `${state}.${browserBinding}`), {
      nonce,
      codeVerifier,
      issuer: cfg.issuer,
      clientId: cfg.clientId,
    }, SSO_FLOW_TTL_SECONDS);
  } catch (err) {
    logger.error({ event: 'sso.oidc.state_store_failed', err: err instanceof Error ? err.message : String(err) }, 'OIDC state store unavailable');
    return res.status(503).json({ error: 'OIDC login state is temporarily unavailable' });
  }
  setFlowBindingCookie(res, 'oidc', state, browserBinding);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes.join(' '),
    state, nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  const authorizationUrl = new URL(discovery.authorization_endpoint!);
  params.forEach((value, key) => authorizationUrl.searchParams.set(key, value));
  res.redirect(authorizationUrl.toString());
});

/**
 * @openapi
 * /sso/oidc/callback:
 *   get:
 *     tags: [Auth]
 *     summary: OIDC callback — token değişimi ve oturum açma
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: state
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       302: { description: Başarılı — uygulamaya yönlendirilir }
 *       401: { description: Geçersiz state veya token }
 */
router.get('/oidc/callback', async (req: import('express').Request, res: import('express').Response) => {
  const cfg = getSystemSSOConfig().oidc;
  if (!cfg.enabled || !cfg.issuer || !cfg.clientId) {
    return res.status(503).json({ error: 'OIDC is disabled or incomplete' });
  }
  // Capture the validated identity namespace before any await boundary. This
  // keeps the security-sensitive issuer/audience contract non-optional for
  // the entire callback instead of re-asserting it with casts later.
  const issuer = cfg.issuer;
  const clientId = cfg.clientId;

  const { code, state } = req.query as { code?: string; state?: string };
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(state)) {
    return res.status(400).json({ error: 'Missing or invalid state parameter' });
  }
  const browserBinding = takeFlowBinding(req, res, 'oidc', state);
  if (!browserBinding) return res.status(400).json({ error: 'OIDC browser flow binding is missing or invalid' });

  let flow: { nonce?: unknown; codeVerifier?: unknown; issuer?: unknown; clientId?: unknown } | null;
  try { flow = await cache.takeAuthoritative(flowKey('oidc', `${state}.${browserBinding}`)); }
  catch (err) {
    logger.error({ event: 'sso.oidc.state_claim_failed', err: err instanceof Error ? err.message : String(err) }, 'OIDC state store unavailable');
    return res.status(503).json({ error: 'OIDC login state is temporarily unavailable' });
  }
  if (!flow || flow.issuer !== issuer || flow.clientId !== clientId ||
      typeof flow.nonce !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(flow.nonce) ||
      typeof flow.codeVerifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(flow.codeVerifier)) {
    return res.status(400).json({ error: 'OIDC state is invalid, expired, or already used' });
  }
  const expectedNonce = flow.nonce;
  const codeVerifier = flow.codeVerifier;
  if (typeof code !== 'string' || code.length < 1 || code.length > 4096) {
    return res.status(400).json({ error: 'Missing or invalid authorization code' });
  }

  let discovery: ReturnType<typeof validateOidcDiscovery>;
  try {
    const _dr2 = await fetchT(`${issuer}/.well-known/openid-configuration`, {
      timeoutMs: OIDC_DISCOVERY_TIMEOUT_MS,
    });
    if (!_dr2.ok) throw new Error(`OIDC discovery failed: ${_dr2.status}`);
    discovery = validateOidcDiscovery(await _dr2.json() as Record<string, unknown>, issuer, false);
  } catch {
    return res.status(503).json({ error: 'OIDC discovery failed' });
  }

  const tokenParams = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code as string,
    redirect_uri: cfg.redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  if (cfg.clientSecret) tokenParams.set('client_secret', cfg.clientSecret);
  const body = tokenParams.toString();

  let tokenResp: Record<string, unknown>;
  try {
    const _tr = await fetchT(discovery.token_endpoint, {
      method:  'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!_tr.ok) return res.status(502).json({ error: 'OIDC token endpoint rejected the authorization code' });
    tokenResp = await _tr.json() as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SSRFError) return res.status(400).json({ error: 'SSRF: token endpoint URL is not allowed' });
    return res.status(502).json({ error: 'Token endpoint is unreachable' });
  }

  if (!tokenResp.id_token) {
    return res.status(401).json({ error: 'id_token was not returned' });
  }

  // [FIX 2] id_token imza doğrulama — jwks_uri + jsonwebtoken.verify
  const jwksUri = discovery.jwks_uri;
  if (!jwksUri) {
    return res.status(503).json({ error: 'OIDC discovery response missing jwks_uri' });
  }

  let claims: Record<string, unknown>;
  try {
    claims = await verifyIdToken(
      tokenResp.id_token as string,
      jwksUri,
      issuer,
      clientId,
    );
    enforceOidcClaims(claims, clientId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(401).json({ error: 'id_token verification failed', detail: message });
  }

  if (typeof claims.nonce !== 'string' || claims.nonce.length !== expectedNonce.length ||
      !crypto.timingSafeEqual(Buffer.from(claims.nonce), Buffer.from(expectedNonce))) {
    return res.status(401).json({ error: 'id_token nonce mismatch' });
  }
  const email = typeof claims.email === 'string' ? claims.email : '';
  const externalId = typeof claims.sub === 'string' ? claims.sub : '';
  const displayName = typeof claims.name === 'string' ? claims.name
    : typeof claims.preferred_username === 'string' ? claims.preferred_username : email;
  if (!email || !externalId) return res.status(400).json({ error: 'Required OIDC claims are missing' });
  if (process.env.OIDC_REQUIRE_EMAIL_VERIFIED !== 'false' && claims.email_verified !== true) {
    return res.status(403).json({ error: 'OIDC email is not verified' });
  }

  let user;
  try {
    user = await findOrCreateSSOUser(email, displayName, 'oidc', issuer, externalId, {
      emailVerified: claims.email_verified === true,
      allowEmailLink: claims.email_verified === true,
    });
  }
  catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), event: 'sso.oidc.binding_rejected' }, 'OIDC account binding rejected');
    return res.status(403).json({ error: 'SSO identity does not match this account' });
  }
  const tokens = await issueTokens(user);

  // [FIX 1] HttpOnly cookie — URL'de token yok
  try { await setAuthCookiesAndRedirect(res, tokens.accessToken, tokens.refreshToken); }
  catch (err) {
    logger.error({ event: 'sso.oidc.handoff_store_failed', err: err instanceof Error ? err.message : String(err) }, 'SSO session handoff store unavailable');
    return res.status(503).json({ error: 'SSO session handoff is temporarily unavailable' });
  }
});

/**
 * POST /api/sso/session
 *
 * Consume the HttpOnly callback handoff exactly once and return the ordinary
 * Bearer access token expected by the rest of Bridge.  The refresh token was
 * already placed in the canonical /api/refresh-scoped HttpOnly cookie.
 */
router.post('/session', async (req: import('express').Request, res: import('express').Response) => {
  res.set('Cache-Control', 'no-store');
  const handoff = String((req.cookies as Record<string, string> | undefined)?.[SSO_HANDOFF_COOKIE] ?? '');
  clearHandoffCookie(res);
  if (!/^[A-Za-z0-9_-]{43}$/.test(handoff)) {
    return res.status(401).json({ error: 'SSO session handoff is missing or expired' });
  }

  let claimed: { accessToken?: unknown } | null;
  try { claimed = await cache.takeAuthoritative(flowKey('handoff', handoff)); }
  catch (err) {
    logger.error({ event: 'sso.handoff.claim_failed', err: err instanceof Error ? err.message : String(err) }, 'SSO session handoff store unavailable');
    return res.status(503).json({ error: 'SSO session handoff is temporarily unavailable' });
  }
  if (!claimed || typeof claimed.accessToken !== 'string' || claimed.accessToken.length < 32 || claimed.accessToken.length > 32_768) {
    return res.status(401).json({ error: 'SSO session handoff is invalid, expired, or already used' });
  }
  return res.json({ token: claimed.accessToken });
});

// ── SAML 2.0 ──────────────────────────────────────────────────

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * @openapi
 * /sso/saml/metadata:
 *   get:
 *     tags: [Auth]
 *     summary: SAML SP metadata XML — IdP'ye yüklenecek
 *     responses:
 *       200:
 *         description: SP metadata XML
 *         content:
 *           application/xml:
 *             schema: { type: string }
 */
router.get('/saml/metadata', (req, res) => {
  const cfg      = getSystemSSOConfig().saml;
  const spIssuer = cfg.issuer || `${BASE_URL}/api/sso/saml/metadata`;
  const acsUrl   = `${BASE_URL}/api/sso/saml/callback`;
  const xml = `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="${escapeXml(spIssuer)}">
  <SPSSODescriptor
    AuthnRequestsSigned="false"
    WantAssertionsSigned="true"
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="${escapeXml(acsUrl)}"
      index="1"/>
    <NameIDFormat>
      urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress
    </NameIDFormat>
  </SPSSODescriptor>
</EntityDescriptor>`;
  res.set('Content-Type', 'application/xml');
  res.send(xml);
});

/**
 * @openapi
 * /sso/saml/start:
 *   get:
 *     tags: [Auth]
 *     summary: SAML oturumu başlat — AuthnRequest ile IdP'ye yönlendir
 *     responses:
 *       302: { description: IdP SSO URL'sine redirect }
 *       500: { description: SAML yapılandırması eksik }
 */
router.get('/saml/start', async (req: import('express').Request, res: import('express').Response) => {
  const cfg = getSystemSSOConfig().saml;
  if (!cfg.enabled || !cfg.entryPoint) {
    return res.status(503).json({ error: 'SAML SSO is not configured' });
  }

  // Reject an unusable/untrusted destination before allocating authoritative
  // flow state. Otherwise a broken (or maliciously supplied) deployment value
  // can fill Redis with ceremonies that can never leave this service.
  let destination: URL;
  try { destination = new URL(cfg.entryPoint); }
  catch { return res.status(503).json({ error: 'SAML entry point is invalid' }); }
  if (!['https:', 'http:'].includes(destination.protocol) || destination.username || destination.password ||
      (IS_PROD && destination.protocol !== 'https:')) {
    return res.status(503).json({ error: 'SAML entry point is invalid' });
  }

  const spIssuer = cfg.issuer;
  const acsUrl   = `${BASE_URL}/api/sso/saml/callback`;
  const id       = '_' + uuidv4().replace(/-/g, '');
  const now      = new Date().toISOString();
  const relayState = crypto.randomBytes(24).toString('base64url');
  const browserBinding = crypto.randomBytes(32).toString('base64url');
  const idpIssuer = process.env.SAML_IDP_ENTITY_ID || '';
  const certDigest = cfg.cert ? digestOpaque(cfg.cert.trim()) : '';
  try {
    await cache.setAuthoritative(flowKey('saml', `${relayState}.${browserBinding}`), {
      requestId: id,
      spIssuer,
      idpIssuer,
      certDigest,
    }, SSO_FLOW_TTL_SECONDS);
  } catch (err) {
    logger.error({ event: 'sso.saml.state_store_failed', err: err instanceof Error ? err.message : String(err) }, 'SAML state store unavailable');
    return res.status(503).json({ error: 'SAML login state is temporarily unavailable' });
  }
  setFlowBindingCookie(res, 'saml', relayState, browserBinding);

  const authnReq = `<samlp:AuthnRequest
    xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
    xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
    ID="${id}"
    Version="2.0"
    IssueInstant="${now}"
    Destination="${escapeXml(cfg.entryPoint)}"
    AssertionConsumerServiceURL="${escapeXml(acsUrl)}"
    ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
    <saml:Issuer>${escapeXml(spIssuer)}</saml:Issuer>
  </samlp:AuthnRequest>`;

  // SAML HTTP-Redirect binding requires raw DEFLATE before base64 encoding.
  const encoded = zlib.deflateRawSync(Buffer.from(authnReq, 'utf8')).toString('base64');
  destination.searchParams.set('SAMLRequest', encoded);
  destination.searchParams.set('RelayState', relayState);
  res.redirect(destination.toString());
});

// [FIX 3] xml-crypto ile gerçek XML-Dsig imza doğrulama
// Minimal structural XML types keep SAML validation independent from browser DOM
// globals and from @xmldom's implementation-specific Node subclasses.  Runtime
// checks below prove element-ness before getAttribute is used.
interface SamlNode {
  nodeType?: number;
  nodeName?: string | null;
  localName?: string | null;
  namespaceURI?: string | null;
  textContent?: string | null;
  childNodes?: ArrayLike<SamlNode>;
}

interface SamlElement extends SamlNode {
  getAttribute(name: string): string | null;
}

interface SamlDocument {
  documentElement: SamlElement;
  getElementsByTagName(name: string): ArrayLike<SamlElement>;
}

function assertUniqueSamlIds(doc: SamlDocument): void {
  const seen = new Map<string, SamlElement>();
  const nodes = Array.from(doc.getElementsByTagName('*'));
  for (const node of nodes) {
    const present = ['ID', 'Id', 'id']
      .map((name) => ({ name, value: String(node.getAttribute?.(name) ?? '') }))
      .filter(({ value }) => value.length > 0);
    if (present.length > 1) throw new Error('SAML element has ambiguous ID attributes');
    for (const { value } of present) {
      if (seen.has(value)) throw new Error('Duplicate SAML XML ID detected');
      seen.set(value, node);
    }
  }
}

async function verifySAMLSignature(xmlDoc: string, idpCert: string): Promise<string> {
  if (Buffer.byteLength(xmlDoc, 'utf8') > SAML_MAX_RESPONSE_BYTES) throw new Error('SAMLResponse is too large');
  if (/<!DOCTYPE|<!ENTITY/i.test(xmlDoc)) throw new Error('DTD/entity declarations are not allowed in SAML');

  let SignedXml: typeof import('xml-crypto').SignedXml;
  let DOMParser: typeof import('@xmldom/xmldom').DOMParser;
  try {
    ({ SignedXml } = await import('xml-crypto'));
    ({ DOMParser } = await import('@xmldom/xmldom'));
  } catch {
    throw new Error('SAML verification runtime is unavailable');
  }

  const doc = new DOMParser().parseFromString(xmlDoc, 'text/xml') as unknown as SamlDocument;
  const parseErrors = Array.from(doc.getElementsByTagName('parsererror') ?? []);
  if (parseErrors.length) throw new Error('Malformed SAML XML');
  assertUniqueSamlIds(doc);
  const all = Array.from(doc.getElementsByTagName('*'));
  const signatureNodes = all.filter((node: SamlElement) =>
    (node.localName || String(node.nodeName || '').split(':').pop()) === 'Signature' &&
    String(node.namespaceURI || '') === 'http://www.w3.org/2000/09/xmldsig#');
  // A narrow, deterministic profile avoids ambiguous multi-signature wrapping.
  if (signatureNodes.length !== 1) throw new Error('Exactly one XML Signature is required');

  const pemCert = idpCert.includes('BEGIN CERTIFICATE') || idpCert.includes('BEGIN PUBLIC KEY')
    ? idpCert
    : `-----BEGIN CERTIFICATE-----\n${idpCert}\n-----END CERTIFICATE-----`;
  const sig = new SignedXml({ publicCert: pemCert });
  sig.loadSignature(signatureNodes[0] as unknown as Parameters<typeof sig.loadSignature>[0]);
  const references = sig.getReferences();
  if (!Array.isArray(references) || references.length !== 1 ||
      typeof references[0]?.uri !== 'string' || !/^#[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/.test(references[0].uri)) {
    throw new Error('SAML signature must use exactly one direct same-document reference');
  }
  const referencedId = references[0].uri.slice(1);
  const referencedNodes = all.filter((node: SamlElement) =>
    ['ID', 'Id', 'id'].some((name) => String(node.getAttribute?.(name) ?? '') === referencedId));
  if (referencedNodes.length !== 1) throw new Error('SAML signature reference does not resolve uniquely');

  const allowedSignatureAlgorithms = new Set([
    'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    'http://www.w3.org/2001/04/xmldsig-more#rsa-sha384',
    'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512',
  ]);
  const allowedDigestAlgorithms = new Set([
    'http://www.w3.org/2001/04/xmlenc#sha256',
    'http://www.w3.org/2001/04/xmldsig-more#sha384',
    'http://www.w3.org/2001/04/xmlenc#sha512',
  ]);
  if (!allowedSignatureAlgorithms.has(String(sig.signatureAlgorithm ?? '')) ||
      !allowedDigestAlgorithms.has(String(references[0].digestAlgorithm ?? ''))) {
    throw new Error('SAML signature uses a disallowed cryptographic algorithm');
  }
  if (!sig.checkSignature(xmlDoc)) {
    throw new Error('SAML signature validation failed');
  }
  if (typeof sig.getSignedReferences !== 'function') throw new Error('SAML verifier cannot expose signed references');
  const refs = sig.getSignedReferences();
  const signedReference = Array.isArray(refs) ? refs[0] : undefined;
  if (!Array.isArray(refs) || refs.length !== 1 || typeof signedReference !== 'string' || !signedReference) {
    throw new Error('SAML signature must bind exactly one XML reference');
  }
  // Return the single bound reference rather than the array: the "exactly one"
  // invariant is enforced here, so no caller can accidentally consume refs[1]
  // or index into an empty list.
  return signedReference;
}

function samlNodeName(node: SamlNode | null | undefined): string {
  return String(node?.localName || String(node?.nodeName || '').split(':').pop() || '');
}

function isSamlElementNode(node: SamlNode | null | undefined): node is SamlElement {
  return node?.nodeType === 1 && typeof (node as SamlElement).getAttribute === 'function';
}

// Do not express the name/namespace match itself as a type predicate. `root` is
// already SamlElement; a predicate `root is SamlElement` makes TypeScript narrow
// the false branch to `never`, which was the source of the production SSO build
// errors around Response.getAttribute().
function matchesSamlElement(node: SamlNode | null | undefined, localName: string, namespace: string): boolean {
  return isSamlElementNode(node)
    && samlNodeName(node) === localName
    && String(node.namespaceURI || '') === namespace;
}

function samlDirectChildren(root: SamlNode, localName: string, namespace: string): SamlElement[] {
  return Array.from(root.childNodes ?? [])
    .filter((node: SamlNode): node is SamlElement => isSamlElementNode(node) && matchesSamlElement(node, localName, namespace));
}

function samlDescendants(root: SamlNode, localName: string, namespace: string): SamlElement[] {
  const result: SamlElement[] = [];
  const visit = (node: SamlNode): void => {
    if (isSamlElementNode(node) && matchesSamlElement(node, localName, namespace)) result.push(node);
    for (const child of Array.from(node.childNodes ?? [])) visit(child);
  };
  visit(root);
  return result;
}

function samlText(node: SamlNode | null | undefined): string { return String(node?.textContent ?? '').trim(); }

// Every "exactly one child" rule in the SAML profile below was written as
// `list.length !== 1 -> throw` followed by a bare `list[0]`. Under the hardening
// ratchet's noUncheckedIndexedAccess that pair produced 16 `possibly undefined`
// errors, and the split form would let a future edit drop the length guard while
// the index access silently kept compiling. One helper enforces both halves.
function samlExactlyOne<T>(nodes: readonly T[], message: string): T {
  const [only] = nodes;
  if (nodes.length !== 1 || only === undefined) throw new Error(message);
  return only;
}

function parseSamlTime(value: string, name: string): number {
  const ms = Date.parse(value);
  if (!value || !Number.isFinite(ms)) throw new Error(`Invalid SAML ${name}`);
  return ms;
}

async function validateSignedSamlReference(
  signedXml: string,
  expectedRequestId: string,
  acsUrl: string,
  spIssuer: string,
  expectedIdpIssuer: string,
): Promise<{ email: string; displayName: string; nameId: string; assertionId: string }> {
  const { DOMParser } = await import('@xmldom/xmldom');
  const doc = new DOMParser().parseFromString(signedXml, 'text/xml') as unknown as SamlDocument;
  if (doc.getElementsByTagName('parsererror')?.length) throw new Error('Malformed signed SAML XML');
  const root = doc.documentElement;
  let response: SamlElement | null = null;
  let assertion: SamlElement;
  if (matchesSamlElement(root, 'Assertion', SAML_ASSERTION_NS)) {
    assertion = root;
  } else if (matchesSamlElement(root, 'Response', SAML_PROTOCOL_NS)) {
    response = root;
    const directAssertions = samlDirectChildren(response, 'Assertion', SAML_ASSERTION_NS);
    assertion = samlExactlyOne(directAssertions, 'Signed SAML Response must contain one direct Assertion');
  } else {
    throw new Error('Signed SAML reference must be a protocol Response or assertion Assertion');
  }
  const assertions = samlDescendants(root, 'Assertion', SAML_ASSERTION_NS);
  if (assertions.length !== 1 || assertions[0] !== assertion) {
    throw new Error('Signed SAML reference must contain exactly one Assertion');
  }
  if (String(assertion.getAttribute?.('Version') ?? '') !== '2.0') throw new Error('SAML Assertion version must be 2.0');
  const assertionId = String(assertion.getAttribute?.('ID') ?? assertion.getAttribute?.('Id') ?? '');
  if (!/^[_A-Za-z][A-Za-z0-9_.:-]{0,255}$/.test(assertionId)) throw new Error('Invalid signed Assertion ID');

  const assertionIssuer = samlExactlyOne(
    samlDirectChildren(assertion, 'Issuer', SAML_ASSERTION_NS),
    'SAML issuer mismatch',
  );
  if (samlText(assertionIssuer) !== expectedIdpIssuer) throw new Error('SAML issuer mismatch');

  if (response) {
    if (String(response.getAttribute?.('Version') ?? '') !== '2.0' ||
        String(response.getAttribute?.('Destination') ?? '') !== acsUrl ||
        String(response.getAttribute?.('InResponseTo') ?? '') !== expectedRequestId) {
      throw new Error('SAML Response does not bind this login request');
    }
    const responseIssuer = samlExactlyOne(
      samlDirectChildren(response, 'Issuer', SAML_ASSERTION_NS),
      'SAML response issuer mismatch',
    );
    if (samlText(responseIssuer) !== expectedIdpIssuer) throw new Error('SAML response issuer mismatch');
    const status = samlExactlyOne(
      samlDirectChildren(response, 'Status', SAML_PROTOCOL_NS),
      'SAML Response status is not Success',
    );
    const statusCode = samlExactlyOne(
      samlDirectChildren(status, 'StatusCode', SAML_PROTOCOL_NS),
      'SAML Response status is not Success',
    );
    if (String(statusCode.getAttribute?.('Value') ?? '') !== SAML_SUCCESS_STATUS) {
      throw new Error('SAML Response status is not Success');
    }
  }

  const now = Date.now();
  const conditions = samlExactlyOne(
    samlDirectChildren(assertion, 'Conditions', SAML_ASSERTION_NS),
    'SAML Conditions are required',
  );
  const notBefore = String(conditions.getAttribute?.('NotBefore') ?? '');
  const notOnOrAfter = String(conditions.getAttribute?.('NotOnOrAfter') ?? '');
  if (!notBefore || !notOnOrAfter) throw new Error('SAML Conditions must be bounded');
  if (now + SAML_CLOCK_SKEW_MS < parseSamlTime(notBefore, 'NotBefore')) throw new Error('SAML assertion is not active yet');
  if (now - SAML_CLOCK_SKEW_MS >= parseSamlTime(notOnOrAfter, 'NotOnOrAfter')) throw new Error('SAML assertion expired');

  const audienceRestrictions = samlDirectChildren(conditions, 'AudienceRestriction', SAML_ASSERTION_NS);
  if (!audienceRestrictions.length || audienceRestrictions.some((restriction: SamlElement) => {
    const audiences = samlDirectChildren(restriction, 'Audience', SAML_ASSERTION_NS).map(samlText).filter(Boolean);
    return !audiences.includes(spIssuer);
  })) throw new Error('SAML audience mismatch');

  const subject = samlExactlyOne(
    samlDirectChildren(assertion, 'Subject', SAML_ASSERTION_NS),
    'SAML Assertion must contain one direct Subject',
  );
  const confirmations = samlDirectChildren(subject, 'SubjectConfirmation', SAML_ASSERTION_NS);
  const bearer = confirmations.find((confirmation: SamlElement) => {
    if (String(confirmation.getAttribute?.('Method') ?? '') !== SAML_BEARER_METHOD) return false;
    const data = samlDirectChildren(confirmation, 'SubjectConfirmationData', SAML_ASSERTION_NS);
    const [confirmationData] = data;
    if (data.length !== 1 || !confirmationData) return false;
    const recipient = String(confirmationData.getAttribute?.('Recipient') ?? '');
    const inResponseTo = String(confirmationData.getAttribute?.('InResponseTo') ?? '');
    const expiry = String(confirmationData.getAttribute?.('NotOnOrAfter') ?? '');
    const confirmationNotBefore = String(confirmationData.getAttribute?.('NotBefore') ?? '');
    if (recipient !== acsUrl || inResponseTo !== expectedRequestId || !expiry) return false;
    try {
      if (confirmationNotBefore && now + SAML_CLOCK_SKEW_MS < parseSamlTime(confirmationNotBefore, 'SubjectConfirmationData.NotBefore')) return false;
      return now - SAML_CLOCK_SKEW_MS < parseSamlTime(expiry, 'SubjectConfirmationData.NotOnOrAfter');
    }
    catch { return false; }
  });
  if (!bearer) throw new Error('SAML bearer confirmation does not bind this login request');

  const attributeStatements = samlDirectChildren(assertion, 'AttributeStatement', SAML_ASSERTION_NS);
  const attrs = attributeStatements.flatMap((statement: SamlElement) =>
    samlDirectChildren(statement, 'Attribute', SAML_ASSERTION_NS));
  const attrValue = (names: string[]): string => {
    for (const attr of attrs) {
      const name = String(attr.getAttribute?.('Name') ?? '');
      if (!names.includes(name)) continue;
      const [firstValue] = samlDirectChildren(attr, 'AttributeValue', SAML_ASSERTION_NS);
      if (firstValue) return samlText(firstValue);
    }
    return '';
  };
  const nameIds = samlDirectChildren(subject, 'NameID', SAML_ASSERTION_NS).map(samlText).filter(Boolean);
  const nameId = samlExactlyOne(nameIds, 'SAML assertion must contain exactly one NameID');
  const email = attrValue(['email', 'Email', 'emailAddress', 'mail']) || nameId;
  const displayName = attrValue(['displayName', 'name', 'cn', 'fullName']) || (email.split('@')[0] ?? email);
  if (!email || !nameId) throw new Error('Required SAML identity attributes are missing');

  const replayDigest = crypto.createHash('sha256').update(`${expectedIdpIssuer}\0${assertionId}`).digest('hex');
  const claimed = await cache.setIfAbsentAuthoritative(`saml:assertion:${replayDigest}`, 1, 10 * 60);
  if (!claimed) throw new Error('SAML assertion replay detected');
  return { email, displayName, nameId, assertionId };
}

/**
 * @openapi
 * /sso/saml/callback:
 *   post:
 *     tags: [Auth]
 *     summary: SAML callback — SAMLResponse doğrulama ve oturum açma
 *     requestBody:
 *       required: true
 *       content:
 *         application/x-www-form-urlencoded:
 *           schema:
 *             type: object
 *             properties:
 *               SAMLResponse: { type: string }
 *     responses:
 *       302: { description: Başarılı — uygulamaya yönlendirilir }
 *       401: { description: Geçersiz SAMLResponse imzası }
 */
router.post('/saml/callback', express.urlencoded({ extended: false, limit: SAML_FORM_LIMIT }), async (req: import('express').Request, res: import('express').Response) => {
  const { SAMLResponse, RelayState } = req.body as { SAMLResponse?: unknown; RelayState?: unknown };
  if (typeof RelayState !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(RelayState)) {
    return res.status(400).json({ error: 'SAML RelayState is missing or invalid' });
  }
  const browserBinding = takeFlowBinding(req, res, 'saml', RelayState);
  if (!browserBinding) return res.status(400).json({ error: 'SAML browser flow binding is missing or invalid' });
  let flow: { requestId?: unknown; spIssuer?: unknown; idpIssuer?: unknown; certDigest?: unknown } | null;
  try { flow = await cache.takeAuthoritative(flowKey('saml', `${RelayState}.${browserBinding}`)); }
  catch (err) {
    logger.error({ event: 'sso.saml.state_claim_failed', err: err instanceof Error ? err.message : String(err) }, 'SAML state store unavailable');
    return res.status(503).json({ error: 'SAML login state is temporarily unavailable' });
  }
  const requestId = typeof flow?.requestId === 'string' ? flow.requestId : '';
  if (!/^_[A-Za-z0-9]{16,64}$/.test(requestId)) {
    return res.status(400).json({ error: 'SAML RelayState is expired or already used' });
  }
  if (typeof SAMLResponse !== 'string' || !SAMLResponse || SAMLResponse.length > Math.ceil(SAML_MAX_RESPONSE_BYTES * 4 / 3) + 16 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(SAMLResponse) || SAMLResponse.length % 4 !== 0) {
    return res.status(400).json({ error: 'SAMLResponse is not valid bounded base64' });
  }

  const xml = Buffer.from(SAMLResponse, 'base64').toString('utf8');
  if (!xml.trim().startsWith('<') || Buffer.byteLength(xml, 'utf8') > SAML_MAX_RESPONSE_BYTES) {
    return res.status(400).json({ error: 'SAMLResponse XML is invalid or too large' });
  }

  const cfg = getSystemSSOConfig().saml;
  const idpCert = cfg.cert;
  const idpIssuer = process.env.SAML_IDP_ENTITY_ID || '';
  if (!cfg.enabled || !idpCert || !idpIssuer || !samlRuntimeAvailable()) {
    return res.status(503).json({ error: 'SAML verification is not fully configured' });
  }
  const acsUrl = `${BASE_URL}/api/sso/saml/callback`;
  const spIssuer = cfg.issuer || `${BASE_URL}/api/sso/saml/metadata`;
  if (flow?.spIssuer !== spIssuer || flow?.idpIssuer !== idpIssuer ||
      flow?.certDigest !== digestOpaque(idpCert.trim())) {
    return res.status(400).json({ error: 'SAML login configuration changed during the flow' });
  }

  let identity: { email: string; displayName: string; nameId: string };
  try {
    const signedReference = await verifySAMLSignature(xml, idpCert);
    identity = await validateSignedSamlReference(signedReference, requestId, acsUrl, spIssuer, idpIssuer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ event: 'sso.saml.rejected', err: message }, 'SAML assertion rejected');
    return res.status(401).json({ error: 'SAML assertion verification failed', detail: message });
  }

  let user;
  try {
    user = await findOrCreateSSOUser(identity.email, identity.displayName, 'saml', idpIssuer, identity.nameId, {
      emailVerified: true,
      allowEmailLink: true,
    });
  }
  catch (err) {
    logger.warn({ event: 'sso.saml.binding_rejected', err: err instanceof Error ? err.message : String(err) }, 'SAML account binding rejected');
    return res.status(403).json({ error: 'SSO identity does not match this account' });
  }
  const tokens = await issueTokens(user);
  try { await setAuthCookiesAndRedirect(res, tokens.accessToken, tokens.refreshToken); }
  catch (err) {
    logger.error({ event: 'sso.saml.handoff_store_failed', err: err instanceof Error ? err.message : String(err) }, 'SSO session handoff store unavailable');
    return res.status(503).json({ error: 'SSO session handoff is temporarily unavailable' });
  }
});

// ── Admin endpoints ────────────────────────────────────────────

/**
 * @openapi
 * /sso/config:
 *   get:
 *     tags: [Auth]
 *     summary: Aktif SSO yapılandırmasını getir
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 'SSO config (oidc/saml enabled, provider adı)' }
 *       401: { description: Kimlik doğrulaması gerekli }
 */
router.get('/config', authMiddleware, async (req: import('express').Request, res: import('express').Response) => {
  const _u   = castAuthed(req).user;
  const user = await Users.findById(_u.id);
  if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });

  const cfg = getSystemSSOConfig();
  res.json({
    oidc: { enabled: cfg.oidc.enabled, issuer: cfg.oidc.issuer, clientId: cfg.oidc.clientId },
    saml: { enabled: cfg.saml.enabled, entryPoint: cfg.saml.entryPoint, issuer: cfg.saml.issuer },
    metadataUrl:  `${BASE_URL}/api/sso/saml/metadata`,
    oidcStartUrl: `${BASE_URL}/api/sso/oidc/start`,
    samlStartUrl: `${BASE_URL}/api/sso/saml/start`,
  });
});

/**
 * @openapi
 * /sso/servers/{serverId}/config:
 *   put:
 *     tags: [Auth]
 *     summary: Sunucu SSO yapılandırmasını güncelle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: Yapılandırma güncellendi }
 *       403: { description: Sunucu sahibi değil }
 */
router.put('/servers/:serverId/config', authMiddleware, requireServerOwner, async (req: import('express').Request, res: import('express').Response) => {
  const { ssoConfig } = req.body as { ssoConfig?: unknown };
  await Servers.update(String(req.params.serverId ?? ''), { ssoConfig: JSON.stringify(ssoConfig) });
  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
