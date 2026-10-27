// Native token endpoints (docs/NATIVE_AUTH.md on the server branch):
//   POST /api/native-auth/token    code + verifier → access + refresh
//   POST /api/native-auth/refresh  rotate the refresh token
//   POST /api/refresh/logout       revoke the refresh session (existing endpoint)
// Cookies are omitted, only HTTPS origins are accepted, nothing is logged,
// stored or retried here. Server text never reaches an error.
export class NativeAuthError extends Error {
  constructor(code, reason = null) {
    super(code);
    this.name = 'NativeAuthError';
    this.code = code;
    this.reason = reason;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const REASONS = new Set(['reuse', 'expired', 'revoked', 'not_found', 'user_not_found']);

function verifiedOrigin(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new NativeAuthError('INVALID_ORIGIN'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
    throw new NativeAuthError('INVALID_ORIGIN');
  }
  return u.origin;
}
const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

export function createNativeAuthApi({ origin, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const root = verifiedOrigin(origin);
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new NativeAuthError('INVALID_ADAPTER');
  }

  /**
   * `unknownOnNetworkFailure`: for a refresh, a lost response does not tell
   * whether the server rotated (consumed) the presented token.
   */
  async function post(path, body, unknownOnNetworkFailure) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl(root + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
        signal: controller?.signal,
      });
    } catch {
      throw new NativeAuthError(unknownOnNetworkFailure ? 'OUTCOME_UNKNOWN' : 'NETWORK_FAILURE');
    } finally {
      if (timer) clearTimeout(timer);
    }
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (response.status >= 200 && response.status < 300) return data;
    if (response.status === 400 || response.status === 401) {
      if (data && data.error === 'invalid_grant') {
        throw new NativeAuthError('INVALID_GRANT', REASONS.has(data.reason) ? data.reason : null);
      }
      throw new NativeAuthError('INVALID_REQUEST');
    }
    if (response.status === 429) throw new NativeAuthError('RATE_LIMITED');
    // A 5xx after a refresh request may follow a committed rotation.
    if (response.status >= 500) throw new NativeAuthError(unknownOnNetworkFailure ? 'OUTCOME_UNKNOWN' : 'SERVER_UNAVAILABLE');
    throw new NativeAuthError('INVALID_REQUEST');
  }

  function tokensFrom(data) {
    if (!data || data.token_type !== 'Bearer' || !str(data.access_token, 8192) || !str(data.refresh_token, 512)) {
      throw new NativeAuthError('BAD_RESPONSE');
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: Number.isInteger(data.expires_in) && data.expires_in > 0 ? data.expires_in : null,
    };
  }

  return Object.freeze({
    async exchangeCode({ code, verifier, redirectUri }) {
      if (!str(code, 128) || !str(verifier, 128) || !str(redirectUri, 512)) throw new NativeAuthError('INVALID_INPUT');
      const data = await post('/api/native-auth/token', {
        grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri,
      }, false);
      const tokens = tokensFrom(data);
      const user = data.user && typeof data.user === 'object' ? data.user : null;
      const userId = user ? (user._id ?? user.id) : null;
      if (!str(userId, 200)) throw new NativeAuthError('BAD_RESPONSE');
      return { ...tokens, userId };
    },
    async refresh(refreshToken) {
      if (!str(refreshToken, 512)) throw new NativeAuthError('INVALID_INPUT');
      return tokensFrom(await post('/api/native-auth/refresh', { refresh_token: refreshToken }, true));
    },
    async revoke(refreshToken) {
      if (!str(refreshToken, 512)) throw new NativeAuthError('INVALID_INPUT');
      const data = await post('/api/refresh/logout', { refreshToken }, false);
      if (!data || data.ok !== true) throw new NativeAuthError('BAD_RESPONSE');
    },
  });
}
