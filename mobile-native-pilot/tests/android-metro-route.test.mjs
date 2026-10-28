import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { configureAndroidMetroRoute } from '../scripts/android-metro-route.mjs';
import { requireMetroLoopbackSource } from '../src/native-metro-source.mjs';

const good = 'HTTP/1.0 200 OK\r\nContent-Length: 23\r\n\r\npackager-status:running';
function fixture({ response = good, control = '', fault, readbackChanged = false, reverse = 'emulator-5554 tcp:8081 tcp:8081\n' } = {}) {
  let stored = '';
  const calls = [];
  const adb = (args, options) => {
    calls.push({ args, options });
    if (fault === calls.length) return { status: 255, stdout: '', stderr: 'transport closed' };
    if (args[0] === 'reverse') return { status: 0, stdout: reverse };
    if (options.input) { stored = options.input; return { status: 0, stdout: '' }; }
    if (args.includes('cat')) return { status: 0, stdout: readbackChanged ? '<map/>' : stored };
    // The original NAT path has no route, as observed in run 40610885003.
    assert.match(args.at(-1), /127\.0\.0\.1 8081$/);
    return { status: 0, stdout: args.at(-1).includes('sleep 5') ? response : control };
  };
  return { adb, calls };
}
test('unavailable emulator NAT is avoided by a read-back RN preference and a real status contract', () => {
  const f = fixture(), evidence = {};
  configureAndroidMetroRoute({ adb: f.adb, evidence });
  assert.equal(f.calls.length, 5);
  assert.match(f.calls[1].options.input, /name="debug_http_host">127\.0\.0\.1:8081</);
  assert.match(f.calls[1].args[2], /^run-as com\.bridge\.nativepilot sh -c '/);
  assert.equal(evidence.verdict, 'PASS');
  assert.equal(evidence.status_body_matches, true);
  assert.equal(evidence.eof_control_bytes, 0);
  assert.ok(evidence.operations.every(op => op.elapsed_ms >= 0));
});
test('wrong or empty HTTP evidence fails closed, even when adb exits zero', () => {
  for (const response of ['', 'HTTP/1.0 200 OK\r\n\r\n', 'HTTP/1.0 503 unavailable\r\n\r\npackager-status:running',
    'HTTP/1.0 200 OK\r\n\r\npackager-status:running-extra', 'HTTP/1.0 200 OK\r\n\r\n<html>packager-status:running</html>']) {
    const f = fixture({ response });
    assert.throws(() => configureAndroidMetroRoute({ adb: f.adb }), /METRO_ROUTE_STATUS_REJECTED/);
    assert.equal(f.calls.length, 5, 'one EOF control and one complete exchange, no retry or host fallback');
  }
});
test('missing reverse mapping or preference readback prevents the HTTP check', () => {
  const missing = fixture({ reverse: '' });
  assert.throws(() => configureAndroidMetroRoute({ adb: missing.adb }), /METRO_REVERSE_MAPPING_REQUIRED/);
  assert.equal(missing.calls.length, 1);
  const wrong = fixture({ readbackChanged: true });
  assert.throws(() => configureAndroidMetroRoute({ adb: wrong.adb }), /METRO_ROUTE_PREFERENCE_MISMATCH/);
  assert.equal(wrong.calls.length, 3);
});
test('every adb failure and a timed-out transport fail without retries', () => {
  for (let fault = 1; fault <= 5; fault++) {
    const f = fixture({ fault });
    assert.throws(() => configureAndroidMetroRoute({ adb: f.adb }), /METRO_ROUTE_.*_FAILED/);
    assert.equal(f.calls.length, fault);
  }
  assert.throws(() => configureAndroidMetroRoute({ adb: () => ({ status: null, error: { code: 'ETIMEDOUT' } }) }), /METRO_ROUTE_REVERSE-CHECK_FAILED/);
});
test('device HTTP probe has Host, connection close, and bounded connect/read without a readiness retry loop', () => {
  const f = fixture(); configureAndroidMetroRoute({ adb: f.adb });
  assert.match(f.calls[4].args[2], /GET \/status HTTP\/1\.0/);
  assert.match(f.calls[4].args[2], /Host: 127\.0\.0\.1:8081/);
  assert.match(f.calls[4].args[2], /Connection: close/);
  assert.match(f.calls[4].args[2], /toybox nc -w 5 -W 5 -q 5/);
  assert.match(f.calls[4].args[2], /^\{ printf .*; sleep 5; \} \| /);
  assert.doesNotMatch(f.calls[3].args[2], /sleep/, 'the EOF control keeps the original close semantics');
});
test('a successful EOF control cannot make an incomplete held-input exchange pass', () => {
  const f = fixture({ control: good, response: '' });
  assert.throws(() => configureAndroidMetroRoute({ adb: f.adb }), /METRO_ROUTE_STATUS_REJECTED/);
  assert.equal(f.calls.length, 5);
});
test('native source URL proves the selected route; NAT, assets and spoofed hosts fail', () => {
  requireMetroLoopbackSource('http://127.0.0.1:8081/index.bundle?platform=android&dev=true');
  for (const source of [null, '', 'assets://index.android.bundle', 'http://10.0.2.2:8081/index.bundle',
    'http://127.0.0.1.evil:8081/index.bundle', 'http://user@127.0.0.1:8081/index.bundle', 'http://127.0.0.1:8082/index.bundle']) {
    assert.throws(() => requireMetroLoopbackSource(source), /NATIVE_METRO_ROUTE_MISMATCH/);
  }
});
test('fixture route is configured after pm clear and before either process launch', () => {
  const s = readFileSync('scripts/android-native-acceptance.sh', 'utf8');
  const configure = s.indexOf('node scripts/android-metro-route.mjs');
  assert.ok(configure > s.indexOf('adb shell pm clear com.bridge.nativepilot'), 'pm clear must not erase the route setting');
  assert.ok(configure < s.indexOf('stage=first-launch'), 'React Native caches its host on first construction');
  assert.ok(configure < s.indexOf('stage=restart-launch'));
});
