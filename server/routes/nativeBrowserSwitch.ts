import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { Users } from '../db/repositories';
import captcha from '../lib/captcha';
import { limits } from '../middleware/rateLimit';
import { passwordLoginHandlers } from './auth';
import { twoFactorLoginHandlers } from './twoFactor';
import type { AuthenticationDestination, VerifiedLoginUser } from '../lib/authenticationDestination';
import { loadNativeAuthConfig, isValidCodeChallenge, isValidState, issueAuthorizationCode } from '../lib/nativeAuth';
import { parseTokenVersion } from '../lib/tokenVersion';
import { NATIVE_SWITCH_COOKIE, NATIVE_SWITCH_TTL_SECONDS, nativeSwitchCookiePath,
  createNativeSwitch, readNativeSwitch, takeNativeSwitch, saveNativeSwitch } from '../lib/nativeBrowserSwitch';
import type { NativeSwitch, NativeSwitchPhase } from '../lib/nativeBrowserSwitch';

const escape = (s: string) => s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
type Context = { flow: NativeSwitch; nonce: string; csrf: string };
export function createNativeBrowserSwitchRouter(config = loadNativeAuthConfig(), baseUrl = process.env.BASE_URL) {
  const router=express.Router();const contexts=new WeakMap<Request,Context>();
  let origin: string|null=null;try {const u=new URL(baseUrl??'');if(u.protocol==='https:')origin=u.origin;}catch{}
  const fail=(res:Response,status=410)=>res.status(status).type('text/plain').send('Native sign-in could not continue. Start again from the app.');
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');res.setHeader('Pragma','no-cache');
    res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');next();});
  if(!config.enabled || !origin){router.use((_req,res)=>{fail(res,503);});return router;}
  const enabled=config;
  const wrapped=(fn:(req:Request,res:Response,next:NextFunction)=>Promise<unknown>):express.RequestHandler =>
    (req,res,next)=>{void fn(req,res,next).catch(()=>{if(!res.headersSent)fail(res,503);});};
  function page(res:Response,flow:NativeSwitch,body:string,withCaptcha=false){
    const nonce=crypto.randomBytes(16).toString('base64');const cfg=captcha.getPublicConfig();
    let widget='',sources="'none'",frames="'none'",connect="'none'";
    if(withCaptcha && cfg.enabled){
      const h=cfg.provider==='hcaptcha',valid=h||cfg.provider==='turnstile';
      if(!valid || !cfg.sitekey)return fail(res,503);
      const src=h?'https://js.hcaptcha.com/1/api.js':'https://challenges.cloudflare.com/turnstile/v0/api.js';
      sources=h?'https://js.hcaptcha.com':'https://challenges.cloudflare.com';
      frames=h?'https://*.hcaptcha.com':'https://challenges.cloudflare.com';connect=frames;
      widget=`<div class="${h?'h-captcha':'cf-turnstile'}" data-sitekey="${escape(cfg.sitekey)}"></div><script src="${src}" async defer></script>`;
    }
    res.setHeader('Content-Security-Policy',`default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self' ${enabled.formActionSources.join(' ')}; style-src 'nonce-${nonce}'; script-src ${sources}; frame-src ${frames}; connect-src ${connect}`);
    const csrf=`<input type="hidden" name="flow_csrf" value="${flow.csrf}">`;
    return res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bridge account switch</title><style nonce="${nonce}">body{font:18px system-ui;background:#101622;color:#f4f6ff;margin:0;padding:24px}main{max-width:420px;margin:24px auto}input,button{box-sizing:border-box;display:block;width:100%;min-height:48px;margin:12px 0;padding:12px;font:inherit}button{background:#4655c2;color:white;border:0;border-radius:8px}label{display:block;margin-top:20px}a{color:#cbd2ff}</style></head><body><main><h1>Switch Bridge account</h1><p>This signs in to the app. Your existing browser account stays unchanged.</p>${body.replaceAll('{{csrf}}',csrf).replace('{{captcha}}',widget)}</main></body></html>`);
  }
  function loginPage(res:Response,flow:NativeSwitch){return page(res,flow,`<form action="${nativeSwitchCookiePath(flow.id)}/login" method="post">{{csrf}}<label for="l-username">Username</label><input id="l-username" name="username" autocomplete="username" maxlength="32" required><label for="l-password">Password</label><input id="l-password" name="password" type="password" autocomplete="current-password" maxlength="128" required>{{captcha}}<button type="submit">Sign In</button></form><p>Passwordless sign-in methods are not available in this native-switch candidate. No authentication policy is bypassed.</p>`,true);}
  const load=wrapped(async(req,res,next)=>{
    const id=String(req.params.id??''),nonce=(req.cookies as Record<string,unknown>|undefined)?.[NATIVE_SWITCH_COOKIE];
    const flow=await readNativeSwitch(id,nonce);if(!flow || typeof nonce!=='string'||!enabled.redirectUris.has(flow.redirectUri))return fail(res);
    contexts.set(req,{flow,nonce,csrf:typeof req.body?.flow_csrf==='string'?req.body.flow_csrf:''});next();
  });
  const post=wrapped(async(req,res,next)=>{
    const c=contexts.get(req);if(!c)return fail(res);
    if(req.get('origin')!==origin || (req.get('sec-fetch-site')!==undefined && req.get('sec-fetch-site')!=='same-origin') || c.csrf!==c.flow.csrf)return fail(res,403);
    next();
  });
  async function claim(req:Request,phase:NativeSwitchPhase){const c=contexts.get(req);return c?takeNativeSwitch(c.flow.id,c.nonce,c.csrf,phase):null;}
  const destination=(expected:NativeSwitchPhase):AuthenticationDestination=>({
    async factorPending(req,res,user,challenge){
      const flow=await claim(req,'login');if(!flow)return fail(res);
      flow.phase='factor';flow.userId=user._id;flow.tokenVersion=parseTokenVersion(user.tokenVersion);flow.factorChallenge=challenge;
      await saveNativeSwitch(flow);return res.redirect(303,`${nativeSwitchCookiePath(flow.id)}/factor`);
    },
    async authenticated(req,res,user:VerifiedLoginUser){
      const flow=await claim(req,expected);if(!flow)return fail(res);
      if(expected==='factor' && (flow.userId!==user._id || flow.tokenVersion!==parseTokenVersion(user.tokenVersion)))return fail(res);
      flow.phase='authenticated';flow.userId=user._id;flow.tokenVersion=parseTokenVersion(user.tokenVersion);delete flow.factorChallenge;
      await saveNativeSwitch(flow);return res.redirect(303,`${nativeSwitchCookiePath(flow.id)}/consent`);
    },
  });
  router.get('/',limits.refresh(),wrapped(async(req,res)=>{
    const q=req.query;if(typeof q.redirect_uri!=='string'||!enabled.redirectUris.has(q.redirect_uri)||q.code_challenge_method!=='S256'||!isValidCodeChallenge(q.code_challenge)||!isValidState(q.state))return fail(res,400);
    const {flow,nonce}=await createNativeSwitch({redirectUri:q.redirect_uri,challenge:q.code_challenge,state:q.state});
    res.cookie(NATIVE_SWITCH_COOKIE,nonce,{secure:true,httpOnly:true,sameSite:'strict',path:nativeSwitchCookiePath(flow.id),maxAge:NATIVE_SWITCH_TTL_SECONDS*1000});
    return loginPage(res,flow);
  }));
  router.get('/:id/login',load,wrapped(async(req,res)=>{const f=contexts.get(req)!.flow;return f.phase==='login'?loginPage(res,f):fail(res);}));
  router.use(express.urlencoded({extended:false,limit:'8kb'}));
  router.post('/:id/login',load,post,...passwordLoginHandlers(destination('login')));
  router.get('/:id/factor',load,wrapped(async(req,res)=>{const f=contexts.get(req)!.flow;if(f.phase!=='factor')return fail(res);
    return page(res,f,`<form action="${nativeSwitchCookiePath(f.id)}/factor" method="post">{{csrf}}<label for="code">Authenticator or backup code</label><input id="code" name="code" autocomplete="one-time-code" maxlength="128" required><button type="submit">Verify</button></form>`);
  }));
  router.post('/:id/factor',load,post,(req,res,next)=>{const f=contexts.get(req)!.flow;if(f.phase!=='factor'||!f.factorChallenge){fail(res);return;}
    req.body={tempToken:f.factorChallenge,code:req.body?.code};next();},...twoFactorLoginHandlers(destination('factor')));
  router.get('/:id/consent',load,wrapped(async(req,res)=>{const f=contexts.get(req)!.flow;if(f.phase!=='authenticated')return fail(res);
    const u=await Users.findById(f.userId!);if(!u||parseTokenVersion(u.tokenVersion)!==f.tokenVersion)return fail(res,401);
    return page(res,f,`<h2>Sign in to the Bridge app?</h2><p>The app will be signed in as <strong>${escape(u.displayName||u.username)}</strong>.</p><form action="${nativeSwitchCookiePath(f.id)}/authorize" method="post">{{csrf}}<button type="submit">Continue in the app</button></form><form action="${nativeSwitchCookiePath(f.id)}/cancel" method="post">{{csrf}}<button type="submit">Cancel</button></form>`);
  }));
  router.post('/:id/authorize',load,post,limits.refresh(),wrapped(async(req,res)=>{const f=await claim(req,'authenticated');if(!f)return fail(res);
    const u=await Users.findById(f.userId!);if(!u||parseTokenVersion(u.tokenVersion)!==f.tokenVersion)return fail(res,401);
    const code=await issueAuthorizationCode({userId:u._id,tokenVersion:f.tokenVersion!,challenge:f.challenge,redirectUri:f.redirectUri});
    res.clearCookie(NATIVE_SWITCH_COOKIE,{secure:true,httpOnly:true,sameSite:'strict',path:nativeSwitchCookiePath(f.id)});
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Location',`${f.redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(f.state)}`);return res.status(303).end();
  }));
  router.post('/:id/cancel',load,post,wrapped(async(req,res)=>{const c=contexts.get(req)!;const f=await claim(req,c.flow.phase);if(!f)return fail(res);
    res.clearCookie(NATIVE_SWITCH_COOKIE,{secure:true,httpOnly:true,sameSite:'strict',path:nativeSwitchCookiePath(f.id)});
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Location',`${f.redirectUri}?error=access_denied&state=${encodeURIComponent(f.state)}`);return res.status(303).end();
  }));
  router.use((_req,res)=>{fail(res,404);});
  router.use((_error:unknown,_req:Request,res:Response,_next:NextFunction)=>{if(!res.headersSent)fail(res,503);});
  return router;
}
