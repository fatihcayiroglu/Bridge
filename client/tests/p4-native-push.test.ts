// client/tests/p4-native-push.test.ts
//
// P4-05 — the device token reaches the server through the app's authenticated client.
//
// MEASURED DEFECT: the Capacitor bridge posted the token itself with a RELATIVE url (the packaged
// app's origin is https://localhost, so it reached the app, not the server) and without the CSRF
// header (403). No native device could register for push. The bridge now only reports the token
// (mobile/tests/push-session.test.js); this module owns the server conversation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../js/core/api-fetch.ts', () => ({ apiFetch: apiFetchMock }));
vi.mock('../js/core/auth-compat.ts', () => ({ readToken: () => localStorage.getItem('token') }));

beforeEach(() => {
  localStorage.clear();
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({ ok: true, status: 200 });
});

let dispose: (() => void) | null = null;

afterEach(() => {
  dispose?.();
  dispose = null;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('native push registration goes through the authenticated client (P4-05)', () => {
  it('a device token received while signed in is registered via apiFetch (API base + CSRF), and stored', async () => {
    localStorage.setItem('token', 'access-token');
    const { initNativePush, _resetNativePushForTest } = await import('../js/core/native-push.ts');
    _resetNativePushForTest();
    dispose = _resetNativePushForTest;
    initNativePush();

    window.dispatchEvent(new CustomEvent('bridge:native-push-token', { detail: { token: 'fcm-abc', platform: 'android' } }));
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = apiFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/mobile/push/register-native');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ token: 'fcm-abc', platform: 'android' });
    expect(localStorage.getItem('bridge_native_push_token')).toBe('fcm-abc');
  });

  it('a token received before sign-in is registered on sign-in (account switch moves the device)', async () => {
    const { initNativePush, _resetNativePushForTest } = await import('../js/core/native-push.ts');
    _resetNativePushForTest();
    dispose = _resetNativePushForTest;
    initNativePush();

    window.dispatchEvent(new CustomEvent('bridge:native-push-token', { detail: { token: 'fcm-early', platform: 'ios' } }));
    await Promise.resolve();
    expect(apiFetchMock).not.toHaveBeenCalled();

    localStorage.setItem('token', 'access-token');
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String((apiFetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ token: 'fcm-early', platform: 'ios' });
  });

  it('sign-out forgets the stored device token (the next person does not inherit it)', async () => {
    localStorage.setItem('bridge_native_push_token', 'fcm-old');
    localStorage.setItem('bridge_native_push_platform', 'android');
    const { initNativePush, _resetNativePushForTest } = await import('../js/core/native-push.ts');
    _resetNativePushForTest();
    dispose = _resetNativePushForTest;
    initNativePush();

    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    expect(localStorage.getItem('bridge_native_push_token')).toBeNull();
    expect(localStorage.getItem('bridge_native_push_platform')).toBeNull();
  });

  it('rejects malformed token events', async () => {
    localStorage.setItem('token', 'access-token');
    const { initNativePush, _resetNativePushForTest } = await import('../js/core/native-push.ts');
    _resetNativePushForTest();
    dispose = _resetNativePushForTest;
    initNativePush();

    window.dispatchEvent(new CustomEvent('bridge:native-push-token', { detail: { token: 42 } }));
    window.dispatchEvent(new CustomEvent('bridge:native-push-token', { detail: { token: 'x'.repeat(5000) } }));
    await Promise.resolve();
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('bridge_native_push_token')).toBeNull();
  });

  it('badge reset clears the server count through the authenticated client', async () => {
    localStorage.setItem('token', 'access-token');
    const { initNativePush, _resetNativePushForTest } = await import('../js/core/native-push.ts');
    _resetNativePushForTest();
    dispose = _resetNativePushForTest;
    initNativePush();

    window.dispatchEvent(new CustomEvent('bridge:badge-cleared'));
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/api/mobile/push/badge/clear', { method: 'POST' }));
  });
});
