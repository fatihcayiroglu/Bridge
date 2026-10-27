// server/routes/nativeAuth.ts
//
// Native (Android/iOS) sign-in with authorization code + PKCE (S256).
// Threat model and exact contract: docs/NATIVE_AUTH.md.
//
//   POST /api/refresh/native-authorize   browser consent → 303 to the app
//   POST /api/native-auth/token          code + verifier → access + refresh
//   POST /api/native-auth/refresh        rotate a native refresh token
//   (revocation reuses POST /api/refresh/logout with a body refreshToken)
//
// The browser step authenticates with the existing httpOnly, SameSite=Strict
// `bridge_refresh` cookie (path /api/refresh, hence the mount point) and answers
// with a redirect, never JSON: the code must not be readable by page script.
// Password, CAPTCHA, e-mail verification, 2FA, WebAuthn and SSO are all
// enforced by the existing web sign-in before that cookie exists.
//
// Native responses carry tokens only in a no-store JSON body. These endpoints
// never read or set the browser refresh cookie, and the browser login/2FA
// responses are unchanged.
import express from 'express';
import type { Request, Response } from 'express';
import logger from '../lib/logger';
import { Users } from '../db/repositories';
import {
  accessTokenLifetimeSeconds, makeRefreshSession, makeToken, revokeRefreshFamily, rotateRefreshToken,
} from '../middleware/auth';
import type { RotateResultOrError } from '../middleware/auth';
import { clearRefreshCookie, setRefreshCookie } from '../lib/authCookies';
import { limits } from '../middleware/rateLimit';
import { sanitizeOwnUser } from '../lib/userUtils';
import { parseTokenVersion } from '../lib/tokenVersion';
import {
  claimAuthorizationCode, isValidCodeChallenge, isValidCodeVerifier, isValidState, isWellFormedCode,
  issueAuthorizationCode, loadNativeAuthConfig, markCodeRedeemed, takeRedeemedFamily, verifierMatchesChallenge,
} from '../lib/nativeAuth';
import type { NativeAuthConfig } from '../lib/nativeAuth';

const REFRESH_TOKEN_MAX = 512;

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function webOrigin(): string | null {
  try { return process.env.BASE_URL ? new URL(process.env.BASE_URL).origin : null; } catch { return null; }
}

/**
 * The consent POST must come from a Bridge page. SameSite=Strict already keeps
 * the cookie off cross-site requests; this also refuses a same-site but
 * cross-origin sender. Fetch metadata first, Origin when it is absent.
 */
function isSameOriginSubmission(req: Request): boolean {
  const site = req.get('sec-fetch-site');
  if (site !== undefined) return site === 'same-origin';
  const origin = req.get('origin');
  const expected = webOrigin();
  return Boolean(origin && expected && origin === expected);
}

function oauthError(res: Response, status: number, error: string, reason?: string): void {
  noStore(res);
  res.status(status).json(reason ? { error, reason } : { error });
}

export function createNativeAuthRouters(config: NativeAuthConfig = loadNativeAuthConfig()) {
  const authorize = express.Router();
  const token = express.Router();

  // ── Browser consent → authorization code ──────────────────────────────
  authorize.post('/', limits.refresh(), express.urlencoded({ extended: false, limit: '4kb' }),
    async (req: Request, res: Response) => {
      noStore(res);
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (!config.enabled) return void res.status(503).type('text/plain').send('Native sign-in is not configured.');
      if (!isSameOriginSubmission(req)) return void res.status(403).type('text/plain').send('Request refused.');

      const body = (req.body ?? {}) as Record<string, unknown>;
      const redirectUri = body.redirect_uri;
      // Never redirect to an address that is not an exact allowlist entry.
      if (typeof redirectUri !== 'string' || !config.redirectUris.has(redirectUri)) {
        return void res.status(400).type('text/plain').send('Unknown redirect address.');
      }
      if (body.code_challenge_method !== 'S256' || !isValidCodeChallenge(body.code_challenge) || !isValidState(body.state)) {
        return void res.status(400).type('text/plain').send('Invalid sign-in request.');
      }

      const cookieToken = (req.cookies as Record<string, unknown> | undefined)?.bridge_refresh;
      if (typeof cookieToken !== 'string' || !cookieToken || cookieToken.length > REFRESH_TOKEN_MAX) {
        return void res.status(401).type('text/plain').send('Sign in to Bridge in this browser first.');
      }
      // Rotating (not just reading) the browser session reuses the existing
      // expiry, tokenVersion and reuse-detection checks exactly.
      let rotated: RotateResultOrError | null;
      try { rotated = await rotateRefreshToken(cookieToken); }
      catch (err) {
        logger.error({ err, event: 'native_auth.authorize.session_check_failed' }, 'Native authorize could not check the browser session');
        return void res.status(503).type('text/plain').send('Temporarily unavailable.');
      }
      if (!rotated || 'error' in rotated) {
        clearRefreshCookie(res);
        return void res.status(401).type('text/plain').send('Your browser session ended. Sign in again.');
      }
      setRefreshCookie(res, rotated.newToken);

      let code: string;
      try {
        code = await issueAuthorizationCode({
          userId: String(rotated.user._id),
          tokenVersion: parseTokenVersion(rotated.user.tokenVersion),
          challenge: body.code_challenge as string,
          redirectUri,
        });
      } catch (err) {
        logger.error({ err, event: 'native_auth.authorize.code_store_failed' }, 'Native authorization code could not be stored');
        return void res.status(503).type('text/plain').send('Temporarily unavailable.');
      }
      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      target.searchParams.set('state', body.state as string);
      res.redirect(303, target.toString());
    });

  // ── Code exchange ─────────────────────────────────────────────────────
  token.post('/token', limits.refresh(), async (req: Request, res: Response) => {
    if (!config.enabled) return oauthError(res, 503, 'temporarily_unavailable');
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.grant_type !== 'authorization_code' || !isWellFormedCode(body.code) ||
        !isValidCodeVerifier(body.code_verifier) || typeof body.redirect_uri !== 'string') {
      return oauthError(res, 400, 'invalid_request');
    }
    const code = body.code;

    let grant;
    try { grant = await claimAuthorizationCode(code); }
    catch (err) {
      logger.error({ err, event: 'native_auth.token.code_store_failed' }, 'Native code store unavailable');
      return oauthError(res, 503, 'temporarily_unavailable');
    }
    if (!grant) {
      // Unknown, expired or already redeemed. A replay of a redeemed code ends
      // the session that code produced: the code leaked.
      try {
        const family = await takeRedeemedFamily(code);
        if (family) {
          await revokeRefreshFamily(family);
          logger.warn({ event: 'native_auth.token.code_replay_revoked' }, 'Replayed native authorization code; its session was revoked');
        }
      } catch (err) {
        logger.error({ err, event: 'native_auth.token.replay_revoke_failed' }, 'Replayed native code could not be fully handled');
      }
      return oauthError(res, 400, 'invalid_grant');
    }
    // The code is consumed from here on, whatever the outcome below.
    if (grant.redirectUri !== body.redirect_uri || !verifierMatchesChallenge(body.code_verifier as string, grant.challenge)) {
      return oauthError(res, 400, 'invalid_grant');
    }

    const user = await Users.findById(grant.userId);
    let currentVersion: number | null;
    try { currentVersion = user ? parseTokenVersion(user.tokenVersion) : null; } catch { currentVersion = null; }
    // Signed out everywhere / password changed between consent and exchange.
    if (!user || currentVersion !== grant.tokenVersion) return oauthError(res, 400, 'invalid_grant');

    const session = await makeRefreshSession(user);
    try {
      await markCodeRedeemed(code, session.family);
    } catch (err) {
      // Without the marker a later replay could not be answered with
      // revocation. Do not hand out a session we could not protect.
      await revokeRefreshFamily(session.family).catch(() => {});
      logger.error({ err, event: 'native_auth.token.marker_failed' }, 'Native code redemption marker failed; session withdrawn');
      return oauthError(res, 503, 'temporarily_unavailable');
    }
    const accessToken = makeToken(user);
    noStore(res);
    res.json({
      token_type: 'Bearer',
      access_token: accessToken,
      expires_in: accessTokenLifetimeSeconds(accessToken),
      refresh_token: session.token,
      user: sanitizeOwnUser(user),
    });
  });

  // ── Native refresh (rotation) ─────────────────────────────────────────
  // Same rotation and reuse detection as /api/refresh, but the replacement
  // refresh token is returned in the body and cookies are neither read nor set.
  token.post('/refresh', limits.refresh(), async (req: Request, res: Response) => {
    const presented = ((req.body ?? {}) as Record<string, unknown>).refresh_token;
    if (typeof presented !== 'string' || !presented || presented.length > REFRESH_TOKEN_MAX) {
      return oauthError(res, 400, 'invalid_request');
    }
    let result: RotateResultOrError | null;
    try { result = await rotateRefreshToken(presented); }
    catch (err) {
      logger.error({ err, event: 'native_auth.refresh.failed' }, 'Native refresh failed');
      return oauthError(res, 503, 'temporarily_unavailable');
    }
    if (!result || 'error' in result) {
      return oauthError(res, 401, 'invalid_grant', result && 'error' in result ? result.error : 'not_found');
    }
    const accessToken = makeToken(result.user);
    noStore(res);
    res.json({
      token_type: 'Bearer',
      access_token: accessToken,
      expires_in: accessTokenLifetimeSeconds(accessToken),
      refresh_token: result.newToken,
    });
  });

  return { authorize, token, config };
}
