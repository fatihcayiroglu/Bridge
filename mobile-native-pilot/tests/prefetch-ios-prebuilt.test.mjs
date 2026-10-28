import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prefetch, validatePins, curlArgs, artifactUrl, MAX_ATTEMPTS } from '../scripts/prefetch-ios-prebuilt.mjs';

const sha = b => createHash('sha512').update(b).digest('hex');
const GOOD = Buffer.from('good-bytes');
const PATH = 'com/x/artifacts/1.2.3/artifacts-1.2.3-reactnative-core-debug.tar.gz';
const pinsFor = (bytes = GOOD) => ({ reactNativeVersion: '1.2.3', hermesVersion: '9.9.9', artifacts: { 'reactnative-core-1.2.3-debug.tar.gz': { defaultBase: 'https://repo.example.test/maven2', path: PATH, sha512: sha(bytes) } } });
const BASE = 'https://repo.example.test/maven2';
const dir = () => mkdtempSync(join(tmpdir(), 'pf-'));
const script = results => { const calls = []; return { calls, download: (url, out) => { const r = results[calls.length] ?? results.at(-1); calls.push(url); if (r.bytes) writeFileSync(out, r.bytes); return { exit: r.exit ?? 0, seconds: 0, stderr: r.stderr ?? '' }; } }; };

test('committed pins are well formed, cover RN core/dependencies AND Hermes, and match the installed React Native version', () => {
  const pins = JSON.parse(readFileSync(new URL('../ios-prebuilt-pins.json', import.meta.url), 'utf8'));
  const rn = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dependencies?.['react-native'];
  assert.equal(validatePins(pins, pins.reactNativeVersion, pins.hermesVersion).length, 6);
  assert.ok(rn === undefined || rn.replace(/^[^\d]*/, '') === pins.reactNativeVersion, `package.json pins react-native ${rn}`);
  const rnNames = ['core', 'dependencies'].flatMap(k => ['debug', 'release'].map(c => `reactnative-${k}-${pins.reactNativeVersion}-${c}.tar.gz`));
  const hermesNames = ['debug', 'release'].map(c => `hermes-ios-${pins.hermesVersion}-${c}.tar.gz`);
  assert.deepEqual(Object.keys(pins.artifacts).sort(), [...rnNames, ...hermesNames].sort());
  for (const a of Object.values(pins.artifacts)) assert.ok(a.defaultBase.startsWith('https://') && a.path.endsWith('.tar.gz') && !a.path.includes('..'));
});
test('a Hermes version other than the pinned one is refused (a bump must update the pins)', () => {
  assert.throws(() => validatePins(pinsFor(), '1.2.3', '1.0.0'), /PINS_HERMES_MISMATCH/);
  assert.doesNotThrow(() => validatePins(pinsFor(), '1.2.3', '9.9.9'));
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
  assert.deepEqual(s.calls, [`https://repo.example.test/maven2/${PATH}`]);
  assert.equal(r.artifacts[0].host, 'repo.example.test');
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
  assert.throws(() => artifactUrl('http://repo.example/maven2', 'x.tar.gz'), /HTTPS_REQUIRED/);
  assert.equal(artifactUrl('https://r.example/m/', 'a/b.tar.gz'), 'https://r.example/m/a/b.tar.gz');
});
test('workflow runs the pinned prefetch before CocoaPods and keeps the failure visible', () => {
  const wf = readFileSync(new URL('../../.github/workflows/native-pilot-ios-browser-auth.yml', import.meta.url), 'utf8');
  const pre = wf.indexOf('node scripts/prefetch-ios-prebuilt.mjs');
  assert.ok(pre > 0, 'prefetch step present');
  assert.ok(pre < wf.indexOf('pod install'), 'prefetch precedes pod install');
  assert.ok(!/RCT_SKIP_CACHES/.test(wf), 'cache bypass would defeat the pinned prefetch');
  assert.ok(!/(^|\s)(-k|--insecure)\b/m.test(wf));
});

test('an explicit base (ENTERPRISE_REPOSITORY) overrides every artifact host, still HTTPS-only and still pinned', () => {
  const d = dir(); const s = script([{ bytes: GOOD }]);
  const r = prefetch({ pins: pinsFor(), rnVersion: '1.2.3', cacheDir: d, base: 'https://mirror.example.test/mvn', download: s.download });
  assert.equal(r.status, 'PASS'); assert.deepEqual(s.calls, [`https://mirror.example.test/mvn/${PATH}`]);
  const bad = script([{ bytes: Buffer.from('tampered') }]);
  assert.equal(prefetch({ pins: pinsFor(), rnVersion: '1.2.3', cacheDir: dir(), base: 'https://mirror.example.test/mvn', download: bad.download }).reason, 'INTEGRITY_MISMATCH');
  assert.throws(() => prefetch({ pins: pinsFor(), rnVersion: '1.2.3', cacheDir: dir(), base: 'http://mirror.example.test/mvn', download: s.download }), /HTTPS_REQUIRED/);
});
test('the Hermes cache file names equal the names CocoaPods looks up (hermes-ios-<version>-<configuration>.tar.gz)', () => {
  const pins = JSON.parse(readFileSync(new URL('../ios-prebuilt-pins.json', import.meta.url), 'utf8'));
  for (const c of ['debug', 'release']) {
    const a = pins.artifacts[`hermes-ios-${pins.hermesVersion}-${c}.tar.gz`];
    assert.ok(a.path.endsWith(`hermes-ios-${pins.hermesVersion}-hermes-ios-${c}.tar.gz`));
  }
});
test('a pin whose source path escapes the repository, or whose base is not HTTPS, is refused', () => {
  const n = 'reactnative-core-1.2.3-debug.tar.gz';
  const mk = (patch) => { const p = pinsFor(); Object.assign(p.artifacts[n], patch); return p; };
  assert.throws(() => validatePins(mk({ path: 'com/x/../../etc/passwd.tar.gz' }), '1.2.3'), /PIN_SOURCE_INVALID/);
  assert.throws(() => validatePins(mk({ path: '/abs/x.tar.gz' }), '1.2.3'), /PIN_SOURCE_INVALID/);
  assert.throws(() => validatePins(mk({ path: 'a/b.zip' }), '1.2.3'), /PIN_SOURCE_INVALID/);
  assert.throws(() => validatePins(mk({ defaultBase: 'http://repo.example.test/m' }), '1.2.3'), /PIN_SOURCE_INVALID/);
  const p = pinsFor(); p.artifacts['../evil-1.2.3.tar.gz'] = p.artifacts[n]; delete p.artifacts[n];
  assert.throws(() => validatePins(p, '1.2.3'), /PIN_NAME_INVALID/);
});

test('EVERY workflow that runs `pod install` runs the pinned prefetch first (a pin that a job does not use protects nothing)', async () => {
  const { readdirSync } = await import('node:fs');
  const dir = new URL('../../.github/workflows/', import.meta.url);
  const offenders = [];
  let seen = 0;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.yml'))) {
    const wf = readFileSync(new URL(f, dir), 'utf8');
    const pod = wf.indexOf('pod install');
    if (pod < 0) continue;
    seen += 1;
    const pre = wf.indexOf('node scripts/prefetch-ios-prebuilt.mjs');
    if (pre < 0 || pre > pod) offenders.push(f);
  }
  assert.ok(seen >= 2, 'both iOS workflows are covered by this check');
  assert.deepEqual(offenders, []);
});
