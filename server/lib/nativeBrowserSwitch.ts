import crypto from 'crypto';
import { cache } from './redisAdapter';
import { isValidCodeChallenge, isValidState } from './nativeAuth';
import { parseTokenVersion } from './tokenVersion';

export const NATIVE_SWITCH_PATH = '/native-auth/switch';
export const NATIVE_SWITCH_COOKIE = '__Secure-bridge_native_switch';
export const NATIVE_SWITCH_TTL_SECONDS = 300;
const REDIS_CONFIGURED = Boolean(process.env.REDIS_URL);
const ID = /^[a-f0-9]{32}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const locks = new Map<string, Promise<void>>();
export type NativeSwitchPhase = 'login' | 'factor' | 'authenticated';
export type NativeSwitch = {
  id: string; cookieHash: string; csrf: string; createdAt: number;
  redirectUri: string; challenge: string; state: string; phase: NativeSwitchPhase;
  userId?: string; tokenVersion?: number; factorChallenge?: string;
};
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const key = (id: string) => `native-switch:${id}`;
export const nativeSwitchCookiePath = (id: string) => `${NATIVE_SWITCH_PATH}/${id}`;
function decode(raw: unknown): NativeSwitch | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as NativeSwitch;
  if (!ID.test(r.id) || !/^[a-f0-9]{64}$/.test(r.cookieHash) || !SECRET.test(r.csrf)
      || !isValidState(r.state) || !isValidCodeChallenge(r.challenge) || typeof r.redirectUri !== 'string'
      || !Number.isSafeInteger(r.createdAt) || r.createdAt > Date.now()+5000
      || Date.now()-r.createdAt >= NATIVE_SWITCH_TTL_SECONDS*1000
      || !['login','factor','authenticated'].includes(r.phase)) return null;
  if (r.phase !== 'login') {
    if (typeof r.userId !== 'string' || !r.userId || r.userId.length > 256) return null;
    try { parseTokenVersion(r.tokenVersion); } catch { return null; }
  }
  if (r.phase === 'factor' && !SECRET.test(r.factorChallenge ?? '')) return null;
  return r;
}
export async function createNativeSwitch(input: { redirectUri: string; challenge: string; state: string }) {
  if (!isValidCodeChallenge(input.challenge) || !isValidState(input.state)) throw Error('INVALID_NATIVE_SWITCH');
  const nonce = crypto.randomBytes(32).toString('base64url');
  const flow: NativeSwitch = { ...input, id: crypto.randomBytes(16).toString('hex'), cookieHash: hash(nonce),
    csrf: crypto.randomBytes(32).toString('base64url'), createdAt: Date.now(), phase: 'login' };
  await cache.setAuthoritative(key(flow.id), flow, NATIVE_SWITCH_TTL_SECONDS);
  return { flow, nonce };
}
export async function readNativeSwitch(id: string, nonce: unknown): Promise<NativeSwitch | null> {
  if (!ID.test(id) || typeof nonce !== 'string' || !SECRET.test(nonce)) return null;
  const flow = decode(await cache.getAuthoritative(key(id)));
  return flow && flow.id === id && crypto.timingSafeEqual(Buffer.from(flow.cookieHash),Buffer.from(hash(nonce))) ? flow : null;
}
/** Compare AND consume atomically; a losing/late request cannot erase a newer phase. */
export async function takeNativeSwitch(id: string, nonce: unknown, csrf: unknown, phase: NativeSwitchPhase): Promise<NativeSwitch | null> {
  if (!ID.test(id) || typeof nonce !== 'string' || !SECRET.test(nonce) || typeof csrf !== 'string' || !SECRET.test(csrf)) return null;
  const script = `local v=redis.call('GET',KEYS[1]); if not v then return nil end
local r=cjson.decode(v)
if r.phase~=ARGV[1] or r.cookieHash~=ARGV[2] or r.csrf~=ARGV[3] then return nil end
redis.call('DEL',KEYS[1]); return v`;
  const raw = await cache.luaEvalAuthoritative(script,[key(id)],[phase,hash(nonce),csrf]);
  if (typeof raw === 'string') return decode(JSON.parse(raw));
  if (REDIS_CONFIGURED) return null;
  const previous=locks.get(id) ?? Promise.resolve(); let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}); const tail=previous.then(()=>gate);locks.set(id,tail);
  await previous;
  try {
    const flow=await readNativeSwitch(id,nonce);
    if (!flow || flow.phase!==phase || flow.csrf!==csrf) return null;
    await cache.delAuthoritative(key(id));return flow;
  } finally { release();if(locks.get(id)===tail)locks.delete(id); }
}
export async function saveNativeSwitch(flow: NativeSwitch): Promise<void> {
  if (!decode(flow)) throw Error('NATIVE_SWITCH_EXPIRED');
  const ttl=Math.ceil((flow.createdAt+NATIVE_SWITCH_TTL_SECONDS*1000-Date.now())/1000);
  await cache.setAuthoritative(key(flow.id),flow,ttl);
}
