// HTTP/security contracts using the actual login, factor and PKCE handlers.
// In-memory repository category; NOT PostgreSQL, browser or mobile acceptance.
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import db from '../db/loader';
import { cache } from '../lib/redisAdapter';
import { loadNativeAuthConfig } from '../lib/nativeAuth';
import { createNativeBrowserSwitchRouter } from '../routes/nativeBrowserSwitch';
import { createNativeAuthRouters } from '../routes/nativeAuth';
import { router as authRouter } from '../routes/auth';
import { NATIVE_SWITCH_PATH, NATIVE_SWITCH_COOKIE, readNativeSwitch } from '../lib/nativeBrowserSwitch';
import twoFactor from '../routes/twoFactor';

jest.mock('../lib/captcha',()=>({__esModule:true,default:{
  botFilterMiddleware:()=> (_q:express.Request,_s:express.Response,n:express.NextFunction)=>n(),
  loginLockMiddleware:(_q:express.Request,_s:express.Response,n:express.NextFunction)=>n(),
  progressiveCaptchaMiddleware:(_q:express.Request,s:express.Response,n:express.NextFunction)=>process.env.SWITCH_TEST_CAPTCHA==='required'?s.status(400).json({requireCaptcha:true}):n(),
  registrationThrottleMiddleware:(_q:express.Request,_s:express.Response,n:express.NextFunction)=>n(),
  captchaMiddleware:(_q:express.Request,_s:express.Response,n:express.NextFunction)=>n(),
  recordFailedLogin:jest.fn().mockResolvedValue(undefined),recordSuccessfulLogin:jest.fn().mockResolvedValue(undefined),
  checkSuspiciousLogin:jest.fn().mockResolvedValue(undefined),claimRegistrationSlot:jest.fn().mockResolvedValue(true),
  _getIp:()=> '127.0.0.1',GENERIC_LOGIN_ERROR:'Invalid credentials',getPublicConfig:()=>({enabled:false,provider:'none',sitekey:''}),
}}));
jest.mock('../middleware/rateLimit',()=>({rateLimit:()=> (_q:express.Request,_s:express.Response,n:express.NextFunction)=>n(),
  limits:new Proxy({},{get:()=>()=> (_q:express.Request,_s:express.Response,n:express.NextFunction)=>n()})}));
jest.mock('../lib/sessionRevocation',()=>({disconnectLiveUserSessions:jest.fn().mockResolvedValue(0)}));

const ORIGIN='https://bridge.example',REDIRECT='com.bridge.nativepilot:/oauth',PASSWORD='Contract-password-123';
const config=loadNativeAuthConfig({BASE_URL:ORIGIN,NATIVE_AUTH_REDIRECT_URIS:REDIRECT});
function appWith(cfg=config,origin=ORIGIN){const a=express();a.use(express.json());a.use(cookieParser());a.use('/api',authRouter);
  a.use(NATIVE_SWITCH_PATH,createNativeBrowserSwitchRouter(cfg,origin));a.use('/api/native-auth',createNativeAuthRouters(cfg).token);return a;}
const app=appWith();
beforeEach(()=>{(db as typeof db & {_reset?:()=>void})._reset?.();delete process.env.SWITCH_TEST_CAPTCHA;delete process.env.REQUIRE_EMAIL_VERIFICATION;});
afterEach(()=>jest.restoreAllMocks());
const lines=(r:request.Response)=>{const h=r.headers['set-cookie'];return Array.isArray(h)?h:h?[h]:[];};
const webCookie=(r:request.Response)=>lines(r).find(s=>s.startsWith('bridge_refresh='))!.split(';')[0]!;
async function user(tag:string){const name='sw_'+tag;const r=await request(app).post('/api/register').send({username:name,password:PASSWORD});expect(r.status).toBe(200);
  return {name,id:String(r.body.user._id??r.body.user.id),cookie:webCookie(r)};}
async function begin(target=app){const verifier=crypto.randomBytes(32).toString('base64url'),state=crypto.randomBytes(16).toString('base64url');
  const r=await request(target).get(NATIVE_SWITCH_PATH).query({redirect_uri:REDIRECT,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',state});
  expect(r.status).toBe(200);const cookie=lines(r)[0]!.split(';')[0]!,nonce=cookie.slice(cookie.indexOf('=')+1);
  const base=/action="([^"?]+)\/login"/.exec(r.text)![1]!,id=base.split('/').at(-1)!;
  const csrf=/name="flow_csrf" value="([A-Za-z0-9_-]+)"/.exec(r.text)![1]!;
  return {r,base,id,cookie,nonce,csrf,verifier,state};}
type Flow=Awaited<ReturnType<typeof begin>>;
function post(f:Flow,suffix:string,body:Record<string,unknown>={},override:Record<string,string>={}){return request(app).post(f.base+suffix).type('form').set({Origin:ORIGIN,'Sec-Fetch-Site':'same-origin',Cookie:f.cookie,...override}).send({flow_csrf:f.csrf,...body});}
const login=(f:Flow,u:Awaited<ReturnType<typeof user>>)=>post(f,'/login',{username:u.name,password:PASSWORD});
const authorize=(f:Flow)=>post(f,'/authorize');
const exchange=(f:Flow,location:string)=>request(app).post('/api/native-auth/token').send({grant_type:'authorization_code',code:new URL(location).searchParams.get('code'),code_verifier:f.verifier,redirect_uri:REDIRECT});

test('new flow has only a secure HttpOnly narrow-path cookie and no ordinary web session',async()=>{
  const f=await begin();expect(lines(f.r).length).toBe(1);const c=lines(f.r)[0]!;
  for(const attr of ['HttpOnly','Secure','SameSite=Strict',`Path=${f.base}`])expect(c.includes(attr)).toBe(true);
  expect(c.startsWith(NATIVE_SWITCH_COOKIE+'=')).toBe(true);expect(f.r.headers['cache-control']).toBe('no-store');
  expect(f.r.headers['referrer-policy']).toBe('same-origin');expect(f.r.text.includes('bridge_refresh')).toBe(false);
});
test('fresh B authentication produces only native credentials; browser A remains usable',async()=>{
  const a=await user('a'),b=await user('b'),f=await begin();
  const signed=await login(f,b);expect(signed.status).toBe(303);expect(lines(signed).length).toBe(0);
  expect(signed.body.token===undefined && signed.body.refresh_token===undefined).toBe(true);
  const consent=await request(app).get(f.base+'/consent').set('Cookie',f.cookie);expect(consent.status).toBe(200);
  expect(consent.text.includes(b.name)).toBe(true);expect(consent.text.includes(a.name)).toBe(false);
  const issued=await authorize(f);expect(issued.status).toBe(303);expect(issued.text).toBe('');expect(issued.headers['referrer-policy']).toBe('no-referrer');
  const native=await exchange(f,issued.headers.location);expect(native.status).toBe(200);expect(String(native.body.user._id??native.body.user.id)===b.id).toBe(true);
  const restored=await request(app).post('/api/refresh').set('Cookie',a.cookie);expect(restored.status).toBe(200);
  const me=await request(app).get('/api/me').set('Authorization','Bearer '+restored.body.token);expect(me.status).toBe(200);
  expect(String(me.body._id??me.body.id)===a.id).toBe(true);
});
test('an existing web cookie cannot complete fresh consent or expose a factor challenge',async()=>{
  const a=await user('existing'),f=await begin();
  expect((await authorize(f)).status).toBe(410);
  expect((await request(app).post(f.base+'/authorize').type('form').set({Origin:ORIGIN,Cookie:a.cookie}).send({flow_csrf:f.csrf})).status).toBe(410);
  expect((await request(app).get(f.base+'/consent').set('Cookie',f.cookie)).status).toBe(410);
});
test.each(['missing','wrong','cross-origin','cross-site'])('CSRF/origin binding fails closed: %s',async mode=>{
  const b=await user('csrf'),f=await begin();const headers:Record<string,string>={};
  if(mode==='cross-origin')headers.Origin='https://untrusted.example';if(mode==='cross-site')headers['Sec-Fetch-Site']='cross-site';
  const r=await post(f,'/login',{username:b.name,password:PASSWORD,...(mode==='missing'?{flow_csrf:undefined}:mode==='wrong'?{flow_csrf:'x'.repeat(43)}:{})},headers);
  expect(r.status).toBe(403);expect(lines(r).length).toBe(0);
});
test('wrong credentials, email policy and CAPTCHA never become a native authenticated transaction',async()=>{
  const b=await user('policies'),f=await begin();expect((await post(f,'/login',{username:b.name,password:'wrong'})).status).toBe(401);
  process.env.REQUIRE_EMAIL_VERIFICATION='true';expect((await login(f,b)).status).toBe(403);delete process.env.REQUIRE_EMAIL_VERIFICATION;
  process.env.SWITCH_TEST_CAPTCHA='required';expect((await login(f,b)).status).toBe(400);
  expect((await authorize(f)).status).toBe(410);
});
test('MFA is required, its challenge stays server-side, and the real one-use factor verifier completes it',async()=>{
  const b=await user('factor');const secret='JBSWY3DPEHPK3PXP';await db.users.update({_id:b.id},{$set:{twoFactorEnabled:true,twoFactorSecret:secret}});
  const f=await begin();const pending=await login(f,b);expect(pending.status).toBe(303);expect(pending.headers.location.endsWith('/factor')).toBe(true);
  expect(lines(pending).length).toBe(0);expect(pending.body.tempToken===undefined && pending.body.token===undefined).toBe(true);
  expect((await authorize(f)).status).toBe(410);
  const page=await request(app).get(f.base+'/factor').set('Cookie',f.cookie);expect(page.status).toBe(200);
  const stored=await readNativeSwitch(f.id,f.nonce);expect(page.text.includes(stored!.factorChallenge!)).toBe(false);
  const code=(twoFactor as unknown as {__totpNowForTest:(s:string)=>string[]}).__totpNowForTest(secret)[1]!;
  const ready=await post(f,'/factor',{code,tempToken:'caller-cannot-replace-the-server-challenge'});expect(ready.status).toBe(303);expect(lines(ready).length).toBe(0);
  expect((await post(f,'/factor',{code})).status).toBe(410);expect((await authorize(f)).status).toBe(303);
});
test('a factor from another account cannot authenticate the selected transaction',async()=>{
  const a=await user('factor_a'),b=await user('factor_b');const sa='JBSWY3DPEHPK3PXP',sb='KRUGS4ZANFZSAYJA';
  for(const [u,s] of [[a,sa],[b,sb]] as const)await db.users.update({_id:u.id},{$set:{twoFactorEnabled:true,twoFactorSecret:s}});
  const f=await begin();await login(f,b);const code=(twoFactor as unknown as {__totpNowForTest:(s:string)=>string[]}).__totpNowForTest(sa)[1]!;
  expect((await post(f,'/factor',{code})).status).toBe(401);expect((await authorize(f)).status).toBe(410);
});
test('duplicate consent submits have one winner; a late login cannot destroy the authenticated phase',async()=>{
  const b=await user('race'),f=await begin();await login(f,b);
  expect((await login(f,b)).status).toBe(410);
  const results=await Promise.all([authorize(f),authorize(f)]);expect(results.map(r=>r.status).sort()).toEqual([303,410]);
  const success=results.find(r=>r.status===303)!;expect((await exchange(f,success.headers.location)).status).toBe(200);
});
test('tokenVersion revocation after fresh login prevents consent and code issuance',async()=>{
  const b=await user('revoked'),f=await begin();await login(f,b);await db.users.update({_id:b.id},{$set:{tokenVersion:1}});
  expect((await request(app).get(f.base+'/consent').set('Cookie',f.cookie)).status).toBe(401);expect((await authorize(f)).status).toBe(401);
});
test('a consent body cannot replace the server-bound redirect, state or PKCE challenge',async()=>{
  const b=await user('bound'),f=await begin();await login(f,b);
  const response=await post(f,'/authorize',{redirect_uri:'com.attacker.app:/oauth',state:'z'.repeat(22),code_challenge:'x'.repeat(43)});
  expect(response.status).toBe(303);expect(response.headers.location.startsWith(REDIRECT+'?')).toBe(true);
  expect(new URL(response.headers.location).searchParams.get('state')===f.state).toBe(true);
  expect((await exchange(f,response.headers.location)).status).toBe(200);
});
test('cancel consumes the transaction without minting a code or ending browser A',async()=>{
  const a=await user('cancel'),f=await begin();const r=await post(f,'/cancel');expect(r.status).toBe(303);expect(r.text).toBe('');
  expect(new URL(r.headers.location).searchParams.has('code')).toBe(false);expect((await login(f,a)).status).toBe(410);
  expect((await request(app).post('/api/refresh').set('Cookie',a.cookie)).status).toBe(200);
});
test('store outage fails closed without returning a code or replacing browser cookies',async()=>{
  const f=await begin();jest.spyOn(cache,'getAuthoritative').mockRejectedValueOnce(Error('unavailable'));
  const r=await request(app).get(f.base+'/login').set('Cookie',f.cookie);expect(r.status).toBe(503);expect(lines(r).length).toBe(0);
});
test('expiry, wrong cookie and malformed redirect cannot become a fresh identity',async()=>{
  const f=await begin();expect((await request(app).get(f.base+'/login').set('Cookie',NATIVE_SWITCH_COOKIE+'='+'x'.repeat(43))).status).toBe(410);
  const now=Date.now();const date=jest.spyOn(Date,'now').mockReturnValue(now+301000);expect((await request(app).get(f.base+'/login').set('Cookie',f.cookie)).status).toBe(410);date.mockRestore();
  expect((await request(app).get(NATIVE_SWITCH_PATH).query({redirect_uri:'https://untrusted.example',code_challenge_method:'S256',state:'s'.repeat(22),code_challenge:'x'.repeat(43)})).status).toBe(400);
});
test('disabled native auth and non-HTTPS configuration never serve the new login surface',async()=>{
  expect((await request(appWith({enabled:false,reason:'not_configured'})).get(NATIVE_SWITCH_PATH)).status).toBe(503);
  expect((await request(appWith(config,'http://bridge.example')).get(NATIVE_SWITCH_PATH)).status).toBe(503);
});
