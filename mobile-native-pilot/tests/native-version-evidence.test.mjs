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
