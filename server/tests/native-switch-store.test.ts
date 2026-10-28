// Authoritative-cache interface contracts, not a real Redis test.
import { cache } from '../lib/redisAdapter';
import { createNativeSwitch, takeNativeSwitch } from '../lib/nativeBrowserSwitch';
afterEach(()=>jest.restoreAllMocks());
test('a successful atomic Lua consume is returned without a second fallback read',async()=>{
  const {flow,nonce}=await createNativeSwitch({redirectUri:'com.bridge.nativepilot:/oauth',challenge:'c'.repeat(43),state:'s'.repeat(22)});
  jest.spyOn(cache,'luaEvalAuthoritative').mockResolvedValueOnce(JSON.stringify(flow));
  const fallback=jest.spyOn(cache,'getAuthoritative').mockRejectedValue(Error('must not reread consumed state'));
  const claimed=await takeNativeSwitch(flow.id,nonce,flow.csrf,'login');
  expect(claimed?.id===flow.id).toBe(true);expect(fallback).not.toHaveBeenCalled();
});
test('malformed or expired authoritative values cannot become a valid native transaction',async()=>{
  const {flow,nonce}=await createNativeSwitch({redirectUri:'com.bridge.nativepilot:/oauth',challenge:'c'.repeat(43),state:'s'.repeat(22)});
  jest.spyOn(cache,'luaEvalAuthoritative').mockResolvedValueOnce(JSON.stringify({...flow,createdAt:Date.now()-301000}));
  expect(await takeNativeSwitch(flow.id,nonce,flow.csrf,'login')).toBeNull();
});
