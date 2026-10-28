import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const confirmProductAction = vi.fn<(options: Record<string, unknown>) => Promise<boolean>>();
vi.mock('../js/core/product-dialog.ts', () => ({ confirmProductAction: (o: Record<string, unknown>) => confirmProductAction(o) }));

import {
  captureNativeAuthRequest, installNativeAuthConsent, NATIVE_AUTHORIZE_ACTION,
  offerNativeAuthConsent, takeNativeAuthRequest,
} from '../js/core/native-auth-consent.ts';

const CHALLENGE = 'A'.repeat(43);
const STATE = 'state_value_1234567890';
const REDIRECT = 'com.bridge.app:/oauth';
const query = (over: Record<string, string> = {}) => '?' + new URLSearchParams({
  redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: 'S256', state: STATE, ...over,
}).toString();

let submitted: HTMLFormElement[] = [];

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  document.body.innerHTML = '';
  submitted = [];
  confirmProductAction.mockReset();
  vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) { submitted.push(this); });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('native-auth request capture', () => {
  it('remembers a well-formed request for this tab and leaves the route', () => {
    window.history.replaceState(null, '', '/native-auth' + query());
    expect(captureNativeAuthRequest(1_000)).toBe(true);
    expect(window.location.pathname + window.location.search).toBe('/');
    expect(takeNativeAuthRequest(2_000)).toEqual({ redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: 'S256', state: STATE });
    expect(takeNativeAuthRequest(2_000)).toBeNull(); // single use
  });

  it.each([
    [{ code_challenge_method: 'plain' }],
    [{ code_challenge: 'short' }],
    [{ state: 'x' }],
    [{ redirect_uri: '' }],
  ])('refuses %p and still leaves the route', (over) => {
    window.history.replaceState(null, '', '/native-auth' + query(over));
    expect(captureNativeAuthRequest()).toBe(true);
    expect(window.location.pathname).toBe('/');
    expect(takeNativeAuthRequest()).toBeNull();
  });

  it('ignores every other route', () => {
    window.history.replaceState(null, '', '/channels' + query());
    expect(captureNativeAuthRequest()).toBe(false);
    expect(window.location.pathname).toBe('/channels');
  });

  it('a request older than 10 minutes is not offered', () => {
    window.history.replaceState(null, '', '/native-auth' + query());
    captureNativeAuthRequest(0);
    expect(takeNativeAuthRequest(10 * 60_000 + 1)).toBeNull();
  });
});

describe('consent', () => {
  it('confirmed: a top-level form POST to the authorize endpoint with exactly the four fields', async () => {
    window.history.replaceState(null, '', '/native-auth' + query());
    captureNativeAuthRequest();
    confirmProductAction.mockResolvedValue(true);
    expect(await offerNativeAuthConsent('Ada')).toBe(true);
    expect(String(confirmProductAction.mock.calls[0][0].message)).toContain('Ada');
    expect(submitted).toHaveLength(1);
    const form = submitted[0];
    expect({ method: form.method.toLowerCase(), action: new URL(form.action).pathname })
      .toEqual({ method: 'post', action: NATIVE_AUTHORIZE_ACTION });
    expect(Object.fromEntries(new FormData(form).entries())).toEqual({
      redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: 'S256', state: STATE,
    });
  });

  it('declined: nothing is submitted and the request is gone', async () => {
    window.history.replaceState(null, '', '/native-auth' + query());
    captureNativeAuthRequest();
    confirmProductAction.mockResolvedValue(false);
    await offerNativeAuthConsent('Ada');
    expect(submitted).toHaveLength(0);
    expect(takeNativeAuthRequest()).toBeNull();
  });

  it('no pending request: an ordinary sign-in shows no dialog', async () => {
    installNativeAuthConsent();
    document.dispatchEvent(new CustomEvent('bridge:auth-success', { detail: { displayName: 'Ada' } }));
    await Promise.resolve();
    expect(confirmProductAction).not.toHaveBeenCalled();
  });

  it('a pending request is offered after the next successful sign-in', async () => {
    window.history.replaceState(null, '', '/native-auth' + query());
    confirmProductAction.mockResolvedValue(true);
    installNativeAuthConsent();
    document.dispatchEvent(new CustomEvent('bridge:auth-success', { detail: { username: 'ada' } }));
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    expect(String(confirmProductAction.mock.calls[0][0].message)).toContain('ada');
  });
});

describe('switching accounts', () => {
  it('offers no switch when no sign-out is installed', async () => {
    window.history.replaceState(null, '', '/native-auth' + query());
    captureNativeAuthRequest();
    confirmProductAction.mockResolvedValue(false);
    await offerNativeAuthConsent('Ada');
    expect(confirmProductAction.mock.calls[0][0].onAlternate).toBeUndefined();
  });

  it('"Use a different account" signs the browser out, submits nothing and keeps the request for the next sign-in', async () => {
    const signOut = vi.fn();
    window.history.replaceState(null, '', '/native-auth' + query());
    confirmProductAction.mockImplementation(async (o) => { (o.onAlternate as () => void)(); return false; });
    installNativeAuthConsent(signOut);
    document.dispatchEvent(new CustomEvent('bridge:auth-success', { detail: { displayName: 'Ada' } }));
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(submitted).toHaveLength(0);
    expect(typeof confirmProductAction.mock.calls[0][0].alternateLabel).toBe('string');
    // Bob signs in next: the same request is offered again, now naming Bob, and confirming submits it.
    confirmProductAction.mockReset();
    confirmProductAction.mockResolvedValue(true);
    document.dispatchEvent(new CustomEvent('bridge:auth-success', { detail: { displayName: 'Bob' } }));
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    expect(String(confirmProductAction.mock.calls[0][0].message)).toContain('Bob');
    expect(Object.fromEntries(new FormData(submitted[0]).entries()).state).toBe(STATE);
  });

  it('the kept request still expires after ten minutes without a sign-in', () => {
    window.history.replaceState(null, '', '/native-auth' + query());
    captureNativeAuthRequest();
    expect(takeNativeAuthRequest(Date.now() + 10 * 60_000 + 1)).toBeNull();
  });
});
