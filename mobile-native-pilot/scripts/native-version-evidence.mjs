import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const outstanding = ['authentication-and-switching', 'messaging', 'voice-video', 'uploads',
  'notifications-and-background', 'release-startup-and-responsiveness'];
export function storageEvidence({ platform, requested, observed, minimum, head, exit, verdict, binarySha256 }) {
  assert.match(head, /^[a-f0-9]{40}$/);
  assert.match(binarySha256, /^[a-f0-9]{64}$/);
  assert.equal(String(observed), String(requested), 'WRONG_RUNTIME_VERSION');
  assert.ok(Number.isInteger(exit) && exit >= 0, 'MISSING_PROCESS_RESULT');
  assert.match(String(minimum), /^\d+(\.\d+){0,2}$/);
  assert.match(String(observed), /^\d+(\.\d+){0,2}$/);
  assert.ok(compare(observed, minimum) >= 0, 'OS_BELOW_BUILT_MINIMUM');
  const marker = `NATIVE_${platform.toUpperCase()}_SECURE_STORE_AND_SQLCIPHER_RESTART=PASS`;
  const passed = exit === 0 && verdict.split(/\r?\n/).some(line => line === marker || line.startsWith(marker + ' '));
  return { category: 'AUTOMATED / SIMULATOR / DEBUG', platform, requested, observed, minimum,
    head, binarySha256, scope: 'native-protected-storage-and-encrypted-recovery',
    status: passed ? 'PASS' : 'FAIL', productCompatibility: 'NOT EXECUTED', physicalDevice: false,
    features: { 'protected-storage-and-encrypted-recovery': passed ? 'PASS' : 'FAIL',
      ...Object.fromEntries(outstanding.map(name => [name, 'NOT EXECUTED'])) } };
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
    write('native-evidence/compatibility.json',{head:head(),platform:'android',requested:Number(requested),status:'NOT EXECUTED',
      productCompatibility:'NOT EXECUTED',reason:'native runtime journey has not completed',physicalDevice:false,
      features:Object.fromEntries(['protected-storage-and-encrypted-recovery',...outstanding].map(name=>[name,'NOT EXECUTED']))});
  } else if(action==='record-android') {
    const minimum=/^sdkVersion:'(\d+)'/m.exec(fs.readFileSync('native-evidence/apk-badging.txt','utf8'))?.[1];
    assert.equal(minimum,'24','BUILT_ANDROID_MINIMUM_CHANGED');
    const report=storageEvidence({platform:'android',requested,observed:fs.readFileSync('native-evidence/runtime-api.txt','utf8').trim(),minimum,
      head:head(),exit:Number(code),verdict:optional('native-evidence/native-verdict.txt'),binarySha256:sha('android/app/build/outputs/apk/debug/app-debug.apk')});
    write('native-evidence/compatibility.json',report);
    assert.equal(report.status,'PASS','NATIVE_STORAGE_COMPATIBILITY_FAILED');
  } else if(action==='ios-plan') {
    const plan=iosRuntimePlan(JSON.parse(fs.readFileSync('native-evidence/runtimes.json','utf8')).runtimes);
    write('native-evidence/ios-version-plan.json',{...plan,head:head()});
    for(const r of plan.runtimes) console.log(`${r.identifier}|${r.version}`);
    assert.ok(plan.runtimes.length,'NO_AVAILABLE_IOS_RUNTIME');
  } else if(action==='record-ios') {
    const report=storageEvidence({platform:'ios',requested,observed:fs.readFileSync(directory+'/runtime-version.txt','utf8').trim(),
      minimum:fs.readFileSync('native-evidence/ios-deployment-target.txt','utf8').trim(),head:head(),exit:Number(code),
      verdict:optional(directory+'/native-verdict.txt'),binarySha256:sha(process.env.IOS_BINARY_PATH)});
    write(directory+'/compatibility.json',report);
    assert.equal(report.status,'PASS','NATIVE_STORAGE_COMPATIBILITY_FAILED');
  } else if(action==='ios-observed') {
    const inventory=JSON.parse(fs.readFileSync(requested+'/booted-device.json','utf8'));
    fs.writeFileSync(requested+'/runtime-version.txt',observedIosRuntime(inventory,code)+'\n');
  } else throw Error('UNKNOWN_EVIDENCE_ACTION');
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
