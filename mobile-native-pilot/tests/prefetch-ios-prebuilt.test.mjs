import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prefetch, validatePins, curlArgs, artifactUrl, MAX_ATTEMPTS } from '../scripts/prefetch-ios-prebuilt.mjs';

const sha = b => createHash('sha512').update(b).digest('hex');
const GOOD = Buffer.from('good-bytes');
const pinsFor = (bytes = GOOD) => ({ reactNativeVersion: '1.2.3', artifacts: { 'reactnative-core-1.2.3-debug.tar.gz': { remote: 'reactnative-core-debug.tar.gz', sha512: sha(bytes) } } });
const BASE = 'https://repo.example.test/maven2';
const dir = () => mkdtempSync(join(tmpdir(), 'pf-'));
const script = results => { const calls = []; return { calls, download: (url, out) => { const r = results[calls.length] ?? results.at(-1); calls.push(url); if (r.bytes) writeFileSync(out, r.bytes); return { exit: r.exit ?? 0, seconds: 0, stderr: r.stderr ?? '' }; } }; };

test('committed pins are well formed and match the installed React Native version', () => {
  const pins = JSON.parse(readFileSync(new URL('../ios-prebuilt-pins.json', import.meta.url), 'utf8'));
  const rn = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dependencies?.['react-native'];
  assert.equal(validatePins(pins, pins.reactNativeVersion).length, 4);
  assert.ok(rn === undefined || rn.replace(/^[^\d]*/, '') === pins.reactNativeVersion, `package.json pins react-native ${rn}`);
  assert.deepEqual(Object.keys(pins.artifacts).sort(), ['core', 'dependencies'].flatMap(k => ['debug', 'release'].map(c => `reactnative-${k}-${pins.reactNativeVersion}-${c}.tar.gz`)).sort());
});
test('a pin file for another React Native version, or with a malformed digest, is refused', () => {
  assert.throws(() => validatePins(pinsFor(), '9.9.9'), /PINS_VERSION_MISMATCH/);
  const bad = pinsFor(); bad.artifacts['reactnative-core-1.2.3-debug.tar.gz'].sha512 = 'abc';
  assert.throws(() => validatePins(bad, '1.2.3'), /PIN_INVALID/);
});
test('verified bytes are installed into the cache; the attempt is recorded', () => {
  const d = dir(); const s = script([{ bytes: GOOD }]);
  const r = prefetch({ pins: pinsFor(), rnVersion: '1.2.3', cacheDir: d, base: BASE, download: s.download });
  assert.equal(r.status, 'PASS');
  assert.equal(readFileSync(join(d, 'reactnative-core-1.2.3-debug.tar.gz')).toString(), 'good-bytes');
  assert.equal(r.artifacts[0].attempts[0].result, 'VERIFIED');
  assert.deepEqual(s.calls, [`${BASE}/com/facebook/react/react-native-artifacts/1.2.3/react-native-artifacts-1.2.3-reactnative-core-debug.tar.gz`]);
});
test('a transfer failure is retried visibly and the FIRST failure stays in the report', () => {
  const d = dir(); const s = script([{ exit: 92, stderr: 'curl: (92) HTTP/2 stream 1 was not closed cleanly' }, { bytes: GOOD }]);
  const r = prefetch({ pins: pinsFor(), rnVersion: '1.2.3', cacheDir: d, base: BASE, download: s.download });
  assert.equal(r.status, 'PASS');
  assert.equal(r.artifacts[0].attempts.length, 2);
  assert.equal(r.artifacts[0].attempts[0].result, 'TRANSFER_FAILED');
  assert.match(r.artifacts[0].attempts[0].stderr, /curl: \(92\)/);
});
test('persistent transfer failure fails closed after exactly the bounded attempts and leaves no cache file', () => {
  const d = dir(); const s = script([{ exit: 28 }]);
  const r = prefetch({ pins: pinsFor(), rnVersion: '1.2.3', cacheDir: d, base: BASE, download: s.download });
  assert.equal(r.status, 'FAIL');
  assert.equal(s.calls.length, MAX_ATTEMPTS);
  assert.deepEqual(readdirSync(d), []);
});
test('wrong bytes (corrupt, truncated or substituted) are an integrity failure: never retried, never cached', () => {
  const d = dir(); const s = script([{ bytes: Buffer.from('tampered') }, { bytes: GOOD }]);
  const r = prefetch({ pins: pinsFor(), rnVersion: '1.2.3', cacheDir: d, base: BASE, download: s.download });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.reason, 'INTEGRITY_MISMATCH');
  assert.equal(s.calls.length, 1, 'integrity failure must not be retried until it passes');
  assert.deepEqual(readdirSync(d), []);
});
test('an existing cache file is trusted only if its SHA-512 matches; a stale one is replaced', () => {
  const d = dir(); const f = join(d, 'reactnative-core-1.2.3-debug.tar.gz');
  writeFileSync(f, GOOD);
  let s = script([{ exit: 1 }]);
  let r = prefetch({ pins: pinsFor(), rnVersion: '1.2.3', cacheDir: d, base: BASE, download: s.download });
  assert.equal(r.artifacts[0].source, 'cache-verified'); assert.equal(s.calls.length, 0);
  writeFileSync(f, 'poisoned');
  s = script([{ bytes: GOOD }]);
  r = prefetch({ pins: pinsFor(), rnVersion: '1.2.3', cacheDir: d, base: BASE, download: s.download });
  assert.equal(r.status, 'PASS'); assert.equal(s.calls.length, 1);
  assert.equal(readFileSync(f).toString(), 'good-bytes');
});
test('transfer is HTTPS-only, bounded, and never relaxes TLS verification', () => {
  const a = curlArgs('https://x/y', '/tmp/o');
  for (const bad of ['-k', '--insecure', '--proxy-insecure', '--cacert', '--retry-all-errors']) assert.ok(!a.includes(bad), bad);
  assert.ok(a.includes('--fail') && a.includes('--max-time') && a.includes('--speed-time') && a.includes('--connect-timeout'));
  assert.equal(a[a.indexOf('--proto') + 1], '=https');
  assert.throws(() => artifactUrl('http://repo.example/maven2', '1.2.3', 'x.tar.gz'), /HTTPS_REQUIRED/);
});
test('workflow runs the pinned prefetch before CocoaPods and keeps the failure visible', () => {
  const wf = readFileSync(new URL('../../.github/workflows/native-pilot-ios-browser-auth.yml', import.meta.url), 'utf8');
  const pre = wf.indexOf('node scripts/prefetch-ios-prebuilt.mjs');
  assert.ok(pre > 0, 'prefetch step present');
  assert.ok(pre < wf.indexOf('pod install'), 'prefetch precedes pod install');
  assert.ok(!/RCT_SKIP_CACHES/.test(wf), 'cache bypass would defeat the pinned prefetch');
  assert.ok(!/(^|\s)(-k|--insecure)\b/m.test(wf));
});
