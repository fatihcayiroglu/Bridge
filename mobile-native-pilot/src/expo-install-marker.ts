// Installation marker in the app sandbox (an SQLite key-value file). The sandbox is
// removed on uninstall on both platforms; the iOS Keychain is not. See install-guard.mjs.
// Backup: Android backup is disabled (app.json). An iOS backup restores this marker
// together with Keychain items only to the SAME device (WHEN_UNLOCKED_THIS_DEVICE_ONLY
// items never move to another device), so a restore cannot pair a marker with a
// credential from a different installation's device.
import { SQLiteStorage } from 'expo-sqlite/kv-store';
import type { InstallMarkerPort } from './install-guard.mjs';

const KEY = 'installation-id';
const storage = new SQLiteStorage('bridge-nativepilot-install.db');

export const pilotInstallMarker: InstallMarkerPort = {
  read: () => storage.getItemAsync(KEY),
  write: (id) => storage.setItemAsync(KEY, id),
};
