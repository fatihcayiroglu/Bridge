// Experimental native binding. No screen imports or invokes this capability yet.
// Merely constructing a port does NOT read, write, authenticate, or restore tokens.
import * as SecureStore from 'expo-secure-store';
import { createNativeCredentialPort } from './native-credential-port.mjs';

export const pilotNativeCredentialPort = createNativeCredentialPort({
  secureStore: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    isAvailableAsync: () => SecureStore.isAvailableAsync(),
    getItemAsync: (key, _options) => SecureStore.getItemAsync(key, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      requireAuthentication: false,
    }),
    setItemAsync: (key, token, _options) => SecureStore.setItemAsync(key, token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      requireAuthentication: false,
    }),
    deleteItemAsync: (key, _options) => SecureStore.deleteItemAsync(key, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      requireAuthentication: false,
    }),
  },
});
