import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nodesOf,namedNode,centerOf} from '../scripts/android-auth-ui.mjs';
const node=(pkg,text,extra='')=>`<node package="${pkg}" text="${text}" content-desc="" enabled="true" bounds="[10,20][110,80]" ${extra}/>`;
test('native selectors require the intended app, exact label and enabled control',()=>{
  const nodes=nodesOf('<hierarchy>'+node('chrome','Sign out')+node('bridge','Sign out')+node('bridge','Sign out extra')+'</hierarchy>');
  assert.equal(namedNode(nodes,'Sign out',['bridge']).package,'bridge');
  assert.equal(namedNode(nodes,'Missing',['bridge']),null);
});
test('ambiguous native controls fail closed instead of clicking an arbitrary account or consent',()=>{
  const nodes=nodesOf('<hierarchy>'+node('bridge','Continue')+node('bridge','Continue')+'</hierarchy>');
  assert.throws(()=>namedNode(nodes,'Continue',['bridge']),/AMBIGUOUS_NATIVE_CONTROL/);
});
test('accessibility labels decode XML entities and gestures use actual positive bounds',()=>{
  const nodes=nodesOf('<hierarchy>'+node('settings','Encryption &amp; credentials')+'</hierarchy>');
  assert.deepEqual(centerOf(namedNode(nodes,'Encryption & credentials',['settings'])),[60,50]);
  assert.throws(()=>centerOf({bounds:'[0,0][0,0]'}),/EMPTY_NATIVE_CONTROL/);
  assert.throws(()=>nodesOf('<html/>'),/NATIVE_UI_HIERARCHY_REQUIRED/);
});
// Run 40691530402: the native "Sign in with your browser" Pressable is a clickable container plus a Text child.
const rn=(cls,clickable,bounds,text='Sign in with your browser',pkg='bridge')=>({class:cls,package:pkg,text,'content-desc':'',enabled:'true',clickable,bounds});
test('a clickable container and its labelled child are one control and the container is chosen',()=>{
  const container=rn('android.view.ViewGroup','true','[10,20][310,120]'),child=rn('android.widget.TextView','false','[20,30][300,110]');
  assert.equal(namedNode([child,container],'Sign in with your browser',['bridge']),container);
});
test('duplicate labels that are not one nested clickable control still fail closed',()=>{
  const a=rn('android.view.ViewGroup','true','[10,20][310,120]'),b=rn('android.view.ViewGroup','true','[10,200][310,300]');
  assert.throws(()=>namedNode([a,b],'Sign in with your browser',['bridge']),/AMBIGUOUS_NATIVE_CONTROL/);
  const apart=rn('android.widget.TextView','false','[10,400][310,500]');
  assert.throws(()=>namedNode([a,apart],'Sign in with your browser',['bridge']),/AMBIGUOUS_NATIVE_CONTROL/);
  assert.throws(()=>namedNode([rn('android.widget.TextView','false','[1,1][2,2]'),rn('android.widget.TextView','false','[1,1][2,2]')],'Sign in with your browser',['bridge']),/AMBIGUOUS_NATIVE_CONTROL/);
  assert.throws(()=>namedNode([a,rn('android.widget.TextView','false','[20,30][300,110]'),rn('android.view.View','true','[20,30][300,110]')],'Sign in with your browser',['bridge']),/AMBIGUOUS_NATIVE_CONTROL/);
});
test('the ambiguity error carries the matching nodes for the failure report',async()=>{
  const {failureReport}=await import('../scripts/android-auth-failure.mjs');
  let err;try{namedNode([rn('a','true','[0,0][5,5]'),rn('b','true','[0,0][5,5]')],'Sign in with your browser',['bridge']);}catch(e){err=e;}
  assert.equal(err.matches.length,2);
  assert.equal(failureReport({facts:{ambiguousMatches:err.matches}}).ambiguousMatches.length,2);
});
// Run 40694259425: the login page's "Sign In" tab and submit button, with the bounds the runner reported.
import {signInSubmit} from '../scripts/android-auth-ui.mjs';
import fs from 'node:fs';
const btn=(bounds,over={})=>({class:'android.widget.Button',package:'chrome',text:'Sign In',enabled:'true',clickable:'true',bounds,...over});
const pw={class:'android.widget.EditText',package:'chrome',password:'true',bounds:'[94,1400][987,1550]'};
const tab=btn('[105,999][538,1117]'),submit=btn('[94,1676][987,1794]');
test('the Sign In submit below the password field is chosen over the tab',()=>{
  assert.equal(signInSubmit([tab,submit],'Sign In',['chrome'],pw),submit);
  assert.equal(signInSubmit([submit,tab],'Sign In',['chrome'],pw),submit);
});
test('Sign In selection waits when the submit is absent and fails closed on several or bad input',()=>{
  assert.equal(signInSubmit([tab],'Sign In',['chrome'],pw),null);
  assert.throws(()=>signInSubmit([tab,submit,btn('[94,1800][987,1900]')],'Sign In',['chrome'],pw),/AMBIGUOUS_SIGN_IN_SUBMIT/);
  assert.throws(()=>signInSubmit([tab,submit],'Sign In',['chrome'],{bounds:''}),/PASSWORD_FIELD_BOUNDS_REQUIRED/);
  assert.equal(signInSubmit([tab,btn('[94,1676][987,1794]',{package:'evil'})],'Sign In',['chrome'],pw),null,'other packages never match');
  assert.equal(signInSubmit([tab,btn('[94,1676][987,1794]',{enabled:'false'})],'Sign In',['chrome'],pw),null);
  assert.equal(signInSubmit([tab,btn('[94,1676][987,1794]',{clickable:'false'})],'Sign In',['chrome'],pw),null);
});
test('the Android harness submits through signInSubmit, not a label click on Sign In',()=>{
  const s=fs.readFileSync(new URL('../scripts/android-browser-auth.mjs',import.meta.url),'utf8');
  assert.match(s,/signInSubmit\(now,'Sign In',\[chrome\],field\)/);
  assert.ok(!/click\('Sign In'/.test(s));
});
// Run 40695774846: the password reached the username field ("and_A_..[secret]") and the page said "All fields are required".
import {loginFields,isFocused,usernameIntact} from '../scripts/android-auth-ui.mjs';
const edit=(password,text,focused='false')=>({class:'android.widget.EditText',package:'chrome',password,text,focused,bounds:'[0,0][9,9]'});
test('login fields are split by the password attribute and need exactly one of each',()=>{
  const name=edit('false','alice'),secret=edit('true','');
  assert.deepEqual(loginFields([name,secret,{...edit('false','x'),package:'other'}],['chrome']),{name,secret});
  assert.throws(()=>loginFields([name],['chrome']),/REAL_LOGIN_FIELDS_REQUIRED/);
  assert.throws(()=>loginFields([name,edit('false','b'),secret],['chrome']),/REAL_LOGIN_FIELDS_REQUIRED/);
});
test('focus is read from the field, and a username with the password appended is detected',()=>{
  assert.equal(isFocused(edit('true','', 'true')),true);
  assert.equal(isFocused(edit('true','', 'false')),false);
  assert.equal(isFocused(undefined),false);
  assert.equal(usernameIntact([edit('false','alice'),edit('true','')],['chrome'],'alice'),true);
  assert.equal(usernameIntact([edit('false','alicePASSWORD'),edit('true','')],['chrome'],'alice'),false);
});
test('the Android harness gates every typed field on observed focus and checks the username afterwards',()=>{
  const s=fs.readFileSync(new URL('../scripts/android-browser-auth.mjs',import.meta.url),'utf8');
  assert.match(s,/const f=loginFields\(await ui\(\),\[chrome\]\);if\(isFocused\(f\[which\]\)\)return true;/);
  assert.match(s,/await fieldFocused\('name'\);shell\('input','text',u\.username\)/);
  assert.match(s,/await fieldFocused\('secret'\);shell\('input','text',password\)/);
  assert.match(s,/username-still-intact/);
  assert.ok(!/tap\(secrets\[0\]\)/.test(s));
});
// Run 40697876546: stuck in the documents picker with the CA file listed after a single tap.
test('the CA install waits for Settings by re-finding and re-tapping the listed file, bounded by until()',()=>{
  const s=fs.readFileSync(new URL('../scripts/android-browser-auth.mjs',import.meta.url),'utf8');
  assert.match(s,/if\(activity\(\)\.startsWith\('com\.android\.settings\/'\)\)return true;\s*const now=await ui\(\),file=namedNode\(now,'bridge-disposable-ca\.crt',documents\);/);
  assert.match(s,/facts\.caFileRetaps=\(facts\.caFileRetaps\?\?0\)\+1;tap\(facts\.caFileRetaps%2===0\?\(smallestClickableContaining\(now,file\)\?\?file\):file\)/);
  assert.ok(!/await until\(async\(\)=>activity\(\)\.startsWith\('com\.android\.settings\/'\),'ca-install-return'\)/.test(s),'a passive wait is not enough');
});

import {smallestClickableContaining} from '../scripts/android-auth-ui.mjs';
const cn=(bounds,over={})=>({class:'android.view.View',package:'docs',enabled:'true',clickable:'false',bounds,...over});
test('the smallest enabled clickable container of the same package around a label is chosen',()=>{
  const label=cn('[20,100][200,140]',{text:'f.crt'}),card=cn('[10,50][210,200]',{clickable:'true'}),list=cn('[0,0][400,800]',{clickable:'true'});
  assert.equal(smallestClickableContaining([list,label,card],label),card);
  assert.equal(smallestClickableContaining([label],label),null);
  assert.equal(smallestClickableContaining([label,{...card,package:'evil'}],label),null);
  assert.equal(smallestClickableContaining([label,{...card,enabled:'false'}],label),null);
  assert.equal(smallestClickableContaining([label,cn('[10,50][100,200]',{clickable:'true'})],label),null,'a clickable that does not contain the label is not a container');
  assert.equal(smallestClickableContaining([label],{bounds:'bad'}),null);
  const clickableLabel={...label,clickable:'true'};
  assert.equal(smallestClickableContaining([clickableLabel],clickableLabel),null,'the target itself is never its own container');
  assert.equal(smallestClickableContaining([clickableLabel,list],clickableLabel),list);
});
test('the failure report lists clickable nodes of the failing screen and the CA re-tap count',async()=>{
  const {failureReport}=await import('../scripts/android-auth-failure.mjs');
  const r=failureReport({facts:{caFileRetaps:3},nodes:[cn('[0,0][9,9]',{clickable:'true'}),cn('[1,1][2,2]'),cn('[3,3][4,4]',{clickable:'true'}),cn('[5,5][6,6]')]});
  assert.equal(r.clickables.length,2);assert.deepEqual(r.clickables.map(c=>c.bounds),['[0,0][9,9]','[3,3][4,4]']);assert.equal(r.caFileRetaps,3);
});
// Run 40701820173: the CA certificate tap did not navigate (screen stayed on "Install a certificate").
test('the Settings certificate hop repeats its tap until the next screen shows, bounded by until()',()=>{
  const s=fs.readFileSync(new URL('../scripts/android-browser-auth.mjs',import.meta.url),'utf8');
  assert.match(s,/const hop=\(label,next,nextOptions=\{\}\)=>until\(async\(\)=>\{const n=await ui\(\);if\(answerPin\(n\)\)\{await pause\(1500\);return false;\}if\(namedNode\(n,next,SETTINGS_HOSTS,nextOptions\)\)return true;\s*const control=namedNode\(n,label,SETTINGS_HOSTS\);if\(control\)\{facts\.settingsHopTaps=\(facts\.settingsHopTaps\?\?0\)\+1;tap\(control\);\}return false;\}/);
  assert.match(s,/await findSetting\('Install a certificate'\);await hop\('CA certificate','Install anyway',\{ignoreCase:true\}\);/);
  assert.ok(!/await findSetting\('CA certificate'\)/.test(s),'a single unverified tap is not enough');
  assert.match(s,/await click\('Install anyway',\['com\.android\.settings'\],\{ignoreCase:true\}\)/,'the existing click of the warning button is kept');
});
// Run 40703767548: login form never rendered inside the Custom Tab (tabs visible, zero input fields).
import {chromeConsoleEvidence} from '../scripts/android-auth-ui.mjs';
const CL=[
  '10-28 14:24:20.100  900  900 I chromium: [INFO:CONSOLE(12)] "Uncaught TypeError: x is not a function", source: https://127.0.0.1:8443/js/app.js?code=SECRETCODE (12)',
  '10-28 14:24:21.100  900  900 W cr_X: unrelated chatter',
  '10-28 14:24:22.100  900  900 E cr_Net: Failed to load resource: net::ERR_CERT_AUTHORITY_INVALID https://127.0.0.1:8443/api/x?token=abcdefghijklmnopqrstuvwxyz0123456789',
  '10-28 14:24:23.100  900  900 I ActivityManager: ERROR but not a chromium tag',
  `10-28 14:24:24.100  900  900 E chromium: ERROR token ${'Q'.repeat(40)}`,
];
test('chrome console evidence keeps only chromium error lines, with URLs and tokens removed',()=>{
  const out=chromeConsoleEvidence(CL.join('\n'));
  assert.equal(out.length,3);
  const all=out.join('\n');
  assert.ok(!/https?:\/\//.test(all) && !all.includes('SECRETCODE') && !all.includes('abcdefghijklmnopqrstuvwxyz') && !all.includes('QQQQQQQQQQQQ'),all);
  assert.ok(all.includes('<url>') && all.includes('ERR_CERT_AUTHORITY_INVALID') && all.includes('[redacted]'));
  assert.ok(!all.includes('ActivityManager') && !all.includes('unrelated'));
});
test('chrome console evidence is bounded in count and width, and tolerates empty input',()=>{
  assert.deepEqual(chromeConsoleEvidence(''),[]);assert.deepEqual(chromeConsoleEvidence(undefined),[]);
  const many=Array.from({length:30},(_,i)=>`10-28 14:00:${String(i).padStart(2,'0')}.000 1 1 E chromium: ERROR line ${i} ${'x '.repeat(200)}`).join('\n');
  const out=chromeConsoleEvidence(many);
  assert.equal(out.length,12);assert.ok(out.every(l=>l.length<=160));assert.ok(out[11].includes('line 29'));
});
test('the harness reads Chrome console only for the login-form wait and reports it',async()=>{
  const s=fs.readFileSync(new URL('../scripts/android-browser-auth.mjs',import.meta.url),'utf8');
  assert.match(s,/if\(facts\.lastWait==='custom-tabs-login'\)\{try\{const l=spawnSync\('adb',\['logcat','-d','-b','main','-t','6000'\]/);
  const {failureReport}=await import('../scripts/android-auth-failure.mjs');
  assert.deepEqual(failureReport({facts:{chromeConsole:['a','b']}}).chromeConsole,['a','b']);
});
// Run 40706223029: Settings showed "Re-enter your PIN" while the harness was still looking for a menu entry.
import {MAX_PIN_ENTRIES,findPinField} from '../scripts/android-auth-ui.mjs';
test('a PIN prompt at any Settings hop is answered, bounded, and counted',async()=>{
  const s=fs.readFileSync(new URL('../scripts/android-browser-auth.mjs',import.meta.url),'utf8');
  assert.equal(MAX_PIN_ENTRIES,3);
  assert.match(s,/const answerPin=\(nodes\)=>\{const field=findPinField\(nodes\);if\(!field\)return false;\s*facts\.pinEntries=\(facts\.pinEntries\?\?0\)\+1;assert\.ok\(facts\.pinEntries<=MAX_PIN_ENTRIES,'PIN_PROMPT_REPEATED'\);\s*tap\(field\);shell\('input','text',pin\);shell\('input','keyevent','66'\);return true;\};/);
  assert.match(s,/async function findSetting\(label\)\{for\(let i=0;i<7;i\+\+\)\{const nodes=await ui\(\);if\(answerPin\(nodes\)\)\{await pause\(1500\);i--;continue;\}/);
  assert.match(s,/const n=await ui\(\);if\(answerPin\(n\)\)\{await pause\(1500\);return false;\}if\(namedNode\(n,next,SETTINGS_HOSTS,nextOptions\)\)return true;/);
  const {failureReport}=await import('../scripts/android-auth-failure.mjs');
  assert.equal(failureReport({facts:{pinEntries:2}}).pinEntries,2);
  // the screen of the failing run: a single enabled EditText hosted by Settings
  const field={class:'android.widget.EditText',package:'com.android.settings',enabled:'true',bounds:'[267,1004][813,1144]'};
  assert.equal(findPinField([field]),field);
  assert.equal(findPinField([{...field,package:'com.evil'}]),null);
});

// Run 40708169639: caFileRetaps was 21 and the picker never accepted the file from the Recent grid.
test('after two ineffective file taps the CA picker is steered to the Downloads root once, and the failure report keeps node state',async()=>{
  const s=fs.readFileSync(new URL('../scripts/android-browser-auth.mjs',import.meta.url),'utf8');
  assert.match(s,/const downloads=namedNode\(now,'Downloads',documents\);\s*if\(file && \(facts\.caFileRetaps\?\?0\)===2 && !facts\.caDownloadsTaps && downloads\)\{facts\.caDownloadsTaps=1;tap\(downloads\);return false;\}/);
  const {failureReport}=await import('../scripts/android-auth-failure.mjs');
  const r=failureReport({facts:{caDownloadsTaps:1},nodes:[{class:'a.B',package:'docs',clickable:'true',selected:'true',focused:'true',bounds:'[0,0][1,1]'},{class:'a.C',package:'docs',clickable:'true',bounds:'[2,2][3,3]'}]});
  assert.equal(r.caDownloadsTaps,1);
  assert.deepEqual(r.clickables.map(c=>c.state),[['selected','focused'],[]]);
});
// Run 40710505946: the password field was reported with inverted bounds behind the keyboard -> EMPTY_NATIVE_CONTROL.
import {tappable,MAX_TAB_PRESSES} from '../scripts/android-auth-ui.mjs';
test('inverted, empty or malformed bounds are not tappable; real bounds are',()=>{
  assert.equal(tappable({bounds:'[94,1235][987,1340]'}),true);
  assert.equal(tappable({bounds:'[94,1437][987,1394]'}),false,'the exact bounds the failing run reported');
  assert.equal(tappable({bounds:'[10,20][10,80]'}),false);
  assert.equal(tappable({bounds:'[10,20][110,20]'}),false);
  assert.equal(tappable({bounds:'bad'}),false);assert.equal(tappable(undefined),false);
});
test('a field hidden behind the keyboard gets at most two Tab presses and must still report focus',async()=>{
  const s=fs.readFileSync(new URL('../scripts/android-browser-auth.mjs',import.meta.url),'utf8');
  assert.equal(MAX_TAB_PRESSES,2);
  assert.match(s,/if\(isFocused\(f\[which\]\)\)return true;\s*if\(tappable\(f\[which\]\)\)tap\(f\[which\]\);else if\(tabs<MAX_TAB_PRESSES\)\{tabs\+\+;facts\.loginTabPresses=\(facts\.loginTabPresses\?\?0\)\+1;shell\('input','keyevent','61'\);\}return false;\},which\+'-field-focus'\)/);
  assert.ok(!/tap\(loginFields\(await ui\(\),\[chrome\]\)\[which\]\)/.test(s),'an unconditional tap on possibly hidden bounds is not enough');
  const {failureReport}=await import('../scripts/android-auth-failure.mjs');
  assert.equal(failureReport({facts:{loginTabPresses:2}}).loginTabPresses,2);
});
test('case 3 switches through the product control and never drives Chrome data or the web session directly',async()=>{
  const s=fs.readFileSync(new URL('../scripts/android-browser-auth.mjs',import.meta.url),'utf8');
  assert.match(s,/await click\('Switch account'\);const second=await signIn\(b,first\.pid,\{fromPrevious:true\}\);/);
  assert.match(s,/async function chooseAnotherAccount\(\)\{[\s\S]*?namedNode\(n,'Use a different account',\[chrome\]\)[\s\S]*?await click\('Use a different account',\[chrome\]\);\}/);
  assert.match(s,/async function signIn\(u,previousPid,\{fromPrevious=false\}=\{\}\)\{if\(fromPrevious\)await chooseAnotherAccount\(\);await browserReady\(\);/);
  assert.ok(!/pm['"],\s*['"]clear|clear-data|clearBrowserData/i.test(s),'the harness must not clear Chrome data');
});
