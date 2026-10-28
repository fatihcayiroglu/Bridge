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
  assert.match(s,/isFocused\(loginFields\(await ui\(\),\[chrome\]\)\[which\]\)/);
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
