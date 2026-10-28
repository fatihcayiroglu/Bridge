import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { logExcerpt, processExcerpt, clean } from '../scripts/ios-wda-diagnostics.mjs';

const LOG = [
  '[XCUITest] Building WebDriverAgent with xcodebuild', '[Appium] unrelated chatter', '[XCUITest] xcodebuild timed out waiting for WDA to launch',
  `[HTTP] Authorization: Bearer ${'a'.repeat(40)}`, '[XCUITest] cookie=abc port forward failed', 'Error: WDA did not start',
  `[XCUITest] derived data ${'Z9'.repeat(30)}/Build failed`,
].join('\n');

test('keeps WDA/xcodebuild/timeout lines, drops chatter, drops any line that could carry a credential', () => {
  const { lines } = logExcerpt(LOG);
  assert.ok(lines.some((l) => /Building WebDriverAgent/.test(l)));
  assert.ok(lines.some((l) => /timed out waiting for WDA/.test(l)));
  assert.ok(lines.some((l) => /Error: WDA did not start/.test(l)));
  assert.ok(!lines.some((l) => /unrelated chatter/.test(l)));
  assert.ok(!lines.some((l) => /Authorization|Bearer|cookie/i.test(l)), 'sensitive-keyword lines are dropped entirely');
});
test('long token-like runs are masked and output is bounded', () => {
  const masked = logExcerpt(LOG).lines.find((l) => /derived data/.test(l));
  assert.ok(masked && masked.includes('[redacted]') && !/Z9Z9Z9Z9/.test(masked));
  const many = Array.from({ length: 500 }, (_, i) => `xcodebuild step ${i}`).join('\n');
  const r = logExcerpt(many, { maxLines: 80, maxChars: 40 });
  assert.equal(r.total, 500); assert.equal(r.lines.length, 80); assert.ok(r.lines.every((l) => l.length <= 40));
  assert.equal(clean('a\u0000b\nc'), 'a b c');
  assert.deepEqual(logExcerpt(undefined).lines, []);
});
test('process listing keeps only build/test infrastructure and caps lines', () => {
  const ps = ['  1 00:10 /sbin/launchd', ' 55128 03:58 /usr/bin/xcodebuild -project WebDriverAgent.xcodeproj', ' 9 00:01 /usr/bin/ssh-agent', ' 77 02:00 SWBBuildService'].join('\n');
  assert.deepEqual(processExcerpt(ps).map((l) => l.split(' ')[1]), ['03:58', '02:00']);
  assert.equal(processExcerpt(Array(100).fill('1 00:01 xcodebuild x').join('\n')).length, 25);
});
test('runner prints the excerpt only inside the pre-input gate, and before Appium is killed; no timeout was changed', () => {
  const sh = readFileSync(new URL('../scripts/run-ios-browser-auth.sh', import.meta.url), 'utf8');
  const gate = sh.indexOf('r.stage==="native-xcuitest-session"&&r.cases.length===0');
  const diag = sh.indexOf('ios-wda-diagnostics.mjs');
  const kill = sh.indexOf('kill "$task_appium_pid"');
  assert.ok(gate > 0 && diag > gate && kill > diag, 'gate < diagnostics < kill');
  assert.match(sh, /ios-wda-diagnostics\.mjs "\$task_appium_debug" \|\| true/);
  const js = readFileSync(new URL('../scripts/ios-browser-auth.mjs', import.meta.url), 'utf8');
  assert.match(js, /driverDeadlineMs = 240000/);
  assert.match(js, /\}, 240000\);/, 'the session deadline is unchanged');
});

// ---- end-of-log evidence summary ----
import { prefetchSummary, journeySummary, podCacheLines, wireSequence } from '../scripts/ios-evidence-summary.mjs';
test('the summary prints allow-listed facts only (no fixture names, ids, tokens or driver traffic)', () => {
  const j = journeySummary({ status: 'FAIL', stage: 'native-xcuitest-session', runtimeVersion: '26.2', cases: [], notExecuted: ['a', 'b', 'c'],
    userA: 'mob_A_deadbeef', token: 'x'.repeat(64), fixtureId: 'u-123' });
  assert.deepEqual(j, { status: 'FAIL', stage: 'native-xcuitest-session', runtimeVersion: '26.2', cases: [], passed: 0, failed: 0, notExecuted: 3 });
  assert.ok(!JSON.stringify(j).match(/mob_A|deadbeef|u-123|xxxx/));
  const p = prefetchSummary({ status: 'PASS', artifacts: [{ name: 'core-debug', source: 'download', expectedSha512: 'abc', attempts: [{ n: 1, exit: 0, seconds: 97.2, bytes: 94100000, result: 'VERIFIED', stderr: 'secret?' }] }] });
  assert.deepEqual(p.artifacts[0].attempts[0], { n: 1, exit: 0, seconds: 97.2, bytes: 94100000, result: 'VERIFIED' });
  assert.deepEqual(prefetchSummary(null), { status: null, failed: null, reason: null, artifacts: [] });
});
test('only React Native cache/download lines are taken from pods.log, bounded', () => {
  const lines = podCacheLines(['noise', '[ReactNativeCore] Cache miss: downloading x', '[Cache] SHA1 verified for y', 'more noise', ...Array(80).fill('[ReactNativeDependencies] z')].join('\n'));
  assert.equal(lines.length, 30); assert.ok(lines.every((l) => /\[(ReactNativeCore|ReactNativeDependencies|Cache)\]/.test(l)));
});
test('the workflow prints the summary as an always() step and never fails the job itself', () => {
  const wf = readFileSync(new URL('../../.github/workflows/native-pilot-ios-browser-auth.yml', import.meta.url), 'utf8');
  const at = wf.indexOf('ios-evidence-summary.mjs');
  assert.ok(at > 0);
  const block = wf.slice(wf.lastIndexOf('- name:', at), wf.indexOf('actions/upload-artifact', at));
  assert.match(block, /if: always\(\)/); assert.match(block, /\|\| true/);
});

test('a failed case run reports case ids/statuses, the closed failure code, UI counts and bundle, but never the raw driver message', () => {
  const j = journeySummary({ status: 'FAIL', stage: 'IOS_AUTHENTICATE_RESTART_ROTATE', failure: 'POSTGRES_ROTATION_REQUIRED',
    cases: [{ id: 'IOS_SYSTEM_BROWSER_CANCEL', status: 'PASS', secret: 'nope' }, { id: 'IOS_AUTHENTICATE_RESTART_ROTATE', status: 'FAIL' }], notExecuted: ['IOS_SWITCH'],
    driverFailure: 'WebDriver 500: http://127.0.0.1/cb?code=SECRETCODE&password=hunter2', failureUi: { webViews: 1, textFields: 0, secureFields: 0, alerts: 0, html: '<x>' },
    failureApplication: { bundleId: 'com.bridge.nativepilot', pid: 4242 } });
  assert.deepEqual(j.cases, [{ id: 'IOS_SYSTEM_BROWSER_CANCEL', status: 'PASS' }, { id: 'IOS_AUTHENTICATE_RESTART_ROTATE', status: 'FAIL' }]);
  assert.equal(j.failure, 'POSTGRES_ROTATION_REQUIRED'); assert.deepEqual(j.failureUi, { webViews: 1, textFields: 0, secureFields: 0, alerts: 0 });
  assert.equal(j.foregroundBundle, 'com.bridge.nativepilot'); assert.equal(j.passed, 1); assert.equal(j.failed, 1); assert.equal(j.notExecuted, 1);
  assert.ok(!JSON.stringify(j).match(/SECRETCODE|hunter2|WebDriver 500|4242|nope|<x>/));
});

test('the wire summary is the ordered, run-length-compressed kind:status sequence and nothing else', () => {
  const log = [
    'noise line', 'NATIVE_AUTH_HTTP ' + JSON.stringify({ kind: 'native-authorize', status: 200, cookiePresent: false, bearerPresent: false, url: '/x?code=SECRET', body: 'hunter2' }),
    'NATIVE_AUTH_HTTP ' + JSON.stringify({ kind: 'native-login', status: 401 }), 'NATIVE_AUTH_HTTP ' + JSON.stringify({ kind: 'native-login', status: 401 }),
    'NATIVE_AUTH_HTTP {not json', 'NATIVE_AUTH_HTTP ' + JSON.stringify({ kind: 'Bad Kind!', status: 200 }), 'NATIVE_AUTH_HTTP ' + JSON.stringify({ kind: 'native-code', status: 200 }),
  ].join('\n');
  assert.deepEqual(wireSequence(log), ['native-authorize:200', 'native-login:401x2', 'native-code:200']);
  assert.ok(!JSON.stringify(wireSequence(log)).match(/SECRET|hunter2|cookiePresent/));
  assert.deepEqual(wireSequence(undefined), []);
  assert.equal(wireSequence(Array(300).fill(0).map((_, i) => 'NATIVE_AUTH_HTTP ' + JSON.stringify({ kind: `k${i % 2}`, status: 200 })).join('\n'), 10).length, 10);
});
