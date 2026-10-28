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

const anrDialog = (title, { wait = true } = {}) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="android" bounds="[0,0][1080,2400]"><node index="0" text="${title}" resource-id="android:id/alertTitle" class="android.widget.TextView" package="android" bounds="[126,1001][954,1078]" /><node index="1" text="Close app" resource-id="android:id/aerr_close" class="android.widget.Button" package="android" bounds="[84,1120][996,1252]" />${wait ? '<node index="2" text="Wait" resource-id="android:id/aerr_wait" class="android.widget.Button" package="android" bounds="[84,1252][996,1384]" />' : ''}</node></hierarchy>`;
const classify = (xml) => runInDir("acceptance_classify_anr_dialog ui.xml 'Bridge Native Pilot'", { 'ui.xml': xml });

test('ANR dialog classification: another app is answered at the centre of Wait; ours is a failure', () => {
  const foreign = classify(anrDialog('Pixel Launcher isn&apos;t responding'));
  assert.equal(foreign.status, 0);
  assert.equal(foreign.stdout, "foreign 540 1318 Pixel Launcher isn't responding\n");
  assert.equal(classify(anrDialog("System UI isn't responding")).stdout, "foreign 540 1318 System UI isn't responding\n");
  assert.equal(classify(anrDialog('Bridge Native Pilot isn&apos;t responding')).stdout, "own Bridge Native Pilot isn't responding\n");
  assert.equal(classify(anrDialog('Pixel Launcher isn&apos;t responding', { wait: false })).stdout, "foreign - - Pixel Launcher isn't responding\n");
  assert.equal(classify(REDBOX_XML).stdout, 'none\n');
  assert.equal(classify('<hierarchy><node text="NATIVE_SQLCIPHER_WRITE_PASS" /></hierarchy>').stdout, 'none\n');
  // A pilot screen that merely mentions the phrase is not a dialog title of another app
  // unless it is a text node ending in "isn't responding"; ours still counts as ours.
  assert.equal(classify(anrDialog('Bridge Native Pilot isn’t responding')).stdout, "own Bridge Native Pilot isn’t responding\n");
});

test('the Android loop answers only foreign ANR dialogs with Wait, inside the same budget, and reports the count', () => {
  const s = fs.readFileSync('scripts/android-native-acceptance.sh', 'utf8');
  const fn = s.slice(s.indexOf('function assert_native_marker'), s.indexOf('stage=first-launch'));
  assert.match(fn, /acceptance_classify_anr_dialog "\$output" "\$own_label"/);
  assert.match(fn, /own\\ \*\) acceptance_detail="\$marker:app-not-responding"[^\n]*return 1/);
  assert.match(fn, /foreign\\ -\\ \*\) acceptance_detail="\$marker:foreign-anr-without-wait"[^\n]*return 1/);
  assert.match(fn, /NATIVE_ANDROID_FOREIGN_ANR/);
  assert.match(fn, /adb shell input tap "\$x" "\$y"/);
  assert.doesNotMatch(fn, /aerr_close/, 'never presses Close app');
  assert.equal((fn.match(/seq 1 90/g) || []).length, 1, 'one loop, same 90-dump budget');
  // The marker check comes first: a visible marker passes without touching any dialog.
  assert.ok(fn.indexOf('grep -q "$marker" "$output"') < fn.indexOf('acceptance_classify_anr_dialog'));
  assert.match(s, /NATIVE_ANDROID_SECURE_STORE_AND_SQLCIPHER_RESTART=PASS foreign_anr_dialogs_answered=\$foreign_anr_count/);
  assert.match(s, /^foreign_anr_count=0$/m);
});

// Runs the REAL assert_native_marker from the Android script against a fake `adb` that
// serves a scripted sequence of UI dumps and records every tap. No device involved.
function runMarkerLoop(dumps, marker = 'NATIVE_SQLCIPHER_WRITE_PASS') {
  const s = fs.readFileSync('scripts/android-native-acceptance.sh', 'utf8');
  const fn = s.slice(s.indexOf('foreign_anr_count=0'), s.indexOf('stage=first-launch'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-'));
  fs.mkdirSync(path.join(dir, 'bin')); fs.mkdirSync(path.join(dir, 'native-evidence'));
  dumps.forEach((xml, i) => fs.writeFileSync(path.join(dir, `dump-${i}.xml`), xml));
  fs.copyFileSync('app.json', path.join(dir, 'app.json')); // the loop reads the app label from it
  fs.writeFileSync(path.join(dir, 'bin', 'adb'), `#!/usr/bin/env bash
cd ${JSON.stringify(dir)}
n=$(cat count 2>/dev/null || echo 0)
case "$1 $2" in
  "shell uiautomator") exit 0 ;;
  "pull /sdcard/native-acceptance.xml") last=$(( ${dumps.length} - 1 )); (( n > last )) && n=$last; cp "dump-$n.xml" "$3"; echo $((n + 1)) > count ;;
  "shell input") echo "$4 $5" >> taps ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'case.sh'), `set -euo pipefail\nsource ${JSON.stringify(TRAP)}\nsleep() { :; }\n${fn}\nassert_native_marker ${marker} native-evidence/ui.xml\necho "count=$foreign_anr_count"\n`);
  const r = spawnSync('bash', ['case.sh'], { encoding: 'utf8', cwd: dir, env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` } });
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
  return { ...r, taps: read('taps'), evidence: read('native-evidence/foreign-anr.txt') };
}
const PASS_XML = '<hierarchy><node text="NATIVE_SECURE_STORE_ROUNDTRIP_PASS NATIVE_SQLCIPHER_WRITE_PASS" /></hierarchy>';

test('loop: a launcher ANR in front of the app is answered with Wait, then the marker passes', () => {
  const r = runMarkerLoop([anrDialog('Pixel Launcher isn&apos;t responding'), anrDialog('Pixel Launcher isn&apos;t responding'), PASS_XML]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.taps, '540 1318\n540 1318\n');
  assert.match(r.stdout, /^count=2$/m);
  assert.match(r.evidence, /^NATIVE_ANDROID_FOREIGN_ANR dump=1 marker=NATIVE_SQLCIPHER_WRITE_PASS dialog=Pixel Launcher isn't responding$/m);
  assert.match(r.stderr, /NATIVE_ANDROID_FOREIGN_ANR dump=2 /);
});

test('loop: the pilot\'s own ANR fails at once, without a tap', () => {
  const r = runMarkerLoop([anrDialog('Bridge Native Pilot isn&apos;t responding'), PASS_XML]);
  assert.equal(r.status, 1);
  assert.equal(r.taps, '');
  assert.match(r.stderr, /NATIVE_ANDROID_UI_TEXT: Bridge Native Pilot isn't responding/);
});

test('loop: a dialog that never goes away still fails after the same 90 dumps', () => {
  const r = runMarkerLoop([anrDialog('Pixel Launcher isn&apos;t responding')]);
  assert.equal(r.status, 1);
  assert.equal(r.taps.trim().split('\n').length, 90);
  assert.doesNotMatch(r.stdout, /count=/);
});

test('loop: a visible marker passes without touching anything', () => {
  const r = runMarkerLoop([PASS_XML]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.taps, '');
  assert.match(r.stdout, /^count=0$/m);
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

test('the ANR label is the app name from app.json, the one Android shows in the dialog title', () => {
  const s = fs.readFileSync('scripts/android-native-acceptance.sh', 'utf8');
  assert.match(s, /^own_label=\$\(node -p 'require\("\.\/app\.json"\)\.expo\.name'\)$/m);
  assert.equal(JSON.parse(fs.readFileSync('app.json', 'utf8')).expo.name, 'Bridge Native Pilot');
});

test('logcat ANR processes: every "ANR in" process once, sub-processes kept distinct', () => {
  const log = [
    '10-27 23:18:01.000  600  700 E ActivityManager: ANR in com.google.android.apps.nexuslauncher (com.google.android.apps.nexuslauncher/.NexusLauncherActivity)',
    '10-27 23:18:05.000  600  700 E ActivityManager: ANR in com.google.android.apps.nexuslauncher',
    '10-27 23:18:09.000  600  700 E ActivityManager: ANR in com.bridge.nativepilot:remote (com.bridge.nativepilot/.Svc)',
    '10-27 23:18:09.100  600  700 I ActivityManager: Start proc com.bridge.nativepilot',
  ].join('\n');
  const r = runInDir('acceptance_anr_processes log.txt; acceptance_anr_processes missing.txt; echo done', { 'log.txt': log });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'com.bridge.nativepilot:remote\ncom.google.android.apps.nexuslauncher\ndone\n');
});

// Runs the REAL anr-check block of the Android script on a logcat capture.
function runAnrCheck(logcat) {
  const s = fs.readFileSync('scripts/android-native-acceptance.sh', 'utf8');
  const block = s.slice(s.indexOf('stage=anr-check'), s.indexOf('# The verdict carries'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-'));
  fs.mkdirSync(path.join(dir, 'native-evidence'));
  fs.writeFileSync(path.join(dir, 'native-evidence', 'android-logcat.txt'), logcat);
  const script = `set -euo pipefail\nsource ${JSON.stringify(TRAP)}\nfunction cleanup() { local status=$?; acceptance_record_failure "$status" native-evidence android; exit "$status"; }\ntrap cleanup EXIT\n${block}\necho "anrs=\${logcat_anrs:-none}"\n`;
  fs.writeFileSync(path.join(dir, 'case.sh'), script);
  return spawnSync('bash', ['case.sh'], { encoding: 'utf8', cwd: dir });
}

test('anr-check: any pilot ANR in logcat fails the run, even when no dialog was ever seen', () => {
  for (const line of ['E ActivityManager: ANR in com.bridge.nativepilot (com.bridge.nativepilot/.MainActivity)',
    'E ActivityManager: ANR in com.bridge.nativepilot', 'E ActivityManager: ANR in com.bridge.nativepilot:remote']) {
    const r = runAnrCheck(`10-27 23:18:01.000  600  700 ${line}\n`);
    assert.equal(r.status, 1, line);
    assert.match(r.stderr, /NATIVE_ANDROID_ACCEPTANCE_FAILED stage=anr-check .*detail=pilot-anr-in-logcat:com\.bridge\.nativepilot/, line);
  }
});

test('anr-check: foreign ANRs are recorded, not failed; a clean log reports none', () => {
  const foreign = runAnrCheck('E ActivityManager: ANR in com.google.android.apps.nexuslauncher (x/.y)\nE ActivityManager: ANR in com.bridge.nativepilotx\n');
  assert.equal(foreign.status, 0, foreign.stderr);
  assert.equal(foreign.stdout, 'anrs=com.bridge.nativepilotx,com.google.android.apps.nexuslauncher\n');
  const clean = runAnrCheck('I ActivityManager: Start proc com.bridge.nativepilot\n');
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout, 'anrs=none\n');
});

test('ANR reports: which process and why (reason, load), from ActivityManager only', () => {
  const log = [
    '10-28 00:20:10.000   600   720 E ActivityManager: ANR in com.google.android.apps.nexuslauncher (com.google.android.apps.nexuslauncher/.NexusLauncherActivity)',
    '10-28 00:20:10.000   600   720 E ActivityManager: PID: 1432',
    '10-28 00:20:10.000   600   720 E ActivityManager: Reason: Input dispatching timed out (8f2 NexusLauncherActivity is not responding. Waited 5001ms for FocusEvent(hasFocus=true))',
    '10-28 00:20:10.000   600   720 E ActivityManager: ErrorId: 0123',
    '10-28 00:20:10.000   600   720 E ActivityManager: Load: 22.5 / 18.1 / 9.4',
    '10-28 00:20:10.000   600   720 E ActivityManager: 197% TOTAL: 120% user + 61% kernel',
    '10-28 00:20:10.000   600   720 I ActivityManager: Start proc 2000:com.bridge.nativepilot',
    '10-28 00:20:11.000  1000  1000 E SurfaceFlinger: unrelated',
  ].join('\n');
  const r = runInDir('acceptance_print_anr_reports android < log.txt', { 'log.txt': log });
  assert.equal(r.status, 0);
  const lines = r.stderr.trim().split('\n');
  assert.equal(lines.length, 6);
  assert.ok(lines.every((l) => l.startsWith('NATIVE_ANDROID_ANR_REPORT: ')));
  assert.match(r.stderr, /Reason: Input dispatching timed out/);
  assert.match(r.stderr, /Load: 22\.5 \/ 18\.1 \/ 9\.4/);
  assert.doesNotMatch(r.stderr, /Start proc|SurfaceFlinger/);
  assert.equal(runInDir('acceptance_print_anr_reports android < /dev/null').stderr, '');
});

test('on failure the Android script prints the ActivityManager ANR reports', () => {
  const s = fs.readFileSync('scripts/android-native-acceptance.sh', 'utf8');
  assert.match(s, /\(\( status == 0 \)\) \|\| acceptance_print_anr_reports android < native-evidence\/android-logcat\.txt/);
});

// Runs the REAL pre-launch probe block with a fake adb. It must record and never gate.
function runPrelaunch(adbScript) {
  const s = fs.readFileSync('scripts/android-native-acceptance.sh', 'utf8');
  const block = s.slice(s.indexOf('stage=pre-launch-metro-probe'), s.indexOf('stage=first-launch'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-'));
  fs.mkdirSync(path.join(dir, 'bin')); fs.mkdirSync(path.join(dir, 'native-evidence'));
  fs.writeFileSync(path.join(dir, 'bin', 'adb'), `#!/usr/bin/env bash\n${adbScript}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'case.sh'), `set -euo pipefail\nsource ${JSON.stringify(TRAP)}\n${block}\necho continued\n`);
  const r = spawnSync('bash', ['case.sh'], { encoding: 'utf8', cwd: dir, env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` } });
  const file = path.join(dir, 'native-evidence', 'pre-launch-metro.txt');
  return { ...r, record: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null };
}

test('pre-launch Metro probe: records tunnel and device-side /status, prints them', () => {
  const r = runPrelaunch('case "$1" in reverse) echo "emulator-5554 tcp:8081 tcp:8081";; shell) printf "HTTP/1.1 200 OK\\r\\n\\r\\npackager-status:running";; esac');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'continued');
  assert.match(r.record, /^reverse_list: emulator-5554 tcp:8081 tcp:8081 $/m);
  assert.match(r.record, /^device_status_ms=\d+$/m);
  assert.match(r.record, /^device_status_body: packager-status:running$/m);
  assert.match(r.stderr, /NATIVE_ANDROID_PRELAUNCH: device_status_body: packager-status:running/);
  // Both paths: the reverse tunnel and RN's emulator host alias that the app really uses.
  assert.match(r.record, /^emulator_host_status_ms=\d+$/m);
  assert.match(r.record, /^emulator_host_status_body: packager-status:running$/m);
  assert.match(r.stderr, /NATIVE_ANDROID_PRELAUNCH: emulator_host_status_body: packager-status:running/);
});

test('the emulator-host probe targets 10.0.2.2:8081 and the tunnel probe 127.0.0.1:8081', () => {
  const s = fs.readFileSync('scripts/android-native-acceptance.sh', 'utf8');
  const block = s.slice(s.indexOf('stage=pre-launch-metro-probe'), s.indexOf('stage=first-launch'));
  assert.match(block, /toybox nc -w 5 127\.0\.0\.1 8081/);
  assert.match(block, /toybox nc -w 5 10\.0\.2\.2 8081/);
});

test('logcat from before the fixture clear is kept and its ANR reports printed on failure', () => {
  const s = fs.readFileSync('scripts/android-native-acceptance.sh', 'utf8');
  assert.ok(s.indexOf('adb logcat -d > native-evidence/pre-test-logcat.txt') < s.indexOf('adb logcat -c'), 'saved before the clear');
  assert.match(s, /acceptance_print_anr_reports android_boot < native-evidence\/pre-test-logcat\.txt/);
  // The label is accepted by the printer (upper-cased tag).
  const r = runInDir('acceptance_print_anr_reports android_boot < log.txt', { 'log.txt': '10-28 00:22:30.000 600 700 E ActivityManager: ANR in com.google.android.apps.nexuslauncher\n' });
  assert.match(r.stderr, /^NATIVE_ANDROID_BOOT_ANR_REPORT: .*ANR in com\.google\.android\.apps\.nexuslauncher/m);
});

test('pre-launch Metro probe times with the monotonic clock, never the wall clock', () => {
  const s = fs.readFileSync('scripts/android-native-acceptance.sh', 'utf8');
  const block = s.slice(s.indexOf('stage=pre-launch-metro-probe'), s.indexOf('stage=first-launch'));
  assert.match(block, /\/proc\/uptime/);
  assert.doesNotMatch(block, /date \+/, 'wall clock can step backwards (CI recorded -355 ms)');
});

test('pre-launch Metro probe never gates: a failing adb is recorded and the run continues', () => {
  const r = runPrelaunch('echo "error: closed" >&2; exit 1');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'continued');
  assert.match(r.record, /^reverse_list: error: closed $/m);
  assert.match(r.record, /^device_status_body: error: closed$/m);
});

test('runtime errors include RN\'s packager-status WARNING (it names the IOException)', () => {
  const log = [
    '10-28 00:35:08.100  2246  2300 W unknown:ReactNative: The packager does not seem to be running as we got an IOException requesting its status: failed to connect to localhost/127.0.0.1 (port 8081) after 5000ms',
    '10-28 00:35:08.200  2246  2300 W unknown:ReactNative: some other warning',
    '10-28 00:35:12.515  2246  2246 E unknown:ReactNative: java.lang.RuntimeException: Unable to load script.',
  ].join('\n');
  const r = runInDir('acceptance_print_runtime_errors android < log.txt', { 'log.txt': log });
  const lines = r.stderr.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /IOException requesting its status: failed to connect .* after 5000ms/);
  assert.match(lines[1], /Unable to load script/);
});

// Runs the REAL final-logcat block with a fake adb.
function runFinalLogcat(adbScript) {
  const s = fs.readFileSync('scripts/android-native-acceptance.sh', 'utf8');
  const start = s.indexOf('stage=final-logcat');
  const block = s.slice(start, s.indexOf('\nstage=', start + 1));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-'));
  fs.mkdirSync(path.join(dir, 'bin')); fs.mkdirSync(path.join(dir, 'native-evidence'));
  fs.writeFileSync(path.join(dir, 'bin', 'adb'), `#!/usr/bin/env bash\n${adbScript}\n`, { mode: 0o755 });
  const script = `set -euo pipefail\nsource ${JSON.stringify(TRAP)}\nfunction cleanup() { local status=$?; acceptance_record_failure "$status" native-evidence android; exit "$status"; }\ntrap cleanup EXIT\n${block}\necho continued\n`;
  fs.writeFileSync(path.join(dir, 'case.sh'), script);
  return spawnSync('bash', ['case.sh'], { encoding: 'utf8', cwd: dir, env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` } });
}

test('final logcat: a failed capture still fails the run, and says why', () => {
  const r = runFinalLogcat('case "$1 $2" in "logcat -d") echo "partial line"; echo "logcat: read failure" >&2; exit 255;; "shell getprop") echo running;; "logcat -g") echo "main: ring buffer is 2 MiB";; esac');
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /continued/);
  assert.match(r.stderr, /NATIVE_ANDROID_LOGCAT: exit=255 bytes=13/);
  assert.match(r.stderr, /NATIVE_ANDROID_LOGCAT: stderr: logcat: read failure/);
  assert.match(r.stderr, /NATIVE_ANDROID_LOGCAT: logd: running/);
  assert.match(r.stderr, /NATIVE_ANDROID_LOGCAT: buffers: main: ring buffer is 2 MiB/);
  assert.match(r.stderr, /NATIVE_ANDROID_ACCEPTANCE_FAILED stage=final-logcat .*detail=logcat-capture-failed:exit=255/);
});

test('final logcat: a good capture continues with nothing extra printed', () => {
  const r = runFinalLogcat('[[ "$1 $2" == "logcat -d" ]] && echo "10-28 00:39:22.000 I x: y"; exit 0');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'continued');
  assert.equal(r.stderr, '');
});
