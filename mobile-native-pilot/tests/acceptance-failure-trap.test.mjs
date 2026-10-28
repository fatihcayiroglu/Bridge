// The native acceptance failure trap names the exact failing command, also for
// SILENT failures (grep -q, discarded output) inside functions. Real bash, no device.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TRAP = path.resolve('scripts/acceptance-failure-trap.sh');

function run(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-'));
  const script = `set -euo pipefail\nsource ${JSON.stringify(TRAP)}\nfunction cleanup() { local status=$?; acceptance_record_failure "$status" ${JSON.stringify(dir)} android; exit "$status"; }\ntrap cleanup EXIT\n${body}\n`;
  const file = path.join(dir, 'case.sh');
  fs.writeFileSync(file, script);
  // Each case runs inside its own temporary directory; nothing touches the package.
  const r = spawnSync('bash', [file], { encoding: 'utf8', cwd: dir });
  const record = path.join(dir, 'native-failure-stage.txt');
  return { status: r.status, stderr: r.stderr, record: fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : null };
}

test('a silent grep -q failure is named with its line and command', () => {
  const r = run(['stage=restart-ui-assertions', 'echo x > ui.xml', 'grep -q NATIVE_SECURE_STORE_RESTORE_PASS ui.xml'].join('\n'));
  assert.equal(r.status, 1);
  assert.match(r.record, /^stage=restart-ui-assertions$/m);
  assert.match(r.record, /^exit=1$/m);
  assert.match(r.record, /^line=7$/m);
  assert.match(r.record, /^function=main$/m);
  assert.match(r.record, /^command=grep -q NATIVE_SECURE_STORE_RESTORE_PASS ui\.xml$/m);
  assert.match(r.stderr, /NATIVE_ANDROID_ACCEPTANCE_FAILED stage=restart-ui-assertions exit=1 function=main line=7 command=grep -q/);
});

test('a failure INSIDE a function (errtrace) names the inner command, not just the call', () => {
  const r = run(['stage=restart-ui-assertions', 'dump() { false; echo unreachable; }', 'poll() { dump > /dev/null; }', 'poll'].join('\n'));
  assert.equal(r.status, 1);
  assert.match(r.record, /^function=dump$/m);
  assert.match(r.record, /^command=false$/m);
});

test('an assertion function that returns 1 is recorded at its call, with the reason it set', () => {
  const r = run(['stage=first-ui-assertions',
    'assert_native_marker() {', '  if grep -q REDBOX /dev/null; then acceptance_detail="$1:redbox"; return 1; fi',
    '  acceptance_detail="$1:not-seen-in-90-dumps"', '  return 1', '}',
    'assert_native_marker NATIVE_SQLCIPHER_WRITE_PASS first-ui.xml'].join('\n'));
  assert.equal(r.status, 1);
  assert.match(r.record, /^line=11$/m, 'the call site');
  assert.match(r.record, /^detail=NATIVE_SQLCIPHER_WRITE_PASS:not-seen-in-90-dumps$/m);
});

test('conditions do not count as failures, and success writes no record', () => {
  const r = run(['stage=verdict', 'if grep -q nothing /dev/null; then exit 3; fi', 'echo ok'].join('\n'));
  assert.equal(r.status, 0);
  assert.equal(r.record, null);
});

test('the Android acceptance script uses the trap and still asserts every marker', () => {
  const s = fs.readFileSync('scripts/android-native-acceptance.sh', 'utf8');
  assert.match(s, /^source scripts\/acceptance-failure-trap\.sh$/m);
  assert.match(s, /acceptance_record_failure "\$status" native-evidence android/);
  for (const marker of ['NATIVE_SQLCIPHER_WRITE_PASS', 'NATIVE_SECURE_STORE_ROUNDTRIP_PASS', 'NATIVE_RECEIPT_COMPACTION_PASS',
    'NATIVE_SQLCIPHER_RECOVERY_PASS', 'NATIVE_SECURE_STORE_RESTORE_PASS', 'NATIVE_ACCOUNT_ISOLATION_PASS', 'NATIVE_RECEIPT_COMPACTION_RESTORE_PASS']) {
    assert.ok(s.includes(marker), marker);
  }
  assert.doesNotMatch(s, /uiautomator dump[^\n]*>\/dev\/null/);
  for (const reason of ['app-reported-failure', 'redbox-or-runtime-not-ready', 'not-seen-in-90-dumps']) assert.ok(s.includes(reason), reason);
  // Unchanged contract: 90 dumps, 2 s apart, no retry of the whole run.
  assert.match(s, /for i in \$\(seq 1 90\); do/);
  assert.match(s, /sleep 2/);
});

function runInDir(body, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  const file = path.join(dir, 'case.sh');
  fs.writeFileSync(file, `set -euo pipefail\nsource ${JSON.stringify(TRAP)}\n${body}\n`);
  return spawnSync('bash', [file], { encoding: 'utf8', cwd: dir });
}

const REDBOX_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="com.bridge.nativepilot:id/catalyst_redbox_title" content-desc="" />
<node index="1" text="TypeError: Cannot read property &apos;exec&apos; of undefined" resource-id="" content-desc="" />
<node index="2" text="TypeError: Cannot read property &apos;exec&apos; of undefined" resource-id="" content-desc="" />
<node index="3" text="token=abcdefghijklmnopqrstuvwxyz0123456789ABCD &amp; more" content-desc="Dismiss" />
</hierarchy>`;

test('a redbox dump is printed as its visible text: decoded, de-duplicated, secrets masked', () => {
  const r = runInDir('acceptance_print_ui_text ui.xml android', { 'ui.xml': REDBOX_XML });
  assert.equal(r.status, 0);
  const lines = r.stderr.trim().split('\n');
  assert.deepEqual(lines, [
    "NATIVE_ANDROID_UI_TEXT: TypeError: Cannot read property 'exec' of undefined",
    'NATIVE_ANDROID_UI_TEXT: token=[redacted] & more',
    'NATIVE_ANDROID_UI_TEXT: Dismiss',
  ]);
});

test('printing never fails the caller: a missing dump and an empty dump both return 0', () => {
  const missing = runInDir('acceptance_print_ui_text nope.xml android; echo after');
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout.trim(), 'after');
  assert.match(missing.stderr, /NATIVE_ANDROID_UI_TEXT: \(no dump at nope\.xml\)/);
  const empty = runInDir('acceptance_print_ui_text ui.xml android; echo after', { 'ui.xml': '<hierarchy/>' });
  assert.equal(empty.status, 0);
  assert.equal(empty.stderr, '');
});

test('runtime errors: only JS-runtime and crash error lines, the last 60, masked', () => {
  const log = [
    '10-27 22:47:15.001  4321  4400 I ReactNativeJS: Running "main"',
    '10-27 22:47:15.200  4321  4400 E ReactNativeJS: Error: SQLCipher key unavailable',
    '10-27 22:47:15.300  4321  4321 E AndroidRuntime: FATAL EXCEPTION: main',
    '10-27 22:47:15.400  1000  1000 E SurfaceFlinger: unrelated',
    '10-27 22:47:15.500  4321  4400 E ReactNativeJS: key=0123456789abcdef0123456789abcdef01',
    ...Array.from({ length: 70 }, (_, i) => `10-27 22:47:16.${String(i).padStart(3, '0')}  4321  4400 E ReactNative: line ${i}`),
  ].join('\n');
  const r = runInDir('acceptance_print_runtime_errors android < log.txt', { 'log.txt': log });
  assert.equal(r.status, 0);
  const lines = r.stderr.trim().split('\n');
  assert.equal(lines.length, 60);
  assert.ok(lines.every((l) => l.startsWith('NATIVE_ANDROID_RUNTIME_ERROR: ')));
  assert.match(lines.at(-1), /line 69$/);
  assert.ok(!r.stderr.includes('Running "main"') && !r.stderr.includes('SurfaceFlinger'));
  const few = runInDir('acceptance_print_runtime_errors android < log.txt', { 'log.txt': log.split('\n').slice(0, 5).join('\n') });
  assert.match(few.stderr, /E ReactNativeJS: Error: SQLCipher key unavailable/);
  assert.match(few.stderr, /E AndroidRuntime: FATAL EXCEPTION: main/);
  assert.match(few.stderr, /key=\[redacted\]/);
});

test('the Android script prints the screen text on every marker failure and runtime errors on any failure', () => {
  const s = fs.readFileSync('scripts/android-native-acceptance.sh', 'utf8');
  const fn = s.slice(s.indexOf('function assert_native_marker'), s.indexOf('stage=first-launch'));
  for (const reason of ['app-reported-failure', 'redbox-or-runtime-not-ready', 'not-seen-in-90-dumps']) {
    const at = fn.indexOf(reason);
    assert.ok(at > 0, reason);
    const after = fn.slice(at, fn.indexOf('return 1', at));
    assert.match(after, /acceptance_print_ui_text "\$output" android/, `${reason} prints the screen`);
  }
  assert.match(s, /\(\( status == 0 \)\) \|\| acceptance_print_runtime_errors android < native-evidence\/android-logcat\.txt/);
});

test('a redbox in the marker loop fails at once, names the reason, and the log shows the error', () => {
  const r = run([
    'stage=first-ui-assertions',
    `printf '%s' ${JSON.stringify(REDBOX_XML)} > first-ui.xml`,
    'check() { if grep -q "catalyst_redbox_title" first-ui.xml; then acceptance_detail="M:redbox-or-runtime-not-ready"; acceptance_print_ui_text first-ui.xml android; return 1; fi; }',
    'check',
  ].join('\n'));
  assert.equal(r.status, 1);
  assert.match(r.record, /^detail=M:redbox-or-runtime-not-ready$/m);
  assert.match(r.stderr, /NATIVE_ANDROID_UI_TEXT: TypeError: Cannot read property 'exec' of undefined/);
  assert.ok(r.stderr.indexOf('UI_TEXT') < r.stderr.indexOf('ACCEPTANCE_FAILED'), 'screen text precedes the verdict line');
});

test('file tails: last N lines, prefixed, masked; a missing file is reported, never fatal', () => {
  const log = Array.from({ length: 50 }, (_, i) => `metro line ${i}`).concat(['Error: Unable to resolve module ./x token=abcdefghijklmnopqrstuvwxyz0123456789ABCD']).join('\n');
  const r = runInDir('acceptance_print_tail metro.log android METRO 3; acceptance_print_tail nope.txt android LAUNCH 5; echo after', { 'metro.log': log });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'after');
  assert.deepEqual(r.stderr.trim().split('\n'), [
    'NATIVE_ANDROID_METRO: metro line 48',
    'NATIVE_ANDROID_METRO: metro line 49',
    'NATIVE_ANDROID_METRO: Error: Unable to resolve module ./x token=[redacted]',
    'NATIVE_ANDROID_LAUNCH: (missing nope.txt)',
  ]);
});

test('on failure the Android script prints the launch timing and the Metro log tail', () => {
  const s = fs.readFileSync('scripts/android-native-acceptance.sh', 'utf8');
  const cleanup = s.slice(s.indexOf('function cleanup()'), s.indexOf('trap cleanup EXIT'));
  assert.match(cleanup, /if \(\( status != 0 \)\); then\n\s+acceptance_print_tail native-evidence\/first-launch\.txt android LAUNCH 20\n\s+acceptance_print_tail native-evidence\/metro-android\.log android METRO 40/);
});
