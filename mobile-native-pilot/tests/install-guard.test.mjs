// Fresh-install purge (security review finding 5). Offline fakes: this is NOT evidence
// that the iOS Keychain really survives uninstall on a device; that needs a device.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInstallGuard, InstallGuardError } from '../src/install-guard.mjs';
import { createNativeCredentialPort } from '../src/native-credential-port.mjs';
import { createSessionCoordinator } from '../src/session-coordinator.mjs';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** A device: the Keychain outlives the app; the sandbox (marker) does not. */
function device() {
  const keychain = { value: null, failRead: false, failDelete: false };
  const sandbox = { marker: null, failRead: false, failWrite: false };
  const calls = [];
  const secureStore = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    isAvailableAsync: async () => true,
    getItemAsync: async () => { calls.push('kc.get'); if (keychain.failRead) throw new Error('native detail'); return keychain.value; },
    setItemAsync: async (_k, v) => { calls.push('kc.set'); keychain.value = v; },
    deleteItemAsync: async () => { calls.push('kc.delete'); if (keychain.failDelete) throw new Error('native detail'); keychain.value = null; },
  };
  const marker = {
    read: async () => { calls.push('marker.read'); if (sandbox.failRead) throw new Error('io'); return sandbox.marker; },
    write: async (id) => { calls.push('marker.write'); if (sandbox.failWrite) throw new Error('io'); sandbox.marker = id; },
  };
  return { keychain, sandbox, calls, secureStore, marker, uninstall() { sandbox.marker = null; } };
}

function launch(dev, { revoked = [], refreshes = [] } = {}) {
  const credentials = createNativeCredentialPort({ secureStore: dev.secureStore });
  const guard = createInstallGuard({ marker: dev.marker, credentials, revoke: async (t) => { revoked.push(t); }, createId: () => ID });
  const authApi = {
    refresh: async (token) => { refreshes.push(token); return { accessToken: 'at-' + token, refreshToken: 'next-' + token, expiresIn: 600 }; },
    revoke: async (t) => { revoked.push(t); },
  };
  const coordinator = createSessionCoordinator({ credentials, authApi,
    createReadApi: () => ({ getMe: async () => ({ id: 'user-1' }) }) });
  return { guard, coordinator, credentials, revoked, refreshes };
}

const tick = () => new Promise((r) => setImmediate(r));

test('reinstall: a Keychain leftover is deleted and revoked, never presented to /refresh', async () => {
  const dev = device();
  dev.keychain.value = 'old-install-refresh-token'; // left by an uninstalled installation
  const app = launch(dev);
  assert.deepEqual(await app.guard.prepare(), { freshInstall: true, purged: true });
  await tick();
  assert.equal(dev.keychain.value, null);
  assert.deepEqual(app.revoked, ['old-install-refresh-token']);
  assert.equal(dev.sandbox.marker, ID);
  const state = await app.coordinator.restore();
  assert.equal(state.phase, 'signed-out');
  assert.deepEqual(app.refreshes, [], 'the leftover never reached /refresh');
  // Delete happens before the marker write: a crash between them purges again.
  assert.ok(dev.calls.indexOf('kc.delete') < dev.calls.indexOf('marker.write'));
});

test('same installation relaunch: the marker is present, nothing is purged, the session restores', async () => {
  const dev = device();
  const first = launch(dev);
  await first.guard.prepare();
  dev.keychain.value = 'signed-in-token'; // signed in during the first launch
  const relaunch = launch(dev);
  assert.deepEqual(await relaunch.guard.prepare(), { freshInstall: false, purged: false });
  assert.equal(dev.keychain.value, 'signed-in-token');
  const state = await relaunch.coordinator.restore();
  assert.equal(state.phase, 'authenticated');
  assert.deepEqual(relaunch.refreshes, ['signed-in-token']);
  assert.deepEqual(relaunch.revoked, []);
});

test('uninstall then reinstall after signing in: the next launch starts signed out', async () => {
  const dev = device();
  await launch(dev).guard.prepare();
  dev.keychain.value = 'session-of-previous-owner';
  dev.uninstall();
  const app = launch(dev);
  assert.deepEqual(await app.guard.prepare(), { freshInstall: true, purged: true });
  assert.equal((await app.coordinator.restore()).phase, 'signed-out');
  assert.deepEqual(app.refreshes, []);
});

test('fresh install with an empty Keychain: marker written, nothing revoked', async () => {
  const dev = device();
  const app = launch(dev);
  assert.deepEqual(await app.guard.prepare(), { freshInstall: true, purged: false });
  await tick();
  assert.deepEqual(app.revoked, []);
  assert.equal(dev.sandbox.marker, ID);
});

test('a corrupt leftover item is still deleted; nothing is revoked with it', async () => {
  const dev = device();
  dev.keychain.value = 'bad\u0000token';
  const app = launch(dev);
  assert.deepEqual(await app.guard.prepare(), { freshInstall: true, purged: false });
  await tick();
  assert.equal(dev.keychain.value, null);
  assert.deepEqual(app.revoked, []);
});

test('fail closed: an unreadable or undeletable Keychain leaves no marker and blocks restore', async () => {
  for (const fault of ['failRead', 'failDelete']) {
    const dev = device();
    dev.keychain.value = 'old-install-refresh-token';
    dev.keychain[fault] = true;
    const app = launch(dev);
    await assert.rejects(app.guard.prepare(), (e) => e instanceof InstallGuardError && e.code === 'PURGE_FAILED', fault);
    assert.equal(dev.sandbox.marker, null, `${fault}: no marker, so the next launch purges again`);
    assert.deepEqual(app.refreshes, []);
    // Recovers once storage works again.
    dev.keychain[fault] = false;
    assert.deepEqual(await app.guard.prepare(), { freshInstall: true, purged: true }, `${fault}: retry after failure`);
    assert.equal(dev.keychain.value, null);
  }
});

test('fail closed: an unreadable marker is an error, not a fresh install and not a restore', async () => {
  const dev = device();
  dev.keychain.value = 'kept-token';
  dev.sandbox.failRead = true;
  const app = launch(dev);
  await assert.rejects(app.guard.prepare(), (e) => e.code === 'MARKER_READ_FAILED');
  assert.equal(dev.keychain.value, 'kept-token', 'no purge on a marker we could not read');
});

test('a marker write failure after the purge is reported; the credential is already gone', async () => {
  const dev = device();
  dev.keychain.value = 'old-install-refresh-token';
  dev.sandbox.failWrite = true;
  const app = launch(dev);
  await assert.rejects(app.guard.prepare(), (e) => e.code === 'MARKER_WRITE_FAILED');
  assert.equal(dev.keychain.value, null);
});

test('an invalid stored marker counts as no marker', async () => {
  const dev = device();
  dev.sandbox.marker = 'x';
  dev.keychain.value = 'old-install-refresh-token';
  assert.deepEqual(await launch(dev).guard.prepare(), { freshInstall: true, purged: true });
  assert.equal(dev.keychain.value, null);
});

test('prepare runs once per process: concurrent callers share one purge', async () => {
  const dev = device();
  dev.keychain.value = 'old-install-refresh-token';
  const app = launch(dev);
  const [a, b] = await Promise.all([app.guard.prepare(), app.guard.prepare()]);
  assert.equal(a, b);
  assert.equal(dev.calls.filter((c) => c === 'kc.delete').length, 1);
  assert.equal(dev.calls.filter((c) => c === 'marker.read').length, 1);
});

test('a revoke failure does not fail the purge or leak an error', async () => {
  const dev = device();
  dev.keychain.value = 'old-install-refresh-token';
  const credentials = createNativeCredentialPort({ secureStore: dev.secureStore });
  const guard = createInstallGuard({ marker: dev.marker, credentials, revoke: async () => { throw new Error('offline'); }, createId: () => ID });
  assert.deepEqual(await guard.prepare(), { freshInstall: true, purged: true });
  await tick();
});

test('adapter validation and id validation', async () => {
  assert.throws(() => createInstallGuard({}), (e) => e.code === 'INVALID_ADAPTER');
  const dev = device();
  const credentials = createNativeCredentialPort({ secureStore: dev.secureStore });
  const guard = createInstallGuard({ marker: dev.marker, credentials, revoke: async () => {}, createId: () => 'short' });
  await assert.rejects(guard.prepare(), (e) => e.code === 'INVALID_ID');
  assert.equal(dev.sandbox.marker, null);
});

// Wiring checks (static): the app and the native acceptance runs go through the guard.
import fs from 'node:fs';
test('the app restores only through the guarded restore; acceptance asserts the install markers', () => {
  const app = fs.readFileSync('App.tsx', 'utf8');
  assert.match(app, /runtime\.session\.restore\(\)/);
  assert.doesNotMatch(app, /coordinator\.restore\(\)/, 'no unguarded restore in the app');
  const session = fs.readFileSync('src/pilot-session.ts', 'utf8');
  assert.match(session, /await installGuard\.prepare\(\);\s*return coordinator\.restore\(\);/);
  const probe = fs.readFileSync('src/NativeAcceptanceProbe.tsx', 'utf8');
  assert.ok(probe.indexOf('createInstallGuard') < probe.indexOf("stage = 'secure-store-read'"), 'guard runs before any fixture read');
  for (const m of ['NATIVE_INSTALL_GUARD_FRESH', 'NATIVE_INSTALL_GUARD_KEPT', 'NATIVE_INSTALL_LEFTOVER_PURGED', 'NATIVE_INSTALL_LEFTOVER_NONE', 'INSTALL_GUARD_CREDENTIAL_MISMATCH']) assert.ok(probe.includes(m), m);
  const ios = fs.readFileSync('scripts/ios-native-acceptance.sh', 'utf8');
  const order = ['NATIVE_INSTALL_GUARD_FRESH native-evidence/first-native-ui.txt', 'NATIVE_INSTALL_GUARD_KEPT native-evidence/restart-native-ui.txt',
    'simctl uninstall', 'simctl install "$udid" "$app"', 'assert_native_marker NATIVE_INSTALL_GUARD_FRESH reinstall-native-ui',
    'NATIVE_SQLCIPHER_WRITE_PASS native-evidence/reinstall-native-ui.txt', 'NATIVE_IOS_SIMULATOR_KEYCHAIN_AFTER_UNINSTALL'];
  let at = -1;
  for (const step of order) { const next = ios.indexOf(step); assert.ok(next > at, step); at = next; }
  const android = fs.readFileSync('scripts/android-native-acceptance.sh', 'utf8');
  assert.match(android, /grep -q NATIVE_INSTALL_GUARD_FRESH native-evidence\/first-ui\.xml/);
  assert.match(android, /grep -q NATIVE_INSTALL_GUARD_KEPT native-evidence\/restart-ui\.xml/);
  const wf = fs.readFileSync('../.github/workflows/native-pilot-native-runtime.yml', 'utf8');
  assert.match(wf, /bash scripts\/ios-native-acceptance\.sh "\$udid" "\$app"/);
});
