// Real native taps/keyboard/Back in an owned emulator. No injected callback,
// cookie, token, page JavaScript, desktop browser or TLS-warning bypass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {nodesOf,namedNode,centerOf,SETTINGS_HOSTS,anrDialog,anrVerdict,dumpSucceeded,MAX_UI_DUMP_ATTEMPTS} from './android-auth-ui.mjs';
import {adbFailure,failureReport,redact} from './android-auth-failure.mjs';
const require=createRequire(import.meta.url),{Client}=require('../../server/node_modules/pg');
const out=path.resolve(process.env.MOBILE_AUTH_EVIDENCE),origin=process.env.BRIDGE_IT_ORIGIN;
const bundle='com.bridge.nativepilot',chrome='com.android.chrome',password=process.env.BRIDGE_MOBILE_PASSWORD;
assert.equal(origin,'https://127.0.0.1:8443');assert.ok(password?.length>=32);
fs.mkdirSync(out,{recursive:true});
const facts={category:'AUTOMATED / ANDROID EMULATOR / DEBUG',status:'FAIL',stage:'prerequisites',cases:[],anrDialogs:[],uiDumpFailures:[],physicalDevice:false};
const protectedNames=[JSON.parse(fs.readFileSync(new URL('../app.json',import.meta.url),'utf8')).expo.name,'Chrome'];
const ids=['ANDROID_SYSTEM_BROWSER_CANCEL','ANDROID_AUTHENTICATE_RESTART_ROTATE','ANDROID_SWITCH_ISOLATE_REVOKE_RESTART'];
let database;
const secrets=()=>[password,process.env.BRIDGE_EMULATOR_PIN].filter(Boolean);
function adb(args,binary=false) {
  const r=spawnSync('adb',args,{encoding:binary?undefined:'utf8',timeout:20000,maxBuffer:8*1024*1024});
  // Only the FIRST adb failure is kept: the failure handler's own adb calls must not overwrite it.
  if(r.error||r.status!==0)facts.firstAdbFailure??=adbFailure(args,r,secrets());
  assert.ok(!r.error && r.status===0,'ADB_COMMAND_FAILED');
  return binary?r.stdout:r.stdout.replace(/\r/g,'');
}
const shell=(...args)=>adb(['shell',...args]);
async function dumpUi() {
  for(let attempt=1;;attempt++){shell('rm','-f','/sdcard/bridge-auth-ui.xml');
    const output=shell('uiautomator','dump','/sdcard/bridge-auth-ui.xml');
    if(dumpSucceeded(output))return nodesOf(shell('cat','/sdcard/bridge-auth-ui.xml'));
    facts.uiDumpFailures.push({attempt,output:redact(output,120,secrets())});
    if(attempt>=MAX_UI_DUMP_ATTEMPTS)throw Error('UI_DUMP_UNAVAILABLE');await pause(1000);}}
async function ui(answerAnr=true) {
  for(;;){const nodes=await dumpUi();
    const dialog=answerAnr?anrDialog(nodes):null,verdict=anrVerdict(dialog,protectedNames,facts.anrDialogs.length);
    if(verdict==='NONE')return nodes;if(verdict!=='WAIT')throw Error(verdict);
    facts.anrDialogs.push(dialog.process);tap(dialog.wait);await pause(1000);}}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(action,label) {facts.lastWait=label;const end=performance.now()+60000;while(performance.now()<end){const r=await action();if(r)return r;await pause(600);}throw Error('MOBILE_AUTH_DEADLINE:'+label);}
const tap=n=>shell('input','tap',...centerOf(n).map(String));
async function click(label,packages=[bundle]) {tap(await until(async()=>namedNode(await ui(),label,packages),'native-control'));}
function activity() {const raw=shell('dumpsys','activity','activities');return /(?:mResumedActivity|topResumedActivity)[^\n]*?\b([A-Za-z][\w.]+\/[\w.$]+)/.exec(raw)?.[1]??'';}
const pid=()=>shell('pidof',bundle).trim();
async function nativeScreen(label) {return activity().startsWith(bundle+'/') && namedNode(await ui(),label,[bundle]);}
const screenshot=label=>fs.writeFileSync(path.join(out,label+'.png'),adb(['exec-out','screencap','-p'],true));
const wire=kind=>fs.readFileSync(process.env.BRIDGE_IT_PROXY_EVIDENCE,'utf8').split('\n').filter(l=>l.startsWith('NATIVE_AUTH_HTTP ')).map(l=>JSON.parse(l.slice(17))).filter(r=>r.kind===kind);
async function api(method,route,token,body) {
  const headers={'Content-Type':'application/json'};if(token)headers.Authorization='Bearer '+token;
  if(token && method!=='GET')headers['X-CSRF-Token']=(await api('GET','/api/csrf-token',token)).token;
  const r=await fetch(origin+route,{method,headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  assert.ok(r.ok,'DISPOSABLE_FIXTURE_API_FAILED');return r.json();
}
async function fixture(tag) {const suffix=crypto.randomBytes(4).toString('hex'),username=`and_${tag}_${suffix}`;
  const r=await api('POST','/api/register',null,{username,password}),userId=String(r.user._id??r.user.id),serverName=`Android ${tag} ${suffix}`;
  await api('POST','/api/servers',r.token,{name:serverName});return {username,userId,serverName};}
async function families(u){return new Set((await database.query('SELECT DISTINCT family FROM refresh_tokens WHERE "userId"=$1 AND family IS NOT NULL',[u.userId])).rows.map(r=>r.family));}
async function tokens(u,f){return (await database.query('SELECT token,used FROM refresh_tokens WHERE "userId"=$1 AND family=$2',[u.userId,f])).rows;}
async function browserReady(){await until(async()=>{const a=activity();if(!a.startsWith(chrome+'/'))return false;
  const n=await ui();assert.ok(!n.some(x=>/Your connection is not private|NET::ERR_CERT/.test(x.text)),'TRUSTED_BROWSER_TLS_REQUIRED');
  return n.filter(x=>x.package===chrome && x.class==='android.widget.EditText').length>=2;},'custom-tabs-login');
  assert.match(activity(),/CustomTabActivity/,'REAL_CHROME_CUSTOM_TAB_REQUIRED');facts.customTabsObserved=true;}
async function signIn(u,previousPid){await browserReady();const n=(await ui()).filter(x=>x.package===chrome && x.class==='android.widget.EditText');
  const names=n.filter(x=>x.password==='false'),secrets=n.filter(x=>x.password==='true');assert.ok(names.length===1 && secrets.length===1,'REAL_LOGIN_FIELDS_REQUIRED');
  tap(names[0]);shell('input','text',u.username);tap(secrets[0]);shell('input','text',password);
  // Back dismisses only an actually shown IME; otherwise it would cancel CCT.
  if(/mInputShown=true/.test(shell('dumpsys','input_method')))shell('input','keyevent','4');
  await click('Sign In',[chrome]);
  await until(async()=>namedNode(await ui(),'Continue in the app',[chrome]),'explicit-consent');screenshot('consent-'+u.username.slice(4,5));
  const before=await families(u),count=wire('native-code').length;await click('Continue in the app',[chrome]);
  await until(()=>nativeScreen(u.serverName),'os-callback-to-native-community');
  assert.ok(namedNode(await ui(),'Sign out',[bundle]) && namedNode(await ui(),'Switch account',[bundle]),'NATIVE_AUTHENTICATED_SCREEN_REQUIRED');
  assert.equal(pid(),previousPid,'CALLBACK_MUST_RESUME_ORIGINAL_PROCESS');
  const codes=wire('native-code').slice(count);assert.ok(codes.length===1 && codes[0].status===200 && !codes[0].cookiePresent,'SINGLE_NATIVE_PKCE_EXCHANGE_REQUIRED');
  const after=[...await families(u)].filter(f=>!before.has(f));assert.equal(after.length,1,'ONE_NATIVE_FAMILY_REQUIRED');
  const live=(await tokens(u,after[0])).filter(r=>!r.used);assert.equal(live.length,1);screenshot('native-'+u.username.slice(4,5));return {family:after[0],token:live[0].token,pid:pid()};}
async function restart(u,issued){const count=wire('native-refresh').length;shell('am','force-stop',bundle);
  assert.equal(activity().startsWith(bundle+'/'),false,'OLD_NATIVE_ACTIVITY_STILL_ACTIVE');
  shell('am','start','-n',bundle+'/.MainActivity');await until(()=>nativeScreen(u.serverName),'keystore-restoration');assert.notEqual(pid(),issued.pid,'NEW_PROCESS_REQUIRED');
  const requests=wire('native-refresh').slice(count);assert.ok(requests.length===1 && requests[0].status===200 && !requests[0].cookiePresent,'SINGLE_NATIVE_ROTATION_REQUIRED');
  const rows=await tokens(u,issued.family),live=rows.filter(r=>!r.used);assert.ok(rows.find(r=>r.token===issued.token)?.used && live.length===1 && live[0].token!==issued.token,'POSTGRES_ROTATION_REQUIRED');return {...issued,token:live[0].token,pid:pid()};}
async function runCase(id,work){facts.stage=id;const c={id,status:'FAIL'};facts.cases.push(c);await work();c.status='PASS';}
async function setupTrustAndChrome(){facts.stage='normal-settings-ca-install';
  assert.equal(shell('getprop','ro.kernel.qemu').trim(),'1','OWNED_EMULATOR_REQUIRED');assert.equal(shell('getprop','ro.build.version.sdk').trim(),'35','API35_REQUIRED');
  const pin=process.env.BRIDGE_EMULATOR_PIN;assert.match(pin,/^\d{6}$/);shell('locksettings','set-pin',pin);
  adb(['push',process.env.NODE_EXTRA_CA_CERTS,'/sdcard/Download/bridge-disposable-ca.crt']);
  shell('am','start','-a','android.settings.SECURITY_SETTINGS');
  async function findSetting(label){for(let i=0;i<7;i++){const n=namedNode(await ui(),label,SETTINGS_HOSTS);if(n){tap(n);return;}
    shell('input','swipe','500','1600','500','600','400');}throw Error('SETTINGS_CONTROL_UNAVAILABLE');}
  // Normal Settings UI, not a privileged CA-install API, root write or TLS bypass.
  await findSetting('More security & privacy');await findSetting('Encryption & credentials');
  await findSetting('Install a certificate');await findSetting('CA certificate');await click('Install anyway',['com.android.settings']);
  await until(async()=>{const n=await ui(),field=n.find(x=>x.package==='com.android.settings' && x.class==='android.widget.EditText');
    if(field){tap(field);shell('input','text',pin);shell('input','keyevent','66');return true;}
    return n.some(x=>x.package==='com.google.android.documentsui' || x.package==='com.android.documentsui');},'settings-confirmation');
  const documents=['com.google.android.documentsui','com.android.documentsui'];
  await until(async()=>{const n=await ui(),file=namedNode(n,'bridge-disposable-ca.crt',documents);if(file){tap(file);return true;}
    const downloads=namedNode(n,'Downloads',documents);if(downloads){tap(downloads);return false;}
    const roots=namedNode(n,'Show roots',documents);if(roots)tap(roots);return false;},'test-ca-file-selection');
  await until(async()=>activity().startsWith('com.android.settings/'),'ca-install-return');facts.testCaInstalledViaSettings=true;
  facts.stage='chrome-first-run';shell('am','start','-n',chrome+'/com.google.android.apps.chrome.Main');
  await until(async()=>{const n=await ui();for(const label of ['Accept & continue','Use without an account','No thanks','Got it']){const control=namedNode(n,label,[chrome]);if(control){tap(control);return false;}}
    return n.some(x=>x.package===chrome && /url_bar|search_box_text/.test(x['resource-id']));},'chrome-ready');
}
try {await setupTrustAndChrome();database=new Client({connectionString:process.env.DATABASE_URL});await database.connect();
  assert.match(String((await database.query('SHOW server_version_num')).rows[0].server_version_num),/^16\d{4}$/);
  const a=await fixture('A'),b=await fixture('B');shell('am','start','-n',bundle+'/.MainActivity');
  await until(()=>nativeScreen('Sign in with your browser'),'native-sign-in-screen');const initial=pid();
  await runCase(ids[0],async()=>{const count=wire('native-code').length;await click('Sign in with your browser');await browserReady();shell('input','keyevent','4');
    await until(()=>nativeScreen('Sign in with your browser'),'cancelled-native-return');assert.equal(pid(),initial);assert.equal(wire('native-code').length,count);});
  let first;
  await runCase(ids[1],async()=>{await click('Sign in with your browser');first=await signIn(a,initial);assert.equal(namedNode(await ui(),b.serverName,[bundle]),null);first=await restart(a,first);});
  await runCase(ids[2],async()=>{await click('Switch account');const second=await signIn(b,first.pid);assert.equal(namedNode(await ui(),a.serverName,[bundle]),null);
    assert.equal((await tokens(a,first.family)).filter(r=>!r.used).length,0);const restored=await restart(b,second);await click('Sign out');
    await until(()=>nativeScreen('Sign in with your browser'),'signed-out-native-return');assert.equal((await tokens(b,restored.family)).filter(r=>!r.used).length,0);
    const r=await fetch(origin+'/api/native-auth/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refresh_token:restored.token}),signal:AbortSignal.timeout(20000)});assert.equal(r.status,401);
    const count=wire('native-refresh').length;shell('am','force-stop',bundle);shell('am','start','-n',bundle+'/.MainActivity');await until(()=>nativeScreen('Sign in with your browser'),'signed-out-restart');assert.equal(wire('native-refresh').length,count);});
  facts.status='PASS';facts.stage='complete';
}catch(error){const known=/^[A-Z_]+(?::[a-z-]+)?$/.test(error.message);facts.failure=known?error.message:'NATIVE_OR_SERVICE_FAILED';
  if(!known){facts.errorKind=redact(error?.name,40,secrets());facts.errorMessage=redact(error?.message,160,secrets());}
  let n=[];try{facts.failureActivity=activity();}catch{}
  try{n=await ui(false);facts.failureUi={packages:[...new Set(n.map(x=>x.package))],editFields:n.filter(x=>x.class==='android.widget.EditText').length};}catch{}
  try{screenshot('first-failure');}catch{}
  facts.failureReport=failureReport({facts,nodes:n,secrets:secrets()});process.exitCode=1;
}finally{facts.notExecuted=ids.filter(id=>!facts.cases.some(c=>c.id===id));fs.writeFileSync(path.join(out,'android-browser-auth.json'),JSON.stringify(facts,null,2));
  if(database)await database.end();if(facts.status!=='PASS')console.log('NATIVE_ANDROID_AUTH_FAILURE '+JSON.stringify(facts.failureReport??failureReport({facts,secrets:secrets()})));
  console.log(JSON.stringify({status:facts.status,stage:facts.stage,passed:facts.cases.filter(c=>c.status==='PASS').length,failed:facts.cases.filter(c=>c.status==='FAIL').length,notExecuted:facts.notExecuted.length,skipped:0}));}
