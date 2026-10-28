import assert from 'node:assert/strict';
import { test } from 'node:test';
import { storageEvidence, iosRuntimePlan, observedIosRuntime } from '../scripts/native-version-evidence.mjs';

const sample = { platform:'android',requested:'35',observed:'35',minimum:'24',head:'a'.repeat(40),exit:0,executed:true,
  verdict:'NATIVE_ANDROID_SECURE_STORE_AND_SQLCIPHER_RESTART=PASS foreign_anr_dialogs_answered=0',binarySha256:'b'.repeat(64) };
test('native storage evidence cannot imply authentication, full OS compatibility or physical hardware acceptance',()=>{
  const r=storageEvidence(sample);
  assert.equal(r.status,'PASS');assert.equal(r.productCompatibility,'NOT EXECUTED');assert.equal(r.physicalDevice,false);
  for(const [feature,status] of Object.entries(r.features)) if(feature!=='protected-storage-and-encrypted-recovery')assert.equal(status,'NOT EXECUTED');
});
test('success marker cannot conceal a failing journey process',()=>assert.equal(storageEvidence({...sample,exit:1}).status,'FAIL'));
test('a prerequisite failure or copied marker cannot claim the native journey executed',()=>{
  for(const exit of [0,1])assert.equal(storageEvidence({...sample,executed:false,exit}).status,'NOT EXECUTED');
});
test('successful process without an actual complete native verdict cannot pass',()=>{
  for(const verdict of ['', 'PASS', 'NATIVE_ANDROID_SECURE_STORE_AND_SQLCIPHER_RESTART=PASS_FAKE', 'prefix '+sample.verdict])
    assert.equal(storageEvidence({...sample,verdict}).status,'FAIL');
});
test('an available runtime cannot stand in for a different requested OS or the minimum',()=>{
  assert.throws(()=>storageEvidence({...sample,requested:'37'}),/WRONG_RUNTIME_VERSION/);
  assert.throws(()=>storageEvidence({...sample,minimum:'36'}),/OS_BELOW_BUILT_MINIMUM/);
});
test('exact commit, binary identity and explicit process outcome are required',()=>{
  assert.throws(()=>storageEvidence({...sample,head:'main'}));
  assert.throws(()=>storageEvidence({...sample,binarySha256:''}));
  assert.throws(()=>storageEvidence({...sample,exit:undefined}));
});
test('iOS patch versions compare as OS versions and require the iOS verdict',()=>{
  const r=storageEvidence({...sample,platform:'ios',requested:'26.3.1',observed:'26.3.1',minimum:'16.4',verdict:'NATIVE_IOS_SECURE_STORE_AND_SQLCIPHER_RESTART=PASS'});
  assert.equal(r.status,'PASS');
  assert.equal(storageEvidence({...sample,platform:'ios'}).status,'FAIL');
});
const runtime=(version,isAvailable=true)=>({version,isAvailable,identifier:'com.apple.CoreSimulator.SimRuntime.iOS-'+version.replaceAll('.','-')});
test('iOS inventory preserves missing minimum/intermediate versions as NOT EXECUTED',()=>{
  const r=iosRuntimePlan([runtime('26.3'),runtime('17.5',false),runtime('15.1')]);
  assert.deepEqual(r.runtimes.map(x=>x.version),['26.3']);
  for(const target of ['16.4','17','18']) {
    const row=r.targets.find(x=>x.target===target);assert.equal(row.status,'NOT EXECUTED');assert.equal(row.runtimeVersions.length,0);
  }
  assert.ok(r.hardware.every(x=>x.status==='NOT EXECUTED'));
});
test('all actually installed supported iOS runtimes are planned; latest is determined numerically',()=>{
  const r=iosRuntimePlan([runtime('26.9'),runtime('16.4'),runtime('26.10'),runtime('18.2')]);
  assert.deepEqual(r.runtimes.map(x=>x.version),['16.4','18.2','26.9','26.10']);
  assert.deepEqual(r.targets.find(x=>x.target==='latest-installed').runtimeVersions,['26.10']);
  assert.ok(r.targets.every(x=>x.status==='NOT EXECUTED'));
});
test('observed iOS version must belong to the actually booted simulator, not the requested label',()=>{
  const a=runtime('17.5'),b=runtime('26.3');
  const inventory={runtimes:[a,b],devices:{[a.identifier]:[{udid:'a',state:'Shutdown'}],[b.identifier]:[{udid:'b',state:'Booted'}]}};
  assert.equal(observedIosRuntime(inventory,'b'),'26.3');
  assert.throws(()=>observedIosRuntime(inventory,'a'),/REQUESTED_SIMULATOR_NOT_BOOTED/);
  assert.throws(()=>observedIosRuntime(inventory,'missing'),/REQUESTED_SIMULATOR_NOT_BOOTED/);
});

// ---- Android SDK availability: NOT EXECUTED, never PASS or FAIL ----
import { sdkPackages, androidSdkAvailability, androidNotExecuted } from '../scripts/native-version-evidence.mjs';
const listing = rows => ['Installed packages:', '  Path | Version | Description | Location', '  ------- | ------- | ------- | -------',
  '  platform-tools | 36.0.0 | Android SDK Platform-Tools | platform-tools', '', 'Available Packages:', '  Path | Version | Description', '  ------- | ------- | -------',
  ...rows.map(id => `  ${id} | 1 | description of ${id}`)].join('\n');
const STABLE_ALL = ['platforms;android-24', 'platforms;android-35', 'platforms;android-36', 'system-images;android-24;google_apis;x86_64',
  'system-images;android-35;google_apis;x86_64', 'system-images;android-36;google_apis;x86_64', 'platforms;android-37.0'];

test('sdkmanager inventories parse to package ids, ignoring headers, rules and blank lines', () => {
  const ids = sdkPackages(listing(['platforms;android-36']));
  assert.deepEqual([...ids].sort(), ['platform-tools', 'platforms;android-36']);
  assert.equal(sdkPackages('').size, 0);
  assert.equal(sdkPackages(undefined).size, 0);
});
test('every package the emulator action installs must be offered by the STABLE channel to be available', () => {
  for (const api of [24, 35, 36]) assert.equal(androidSdkAvailability(api, listing(STABLE_ALL)).available, true, String(api));
  const missingImage = androidSdkAvailability(35, listing(STABLE_ALL.filter(id => id !== 'system-images;android-35;google_apis;x86_64')));
  assert.equal(missingImage.available, false);
  assert.deepEqual(missingImage.missing, ['system-images;android-35;google_apis;x86_64']);
});
test('API 37 absent from the SDK: NOT available, names what is missing and the near-miss package', () => {
  const r = androidSdkAvailability(37, listing(STABLE_ALL));
  assert.equal(r.available, false);
  assert.deepEqual(r.missing, ['platforms;android-37', 'system-images;android-37;google_apis;x86_64']);
  assert.equal(r.reason, 'SDK_PACKAGE_UNAVAILABLE');
  assert.deepEqual(r.nearby, ['platforms;android-37.0'], 'a differently named package is surfaced, never silently substituted');
});
test('a package offered only outside the stable channel is reported as such, not as available', () => {
  const preview = listing([...STABLE_ALL, 'platforms;android-37', 'system-images;android-37;google_apis;x86_64']);
  const r = androidSdkAvailability(37, listing(STABLE_ALL), preview);
  assert.equal(r.available, false);
  assert.equal(r.reason, 'SDK_PACKAGE_ONLY_OUTSIDE_STABLE_CHANNEL');
  assert.deepEqual(r.missing, ['platforms;android-37', 'system-images;android-37;google_apis;x86_64']);
});
test('an empty or unreadable inventory is never "available"', () => {
  assert.equal(androidSdkAvailability(35, '').available, false);
  assert.equal(androidSdkAvailability(35, undefined).available, false);
  assert.throws(() => androidSdkAvailability('x', ''), /ANDROID_API_REQUIRED/);
});
test('an unavailable SDK yields NOT EXECUTED evidence for every feature, with the reason and no pass anywhere', () => {
  const head = 'a'.repeat(40);
  const r = androidSdkAvailability(37, listing(STABLE_ALL));
  const report = androidNotExecuted({ head, requested: 37, reason: r.reason, missing: r.missing, nearby: r.nearby });
  assert.equal(report.status, 'NOT EXECUTED');
  assert.equal(report.productCompatibility, 'NOT EXECUTED');
  assert.equal(report.reason, 'SDK_PACKAGE_UNAVAILABLE');
  assert.equal(report.physicalDevice, false);
  assert.ok(Object.values(report.features).every(v => v === 'NOT EXECUTED'));
  assert.ok(!JSON.stringify(report).includes('PASS'));
  assert.throws(() => androidNotExecuted({ head: 'short', requested: 37, reason: 'x' }));
});
test('the workflow gates the emulator on SDK availability and keeps an unavailable cell red and named', async () => {
  const fs = await import('node:fs');
  const wf = fs.readFileSync(new URL('../../.github/workflows/native-pilot-native-runtime.yml', import.meta.url), 'utf8');
  assert.match(wf, /id: sdk\n\s+run: node scripts\/native-version-evidence\.mjs sdk-check '\$\{\{ matrix\.api \}\}'/);
  assert.match(wf, /sdkmanager" --list > native-evidence\/sdk-inventory-stable\.txt/);
  const boot = wf.slice(wf.indexOf('Boot real app, native secure storage'), wf.indexOf('android-emulator-runner@v2'));
  assert.match(boot, /if: steps\.sdk\.outputs\.available == 'true'/);
  const gate = wf.slice(wf.indexOf('Gate not satisfied'), wf.indexOf('actions/upload-artifact@v4'));
  assert.match(gate, /if: steps\.sdk\.outputs\.available == 'false'/);
  assert.match(gate, /NOT EXECUTED/);
  assert.match(gate, /exit 1/, 'an unexecuted gate must never be green');
  assert.match(wf, /api: \[24, 35, 36, 37\]/, 'API 37 stays in the matrix');
});
