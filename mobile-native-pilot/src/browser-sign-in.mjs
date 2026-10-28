// System-browser sign-in (Android Custom Tabs / iOS ASWebAuthenticationSession via
// an injected openAuthSession, e.g. expo-web-browser's openAuthSessionAsync).
// The web page enforces password, CAPTCHA, e-mail verification, 2FA, WebAuthn and
// SSO; this module only carries the PKCE challenge out and validates the callback.
export class BrowserSignInError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BrowserSignInError';
    this.code = code;
  }
}

const CODE_RE = /^[A-Za-z0-9_-]{43}$/;

function verifiedOrigin(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new BrowserSignInError('INVALID_ORIGIN'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
    throw new BrowserSignInError('INVALID_ORIGIN');
  }
  return u.origin;
}

/** Query parser that does not depend on React Native's partial URL implementation. */
function parseQuery(query) {
  const out = new Map();
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    const value = eq < 0 ? '' : part.slice(eq + 1);
    let k, v;
    try { k = decodeURIComponent(key.replace(/\+/g, ' ')); v = decodeURIComponent(value.replace(/\+/g, ' ')); }
    catch { return null; }
    if (out.has(k)) return null; // duplicated parameters are refused, never "first wins"
    out.set(k, v);
  }
  return out;
}

function equalStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * @param origin        Bridge web origin (https)
 * @param redirectUri   exact redirect address registered on the server
 * @param openAuthSession (url, redirectUri) => Promise<{type:'success', url} | {type:'cancel'|'dismiss'|...}>
 * @param createPkce    () => Promise<{verifier, challenge, state}>
 */
export function createBrowserSignIn({ origin, redirectUri, openAuthSession, createPkce }) {
  const root = verifiedOrigin(origin);
  if (typeof redirectUri !== 'string' || !redirectUri || /[?#\s]/.test(redirectUri) ||
      typeof openAuthSession !== 'function' || typeof createPkce !== 'function') {
    throw new BrowserSignInError('INVALID_ADAPTER');
  }
  let pending = null;

  return Object.freeze({
    /** Resolves to {code, verifier, redirectUri}; the caller exchanges it at once. */
    async start() {
      // Invocation order owns the attempt, not completion order of native RNG.
      const request = {};
      pending = request;
      let attempt;
      try { attempt = await createPkce(); }
      catch {
        if (pending !== request) throw new BrowserSignInError('SUPERSEDED');
        pending = null;
        throw new BrowserSignInError('PKCE_FAILED');
      }
      if (pending !== request) throw new BrowserSignInError('SUPERSEDED');
      const query = [
        ['redirect_uri', redirectUri],
        ['code_challenge', attempt.challenge],
        ['code_challenge_method', 'S256'],
        ['state', attempt.state],
      ].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

      let result;
      try { result = await openAuthSession(`${root}/native-auth?${query}`, redirectUri); }
      catch { if (pending === request) pending = null; throw new BrowserSignInError('BROWSER_FAILED'); }
      if (pending !== request) throw new BrowserSignInError('SUPERSEDED');
      pending = null;

      if (!result || result.type !== 'success' || typeof result.url !== 'string') throw new BrowserSignInError('CANCELLED');
      const url = result.url;
      if (!url.startsWith(redirectUri + '?') || url.includes('#')) throw new BrowserSignInError('BAD_CALLBACK');
      const params = parseQuery(url.slice(redirectUri.length + 1));
      if (!params) throw new BrowserSignInError('BAD_CALLBACK');
      // A callback that is not for THIS attempt (injected, replayed or from an older
      // attempt) is refused before anything is sent anywhere.
      if (!equalStrings(params.get('state'), attempt.state)) throw new BrowserSignInError('STATE_MISMATCH');
      if (params.has('error')) throw new BrowserSignInError('DENIED');
      const code = params.get('code');
      if (!CODE_RE.test(code ?? '')) throw new BrowserSignInError('BAD_CALLBACK');
      return { code, verifier: attempt.verifier, redirectUri };
    },
    hasPendingAttempt: () => pending !== null,
  });
}
