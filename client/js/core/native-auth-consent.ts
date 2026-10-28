// Web half of native (Android/iOS) sign-in. Contract: docs/NATIVE_AUTH.md.
//
// The app opens `/native-auth?redirect_uri&code_challenge&code_challenge_method&state`
// in the system browser. This page only carries those values: the person signs in
// here exactly as on the web (password, CAPTCHA, e-mail verification, 2FA,
// WebAuthn, SSO), then confirms. Confirmation is a plain top-level form POST to
// /api/refresh/native-authorize, authenticated by the httpOnly refresh cookie; the
// server answers with a redirect straight to the app. No script on this page ever
// sees the authorization code, and the server re-validates every value.
import { t } from './i18n/index.ts';
import { confirmProductAction } from './product-dialog.ts';

const STORAGE_KEY = 'bridge_native_auth_request';
const MAX_AGE_MS = 10 * 60_000;
export const NATIVE_AUTH_PATH = '/native-auth';
export const NATIVE_AUTHORIZE_ACTION = '/api/refresh/native-authorize';

export type NativeAuthRequest = {
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  state: string;
};

function shapeOf(value: unknown): NativeAuthRequest | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.redirect_uri !== 'string' || v.redirect_uri.length < 8 || v.redirect_uri.length > 512) return null;
  if (typeof v.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v.code_challenge)) return null;
  if (v.code_challenge_method !== 'S256') return null;
  if (typeof v.state !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(v.state)) return null;
  return { redirect_uri: v.redirect_uri, code_challenge: v.code_challenge, code_challenge_method: 'S256', state: v.state };
}

/**
 * On the /native-auth route: remember the request for this tab only and leave the
 * route, so a reload or a later sign-in does not replay it. Returns whether this
 * document was the native-auth route.
 */
export function captureNativeAuthRequest(now: number = Date.now()): boolean {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path !== NATIVE_AUTH_PATH) return false;
  const params = new URLSearchParams(window.location.search);
  const request = shapeOf(Object.fromEntries(params.entries()));
  try {
    if (request) sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...request, at: now }));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch { /* storage off: the request is simply not offered */ }
  window.history.replaceState(null, '', '/');
  return true;
}

/** Consumes the pending request (single use); null when absent, malformed or stale. */
export function takeNativeAuthRequest(now: number = Date.now()): NativeAuthRequest | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
  } catch { return null; }
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const at = (parsed as { at?: unknown } | null)?.at;
  if (typeof at !== 'number' || at > now || now - at > MAX_AGE_MS) return null;
  return shapeOf(parsed);
}

/** Top-level navigation: the 303 to the app is never readable by page script. */
export function submitNativeAuthorization(request: NativeAuthRequest): void {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = NATIVE_AUTHORIZE_ACTION;
  form.style.display = 'none';
  for (const [name, value] of Object.entries(request)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

/** Put a taken request back so the next sign-in in this tab can offer it again. */
function keepNativeAuthRequest(request: NativeAuthRequest, now: number = Date.now()): void {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...request, at: now })); }
  catch { /* storage off: the request is simply not offered */ }
}

let signOutForSwitch: (() => void) | null = null;

/**
 * After a successful sign-in: ask before handing a session to the app. When this
 * browser is already signed in as someone else, "Use a different account" ends
 * only this browser session (the existing web sign-out) and keeps the pending
 * request, so the next sign-in, as another person, is offered the same consent.
 * Nothing is sent to the app until the person confirms.
 */
export async function offerNativeAuthConsent(displayName: string): Promise<boolean> {
  const request = takeNativeAuthRequest();
  if (!request) return false;
  const switchAccount = signOutForSwitch;
  const confirmed = await confirmProductAction({
    ...(switchAccount ? {
      alternateLabel: t('native_auth_consent_switch'),
      onAlternate: () => { keepNativeAuthRequest(request); switchAccount(); },
    } : {}),
    title: t('native_auth_consent_title'),
    message: t('native_auth_consent_message', undefined, { name: displayName }),
    confirmLabel: t('native_auth_consent_continue'),
    cancelLabel: t('cancel'),
  });
  if (confirmed) submitNativeAuthorization(request);
  return true;
}

let installed = false;
/** Captures a native-auth request and offers consent after the next sign-in or restore. */
export function installNativeAuthConsent(signOut?: () => void): void {
  if (signOut) signOutForSwitch = signOut;
  captureNativeAuthRequest();
  if (installed) return;
  installed = true;
  document.addEventListener('bridge:auth-success', (event) => {
    const user = (event as CustomEvent<{ displayName?: unknown; username?: unknown }>).detail;
    const name = typeof user?.displayName === 'string' && user.displayName
      ? user.displayName
      : typeof user?.username === 'string' ? user.username : '';
    void offerNativeAuthConsent(name);
  });
}
