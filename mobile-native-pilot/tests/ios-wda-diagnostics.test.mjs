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
