// Native app configuration contract (security review findings 2 and backup handling).
// Static checks of app.json; the generated manifest/Info.plist come from it at prebuild.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync('app.json', 'utf8')).expo;
const app = fs.readFileSync('App.tsx', 'utf8');
const redirect = app.match(/createPilotSession\(origin, '([^']+)'\)/)?.[1];

test('exactly one URL scheme is registered: the one the sign-in redirect uses', () => {
  assert.equal(redirect, 'com.bridge.nativepilot:/oauth');
  const schemes = [config.scheme].flat();
  // Every registered scheme is another URL a hostile app or page can aim at this app;
  // only the redirect's own scheme is needed.
  assert.deepEqual(schemes, [new URL(redirect).protocol.slice(0, -1)]);
});

test('the backend integration run allows exactly the redirect the app sends', () => {
  const wf = fs.readFileSync('../.github/workflows/native-pilot-backend-integration.yml', 'utf8');
  assert.match(wf, new RegExp(`NATIVE_AUTH_REDIRECT_URIS: ${redirect.replace(/[.:/]/g, '\\$&')}\\s*$`, 'm'));
});

test('credentials stay out of device backups', () => {
  assert.equal(config.android.allowBackup, false);
  const secureStore = config.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-secure-store');
  assert.equal(secureStore?.[1]?.configureAndroidBackup, true);
});
