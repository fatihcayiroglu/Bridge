import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { androidProfiles, iosProfiles, initialEvidence, recordEvidence, assertComplete,
  chooseIosDeviceTypes, parseUiNodes, verifyAndroidUi } from '../scripts/layout-profiles.mjs';

const ui = (actionBounds = '[20,180][700,250]') => `<hierarchy rotation="0"><node text="Bridge" bounds="[20,40][600,90]"/><node text="Session: signed-out" bounds="[20,110][680,150]"/><node content-desc="Sign in with your browser" clickable="true" bounds="${actionBounds}"/></hierarchy>`;

test('Android has four representative logical viewports, including 320dp and tablet', () => {
  assert.deepEqual(androidProfiles.map(p => p.id), ['compact_320dp', 'phone_393dp', 'large_411dp', 'tablet_800dp']);
  for (const p of androidProfiles) assert.ok(p.width / (p.dpi / 160) >= 320);
  assert.ok(androidProfiles.at(-1).width / (androidProfiles.at(-1).dpi / 160) >= 600);
});

test('iOS requires four real simulator device families without substitutions', () => {
  assert.equal(iosProfiles.length, 4);
  const chosen = chooseIosDeviceTypes([{ name: 'iPhone 16', identifier: 'ios-standard' }]);
  assert.equal(chosen.find(x => x.id === 'standard_iphone').identifier, 'ios-standard');
  assert.equal(chosen.find(x => x.id === 'ipad').identifier, null);
});

test('Android checks real hierarchy and button bounds', () => {
  assert.equal(verifyAndroidUi(ui(), { width: 720, height: 1440 }).verdict, 'PASS');
  assert.equal(parseUiNodes(ui())[2].description, 'Sign in with your browser');
  assert.throws(() => verifyAndroidUi(ui('[650,180][750,250]'), { width: 720, height: 1440 }), /SIGN_IN_ACTION_CLIPPED/);
  assert.throws(() => verifyAndroidUi(ui().replace('Bridge', 'Other'), { width: 720, height: 1440 }), /BRIDGE_TITLE_MISSING/);
  assert.throws(() => verifyAndroidUi(ui().replace('Session: signed-out', 'Welcome'), { width: 720, height: 1440 }), /SESSION_STATE_MISSING/);
  assert.throws(() => verifyAndroidUi(ui().replace('Sign in with your browser', 'Something else'), { width: 720, height: 1440 }), /SIGN_IN_ACTION_MISSING/);
  assert.throws(() => verifyAndroidUi(ui().replace('Bridge', 'catalyst_redbox_title'), { width: 720, height: 1440 }), /ANDROID_RUNTIME_ERROR_SCREEN/);
});

test('NOT EXECUTED never masquerades as PASS', () => {
  const evidence = initialEvidence('android');
  assert.equal(evidence.physicalHardware, false);
  assert.throws(() => assertComplete(evidence), /LAYOUT_NOT_ALL_PROFILES_PASSED/);
  recordEvidence(evidence, 'compact_320dp', 'PASS');
  assert.throws(() => assertComplete(evidence), /LAYOUT_NOT_ALL_PROFILES_PASSED/);
  assert.throws(() => recordEvidence(evidence, 'compact_320dp', 'PASS'), /PROFILE_ALREADY_EXECUTED/);
  for (const p of androidProfiles.slice(1)) recordEvidence(evidence, p.id, 'PASS');
  assert.equal(assertComplete(evidence), true);
});

test('missing iPad is explicitly NOT EXECUTED and keeps the matrix red', () => {
  const evidence = initialEvidence('ios');
  assert.throws(() => recordEvidence(evidence, 'ipad', 'FAIL'), /FAILURE_REASON_REQUIRED/);
  recordEvidence(evidence, 'ipad', 'NOT_EXECUTED', 'DEVICE_TYPE_NOT_AVAILABLE');
  for (const p of iosProfiles.filter(p => p.id !== 'ipad')) recordEvidence(evidence, p.id, 'PASS');
  assert.throws(() => assertComplete(evidence), /LAYOUT_NOT_ALL_PROFILES_PASSED/);
});

test('CI actually runs both screen suites, captures evidence and pins its checkout to the PR head', () => {
  const flow = readFileSync(new URL('../../.github/workflows/native-pilot-layout-smoke.yml', import.meta.url), 'utf8');
  assert.match(flow, /android-layout-smoke\.sh/);
  assert.match(flow, /ios-layout-smoke\.sh/);
  assert.match(flow, /reactivecircus\/android-emulator-runner@v2/);
  assert.match(flow, /EXPO_PUBLIC_NATIVE_SELF_TEST:\s*'0'/);
  assert.match(flow, /github\.event\.pull_request\.head\.sha \|\| github\.sha/);
  assert.equal((flow.match(/if:\s*always\(\)/g) ?? []).length, 2);
  assert.match(flow, /prefetch-ios-prebuilt\.mjs/);
});
