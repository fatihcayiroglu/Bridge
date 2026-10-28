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
  assert.deepEqual(failureReport({facts:{},secrets:[]}),{failure:null,stage:null,lastWait:null,errorKind:null,errorMessage:null,activity:'',packages:[],visibleText:[],firstAdbFailure:null});
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
