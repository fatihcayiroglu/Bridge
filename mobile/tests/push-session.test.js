// mobile/tests/push-session.test.js
//
// P4 — the native bridge hands the device token to the app and ties push to the session.
//
// MEASURED DEFECT (P4-05): the bridge posted the token itself with
//   fetch('/api/mobile/push/register-native', { headers: { Authorization: `Bearer ${jwt}` } })
// · a RELATIVE url: the packaged app's origin is https://localhost, so the request reached the
//   app itself, never the Bridge server;
// · a Bearer request without X-CSRF-Token, which the server's enforceApiCsrf rejects with 403.
// A native device could therefore never register for push. The same applied to the badge reset.
//
// These tests run the REAL compiled bridge (mobile/capacitor-bridge.js) against a minimal plugin
// double and assert the new contract. The first test is also the negative control: with the old
// bridge it fails (fetch was called and no bridge:native-push-token event existed).

'use strict';

function pushPlugin(permission = 'granted') {
  const listeners = {};
  return {
    listeners,
    checkPermissions: jest.fn().mockResolvedValue({ receive: permission }),
    requestPermissions: jest.fn().mockResolvedValue({ receive: permission }),
    register: jest.fn().mockResolvedValue(undefined),
    unregister: jest.fn().mockResolvedValue(undefined),
    addListener: jest.fn((event, cb) => { listeners[event] = cb; }),
    emit(event, payload) { listeners[event]?.(payload); },
  };
}

const fcmConfigured = () => ({ status: jest.fn().mockResolvedValue({ available: true, reason: 'ok' }) });

function loadBridge(plugins, platform = 'android') {
  global.Capacitor = { Plugins: plugins, getPlatform: () => platform };
  window.Capacitor = global.Capacitor;
  jest.isolateModules(() => { require('../capacitor-bridge.js'); });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('native push registration is owned by the app (P4-05)', () => {
  let fetchSpy;
  const events = [];
  const onToken = (e) => events.push(e.detail);

  beforeEach(() => {
    events.length = 0;
    fetchSpy = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchSpy;
    window.addEventListener('bridge:native-push-token', onToken);
  });

  afterEach(() => {
    window.removeEventListener('bridge:native-push-token', onToken);
    delete global.fetch;
  });

  it('registration token → bridge:native-push-token event; the bridge makes NO network request', async () => {
    const push = pushPlugin('granted');
    loadBridge({ PushNotifications: push, BridgePushSupport: fcmConfigured() });
    window.dispatchEvent(new Event('load'));
    await flush();

    expect(push.register).toHaveBeenCalledTimes(1); // already-granted permission: no prompt, just register
    push.emit('registration', { value: 'fcm-token-abc' });

    expect(events).toEqual([{ token: 'fcm-token-abc', platform: 'android' }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('launch without permission does not prompt and does not register', async () => {
    const push = pushPlugin('prompt');
    loadBridge({ PushNotifications: push });
    window.dispatchEvent(new Event('load'));
    await flush();

    expect(push.requestPermissions).not.toHaveBeenCalled();
    expect(push.register).not.toHaveBeenCalled();
  });

  it('sign-out unregisters the device token natively', async () => {
    const push = pushPlugin('granted');
    loadBridge({ PushNotifications: push });
    window.dispatchEvent(new Event('load'));
    await flush();

    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    await flush();
    expect(push.unregister).toHaveBeenCalledTimes(1);
  });

  it('sign-in re-registers when the permission is already granted (new account gets the device)', async () => {
    const push = pushPlugin('granted');
    loadBridge({ PushNotifications: push, BridgePushSupport: fcmConfigured() });
    window.dispatchEvent(new Event('load'));
    await flush();
    push.register.mockClear();

    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    await flush();
    expect(push.register).toHaveBeenCalledTimes(1);
  });

  it('sign-in without permission does not prompt', async () => {
    const push = pushPlugin('denied');
    loadBridge({ PushNotifications: push });
    window.dispatchEvent(new Event('load'));
    await flush();

    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    await flush();
    expect(push.register).not.toHaveBeenCalled();
    expect(push.requestPermissions).not.toHaveBeenCalled();
  });

  it('badge reset asks the app to clear the server count; the bridge makes NO network request', async () => {
    const push = pushPlugin('granted');
    loadBridge({ PushNotifications: push });
    const cleared = jest.fn();
    window.addEventListener('bridge:badge-cleared', cleared);
    localStorage.setItem('bridge_token', 'jwt-would-have-been-sent');
    try {
      await window.bridgeBadge.clear();
      expect(cleared).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('bridge:badge-cleared', cleared);
      localStorage.removeItem('bridge_token');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P4-18 — register() MUST NOT RUN WHERE IT CRASHES THE PROCESS
// ════════════════════════════════════════════════════════════════════════════
// Measured on the Android 14 emulator: with the notification permission granted and no
// google-services.json (the self-hosted default), register() threw
// "IllegalStateException: Default FirebaseApp is not initialized" and the app died.
describe('native push is only registered where FCM is configured (P4-18)', () => {
  it('Android build without FCM: launch with permission granted does NOT call register(); status is "unavailable"', async () => {
    const push = pushPlugin('granted');
    const support = { status: jest.fn().mockResolvedValue({ available: false, reason: 'firebase_not_configured' }) };
    loadBridge({ PushNotifications: push, BridgePushSupport: support });
    window.dispatchEvent(new Event('load'));
    await flush();
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    await flush();

    expect(push.register).not.toHaveBeenCalled();
    await expect(window.bridgePush.status()).resolves.toBe('unavailable');
    // Enabling does not even open the OS permission sheet for a feature that cannot work.
    await expect(window.bridgePush.enable()).resolves.toBe(false);
    expect(push.requestPermissions).not.toHaveBeenCalled();
  });

  it('Android shell without the native guard (older APK): never registers', async () => {
    const push = pushPlugin('granted');
    loadBridge({ PushNotifications: push });
    window.dispatchEvent(new Event('load'));
    await flush();
    expect(push.register).not.toHaveBeenCalled();
  });

  it('iOS needs no Firebase: registers with the permission already granted', async () => {
    const push = pushPlugin('granted');
    loadBridge({ PushNotifications: push }, 'ios');
    window.dispatchEvent(new Event('load'));
    await flush();
    expect(push.register).toHaveBeenCalledTimes(1);
  });

  it('Android with FCM configured: enable() asks for permission and registers', async () => {
    const push = pushPlugin('prompt');
    push.requestPermissions.mockResolvedValue({ receive: 'granted' });
    loadBridge({ PushNotifications: push, BridgePushSupport: fcmConfigured() });
    await expect(window.bridgePush.enable()).resolves.toBe(true);
    expect(push.requestPermissions).toHaveBeenCalledTimes(1);
    expect(push.register).toHaveBeenCalledTimes(1);
  });
});
