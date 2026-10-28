import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {nodesOf} from '../scripts/android-auth-ui.mjs';
import {redact,adbFailure,visibleText,failureReport} from '../scripts/android-auth-failure.mjs';

const PIN='482915', PASSWORD='p'.repeat(8)+'Zq9!'.repeat(6);

test('redact masks exact secrets, long token-like runs and 6-digit numbers, and bounds the output',()=>{
  assert.equal(redact(`pin ${PIN} done`,160,[PIN]),'pin [secret] done');
  assert.equal(redact('token '+'a'.repeat(40)+' end'),'token [redacted] end');
  assert.equal(redact('code 123456 x'),'code [pin] x');
  assert.equal(redact('a\u0000b\tc\n d'),'a b c d');
  assert.equal(redact('word '.repeat(200),50).length,50,'bounded');
  assert.equal(redact('x'.repeat(500),50),'[redacted]','a long unbroken run is masked before the cap');
  assert.equal(redact(null),'');
  assert.equal(redact('keep SETTINGS_CONTROL_UNAVAILABLE as is'),'keep SETTINGS_CONTROL_UNAVAILABLE as is');
});

test('adb failures never print arguments past the subcommand: set-pin and input text carry the PIN',()=>{
  for(const args of [['shell','locksettings','set-pin',PIN],['shell','input','text',PIN],['shell','locksettings','set-pin',PIN,'extra']]){
    const f=adbFailure(args,{status:255,signal:null,stderr:`Error: bad pin ${PIN}`},[PIN]);
    assert.ok(!JSON.stringify(f).includes(PIN),'PIN must not appear: '+JSON.stringify(f));
    assert.equal(f.exit,255);
  }
  assert.equal(adbFailure(['shell','locksettings','set-pin',PIN],{status:1,stderr:''},[PIN]).command,'shell locksettings set-pin');
});

test('adb failure records exit, signal, timeout and redacted stderr',()=>{
  const timeout=adbFailure(['shell','uiautomator','dump','/sdcard/x.xml'],{status:null,signal:'SIGTERM',error:{code:'ETIMEDOUT'},stderr:''});
  assert.deepEqual(timeout,{command:'shell uiautomator dump',exit:null,signal:'SIGTERM',timedOut:true,stderr:''});
  const refused=adbFailure(['push','/tmp/ca.crt','/sdcard/Download/ca.crt'],{status:1,stderr:'adb: error: device offline '+'z'.repeat(60)});
  assert.equal(refused.timedOut,false);
  assert.match(refused.stderr,/^adb: error: device offline \[redacted\]$/);
});

test('visible text: text then content-desc, de-duplicated, bounded, decoded by the UI parser',()=>{
  const xml='<hierarchy>'+
    '<node package="com.android.settings" text="Encryption &amp; credentials" content-desc="" bounds="[0,0][1,1]"/>'+
    '<node package="com.android.settings" text="Encryption &amp; credentials" content-desc="" bounds="[0,0][1,1]"/>'+
    '<node package="com.android.settings" text="" content-desc="Navigate up" bounds="[0,0][1,1]"/>'+
    '<node package="com.android.settings" text="" content-desc="" bounds="[0,0][1,1]"/></hierarchy>';
  assert.deepEqual(visibleText(nodesOf(xml)),['Encryption & credentials','Navigate up']);
  const many=nodesOf('<hierarchy>'+Array.from({length:100},(_,i)=>`<node package="p" text="row ${i}" content-desc=""/>`).join('')+'</hierarchy>');
  assert.equal(visibleText(many).length,40);
  assert.equal(visibleText(many,5).length,5);
  assert.deepEqual(visibleText(undefined),[]);
});

test('failure report: the CA-install failure shape is fully described and secret-free',()=>{
  const facts={failure:'MOBILE_AUTH_DEADLINE:settings-confirmation',stage:'normal-settings-ca-install',lastWait:'settings-confirmation',
    failureActivity:'com.android.settings/.password.ConfirmLockPassword',firstAdbFailure:adbFailure(['shell','input','text',PIN],{status:1,stderr:'x'},[PIN])};
  const nodes=nodesOf('<hierarchy><node package="com.android.settings" class="android.widget.EditText" text="" content-desc="Enter your PIN"/>'+
    `<node package="com.android.settings" text="Your PIN ${PIN} is wrong" content-desc=""/></hierarchy>`);
  const report=failureReport({facts,nodes,secrets:[PIN,PASSWORD]});
  assert.equal(report.failure,'MOBILE_AUTH_DEADLINE:settings-confirmation');
  assert.equal(report.lastWait,'settings-confirmation');
  assert.equal(report.activity,'com.android.settings/.password.ConfirmLockPassword');
  assert.deepEqual(report.packages,['com.android.settings']);
  assert.deepEqual(report.visibleText,['Enter your PIN','Your PIN [secret] is wrong']);
  assert.ok(!JSON.stringify(report).includes(PIN));
  assert.deepEqual(failureReport({facts:{},secrets:[]}),{failure:null,stage:null,lastWait:null,errorKind:null,errorMessage:null,activity:'',packages:[],visibleText:[],firstAdbFailure:null,uiDumpFailures:[],anrEvidence:[],anrDialogsAnswered:[]});
});

test('the harness records only the FIRST adb failure and prints the report before the summary line',()=>{
  const s=fs.readFileSync(new URL('../scripts/android-browser-auth.mjs',import.meta.url),'utf8');
  assert.match(s,/facts\.firstAdbFailure\?\?=adbFailure\(args,r,secrets\(\)\)/);
  assert.ok(s.indexOf("facts.firstAdbFailure??=")<s.indexOf("assert.ok(!r.error && r.status===0,'ADB_COMMAND_FAILED')"),'recorded before the assertion throws');
  const report=s.indexOf("console.log('NATIVE_ANDROID_AUTH_FAILURE '"),summary=s.indexOf('console.log(JSON.stringify({status:facts.status');
  assert.ok(report>0 && report<summary);
  assert.match(s,/if\(facts\.status!=='PASS'\)console\.log\('NATIVE_ANDROID_AUTH_FAILURE '/);
  // Nothing in the diagnostics path may log adb argument lists.
  assert.doesNotMatch(s,/args\.join|JSON\.stringify\(args\)|console\.log\([^)]*args/);
  // Failure handling must not change what the harness asserts: the three native cases remain.
  for(const id of ['ANDROID_SYSTEM_BROWSER_CANCEL','ANDROID_AUTHENTICATE_RESTART_ROTATE','ANDROID_SWITCH_ISOLATE_REVOKE_RESTART'])assert.ok(s.includes(id));
  assert.match(s,/const end=performance\.now\(\)\+60000/,'the 60 s wait deadline is unchanged');
});

test('unknown errors keep only a redacted, bounded name and message; known codes pass through',()=>{
  const s=fs.readFileSync(new URL('../scripts/android-browser-auth.mjs',import.meta.url),'utf8');
  assert.match(s,/facts\.errorKind=redact\(error\?\.name,40,secrets\(\)\)/);
  assert.match(s,/facts\.errorMessage=redact\(error\?\.message,160,secrets\(\)\)/);
  const unsafe=new Error(`assert failed with ${PASSWORD} and ${PIN}`);
  assert.ok(!redact(unsafe.message,160,[PASSWORD,PIN]).includes(PIN));
  assert.ok(!redact(unsafe.message,160,[PASSWORD,PIN]).includes(PASSWORD));
});

// ---- Safety Center hosts the first Settings hop on API 35 (first failure: run 40678995495) ----
import { namedNode, SETTINGS_HOSTS } from '../scripts/android-auth-ui.mjs';
const node = (text, pkg) => ({ text, package: pkg, enabled: 'true', bounds: '[0,0][10,10]' });
// The screen the failing run actually showed (visibleText of NATIVE_ANDROID_AUTH_FAILURE).
const safetyCenter = ['Security & privacy', 'App security', 'Device unlock', 'Privacy', 'More security & privacy'].map(t => node(t, 'com.google.android.permissioncontroller'));

test('reproduces the first failure: restricting to com.android.settings cannot see the Safety Center control', () => {
  assert.equal(namedNode(safetyCenter, 'More security & privacy', ['com.android.settings']), null);
});
test('the Settings navigation accepts the OS packages that host it, and finds the control', () => {
  assert.equal(namedNode(safetyCenter, 'More security & privacy', SETTINGS_HOSTS).text, 'More security & privacy');
  assert.ok(namedNode([node('Encryption & credentials', 'com.android.settings')], 'Encryption & credentials', SETTINGS_HOSTS));
});
test('negative control: the same label from any non-OS package is never matched', () => {
  for (const pkg of ['com.bridge.nativepilot', 'com.evil.overlay', 'com.android.chrome'])
    assert.equal(namedNode([node('More security & privacy', pkg)], 'More security & privacy', SETTINGS_HOSTS), null, pkg);
  assert.deepEqual(SETTINGS_HOSTS.filter(p => !/^com\.(android|google\.android\.permissioncontroller|android\.permissioncontroller)/.test(p)), []);
});
test('ambiguity is still fatal and "Install anyway" stays restricted to com.android.settings', async () => {
  assert.throws(() => namedNode([node('X', 'com.android.settings'), node('X', 'com.google.android.permissioncontroller')], 'X', SETTINGS_HOSTS), /AMBIGUOUS_NATIVE_CONTROL/);
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../scripts/android-browser-auth.mjs', import.meta.url), 'utf8');
  assert.match(src, /click\('Install anyway',\['com\.android\.settings'\],\{ignoreCase:true\}\)/);
  assert.match(src, /namedNode\(await ui\(\),label,SETTINGS_HOSTS\)/);
});

// ---- Foreign ANR dialog (first-failure #2: run 40680725164, "Pixel Launcher isn't responding") ----
import { anrDialog, anrVerdict, MAX_ANR_DIALOGS } from '../scripts/android-auth-ui.mjs';
const sys = (text, extra = {}) => ({ text, package: 'android', enabled: 'true', bounds: '[0,0][10,10]', ...extra });
const launcherAnr = [sys("Pixel Launcher isn't responding"), sys('Close app'), sys('Wait')];
const PROTECTED = ['Bridge Native Pilot', 'Chrome'];

test('the real failing screen is recognised as a launcher ANR with a Wait control', () => {
  const d = anrDialog(launcherAnr);
  assert.equal(d.process, 'Pixel Launcher');
  assert.ok(d.wait);
  assert.equal(anrVerdict(d, PROTECTED), 'WAIT');
  assert.equal(anrDialog([node('More security & privacy', 'com.google.android.permissioncontroller')]), null);
  assert.equal(anrDialog([sys("Pixel Launcher isn\u2019t responding"), sys('Wait')]).process, 'Pixel Launcher');
});
test('negative control: an ANR of the app under test or of the browser is never dismissed', () => {
  for (const name of PROTECTED) assert.equal(anrVerdict(anrDialog([sys(`${name} isn't responding`), sys('Wait')]), PROTECTED), 'APP_OR_BROWSER_ANR', name);
});
test('only OS dialogs count: the same text from a non-`android` package is ignored', () => {
  assert.equal(anrDialog([node("Pixel Launcher isn't responding", 'com.evil.overlay'), node('Wait', 'com.evil.overlay')]), null);
});
test('a dialog without a usable Wait control, or beyond the bound, fails closed', () => {
  assert.equal(anrVerdict(anrDialog([sys("Pixel Launcher isn't responding")]), PROTECTED), 'ANR_DIALOG_UNHANDLED');
  assert.equal(anrVerdict(anrDialog(launcherAnr), PROTECTED, MAX_ANR_DIALOGS), 'ANR_DIALOG_UNHANDLED');
  assert.equal(anrVerdict(anrDialog(launcherAnr), PROTECTED, MAX_ANR_DIALOGS - 1), 'WAIT');
  assert.equal(MAX_ANR_DIALOGS, 30, 'a bounded budget, recorded per press');
});
test('every answered dialog is visible in the failure report; the failure handler reads the screen without tapping', async () => {
  assert.deepEqual(failureReport({ facts: { anrDialogs: ['Pixel Launcher', 'Pixel Launcher'] } }).anrDialogsAnswered, ['Pixel Launcher', 'Pixel Launcher']);
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../scripts/android-browser-auth.mjs', import.meta.url), 'utf8');
  assert.match(src, /n=await ui\(false\)/);
  assert.match(src, /facts\.anrDialogs\.push\(dialog\.process\);tap\(dialog\.wait\)/);
});

// ---- uiautomator dump that exits 0 without writing the file (first failure #3: run 40682196007) ----
import { dumpSucceeded, MAX_UI_DUMP_ATTEMPTS } from '../scripts/android-auth-ui.mjs';
test('only the tool\'s own confirmation counts as a successful dump, never an empty exit-0 output', () => {
  assert.equal(dumpSucceeded('UI hierarchy dumped to: /sdcard/bridge-auth-ui.xml\n'), true);
  // The exact text observed on the emulator (run 40683551643): the tool misspells "hierarchy".
  assert.equal(dumpSucceeded('UI hierchary dumped to: /sdcard/bridge-auth-ui.xml'), true);
  for (const bad of ['', undefined, 'ERROR: could not get idle state.', 'UI hierarchy']) assert.equal(dumpSucceeded(bad), false, String(bad));
});
test('dump failures are retried a bounded number of times, recorded, removed-before-read, and end fail-closed', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../scripts/android-browser-auth.mjs', import.meta.url), 'utf8');
  assert.equal(MAX_UI_DUMP_ATTEMPTS, 5);
  assert.match(src, /shell\('rm','-f','\/sdcard\/bridge-auth-ui\.xml'\)/, 'a stale dump must never be read');
  assert.match(src, /facts\.uiDumpFailures\.push\(\{attempt,output:redact\(output,120,secrets\(\)\),file:present\}\)/);
  assert.match(src, /nonEmptyFileProbe\('\/sdcard\/bridge-auth-ui\.xml'\)/, 'the file must exist and be non-empty before it is read');
  assert.match(src, /attempt>=MAX_UI_DUMP_ATTEMPTS\)throw Error\('UI_DUMP_UNAVAILABLE'\)/);
  assert.deepEqual(failureReport({ facts: { uiDumpFailures: [{ attempt: 1, output: 'ERROR: could not get idle state.' }] } }).uiDumpFailures, [{ attempt: 1, output: 'ERROR: could not get idle state.' }]);
});

// ---- the existence probe, run through a faithful model of `adb shell` argument handling ----
import { nonEmptyFileProbe } from '../scripts/android-auth-ui.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// adb joins the arguments with spaces and the device shell parses the result.
const adbShell = (...args) => spawnSync('sh', ['-c', args.join(' ')], { encoding: 'utf8' }).stdout.trim();

test('the probe answers present only for a non-empty file, absent for missing or empty', () => {
  const d = mkdtempSync(join(tmpdir(), 'probe-'));
  writeFileSync(join(d, 'full.xml'), '<hierarchy/>'); writeFileSync(join(d, 'empty.xml'), '');
  assert.equal(adbShell(nonEmptyFileProbe(join(d, 'full.xml'))), 'present');
  assert.equal(adbShell(nonEmptyFileProbe(join(d, 'empty.xml'))), 'absent');
  assert.equal(adbShell(nonEmptyFileProbe(join(d, 'missing.xml'))), 'absent');
});
test('regression for run 40684975946: the split-argument form always answers absent, even for a real file', () => {
  const d = mkdtempSync(join(tmpdir(), 'probe-')); const f = join(d, 'full.xml'); writeFileSync(f, '<hierarchy/>');
  assert.equal(adbShell('sh', '-c', `test -s ${f} && echo present || echo absent`), 'absent', 'this is the bug that was shipped');
  assert.equal(adbShell(nonEmptyFileProbe(f)), 'present');
});
test('the probe refuses a path that could inject shell syntax', () => {
  for (const bad of ['/sdcard/x; rm -rf /', '/sdcard/$(id)', 'relative.xml', '/sdcard/a b', '']) assert.throws(() => nonEmptyFileProbe(bad), /PROBE_PATH_INVALID/, bad);
});

// ---- "INSTALL ANYWAY" (first failure #6: run 40686263044, screen InstallCaCertificateWarning) ----
const warning = ['Your data won\u2019t be private', 'INSTALL ANYWAY', 'DON\u2019T INSTALL'].map(t => node(t, 'com.android.settings'));
test('reproduces the failure: exact matching cannot find the capitalised system button', () => {
  assert.equal(namedNode(warning, 'Install anyway', ['com.android.settings']), null);
});
test('opt-in case-insensitive matching finds it, and only it', () => {
  assert.equal(namedNode(warning, 'Install anyway', ['com.android.settings'], { ignoreCase: true }).text, 'INSTALL ANYWAY');
  assert.equal(namedNode(warning, 'Install', ['com.android.settings'], { ignoreCase: true }), null, 'a prefix is not a match');
  assert.equal(namedNode(warning, "Don't install", ['com.android.settings'], { ignoreCase: true }), null, 'a different (curly-apostrophe) control is not matched');
});
test('negative controls: still package-scoped, enabled-only, and ambiguity stays fatal', () => {
  assert.equal(namedNode([node('INSTALL ANYWAY', 'com.evil.overlay')], 'Install anyway', ['com.android.settings'], { ignoreCase: true }), null);
  assert.equal(namedNode([{ ...node('INSTALL ANYWAY', 'com.android.settings'), enabled: 'false' }], 'Install anyway', ['com.android.settings'], { ignoreCase: true }), null);
  assert.throws(() => namedNode([node('INSTALL ANYWAY', 'com.android.settings'), node('Install Anyway', 'com.android.settings')], 'Install anyway', ['com.android.settings'], { ignoreCase: true }), /AMBIGUOUS_NATIVE_CONTROL/);
});
test('every other control keeps exact matching: only the certificate warning button opts in', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../scripts/android-browser-auth.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/ignoreCase:true/g) ?? []).length, 1);
  assert.equal(namedNode([node('Sign Out', 'com.bridge.nativepilot')], 'Sign out', ['com.bridge.nativepilot']), null);
});

// ---- recurring launcher ANR during PIN confirmation (first failure #7: run 40687924466) ----
import { anrEvidence } from '../scripts/android-auth-ui.mjs';
const AM = [
  '10-28 12:37:01.100  1000  1100  1200 E ActivityManager: ANR in com.google.android.apps.nexuslauncher (com.google.android.apps.nexuslauncher/.NexusLauncherActivity)',
  '10-28 12:37:01.100  1000  1100  1200 E ActivityManager: PID: 2468',
  '10-28 12:37:01.100  1000  1100  1200 E ActivityManager: Reason: Input dispatching timed out (Application does not have a focused window)',
  '10-28 12:37:01.100  1000  1100  1200 E ActivityManager: Load: 9.24 / 5.1 / 2.3',
  '10-28 12:37:01.100  1000  1100  1200 E ActivityManager: unrelated chatter that must not appear',
  `10-28 12:37:01.100  1000  1100  1200 E ActivityManager: Reason: token ${'q'.repeat(40)}`,
];
test('only the ActivityManager ANR facts are extracted: process, pid, reason, load; long token-like runs are masked', () => {
  const lines = anrEvidence(AM.join('\n'));
  assert.ok(lines.some(l => /ANR in com\.google\.android\.apps\.nexuslauncher/.test(l)));
  assert.ok(lines.some(l => /Reason: Input dispatching timed out/.test(l)));
  assert.ok(lines.some(l => /Load: 9\.24/.test(l)));
  assert.ok(!lines.some(l => /unrelated chatter/.test(l)));
  assert.ok(!lines.join(' ').includes('qqqqqqqq'));
});
test('the excerpt is bounded and tolerates missing input', () => {
  assert.equal(anrEvidence(Array(100).fill('E ActivityManager: Reason: x').join('\n'), 10).length, 10);
  assert.ok(anrEvidence(AM.join('\n'), 10, 40).every(l => l.length <= 40));
  assert.deepEqual(anrEvidence(undefined), []);
});
test('the log read is a soft call (never the run\'s first adb failure) and is also taken on the run-ending dialog', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../scripts/android-browser-auth.mjs', import.meta.url), 'utf8');
  assert.match(src, /spawnSync\('adb',\['logcat','-d','-b','system'/, 'direct spawn, not the asserting adb() helper');
  assert.match(src, /facts\.anrEvidence\.length===0\|\|verdict!=='WAIT'/);
  assert.match(src, /logcat-unavailable exit=/);
  assert.deepEqual(failureReport({ facts: { anrEvidence: ['x'] } }).anrEvidence, ['x']);
});
