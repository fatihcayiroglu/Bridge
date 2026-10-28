// Platform-specific native binding used by the pilot session coordinator.
// Merely constructing a port does NOT read, write, authenticate, or restore tokens.
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { createNativeCredentialPort, NativeCredentialError } from './native-credential-port.mjs';

const platform = Platform.OS;
if (platform !== 'ios' && platform !== 'android') throw new NativeCredentialError('INVALID_NATIVE_ADAPTER');
const options = { requireAuthentication: false, ...(platform === 'ios' ? { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } : {}) };

export const pilotNativeCredentialPort = createNativeCredentialPort({
  platform,
  secureStore: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    isAvailableAsync: () => SecureStore.isAvailableAsync(),
    getItemAsync: (key, _options) => SecureStore.getItemAsync(key, options),
    setItemAsync: (key, token, _options) => SecureStore.setItemAsync(key, token, options),
    deleteItemAsync: (key, _options) => SecureStore.deleteItemAsync(key, options),
  },
});
