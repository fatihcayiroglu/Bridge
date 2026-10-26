import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { installNavigationStorageProbe } from './install-navigation-storage-probe.mjs';

const source = fs.readFileSync(fileURLToPath(new URL('./navigation-storage-probe.js', import.meta.url)), 'utf8');
const preference = 'bridge:last-navigation:v1:channel:user-1:server-1';
function storage(initial = []) {
  const data = new Map(initial);
  return {
    get length() { return data.size; },
    key(i) { return [...data.keys()][i] ?? null; },
    getItem(k) { return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { data.set(k, String(v)); },
    removeItem(k) { data.delete(k); },
  };
}
function boot(store) {
  const window = { localStorage: store };
  vm.runInNewContext(source, { window }, { timeout: 1000 });
  return window.__bridgeNavigationProbeV1;
}
test('early snapshot distinguishes intact, overwritten, erased, and absent preference', () => {
  const s = storage([[preference, 'expected']]);
  const p = boot(s);
  const inspect = () => p.inspect('user-1', 'server-1', 'expected');
  assert.equal(inspect().expectedAtBoot, true);
  assert.equal(inspect().expectedNow, true);
  s.setItem(preference, 'fallback');
  assert.equal(inspect().expectedAtBoot, true);
  assert.equal(inspect().expectedNow, false);
  assert.equal(inspect().changedSinceBoot, true);
  s.removeItem(preference);
  assert.equal(inspect().keyNow, false);
  assert.equal(inspect().changedSinceBoot, true);
  assert.equal(boot(storage()).inspect('user-1','server-1','expected').keyAtBoot, false);
});
test('probe exports only bounded booleans/counts, no stored IDs or values', () => {
  const p = boot(storage([[preference,'private-channel'],['unrelated','secret']]));
  const result = p.inspect('user-1','server-1','private-channel');
  assert.equal(result.expectedAtBoot, true);
  assert.equal(result.navigationKeysAtBoot, 1);
  assert.doesNotMatch(JSON.stringify(result), /private|user-1|server-1|secret/);
  assert.equal(p.inspect('', 'server-1', 'private-channel').available, false);
});
test('a preference created after boot is reported as changed, not unchanged', () => {
  const s = storage();
  const p = boot(s);
  s.setItem(preference, 'expected');
  const result = p.inspect('user-1', 'server-1', 'expected');
  assert.equal(result.keyAtBoot, false);
  assert.equal(result.expectedNow, true);
  assert.equal(result.changedSinceBoot, true);
});
test('early snapshot distinguishes channel-only rollback from server-key rollback without exposing values', () => {
  const serverPreference = 'bridge:last-navigation:v1:server:user-1';
  const s = storage([[preference, 'stale-channel'], [serverPreference, 'server-1']]);
  const p = boot(s);
  let result = p.inspect('user-1', 'server-1', 'expected');
  assert.equal(result.expectedAtBoot, false);
  assert.equal(result.serverKeyAtBoot, true);
  assert.equal(result.serverExpectedAtBoot, true);
  assert.equal(result.serverExpectedNow, true);
  assert.equal(result.serverChangedSinceBoot, false);
  s.setItem(serverPreference, 'private-other-server');
  result = p.inspect('user-1', 'server-1', 'expected');
  assert.equal(result.serverExpectedAtBoot, true);
  assert.equal(result.serverExpectedNow, false);
  assert.equal(result.serverChangedSinceBoot, true);
  assert.doesNotMatch(JSON.stringify(result), /stale-channel|private|user-1|server-1/);
  const missing = boot(storage([[preference, 'stale-channel']]))
    .inspect('user-1', 'server-1', 'expected');
  assert.equal(missing.serverKeyAtBoot, false);
  assert.equal(missing.serverExpectedAtBoot, false);
  assert.equal(missing.serverChangedSinceBoot, false);
});
test('probe fails closed for blocked, unknown or oversized localStorage', () => {
  assert.equal(boot({ get length() { throw Error('private'); } }).inspect('user','server','c').available, false);
  assert.equal(boot({ length: 513, key() { throw Error('unexpected'); } }).inspect('user','server','c').available, false);
});
test('installer injects before application modules in generated shell and rejects duplicates', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ex01-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root,'mobile/www/js'), { recursive: true });
  fs.mkdirSync(path.join(root,'e2e/android'), { recursive: true });
  fs.writeFileSync(path.join(root,'mobile/www/index.html'),
    '<html><!-- BRIDGE:APP-SCRIPTS:START --><script type="module" src="app.js"></script></html>');
  fs.writeFileSync(path.join(root,'e2e/android/navigation-storage-probe.js'), source);
  assert.deepEqual(installNavigationStorageProbe(root), { installed:true });
  const html = fs.readFileSync(path.join(root,'mobile/www/index.html'),'utf8');
  assert.ok(html.indexOf('navigation-storage-probe.js') < html.indexOf('app.js'));
  assert.equal(fs.readFileSync(path.join(root,'mobile/www/js/navigation-storage-probe.js'),'utf8'),source);
  assert.throws(() => installNavigationStorageProbe(root), /already instrumented/);
});
