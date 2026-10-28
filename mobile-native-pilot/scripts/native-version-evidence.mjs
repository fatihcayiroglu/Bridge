import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const outstanding = ['authentication-and-switching', 'messaging', 'voice-video', 'uploads',
  'notifications-and-background', 'release-startup-and-responsiveness'];
export function storageEvidence({ platform, requested, observed, minimum, head, exit, verdict, binarySha256, executed }) {
  assert.match(head, /^[a-f0-9]{40}$/);
  assert.match(binarySha256, /^[a-f0-9]{64}$/);
  assert.equal(String(observed), String(requested), 'WRONG_RUNTIME_VERSION');
  assert.ok(Number.isInteger(exit) && exit >= 0, 'MISSING_PROCESS_RESULT');
  assert.match(String(minimum), /^\d+(\.\d+){0,2}$/);
  assert.match(String(observed), /^\d+(\.\d+){0,2}$/);
  assert.ok(compare(observed, minimum) >= 0, 'OS_BELOW_BUILT_MINIMUM');
  const marker = `NATIVE_${platform.toUpperCase()}_SECURE_STORE_AND_SQLCIPHER_RESTART=PASS`;
  const passed = executed === true && exit === 0 && verdict.split(/\r?\n/).some(line => line === marker || line.startsWith(marker + ' '));
  const status=executed === true ? (passed ? 'PASS' : 'FAIL') : 'NOT EXECUTED';
  return { category: 'AUTOMATED / SIMULATOR / DEBUG', platform, requested, observed, minimum,
    head, binarySha256, scope: 'native-protected-storage-and-encrypted-recovery',
    status, productCompatibility: 'NOT EXECUTED', physicalDevice: false,
    features: { 'protected-storage-and-encrypted-recovery': status,
      ...Object.fromEntries(outstanding.map(name => [name, 'NOT EXECUTED'])) } };
}
// ---- Android SDK availability (a gate that cannot run is NOT EXECUTED, never PASS or FAIL) ----
// Run 40676731505 (#546): `sdkmanager --install 'platforms;android-37'` -> "Failed to find
// package", no emulator ever started, and the cell showed only the raw emulator-action error.
// The packages the emulator action installs are checked first, against the STABLE channel
// the action uses; the all-channels inventory only explains where a package is offered.
export function sdkPackages(inventory) {
  const ids = new Set();
  for (const line of String(inventory ?? '').split(/\r?\n/)) {
    const m = /^\s{2}(\S[^|]*?)\s*\|/.exec(line);
    if (m && m[1] !== 'Path' && !/^-+$/.test(m[1])) ids.add(m[1]);
  }
  return ids;
}
export function androidSdkAvailability(api, stableInventory, allChannelsInventory = '') {
  assert.match(String(api), /^\d+$/, 'ANDROID_API_REQUIRED');
  const required = [`platforms;android-${api}`, `system-images;android-${api};google_apis;x86_64`];
  const stable = sdkPackages(stableInventory), everywhere = sdkPackages(allChannelsInventory);
  const missing = required.filter(id => !stable.has(id));
  const near = id => id.includes(`android-${api}`) || id.includes(`android-${api}.`);
  const nearby = [...new Set([...stable, ...everywhere])].filter(near).sort().slice(0, 12);
  if (!missing.length) return { available: true, required, missing, nearby, reason: null };
  const reason = missing.every(id => everywhere.has(id)) ? 'SDK_PACKAGE_ONLY_OUTSIDE_STABLE_CHANNEL' : 'SDK_PACKAGE_UNAVAILABLE';
  return { available: false, required, missing, nearby, reason };
}
export function androidNotExecuted({ head, requested, reason, missing = [], nearby = [] }) {
  assert.match(head, /^[a-f0-9]{40}$/);
  return { head, platform: 'android', requested: Number(requested), status: 'NOT EXECUTED', productCompatibility: 'NOT EXECUTED',
    reason, missing, nearby, physicalDevice: false,
    features: Object.fromEntries(['protected-storage-and-encrypted-recovery', ...outstanding].map(name => [name, 'NOT EXECUTED'])) };
}
const versionParts = version => String(version).split('.').map(Number);
const compare = (a, b) => { const x = versionParts(a), y = versionParts(b); for (let i=0;i<3;i++) { const d=(x[i]??0)-(y[i]??0);if(d)return d; } return 0; };
export function iosRuntimePlan(runtimes) {
  const available = runtimes.filter(r => r.isAvailable === true && /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-/.test(r.identifier)
    && /^\d+\.\d+(\.\d+)?$/.test(r.version) && compare(r.version, '16.4') >= 0)
    .sort((a,b) => compare(a.version,b.version));
  const latest = available.at(-1)?.version;
  const targets = [ ['16.4', r => compare(r.version,'16.4') === 0], ['17', r => r.version.startsWith('17.')],
    ['18', r => r.version.startsWith('18.')], ['26', r => r.version.startsWith('26.')], ['latest-installed', r => r.version === latest] ];
  return { status: 'NOT EXECUTED', runtimes: available, targets: targets.map(([target, matches]) => ({ target,
    runtimeVersions: available.filter(matches).map(r=>r.version), status: 'NOT EXECUTED',
    reason: available.some(matches) ? 'native journey pending' : 'no available installed simulator runtime' })),
    hardware: ['Samsung','Xiaomi','Pixel','iPhone'].map(device => ({ device, status: 'NOT EXECUTED', reason: 'no attached physical device supplied' })) };
}
export function observedIosRuntime(inventory, udid) {
  const identifier=Object.keys(inventory.devices).find(id=>inventory.devices[id].some(d=>d.udid===udid && d.state==='Booted'));
  const runtime=inventory.runtimes.find(r=>r.identifier===identifier && r.isAvailable===true);
  assert.ok(runtime,'REQUESTED_SIMULATOR_NOT_BOOTED');
  return runtime.version;
}
function write(file, data) { fs.writeFileSync(file, JSON.stringify(data,null,2)); }
function head() { const current=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();assert.equal(fs.readFileSync('native-evidence/head.txt','utf8').trim(),current,'STALE_HEAD_EVIDENCE');return current; }
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function optional(file) { return fs.existsSync(file) ? fs.readFileSync(file,'utf8') : ''; }
function main([action, requested, code, directory]) {
  if(action==='init-android') {
    write('native-evidence/compatibility.json',androidNotExecuted({head:head(),requested,reason:'native runtime journey has not completed'}));
  } else if(action==='sdk-check') {
    const result=androidSdkAvailability(requested,optional('native-evidence/sdk-inventory-stable.txt'),optional('native-evidence/sdk-inventory.txt'));
    if(!result.available) write('native-evidence/compatibility.json',androidNotExecuted({head:head(),requested,reason:result.reason,missing:result.missing,nearby:result.nearby}));
    console.log(result.available ? `NATIVE_ANDROID_API${requested}_SDK_AVAILABLE`
      : `NATIVE_ANDROID_API${requested}_NOT_EXECUTED reason=${result.reason} missing=${result.missing.join(',')} nearby=${result.nearby.join(',')||'none'}`);
    if(process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,`available=${result.available}\n`);
  } else if(action==='record-android') {
    const minimum=/^sdkVersion:'(\d+)'/m.exec(fs.readFileSync('native-evidence/apk-badging.txt','utf8'))?.[1];
    assert.equal(minimum,'24','BUILT_ANDROID_MINIMUM_CHANGED');
    const report=storageEvidence({platform:'android',requested,observed:fs.readFileSync('native-evidence/runtime-api.txt','utf8').trim(),minimum,
      head:head(),exit:Number(code),executed:fs.existsSync('native-evidence/first-launch.txt'),
      verdict:optional('native-evidence/native-verdict.txt'),binarySha256:sha('android/app/build/outputs/apk/debug/app-debug.apk')});
    write('native-evidence/compatibility.json',report);
    assert.equal(report.status,'PASS','NATIVE_STORAGE_COMPATIBILITY_FAILED');
  } else if(action==='ios-plan') {
    const plan=iosRuntimePlan(JSON.parse(fs.readFileSync('native-evidence/runtimes.json','utf8')).runtimes);
    write('native-evidence/ios-version-plan.json',{...plan,head:head()});
    for(const r of plan.runtimes) console.log(`${r.identifier}|${r.version}`);
    assert.ok(plan.runtimes.length,'NO_AVAILABLE_IOS_RUNTIME');
  } else if(action==='record-ios') {
    const report=storageEvidence({platform:'ios',requested,observed:fs.readFileSync(directory+'/runtime-version.txt','utf8').trim(),
      minimum:fs.readFileSync('native-evidence/ios-deployment-target.txt','utf8').trim(),head:head(),exit:Number(code),executed:fs.existsSync(directory+'/simulator-launch.txt'),
      verdict:optional(directory+'/native-verdict.txt'),binarySha256:sha(process.env.IOS_BINARY_PATH)});
    write(directory+'/compatibility.json',report);
    assert.equal(report.status,'PASS','NATIVE_STORAGE_COMPATIBILITY_FAILED');
  } else if(action==='ios-observed') {
    const inventory=JSON.parse(fs.readFileSync(requested+'/booted-device.json','utf8'));
    fs.writeFileSync(requested+'/runtime-version.txt',observedIosRuntime(inventory,code)+'\n');
  } else throw Error('UNKNOWN_EVIDENCE_ACTION');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
