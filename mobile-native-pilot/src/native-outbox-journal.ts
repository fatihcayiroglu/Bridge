import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { createEncryptedOutboxJournal } from './encrypted-outbox-journal.mjs';
import { outboxNamespaceMaterial } from './outbox-namespace.mjs';

// Call only with the server-validated account ID, never a display name or epoch.
export async function openNativeOutboxJournal(accountId: string, origin = 'https://native-acceptance.invalid') {
  const material = outboxNamespaceMaterial(origin, accountId);
  if (!await SecureStore.isAvailableAsync()) throw new Error('SECURE_STORE_REQUIRED');
  const name = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, material);
  const keyName = `bridge.nativepilot.outbox-key.v1.${name}`;
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  let keyHex = await SecureStore.getItemAsync(keyName, options);
  if (keyHex === null) {
    keyHex = [...Crypto.getRandomBytes(32)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    await SecureStore.setItemAsync(keyName, keyHex, options);
  }
  const db = await SQLite.openDatabaseAsync(`bridge-outbox-${name}.db`, { useNewConnection: true });
  try { return await createEncryptedOutboxJournal({ db, keyHex }); }
  catch (cause) { await db.closeAsync(); throw new Error('ENCRYPTED_OUTBOX_UNAVAILABLE', { cause }); }
}
