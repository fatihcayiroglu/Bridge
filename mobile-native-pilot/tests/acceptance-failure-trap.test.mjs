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
