import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserSignIn} from '../src/browser-sign-in.mjs';
import {createBrowserSessionSignIn} from '../src/browser-session.mjs';
const origin='https://bridge.example',redirect='com.bridge.nativepilot:/oauth';
const attempt={state:'s'.repeat(22),challenge:'h'.repeat(43),verifier:'v'.repeat(43)};
const answer=()=>({type:'success',url:redirect+'?code='+'c'.repeat(43)+'&state='+attempt.state});
test('intentional account switch chooses the isolated server entry with the same strict PKCE contract',async()=>{
  for(const fresh of [false,true]){let opened;const b=createBrowserSignIn({origin,redirectUri:redirect,createPkce:async()=>attempt,
    openAuthSession:async url=>{opened=new URL(url);return answer();}});
    const result=await b.start({freshAuthentication:fresh});
    assert.equal(opened.pathname,fresh?'/native-auth/switch':'/native-auth');
    assert.equal(opened.searchParams.get('code_challenge_method'),'S256');assert.equal(opened.searchParams.has('prompt'),false);
    assert.equal(result.verifier===attempt.verifier,true);}
});
test('fresh intent is captured before asynchronous PKCE work and cannot be downgraded by mutating caller options',async()=>{
  let complete,opened;const options={freshAuthentication:true};const b=createBrowserSignIn({origin,redirectUri:redirect,
    createPkce:()=>new Promise(r=>{complete=r;}),openAuthSession:async url=>{opened=new URL(url);return answer();}});
  const pending=b.start(options);options.freshAuthentication=false;complete(attempt);await pending;
  assert.equal(opened.pathname,'/native-auth/switch');
});
test('isolated entry still rejects wrong state and malformed mode before trusting a callback',async()=>{
  const b=createBrowserSignIn({origin,redirectUri:redirect,createPkce:async()=>attempt,
    openAuthSession:async()=>({...answer(),url:answer().url.replace(attempt.state,'z'.repeat(22))})});
  await assert.rejects(b.start({freshAuthentication:true}),e=>e.code==='STATE_MISMATCH');
  await assert.rejects(b.start({freshAuthentication:'true'}),e=>e.code==='INVALID_ADAPTER');
});
test('session orchestration forwards fresh intent without bypassing its ownership fence',async()=>{
  let forwarded;const state={epoch:1,phase:'anonymous'};
  const signIn=createBrowserSessionSignIn({coordinator:{getState:()=>state,signIn:async()=>({epoch:2,phase:'authenticated'})},
    browser:{start:async options=>{forwarded=options;return{};}},authApi:{exchangeCode:async()=>({}),revoke:async()=>{}}});
  await signIn({freshAuthentication:true});assert.equal(forwarded.freshAuthentication,true);
});
