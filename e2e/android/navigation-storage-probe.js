// EX01 test-APK-only snapshot before Bridge modules initialize.
// Read-only; values and user/channel IDs never leave this page.
(() => {
  'use strict';
  const PREFIX = 'bridge:last-navigation:v1:';
  const LIMIT = 512;
  const boot = new Map();
  let complete = false;
  try {
    const storage = window.localStorage;
    if (storage.length <= LIMIT) {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (typeof k === 'string' && k.startsWith(PREFIX)) boot.set(k, storage.getItem(k));
      }
      complete = true;
    }
  } catch { /* Incomplete evidence must never count as a negative. */ }

  function inspect(user, server, expected) {
    const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
    if (!complete || !valid(user) || !valid(server) || !valid(expected)) return { available: false };
    const key = PREFIX + 'channel:' + user + ':' + server;
    try {
      const now = window.localStorage.getItem(key);
      const before = boot.get(key);
      const keyAtBoot = boot.has(key);
      return {
        available: true,
        keyAtBoot,
        expectedAtBoot: keyAtBoot && before === expected,
        keyNow: now !== null,
        expectedNow: now === expected,
        changedSinceBoot: keyAtBoot ? before !== now : now !== null,
        navigationKeysAtBoot: Math.min(boot.size, LIMIT),
      };
    } catch { return { available: false }; }
  }
  Object.defineProperty(window, '__bridgeNavigationProbeV1', {
    value: Object.freeze({ inspect }), enumerable: false, configurable: false, writable: false,
  });
})();
