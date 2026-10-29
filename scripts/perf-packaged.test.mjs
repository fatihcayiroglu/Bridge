import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateConfig, normalizeMetrics, validateIdentity, isolatedRequestAllowed, closedAuthInputGeometry, x11ActiveWindowMatches } from './perf-acceptance/packaged.mjs';
import { SCENARIOS } from './perf-acceptance/scenarios.mjs';
import { requireDisposable } from './perf-acceptance/disposable.mjs';

test('fixture writer refuses non-CI, production names, remote hosts and connection query overrides', () => {
  const env = { GITHUB_ACTIONS: 'true', BRIDGE_PERF_DISPOSABLE: '1', PG_TEST_URL: 'postgresql://fixture:fixture@127.0.0.1/bridge_perf_test' };
  assert.equal(requireDisposable(env), env.PG_TEST_URL);
  assert.throws(() => requireDisposable({ ...env, GITHUB_ACTIONS: 'false' }));
  assert.throws(() => requireDisposable({ ...env, BRIDGE_PERF_DISPOSABLE: '' }));
  for (const PG_TEST_URL of ['postgresql://localhost/production', 'postgresql://remote.test/bridge_perf_test',
    'postgresql://localhost/bridge_perf_test?host=remote.test', 'http://localhost/bridge_perf_test', 'malformed']) {
    assert.throws(() => requireDisposable({ ...env, PG_TEST_URL }));
  }
});

test('missing runtime prerequisites exit NOT EXECUTED without inventing samples', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./perf-acceptance/packaged.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(run.status, 3);
  assert.match(run.stderr, /NOT_EXECUTED:CONFIG_REQUIRED/);
  assert.equal(run.stdout, '');
});

test('rejects non-HTTPS, credentials in origin and unpinned source before launching', () => {
  const base = { schema: 1, bridgeCommit: 'a'.repeat(40), executable: fileURLToPath(import.meta.url),
    output: fileURLToPath(new URL('./output-fixture', import.meta.url)), origin: 'https://localhost:3443',
    server: 's', idleChannel: 'i', historyChannel: 'h', messagePrefix: 'm-',
    username: 'fixture', password: 'fixture-password', seededMessages: 10000 };
  assert.equal(validateConfig(base), base);
  for (const origin of ['http://localhost:3443', 'https://u:p@localhost:3443', 'https://localhost:3443/path']) {
    assert.throws(() => validateConfig({ ...base, origin }));
  }
  assert.throws(() => validateConfig({ ...base, bridgeCommit: 'unknown' }));
  assert.throws(() => validateConfig({ ...base, seededMessages: 9999 }));
});

test('missing process or nonfinite OS metric refuses measurement rather than substituting zero', () => {
  const browser = { pid: 1, type: 'Browser', cpu: { percentCPUUsage: 2 }, memory: { workingSetSize: 100 } };
  const renderer = { ...browser, pid: 2, type: 'Tab', cpu: { percentCPUUsage: 3 } };
  const sample = normalizeMetrics([browser, renderer], 1);
  assert.equal(sample.cpuPercent, 5);
  assert.equal(sample.workingSetKiB, 200);
  assert.throws(() => normalizeMetrics([], 1));
  assert.throws(() => normalizeMetrics([browser], 1));
  assert.throws(() => normalizeMetrics([browser, { ...renderer, memory: {} }], 1));
  assert.throws(() => normalizeMetrics([browser, { ...renderer, cpu: { percentCPUUsage: NaN } }], 1));
});

test('idle needs no call, while every actual voice scenario still requires real SFU', () => {
  assert.equal(SCENARIOS.find(s => s.id === 'PA01').realSfu, false);
  for (const id of ['PA02', 'PA03', 'PA04', 'PA05', 'PA06', 'PA07', 'PA10']) {
    assert.equal(SCENARIOS.find(s => s.id === id).realSfu, true);
  }
});

test('a packaged executable with disabled sandbox, unsafe renderer or no real window never qualifies', () => {
  const good = { packaged: true, appPath: '/fixture/resources/app.asar', insecure: false,
    windows: [{ sandbox: true, contextIsolation: true, nodeIntegration: false }] };
  validateIdentity(good);
  for (const patch of [{ packaged: false }, { appPath: '/fixture/synthetic.js' }, { insecure: true }, { windows: [] },
    { windows: [{ sandbox: false, contextIsolation: true, nodeIntegration: false }] },
    { windows: [{ sandbox: true, contextIsolation: false, nodeIntegration: false }] },
    { windows: [{ sandbox: true, contextIsolation: true, nodeIntegration: true }] }]) {
    assert.throws(() => validateIdentity({ ...good, ...patch }), /PACKAGED_SECURITY_PRECONDITION/);
  }
});

test('fixture credentials and API traffic cannot be submitted to another installation', () => {
  const origin = 'https://127.0.0.1:3443';
  assert.equal(isolatedRequestAllowed(`${origin}/api/login`, 'POST', origin), true);
  assert.equal(isolatedRequestAllowed(`${origin}/api/me`, 'GET', origin), true);
  assert.equal(isolatedRequestAllowed('https://other.example/api/login', 'POST', origin), false);
  assert.equal(isolatedRequestAllowed('https://other.example/api/me', 'GET', origin), false);
  assert.equal(isolatedRequestAllowed('https://other.example/submit', 'POST', origin), false);
  assert.equal(isolatedRequestAllowed('https://u:p@other.example/font.woff', 'GET', origin), false);
  assert.equal(isolatedRequestAllowed('https://static.example/font.woff', 'GET', origin), true);
});

test('auth input transition evidence uses closed boolean geometry and never leaks user data', () => {
  const benign = { buttonPresent: true, buttonEnabled: true, buttonVisible: true,
    buttonCenterInViewport: true, hitIsLoginButton: false, documentFocused: true };
  const malicious = { ...benign, username: 'sensitive-username', password: 'private-password',
    token: 'private-token', url: 'https://private.example/path', text: 'private-text',
    buttonVisible: 'private-value' };
  const safe = closedAuthInputGeometry(malicious);
  assert.deepEqual(safe, { ...benign, buttonVisible: false });
  assert.equal(Object.keys(safe).length, 6);
  assert.doesNotMatch(JSON.stringify(safe), /private|sensitive|example|username|password|token|url|text/);
  assert.deepEqual(closedAuthInputGeometry(null), { unavailable: true });
  assert.deepEqual(closedAuthInputGeometry('sensitive-secret'), { unavailable: true });
});

test('X11 active window evidence is boolean-only and rejects malformed or absent state', () => {
  const good = '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3e00007';
  assert.equal(x11ActiveWindowMatches(good, 0x3e00007), true);
  assert.equal(x11ActiveWindowMatches(good, 0x3e00008), false);
  assert.equal(x11ActiveWindowMatches('_NET_ACTIVE_WINDOW: not found.', 42), null);
  assert.equal(x11ActiveWindowMatches(good, -1), null);
  assert.equal(x11ActiveWindowMatches('private-token', 42), null);
  const report = { available: x11ActiveWindowMatches(good, 0x3e00007) !== null,
    matchesNative: x11ActiveWindowMatches(good, 0x3e00008) };
  assert.deepEqual(report, { available: true, matchesNative: false });
  assert.doesNotMatch(JSON.stringify(report), /3e000|private|token|window id/);
});
