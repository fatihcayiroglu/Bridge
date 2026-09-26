'use strict';
process.env.NODE_ENV = 'test';

const verifyCsrfToken = jest.fn();
const verifyToken = jest.fn();
const findBot = jest.fn();

jest.mock('../lib/security', () => ({ verifyCsrfToken: (...args: unknown[]) => verifyCsrfToken(...args) }));
jest.mock('../middleware/auth', () => ({ verifyToken: (...args: unknown[]) => verifyToken(...args) }));
jest.mock('../db/loader', () => ({ __esModule: true, default: { bots: { findOne: (...args: unknown[]) => findBot(...args) } } }));

import { csrfMiddleware, enforceApiCsrf } from '../middleware/csrf';

function req(method='POST', opts: { headers?: Record<string,string>; path?: string; user?: {id:string} } = {}) {
  return { method, headers: opts.headers ?? {}, path: opts.path ?? '/protected', user: opts.user } as any;
}
function res() {
  const r: any = {};
  r.status = jest.fn(() => r);
  r.json = jest.fn(() => r);
  return r;
}

async function runCsrf(rq: any) {
  const rs=res(), next=jest.fn();
  await csrfMiddleware(rq,rs,next);
  return {rs,next};
}
async function runGlobal(rq: any) {
  const rs=res(), next=jest.fn();
  await enforceApiCsrf(rq,rs,next);
  return {rs,next};
}

describe('CSRF middleware security branches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    verifyCsrfToken.mockResolvedValue(true);
    verifyToken.mockReturnValue({ id:'u1' });
    findBot.mockResolvedValue(null);
  });

  it.each(['GET','HEAD','OPTIONS'])('allows safe %s without CSRF', async method => {
    const {next,rs}=await runCsrf(req(method));
    expect(next).toHaveBeenCalledTimes(1); expect(rs.status).not.toHaveBeenCalled();
  });

  it('re-checks a previously valid bot token so revocation takes effect immediately', async () => {
    findBot.mockResolvedValueOnce({ _id:'bot1' });
    let out=await runCsrf(req('POST',{headers:{'x-bot-token':'valid-bot'}}));
    expect(out.next).toHaveBeenCalled();
    expect(findBot).toHaveBeenCalledTimes(1);

    findBot.mockResolvedValueOnce(null); // revoked/disabled before next request
    out=await runCsrf(req('POST',{headers:{'x-bot-token':'valid-bot'}}));
    expect(out.rs.status).toHaveBeenCalledWith(403);
    expect(findBot).toHaveBeenCalledTimes(2);
  });

  it('supports x-api-key through the same verified bot-token store', async () => {
    findBot.mockResolvedValueOnce({ _id:'bot2' });
    const {next}=await runCsrf(req('POST',{headers:{'x-api-key':'valid-api-key'}}));
    expect(next).toHaveBeenCalled();
  });

  it('negative-caches an invalid bot token but still requires browser CSRF', async () => {
    let out=await runCsrf(req('POST',{headers:{'x-bot-token':'invalid-bot'}}));
    expect(out.rs.status).toHaveBeenCalledWith(403);
    expect(findBot).toHaveBeenCalledTimes(1);
    findBot.mockClear();
    out=await runCsrf(req('POST',{headers:{'x-bot-token':'invalid-bot'}}));
    expect(out.rs.status).toHaveBeenCalledWith(403);
    expect(findBot).not.toHaveBeenCalled();
  });

  it('fails bot bypass closed on DB error and does not cache transient failure', async () => {
    findBot.mockRejectedValueOnce(new Error('db down'));
    let out=await runCsrf(req('POST',{headers:{'x-bot-token':'db-error-token'}}));
    expect(out.rs.status).toHaveBeenCalledWith(403);
    findBot.mockResolvedValueOnce({ _id:'recovered' });
    out=await runCsrf(req('POST',{headers:{'x-bot-token':'db-error-token'}}));
    expect(out.next).toHaveBeenCalled();
    expect(findBot).toHaveBeenCalledTimes(2);
  });

  it('expires negative bot-token cache after 60 seconds', async () => {
    const now=jest.spyOn(Date,'now');
    now.mockReturnValue(1_000_000);
    await runCsrf(req('POST',{headers:{'x-bot-token':'expiring-invalid'}}));
    expect(findBot).toHaveBeenCalledTimes(1);
    findBot.mockClear();
    now.mockReturnValue(1_059_999);
    await runCsrf(req('POST',{headers:{'x-bot-token':'expiring-invalid'}}));
    expect(findBot).not.toHaveBeenCalled();
    now.mockReturnValue(1_060_001);
    await runCsrf(req('POST',{headers:{'x-bot-token':'expiring-invalid'}}));
    expect(findBot).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });

  it('bounds and LRU-refreshes the negative token cache under a token flood', async () => {
    // Seed one invalid token then fill to capacity. Re-touching the seed should
    // keep it MRU so the overflow evicts an older noise entry instead.
    await runCsrf(req('POST',{headers:{'x-bot-token':'lru-invalid'}}));
    for (let i=0;i<999;i++) await runCsrf(req('POST',{headers:{'x-bot-token':`noise-${i}`}}));
    findBot.mockClear();
    await runCsrf(req('POST',{headers:{'x-bot-token':'lru-invalid'}}));
    expect(findBot).not.toHaveBeenCalled();
    await runCsrf(req('POST',{headers:{'x-bot-token':'noise-overflow'}}));
    findBot.mockClear();
    await runCsrf(req('POST',{headers:{'x-bot-token':'lru-invalid'}}));
    expect(findBot).not.toHaveBeenCalled();
  });

  it('requires token, user identity, and a valid CSRF binding in order', async () => {
    let out=await runCsrf(req('POST',{user:{id:'u1'}}));
    expect(out.rs.status).toHaveBeenCalledWith(403);
    expect(out.rs.json).toHaveBeenCalledWith({error:'CSRF token missing'});

    out=await runCsrf(req('POST',{headers:{'x-csrf-token':'t'}}));
    expect(out.rs.status).toHaveBeenCalledWith(401);

    verifyCsrfToken.mockResolvedValueOnce(false);
    out=await runCsrf(req('POST',{headers:{'x-csrf-token':'t'},user:{id:'u1'}}));
    expect(out.rs.status).toHaveBeenCalledWith(403);

    verifyCsrfToken.mockResolvedValueOnce(true);
    out=await runCsrf(req('POST',{headers:{'x-csrf-token':'t'},user:{id:'u1'}}));
    expect(out.next).toHaveBeenCalled();
    expect(verifyCsrfToken).toHaveBeenLastCalledWith('u1','t');
  });

  it('returns 503 when the authoritative CSRF store is unavailable', async () => {
    verifyCsrfToken.mockRejectedValueOnce(new Error('redis down'));
    const out = await runCsrf(req('POST',{headers:{'x-csrf-token':'t'},user:{id:'u1'}}));
    expect(out.rs.status).toHaveBeenCalledWith(503);
    expect(out.rs.json).toHaveBeenCalledWith({ error:'CSRF security state unavailable' });
    expect(out.next).not.toHaveBeenCalled();
  });

  it.each(['GET','HEAD','OPTIONS'])('global guard allows safe %s', async method => {
    expect((await runGlobal(req(method))).next).toHaveBeenCalled();
  });

  it.each(['/login','/register','/refresh','/captcha-config','/health','/health/live','/health/ready','/e2e'])('global guard exempts %s mutation', async path => {
    expect((await runGlobal(req('POST',{path}))).next).toHaveBeenCalled();
  });

  it('global guard accepts verified bot/API identity before bearer processing', async () => {
    findBot.mockResolvedValueOnce({ _id:'bot-global' });
    const out=await runGlobal(req('POST',{headers:{'x-bot-token':'global-bot'}}));
    expect(out.next).toHaveBeenCalled(); expect(verifyToken).not.toHaveBeenCalled();
  });

  it('global guard ignores invalid bot bypass and falls through to bearer rules', async () => {
    const out=await runGlobal(req('POST',{headers:{'x-bot-token':'global-invalid'}}));
    expect(out.next).toHaveBeenCalled(); // no Bearer => API/browser-agnostic pass-through
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('global guard passes non-bearer and invalid bearer identities without CSRF enforcement', async () => {
    let out=await runGlobal(req('POST',{headers:{authorization:'Basic abc'}}));
    expect(out.next).toHaveBeenCalled();
    verifyToken.mockReturnValueOnce(null);
    out=await runGlobal(req('POST',{headers:{authorization:'Bearer bad'}}));
    expect(out.next).toHaveBeenCalled();
  });

  it('global bearer flow returns 503 on authoritative CSRF-store failure', async () => {
    verifyCsrfToken.mockRejectedValueOnce(new Error('redis down'));
    const out = await runGlobal(req('POST',{headers:{authorization:'Bearer jwt','x-csrf-token':'t'}}));
    expect(out.rs.status).toHaveBeenCalledWith(503);
    expect(out.rs.json).toHaveBeenCalledWith({ error:'CSRF security state unavailable' });
    expect(out.next).not.toHaveBeenCalled();
  });

  it('global bearer flow rejects missing/invalid CSRF and accepts a valid user-bound token', async () => {
    let out=await runGlobal(req('POST',{headers:{authorization:'Bearer jwt'}}));
    expect(out.rs.status).toHaveBeenCalledWith(403);

    verifyCsrfToken.mockResolvedValueOnce(false);
    out=await runGlobal(req('POST',{headers:{authorization:'Bearer jwt','x-csrf-token':'bad'}}));
    expect(out.rs.status).toHaveBeenCalledWith(403);

    verifyCsrfToken.mockResolvedValueOnce(true);
    out=await runGlobal(req('POST',{headers:{authorization:'Bearer jwt','x-csrf-token':'good'}}));
    expect(out.next).toHaveBeenCalled();
    expect(verifyCsrfToken).toHaveBeenLastCalledWith('u1','good');
  });
});
