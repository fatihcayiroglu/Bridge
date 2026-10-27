// Bounded native credential storage port for the isolated RN pilot.
// Unused by the UI. It never signs in, reads a production session, or auto-restores.
// The injected implementation is Expo SecureStore on device or a fake in Node tests.
export class NativeCredentialError extends Error {
  constructor(code) {
    super(code);
    this.name = 'NativeCredentialError';
    this.code = code;
  }
}

// Separate pilot app identifiers prevent sharing the current Capacitor credential area.
// No accounts are stored by this module until the caller deliberately invokes writeToken.
export const NATIVE_PILOT_CREDENTIAL_KEY = 'bridge.nativepilot.session.v1';

function validToken(token) {
  return typeof token === 'string' && token.length > 0 &&
    token.length <= 8192 && token.trim() === token &&
    !/[\u0000-\u001f\u007f]/.test(token);
}

/**
 * Native SecureStore is a *capability*, not a guarantee that authentication works.
 * Neither biometric fallback nor insecure local/AsyncStorage fallback is allowed.
 *
 * On iOS Keychain can persist across uninstallation. A future complete session
 * implementation MUST validate restored credentials with /api/me, revoke on
 * account deletion/logout, and handle storage failures as explicit blockers.
 */
export function createNativeCredentialPort({ secureStore }) {
  if (!secureStore ||
      typeof secureStore.isAvailableAsync !== 'function' ||
      typeof secureStore.getItemAsync !== 'function' ||
      typeof secureStore.setItemAsync !== 'function' ||
      typeof secureStore.deleteItemAsync !== 'function' ||
      typeof secureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY !== 'string') {
    throw new NativeCredentialError('INVALID_NATIVE_ADAPTER');
  }

  const options = Object.freeze({
    keychainAccessible: secureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    requireAuthentication: false,
  });

  async function assertAvailable() {
    let available;
    try {
      available = await secureStore.isAvailableAsync();
    } catch {
      throw new NativeCredentialError('STORAGE_UNAVAILABLE');
    }
    if (available !== true) throw new NativeCredentialError('STORAGE_UNAVAILABLE');
  }

  async function perform(method, ...args) {
    await assertAvailable();
    try {
      return await secureStore[method](NATIVE_PILOT_CREDENTIAL_KEY, ...args, options);
    } catch {
      // Never expose native error messages, stored token, keychain metadata or stack.
      throw new NativeCredentialError('STORAGE_FAILURE');
    }
  }

  // Native Keychain/Keystore calls are async. Preserve invocation order so a
  // later clear cannot be overtaken by an earlier in-flight write.
  let tail = Promise.resolve();
  function serialize(task) {
    const result = tail.then(task);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  return Object.freeze({
    readToken() {
      return serialize(async () => {
        const stored = await perform('getItemAsync');
        if (stored === null) return null;
        if (!validToken(stored)) throw new NativeCredentialError('INVALID_STORED_TOKEN');
        return stored;
      });
    },
    writeToken(token) {
      if (!validToken(token)) return Promise.reject(new NativeCredentialError('INVALID_TOKEN'));
      return serialize(async () => { await perform('setItemAsync', token); });
    },
    clearToken() {
      // No "clear succeeded" result is returned before the native deletion resolves.
      return serialize(async () => { await perform('deleteItemAsync'); });
    },
  });
}
