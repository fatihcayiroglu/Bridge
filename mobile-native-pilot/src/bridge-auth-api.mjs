// Experimental Bridge sign-in adapter for the RN pilot. Matches server/routes/auth.ts
// (POST /api/login, POST /api/logout) and server/routes/twoFactor.ts (POST /api/2fa/check)
// as of main c061d72f. It never logs, stores or retries credentials.
//
// Not used to establish the pilot's session. These endpoints deliver the refresh token
// only as an httpOnly cookie, so a session started here could not be renewed. Native
// sessions come from system-browser sign-in with code + PKCE (browser-sign-in.mjs,
// native-auth-api.mjs; server docs/NATIVE_AUTH.md), which returns a rotating refresh
// token without changing these browser responses.
export class BridgeAuthError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BridgeAuthError';
    this.code = code;
  }
}

function verifiedOrigin(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new BridgeAuthError('INVALID_ORIGIN'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
    throw new BridgeAuthError('INVALID_ORIGIN');
  }
  return u.origin;
}

function nonEmpty(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** A server-issued session: the access token and the account it belongs to. */
function sessionFrom(data) {
  const user = data && typeof data === 'object' ? data.user : null;
  const userId = user && typeof user === 'object' ? (user._id ?? user.id) : null;
  if (!data || !nonEmpty(data.token, 8192) || !nonEmpty(userId, 200)) {
    throw new BridgeAuthError('BAD_RESPONSE');
  }
  return {
    kind: 'session',
    token: data.token,
    userId,
    displayName: typeof user.displayName === 'string' ? user.displayName : '',
  };
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

export function createBridgeAuthApi({ origin, fetchImpl = fetch }) {
  const root = verifiedOrigin(origin);
  if (typeof fetchImpl !== 'function') throw new BridgeAuthError('INVALID_ADAPTER');

  async function post(path, body, { signal } = {}) {
    try {
      return await fetchImpl(root + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
        signal,
      });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw new BridgeAuthError('ABORTED');
      throw new BridgeAuthError('NETWORK_FAILURE');
    }
  }

  function refusal(status, data) {
    if (status === 400 && data && data.requireCaptcha === true) return 'CAPTCHA_REQUIRED';
    if (status === 401) return 'INVALID_CREDENTIALS';
    if (status === 403 && data && data.error === 'EMAIL_NOT_VERIFIED') return 'EMAIL_NOT_VERIFIED';
    if (status === 403) return 'FORBIDDEN';
    if (status === 429) return 'RATE_LIMITED';
    if (status >= 500) return 'SERVER_UNAVAILABLE';
    return 'REQUEST_REJECTED';
  }

  return Object.freeze({
    /**
     * Password sign-in. 2FA accounts get NO credentials here: the server answers 202
     * with an opaque challenge that only completeTwoFactor can redeem.
     */
    async signInWithPassword(username, password, options = {}) {
      if (!nonEmpty(username, 256) || !nonEmpty(password, 1024)) throw new BridgeAuthError('INVALID_INPUT');
      const response = await post('/api/login', { username, password }, options);
      const data = await readJson(response);
      if (response.status === 202) {
        if (!data || data.requiresTwoFactor !== true || !nonEmpty(data.tempToken, 128)) {
          throw new BridgeAuthError('BAD_RESPONSE');
        }
        return { kind: 'two-factor', challenge: data.tempToken };
      }
      if (!response.ok) throw new BridgeAuthError(refusal(response.status, data));
      return sessionFrom(data);
    },

    async completeTwoFactor(challenge, code, options = {}) {
      if (!nonEmpty(challenge, 128) || !nonEmpty(code, 64)) throw new BridgeAuthError('INVALID_INPUT');
      const response = await post('/api/2fa/check', { tempToken: challenge, code }, options);
      const data = await readJson(response);
      if (!response.ok) throw new BridgeAuthError(refusal(response.status, data));
      return sessionFrom(data);
    },

    /**
     * Server half of sign-out. Without a refresh token there is nothing for the server
     * to revoke (see the boundary above); the call still clears the server's cookies.
     * Local sign-out never waits on, or depends on, this succeeding.
     */
    async logout(options = {}) {
      const response = await post('/api/logout', {}, options);
      if (!response.ok) throw new BridgeAuthError(refusal(response.status, null));
    },
  });
}
