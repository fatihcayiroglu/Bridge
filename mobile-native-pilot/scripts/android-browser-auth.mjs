// Real native taps/keyboard/Back in an owned emulator. No injected callback,
// cookie, token, page JavaScript, desktop browser or TLS-warning bypass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {nodesOf,namedNode,centerOf,SETTINGS_HOSTS,anrDialog,anrVerdict,dumpSucceeded,MAX_UI_DUMP_ATTEMPTS,nonEmptyFileProbe,anrEvidence,findPinField,signInSubmit,loginFields,isFocused,usernameIntact,smallestClickableContaining,chromeConsoleEvidence,MAX_PIN_ENTRIES} from './android-auth-ui.mjs';
import {adbFailure,failureReport,redact} from './android-auth-failure.mjs';
const require=createRequire(import.meta.url),{Client}=require('../../server/node_modules/pg');
const out=path.resolve(process.env.MOBILE_AUTH_EVIDENCE),origin=process.env.BRIDGE_IT_ORIGIN;
const bundle='com.bridge.nativepilot',chrome='com.android.chrome',password=process.env.BRIDGE_MOBILE_PASSWORD;
assert.equal(origin,'https://127.0.0.1:8443');assert.ok(password?.length>=32);
fs.mkdirSync(out,{recursive:true});
const facts={category:'AUTOMATED / ANDROID EMULATOR / DEBUG',status:'FAIL',stage:'prerequisites',cases:[],anrDialogs:[],anrEvidence:[],uiDumpFailures:[],physicalDevice:false};
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
    // The tool's message alone is not enough: the file itself must exist and be non-empty before it is read.
    const present=dumpSucceeded(output)?shell(nonEmptyFileProbe('/sdcard/bridge-auth-ui.xml')).trim():'no-confirmation';
    if(present==='present')return nodesOf(shell('cat','/sdcard/bridge-auth-ui.xml'));
    facts.uiDumpFailures.push({attempt,output:redact(output,120,secrets()),file:present});
    if(attempt>=MAX_UI_DUMP_ATTEMPTS)throw Error('UI_DUMP_UNAVAILABLE');await pause(1000);}}
async function ui(answerAnr=true) {
  for(;;){const nodes=await dumpUi();
    const dialog=answerAnr?anrDialog(nodes):null,verdict=anrVerdict(dialog,protectedNames,facts.anrDialogs.length);
    if(verdict==='NONE')return nodes;
    // Explain the dialog from the system's own ActivityManager lines (first one, and the one that ends the run).
    // Soft call: `adb logcat -d` has exited 255 before and must not masquerade as the run's first adb failure.
    if(facts.anrEvidence.length===0||verdict!=='WAIT'){const l=spawnSync('adb',['logcat','-d','-b','system,events','-t','4000'],{encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024});
      facts.anrEvidence.push(...(l.status===0?anrEvidence(l.stdout):['logcat-unavailable exit='+String(l.status)+' signal='+String(l.signal)]));facts.anrEvidence=facts.anrEvidence.slice(-12);}
    if(verdict!=='WAIT')throw Error(verdict);
    facts.anrDialogs.push(dialog.process);tap(dialog.wait);await pause(1000);}}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(action,label) {facts.lastWait=label;const end=performance.now()+60000;while(performance.now()<end){const r=await action();if(r)return r;await pause(600);}throw Error('MOBILE_AUTH_DEADLINE:'+label);}
const tap=n=>shell('input','tap',...centerOf(n).map(String));
async function click(label,packages=[bundle],options={}) {tap(await until(async()=>namedNode(await ui(),label,packages,options),'native-control'));}
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
async function signIn(u,previousPid){await browserReady();
  // Every field is re-read after the previous input and must report focus before it receives text; a tap on stale
  // bounds once sent the password into the username field (run 40695774846).
  const fieldFocused=async(which)=>{tap(loginFields(await ui(),[chrome])[which]);
    await until(async()=>isFocused(loginFields(await ui(),[chrome])[which]),which+'-field-focus');};
  await fieldFocused('name');shell('input','text',u.username);
  await until(async()=>usernameIntact(await ui(),[chrome],u.username),'username-entered');
  await fieldFocused('secret');shell('input','text',password);
  await until(async()=>usernameIntact(await ui(),[chrome],u.username),'username-still-intact');
  // Back dismisses only an actually shown IME; otherwise it would cancel CCT.
  if(/mInputShown=true/.test(shell('dumpsys','input_method')))shell('input','keyevent','4');
  tap(await until(async()=>{const now=await ui(),field=now.find(x=>x.package===chrome && x.class==='android.widget.EditText' && x.password==='true');
    return field && signInSubmit(now,'Sign In',[chrome],field);},'sign-in-submit'));
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
  // Settings may ask for the device PIN before it opens a protected page, at any hop (run 40706223029: the PIN screen
  // "Re-enter your PIN" was up while the harness was still looking for a menu entry, SETTINGS_CONTROL_UNAVAILABLE).
  // Answer it with the emulator's own disposable PIN, at most MAX_PIN_ENTRIES times, then carry on.
  const answerPin=(nodes)=>{const field=findPinField(nodes);if(!field)return false;
    facts.pinEntries=(facts.pinEntries??0)+1;assert.ok(facts.pinEntries<=MAX_PIN_ENTRIES,'PIN_PROMPT_REPEATED');
    tap(field);shell('input','text',pin);shell('input','keyevent','66');return true;};
  async function findSetting(label){for(let i=0;i<7;i++){const nodes=await ui();if(answerPin(nodes)){await pause(1500);i--;continue;}
    const n=namedNode(nodes,label,SETTINGS_HOSTS);if(n){tap(n);return;}
    shell('input','swipe','500','1600','500','600','400');}throw Error('SETTINGS_CONTROL_UNAVAILABLE');}
  // Normal Settings UI, not a privileged CA-install API, root write or TLS bypass.
  await findSetting('More security & privacy');await findSetting('Encryption & credentials');
  // A tap is only a hop once the NEXT screen shows: run 40701820173 stayed on the "Install a certificate" list after the
  // "CA certificate" tap (ten foreign ANR dialogs were answered in that run, so a tap can be swallowed). Repeat the tap
  // while the current screen still shows the label and the next one has not appeared; the 60 s deadline bounds it.
  const hop=(label,next,nextOptions={})=>until(async()=>{const n=await ui();if(answerPin(n)){await pause(1500);return false;}if(namedNode(n,next,SETTINGS_HOSTS,nextOptions))return true;
    const control=namedNode(n,label,SETTINGS_HOSTS);if(control){facts.settingsHopTaps=(facts.settingsHopTaps??0)+1;tap(control);}return false;},'settings-hop:'+label.toLowerCase().replace(/\W+/g,'-'));
  await findSetting('Install a certificate');await hop('CA certificate','Install anyway',{ignoreCase:true});
  await click('Install anyway',['com.android.settings'],{ignoreCase:true});
  await until(async()=>{const n=await ui(),field=findPinField(n);
    if(field){tap(field);shell('input','text',pin);shell('input','keyevent','66');return true;}
    return n.some(x=>x.package==='com.google.android.documentsui' || x.package==='com.android.documentsui');},'settings-confirmation');
  const documents=['com.google.android.documentsui','com.android.documentsui'];
  await until(async()=>{const n=await ui(),file=namedNode(n,'bridge-disposable-ca.crt',documents);if(file){tap(file);return true;}
    const downloads=namedNode(n,'Downloads',documents);if(downloads){tap(downloads);return false;}
    const roots=namedNode(n,'Show roots',documents);if(roots)tap(roots);return false;},'test-ca-file-selection');
  // One tap on the file is not proof the picker accepted it: run 40697876546 stayed in PickActivity with the file still
  // listed. While the picker is still foreground, find the file again in a fresh dump and tap it again (each pass costs
  // a full UI dump, and the 60 s deadline still bounds the wait). Selecting the same file twice is idempotent.
  await until(async()=>{if(activity().startsWith('com.android.settings/'))return true;
    const now=await ui(),file=namedNode(now,'bridge-disposable-ca.crt',documents);
    // Even retaps press the label, odd ones the smallest clickable container around it (the card), so one wrong target cannot repeat.
    if(file){facts.caFileRetaps=(facts.caFileRetaps??0)+1;tap(facts.caFileRetaps%2===0?(smallestClickableContaining(now,file)??file):file);}return false;},'ca-install-return');facts.testCaInstalledViaSettings=true;
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
  if(Array.isArray(error?.matches))facts.ambiguousMatches=error.matches;
  if(!known){facts.errorKind=redact(error?.name,40,secrets());facts.errorMessage=redact(error?.message,160,secrets());}
  let n=[];try{facts.failureActivity=activity();}catch{}
  try{n=await ui(false);facts.failureUi={packages:[...new Set(n.map(x=>x.package))],editFields:n.filter(x=>x.class==='android.widget.EditText').length};}catch{}
  // Soft, bounded read of Chrome's own console/error lines, only when the login form never rendered.
  if(facts.lastWait==='custom-tabs-login'){try{const l=spawnSync('adb',['logcat','-d','-b','main','-t','6000'],{encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024});
    facts.chromeConsole=l.status===0?chromeConsoleEvidence(l.stdout):['logcat-unavailable exit='+String(l.status)];}catch{}}
  try{screenshot('first-failure');}catch{}
  facts.failureReport=failureReport({facts,nodes:n,secrets:secrets()});process.exitCode=1;
}finally{facts.notExecuted=ids.filter(id=>!facts.cases.some(c=>c.id===id));fs.writeFileSync(path.join(out,'android-browser-auth.json'),JSON.stringify(facts,null,2));
  if(database)await database.end();if(facts.status!=='PASS')console.log('NATIVE_ANDROID_AUTH_FAILURE '+JSON.stringify(facts.failureReport??failureReport({facts,secrets:secrets()})));
  console.log(JSON.stringify({status:facts.status,stage:facts.stage,passed:facts.cases.filter(c=>c.status==='PASS').length,failed:facts.cases.filter(c=>c.status==='FAIL').length,notExecuted:facts.notExecuted.length,skipped:0}));}
