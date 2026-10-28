// Executes the real EXIT cleanup with a deterministic adb transport fixture.
// These are shell contract tests, not an Android/logd availability claim.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function cleanup({ firstCapture, exit = 7, finalCapture = false }) {
  const source = fs.readFileSync('scripts/android-native-acceptance.sh', 'utf8');
  const fn = source.slice(source.indexOf('function cleanup()'), source.indexOf('trap cleanup EXIT'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-logcat-'));
  fs.mkdirSync(path.join(directory, 'bin')); fs.mkdirSync(path.join(directory, 'native-evidence'));
  const file = path.join(directory, 'native-evidence', 'android-logcat.txt');
  if (firstCapture !== undefined) fs.writeFileSync(file, firstCapture);
  fs.writeFileSync(path.join(directory, 'bin', 'adb'), `#!/usr/bin/env bash
if [[ "$1 $2" == "logcat -d" ]]; then
  echo capture >> captures
  ${finalCapture ? ':' : 'echo "replacement logcat"'}
  exit 0
fi
exit 1
`, { mode: 0o755 });
  const trap = path.resolve('scripts/acceptance-failure-trap.sh');
  const finalStart = source.indexOf('stage=final-logcat');
  const finalBlock = source.slice(finalStart, source.indexOf('\nstage=', finalStart + 1));
  fs.writeFileSync(path.join(directory, 'case.sh'), `set -euo pipefail
source ${JSON.stringify(trap)}
stage=cleanup-fixture
metro_pid=fixture
kill() { :; }
${fn}
trap cleanup EXIT
${finalCapture ? finalBlock : ''}
exit ${exit}
`);
  const result = spawnSync('bash', ['case.sh'], { cwd: directory, encoding: 'utf8', env: { ...process.env, PATH: `${directory}/bin:${process.env.PATH}` } });
  const calls = path.join(directory, 'captures');
  return { ...result, captured: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined,
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0 };
}

test('cleanup preserves the first failed capture bytes and exit status without a second read', () => {
  for (const firstCapture of ['first partial log\n', '']) {
    const result = cleanup({ firstCapture, exit: 255 });
    assert.equal(result.status, 255, result.stderr);
    assert.equal(result.captured, firstCapture);
    assert.equal(result.calls, 0, 'failed logcat must not be retried or overwritten');
  }
});
test('cleanup captures diagnostics once when failure precedes the final capture', () => {
  const result = cleanup({});
  assert.equal(result.status, 7, result.stderr);
  assert.equal(result.captured, 'replacement logcat\n');
  assert.equal(result.calls, 1);
});
test('successful acceptance retains the exact log used by its ANR check', () => {
  const firstCapture = 'original successful ANR evidence\n';
  const result = cleanup({ firstCapture, exit: 0 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.captured, firstCapture);
  assert.equal(result.calls, 0);
});
test('exit-zero empty final capture fails and cleanup cannot replace its missing evidence', () => {
  const result = cleanup({ finalCapture: true, exit: 0 });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.captured, '');
  assert.equal(result.calls, 1);
  assert.match(result.stderr, /NATIVE_ANDROID_LOGCAT: exit=0 bytes=0/);
  assert.match(result.stderr, /detail=logcat-capture-failed:exit=0:empty/);
});
