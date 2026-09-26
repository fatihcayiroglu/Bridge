'use strict';
process.env.NODE_ENV='test';

let packageAvailable=true;
let adapterAvailable=true;
let adapterThrows=false;
let connectReject=false;
let subConnectReject=false;
let deferConnect=false;
let connectResolvers:Array<()=>void>=[];
let pub:any;
let sub:any;
let createAdapterMock=jest.fn();

function makeClient(name:string){
  const events:Record<string,Function[]>={};
  const kv=new Map<string,string>(); const hashes=new Map<string,Record<string,string>>();
  let counter=0;
  const c:any={
    name,events,kv,hashes,
    connect:jest.fn(async()=>{
      if(connectReject || (name==='sub' && subConnectReject)) throw new Error('connect down');
      if(deferConnect) await new Promise<void>(resolve=>connectResolvers.push(resolve));
    }),
    quit:jest.fn().mockResolvedValue(undefined),
    duplicate:jest.fn(),
    ping:jest.fn().mockResolvedValue('PONG'),
    info:jest.fn().mockResolvedValue('used_memory_human:12.3M\r\n'),
    publish:jest.fn().mockResolvedValue(1),
    subscribe:jest.fn().mockResolvedValue(undefined), unsubscribe:jest.fn().mockResolvedValue(undefined),
    get:jest.fn(async(k:string)=>kv.get(k)??null),
    set:jest.fn(async(k:string,v:string,o?:any)=>{ if(o?.NX && kv.has(k)) return null; kv.set(k,v); return 'OK'; }),
    del:jest.fn(async(k:string|string[])=>{ const ks=Array.isArray(k)?k:[k]; let n=0; for(const x of ks) if(kv.delete(x)) n++; return n; }),
    keys:jest.fn(async(pattern:string)=>{ const prefix=pattern.replace(/\*$/,''); return [...kv.keys()].filter(k=>k.startsWith(prefix)); }),
    scan:jest.fn(async(cursor:number,opts?:{MATCH?:string;COUNT?:number})=>{ const prefix=(opts?.MATCH||'').replace(/\*$/,''); const keys=[...kv.keys()].filter(k=>k.startsWith(prefix)); return {cursor:0,keys}; }),
    mGet:jest.fn(async(keys:string[])=>keys.map(k=>kv.get(k)??null)),
    multi:jest.fn(()=>{
      const ops:any[]=[];
      const pipeline:any={};
      pipeline.set=jest.fn((k:string,v:string,o?:any)=>{ops.push([k,v,o]); return pipeline;});
      pipeline.exec=jest.fn(async()=>{for(const [k,v] of ops) kv.set(k,v); return ops.map(()=> 'OK');});
      return pipeline;
    }),
    incr:jest.fn(async(k:string)=>{ const n=Number(kv.get(k)||0)+1; kv.set(k,String(n)); return n; }),
    decr:jest.fn(async(k:string)=>{ const n=Number(kv.get(k)||0)-1; kv.set(k,String(n)); return n; }),
    expire:jest.fn().mockResolvedValue(1),
    hSet:jest.fn(async(k:string,f:string,v:string)=>{const h=hashes.get(k)||{}; h[f]=v; hashes.set(k,h); return 1;}),
    hGet:jest.fn(async(k:string,f:string)=>hashes.get(k)?.[f]??null),
    hGetAll:jest.fn(async(k:string)=>hashes.get(k)||{}),
    hDel:jest.fn(async(k:string,f:string)=>{const h=hashes.get(k); if(h&&f in h){delete h[f];return 1;} return 0;}),
    eval:jest.fn(async(script:string,opts:{keys:string[];arguments:string[]})=>{
      const key=opts.keys[0];
      if(script.includes('local interval = tonumber(ARGV[2])')){
        const now=Number(opts.arguments[0]); const interval=Number(opts.arguments[1]);
        const raw=kv.get(key); const last=raw===undefined?null:Number(JSON.parse(raw));
        if(last!==null && Number.isFinite(last) && last<=now && now-last<interval) return interval-(now-last);
        kv.set(key,String(now)); return 0;
      }
      if(script.includes("redis.call('ZADD'")){
        const countKey=`__zcount:${key}`; const n=Number(kv.get(countKey)||0)+1; kv.set(countKey,String(n)); return n;
      }
      if(script.includes("redis.call('INCR'")){
        const n=Number(kv.get(key)||0)+1; kv.set(key,String(n)); return n;
      }
      if(script.includes("redis.call('GET', KEYS[1]) == ARGV[1]")){
        if(kv.get(key)===opts.arguments[0]){
          if(script.includes("redis.call('EXPIRE'")) return 1;
          kv.delete(key); return 1;
        } return 0;
      }
      if(script.includes("local v = redis.call('GET'")){ const value=kv.get(key)??null; if(value!==null)kv.delete(key); return value; }
      return ['lua-ok'];
    }),
    on:jest.fn((ev:string,fn:Function)=>{(events[ev] ||= []).push(fn); return c;}),
    emitEvent:(ev:string,...a:any[])=>{for(const fn of events[ev]||[]) fn(...a);},
  };
  return c;
}

function resetFakes(){
  packageAvailable=true; adapterAvailable=true; adapterThrows=false; connectReject=false; subConnectReject=false; deferConnect=false; connectResolvers=[];
  sub=makeClient('sub'); pub=makeClient('pub'); pub.duplicate.mockReturnValue(sub);
  createAdapterMock=jest.fn((p,s)=>{ if(adapterThrows) throw new Error('adapter boom'); return {p,s}; });
}
resetFakes();

jest.mock('../lib/_optional-require',()=>({
  tryRequire:(id:string)=>{
    if(id==='redis') return packageAvailable ? { createClient:jest.fn(()=>pub) } : null;
    if(id==='@socket.io/redis-adapter') return adapterAvailable ? { createAdapter:(...a:any[])=>createAdapterMock(...a) } : null;
    return null;
  },
}));
jest.mock('../lib/logger',()=>({__esModule:true,default:{info:jest.fn(),warn:jest.fn(),error:jest.fn(),debug:jest.fn()}}));

function load(){ process.env.REDIS_URL='redis://user:secret@localhost:6379'; jest.resetModules(); return require('../lib/redisAdapter') as typeof import('../lib/redisAdapter'); }

afterEach(async()=>{
  delete process.env.REDIS_URL;
  delete process.env.REDIS_COMMAND_TIMEOUT_MS;
  delete process.env.REDIS_RECOVERY_PROBE_MS;
});

describe('redisAdapter connected protocol paths',()=>{
  beforeEach(()=>resetFakes());

  it('connects once, wires Socket.IO adapter, and idempotently reuses it',async()=>{
    const r=load(); const io={adapter:jest.fn()};
    await expect(r.applyAdapter(io)).resolves.toBe(true);
    expect(pub.connect).toHaveBeenCalledTimes(1); expect(sub.connect).toHaveBeenCalledTimes(1); expect(createAdapterMock).toHaveBeenCalledWith(pub,sub); expect(io.adapter).toHaveBeenCalledTimes(1);
    await expect(r.applyAdapter(io)).resolves.toBe(true); expect(io.adapter).toHaveBeenCalledTimes(1); expect(r.redisClient()).toBe(pub); expect(r.isRedisAvailable()).toBe(true);
    pub.emitEvent('end'); expect(r.isRedisAvailable()).toBe(false); pub.emitEvent('ready'); expect(r.isRedisAvailable()).toBe(true);
    await r.disconnect();
  });

  it('connected cache executes get/set/NX/delete/pattern/mget/mset/counters/hash/Lua branches',async()=>{
    const r=load(); await r.applyAdapter({adapter:jest.fn()}); const c:any=r.cache;
    await c.set('a',{x:1},30); await c.set('persist',2,0); expect(await c.get('a')).toEqual({x:1}); expect(await c.get('missing')).toBeNull();
    expect(await c.setIfAbsent('nx',1,10)).toBe(true); expect(await c.setIfAbsent('nx',2,10)).toBe(false); expect(await c.setIfAbsent('nx0',1,0)).toBe(true);
    await c.mset([['m1',{a:1}],['m2',2]],20); expect([...((await c.mget(['m1','m2','missing'])) as Map<any,any>).entries()]).toEqual([['m1',{a:1}],['m2',2]]); expect((await c.mget([])).size).toBe(0); await c.mset([],20);
    await c.mset([['m-persistent',3]],0);
    const persistentPipeline=pub.multi.mock.results.at(-1).value;
    expect(persistentPipeline.set).toHaveBeenCalledWith('bridge:cache:m-persistent','3');
    await c.set('pref:1',1); await c.set('pref:2',2); await c.invalidatePattern('pref:'); expect(await c.get('pref:1')).toBeNull(); // IMLEC DIZGE OLMALIDIR. @redis/client 6 `cursor` icin string|Buffer
    // ister; sayi verilince komut kodlanirken firlatir ve gecersiz kilma
    // SESSIZCE basarisiz olur (cagiran hatayi yutar). Bu mock sayiyi
    // memnuniyetle kabul ettigi icin eski iddia KUSURU SABITLEMISTI;
    // gercek Redis'e kosan tests/pg-integration/redis-cache-invalidation
    // bunu ortaya cikardi.
    expect(pub.scan).toHaveBeenCalledWith('0',{MATCH:'bridge:cache:pref:*',COUNT:100}); expect(pub.keys).not.toHaveBeenCalled();
    expect(await c.increment('count',10)).toBe(1); expect(pub.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('INCR'"),{keys:['bridge:cache:count'],arguments:['10']}); expect(await c.increment('count',10)).toBe(2); expect(await c.decrement('count')).toBe(1);
    expect(await c.slidingWindowCount('sock:u1',10000,1000)).toBe(1); expect(await c.slidingWindowCount('sock:u1',10000,1001)).toBe(2);
    await c.hset('h','a',{v:1}); expect(await c.hget('h','a')).toEqual({v:1}); expect(await c.hget('h','x')).toBeNull(); expect(await c.hgetAll('h')).toEqual({a:{v:1}}); await c.hdel('h','a');
    expect(await c.luaEval('return 1',['k'],['a'])).toEqual(['lua-ok']); await c.delete('persist');
    await r.disconnect();
  });

  it('configured Redis rate limiter fails closed when shared quota authority is unavailable',async()=>{
    const r=load(); await r.applyAdapter({adapter:jest.fn()});
    const increment=jest.spyOn(r.cache,'increment').mockRejectedValueOnce(new Error('redis unavailable'));
    const limiter=r.redisRateLimiter({windowMs:20000,max:2,keyPrefix:'secure'});
    const headers:any={}; const json=jest.fn(); const status=jest.fn(()=>({json})); const next=jest.fn();
    await limiter({user:{id:'u1'}},{setHeader:(k:string,v:any)=>headers[k]=v,status} as any,next);
    expect(increment).toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({error:'Rate limit authority unavailable'});
    expect(headers['Retry-After']).toBeGreaterThan(0);
    await r.disconnect();
  });

  it('authoritative security primitives use Redis and never consult process-local fallback',async()=>{
    const r=load(); await r.applyAdapter({adapter:jest.fn()}); const c:any=r.cache;
    await c.setAuthoritative('sec:state',{userId:'u1'},30);
    await expect(c.getAuthoritative('sec:state')).resolves.toEqual({userId:'u1'});
    await expect(c.setIfAbsentAuthoritative('sec:nx',1,30)).resolves.toBe(true);
    await expect(c.setIfAbsentAuthoritative('sec:nx',2,30)).resolves.toBe(false);
    pub.kv.set('bridge:cache:sec:take',JSON.stringify({challenge:'c1'}));
    await expect(c.takeAuthoritative('sec:take')).resolves.toEqual({challenge:'c1'});
    await expect(c.takeAuthoritative('sec:take')).resolves.toBeNull();
    await c.setAuthoritative('sec:delete',1,30);
    await expect(c.delAuthoritative('sec:delete')).resolves.toBeUndefined();
    await expect(c.getAuthoritative('sec:delete')).resolves.toBeNull();
    await expect(c.luaEvalAuthoritative('return 1',['sec:lua'],['a'])).resolves.toEqual(['lua-ok']);
    expect(pub.eval).toHaveBeenCalledWith('return 1',{keys:['bridge:cache:sec:lua'],arguments:['a']});

    await expect(r.redisAuthoritativeCommand('owned command', async client => {
      expect(client).toBe(pub);
      return 'authoritative-result';
    })).resolves.toBe('authoritative-result');

    await r.disconnect();
    await expect(r.redisAuthoritativeCommand('after shutdown', async () => true))
      .rejects.toThrow(/authoritative command unavailable/i);
  });

  it('configured Redis outage makes authoritative security primitives fail closed',async()=>{
    packageAvailable=false; const r=load(); await expect(r.applyAdapter({adapter:jest.fn()})).resolves.toBe(false); const c:any=r.cache;
    await expect(c.getAuthoritative('oauth:state')).rejects.toThrow(/authoritative cache unavailable/);
    await expect(c.setAuthoritative('webauthn:challenge','c',60)).rejects.toThrow(/authoritative cache unavailable/);
    await expect(c.setIfAbsentAuthoritative('federation:replay',1,60)).rejects.toThrow(/authoritative cache unavailable/);
    await expect(c.takeAuthoritative('oauth:state')).rejects.toThrow(/authoritative cache unavailable/);
    await expect(c.delAuthoritative('oauth:state')).rejects.toThrow(/authoritative cache unavailable/);
    await expect(c.delAuthoritative('voice:room:c1')).rejects.toThrow(/authoritative cache unavailable/);
    await expect(c.luaEvalAuthoritative('return 1',['chess:game:c1'],[])).rejects.toThrow(/authoritative cache unavailable/);
  });

  it('bounds authoritative Lua during a silent Redis black-hole and degrades shared authority',async()=>{
    process.env.REDIS_COMMAND_TIMEOUT_MS='100';
    process.env.REDIS_RECOVERY_PROBE_MS='1000';
    const r=load(); await r.applyAdapter({adapter:jest.fn()}); const c:any=r.cache;
    pub.eval.mockImplementationOnce(()=>new Promise(()=>undefined));
    const started=Date.now();
    await expect(c.luaEvalAuthoritative('return 1',['ws-limit:black-hole'],[])).rejects.toThrow(/command timeout/i);
    expect(Date.now()-started).toBeLessThan(1000);
    expect(r.isRedisAvailable()).toBe(false);
    await r.disconnect();
  });

  it('bounds a silent Redis black-hole and prevents a queued lock callback from running later',async()=>{
    process.env.REDIS_COMMAND_TIMEOUT_MS='100';
    process.env.REDIS_RECOVERY_PROBE_MS='1000';
    const r=load(); await r.applyAdapter({adapter:jest.fn()}); const c:any=r.cache;
    pub.get.mockImplementationOnce(()=>new Promise(()=>undefined));
    const started=Date.now();
    await expect(c.getAuthoritative('oauth:black-hole')).rejects.toThrow(/command timeout/i);
    expect(Date.now()-started).toBeLessThan(1000);
    expect(r.isRedisAvailable()).toBe(false);

    const callback=jest.fn().mockResolvedValue(1);
    await expect(c.withKeyLock('voice-room:black-hole',callback)).rejects.toThrow(/coordination unavailable/);
    expect(callback).not.toHaveBeenCalled();
    await expect(r.healthCheck()).resolves.toMatchObject({redis:false});
    await r.disconnect();

  });

  it('remember uses distributed lock, refetches after lock contention, and falls back when lock command fails',async()=>{
    const r=load(); await r.applyAdapter({adapter:jest.fn()}); const c:any=r.cache;
    const compute=jest.fn().mockResolvedValue({v:1}); expect(await c.remember('r1',30,compute)).toEqual({v:1}); expect(compute).toHaveBeenCalledTimes(1); expect(pub.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('GET', KEYS[1]) == ARGV[1]"),expect.objectContaining({keys:['bridge:lock:r1'],arguments:[expect.any(String)]}));

    // Cache miss, lock held by another worker, value appears during wait.
    const realSet=pub.set.getMockImplementation(); pub.set.mockImplementation(async(k:string,v:string,o?:any)=>{ if(k==='bridge:lock:r2') { pub.kv.set('bridge:cache:r2',JSON.stringify({v:2})); return null; } return realSet!(k,v,o); });
    const never=jest.fn(); expect(await c.remember('r2',30,never)).toEqual({v:2}); expect(never).not.toHaveBeenCalled();

    pub.set.mockImplementation(async(k:string,v:string,o?:any)=>{ if(k==='bridge:lock:r3') throw new Error('lock down'); return realSet!(k,v,o); });
    const fallback=jest.fn().mockResolvedValue('fallback'); expect(await c.remember('r3',30,fallback)).toBe('fallback'); expect(fallback).toHaveBeenCalled();
    await r.disconnect();
  });

  it('remember propagates compute/cache failures without executing business compute twice',async()=>{
    const r=load(); await r.applyAdapter({adapter:jest.fn()}); const c:any=r.cache;
    const failing=jest.fn().mockRejectedValue(new Error('compute failed'));
    await expect(c.remember('compute-fails',30,failing)).rejects.toThrow('compute failed');
    expect(failing).toHaveBeenCalledTimes(1);

    const originalSet=c.set;
    const computed=jest.fn().mockResolvedValue('once');
    c.set=jest.fn().mockRejectedValueOnce(new Error('cache write failed'));
    await expect(c.remember('cache-fails',30,computed)).rejects.toThrow('cache write failed');
    expect(computed).toHaveBeenCalledTimes(1);
    c.set=originalSet;
    await r.disconnect();
  });

  it('remember never deletes a lock that was re-acquired after its lease expired',async()=>{
    const r=load(); await r.applyAdapter({adapter:jest.fn()}); const c:any=r.cache;
    const compute=jest.fn(async()=>{ pub.kv.set('bridge:lock:owned','new-worker'); return 'value'; });
    await expect(c.remember('owned',1,compute)).resolves.toBe('value');
    expect(pub.kv.get('bridge:lock:owned')).toBe('new-worker');
    await r.disconnect();
  });

  it('withKeyLock uses an owner-token Redis lease and releases only its own lock',async()=>{
    const r=load(); await r.applyAdapter({adapter:jest.fn()}); const c:any=r.cache;
    const result=await c.withKeyLock('voice-room:c1',async()=>{ expect(pub.kv.get('bridge:lock:mutation:voice-room:c1')).toEqual(expect.any(String)); return 42; });
    expect(result).toBe(42);
    expect(pub.kv.has('bridge:lock:mutation:voice-room:c1')).toBe(false);
    expect(pub.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('GET', KEYS[1]) == ARGV[1]"),expect.objectContaining({keys:['bridge:lock:mutation:voice-room:c1'],arguments:[expect.any(String)]}));
    await r.disconnect();
  });

  it('increment uses atomic Lua TTL ownership and rejects invalid TTLs',async()=>{
    const r=load(); await r.applyAdapter({adapter:jest.fn()}); const c:any=r.cache;
    await expect(c.increment('atomic',15)).resolves.toBe(1);
    await expect(c.increment('atomic',15)).resolves.toBe(2);
    await expect(c.increment('bad',0)).rejects.toThrow(/positive safe integer/);
    await expect(c.increment('bad',1.5)).rejects.toThrow(/positive safe integer/);
    await r.disconnect();
  });

  it('claimCooldown is one Redis transaction and preserves the original window on rejection',async()=>{
    const r=load(); await r.applyAdapter({adapter:jest.fn()}); const c:any=r.cache;
    await expect(c.claimCooldown('slow:u:c',10_000,15_000,100_000)).resolves.toBe(0);
    await expect(c.claimCooldown('slow:u:c',10_000,15_000,102_500)).resolves.toBe(7_500);
    await expect(c.claimCooldown('slow:u:c',10_000,15_000,110_000)).resolves.toBe(0);
    expect(pub.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1])"),
      {keys:['bridge:cache:slow:u:c'],arguments:['110000','10000','15000']},
    );
    await expect(c.claimCooldown('bad',0)).rejects.toThrow(/positive safe integer/);
    await expect(c.claimCooldown('bad',10,9)).rejects.toThrow(/>= intervalMs/);
    await r.disconnect();
  });

  it('pub/sub, session revocation, limiter and health use connected Redis client',async()=>{
    const r=load(); await r.applyAdapter({adapter:jest.fn()});
    await r.publishNotification({x:1}); expect(pub.publish).toHaveBeenCalledWith('bridge:notifications',JSON.stringify({x:1}));
    const handler=jest.fn(); const unsub=await r.subscribeToChannel('chan',handler); expect(sub.subscribe).toHaveBeenCalledWith('chan',handler); await unsub!(); expect(sub.unsubscribe).toHaveBeenCalledWith('chan'); await r.publishToChannel('chan','msg'); expect(pub.publish).toHaveBeenCalledWith('chan','msg');
    await r.sessionCache.invalidateToken('jti',60); expect(await r.sessionCache.isRevoked('jti')).toBe(true);
    const limiter=r.redisRateLimiter({windowMs:20000,max:1,keyPrefix:'z'}); const headers:any={}; const res:any={setHeader:(k:string,v:any)=>headers[k]=v,status:jest.fn(()=>({json:jest.fn()}))}; const next=jest.fn(); await limiter({user:{id:'u'}},res,next); await limiter({user:{id:'u'}},res,next); expect(next).toHaveBeenCalledTimes(1); expect(res.status).toHaveBeenCalledWith(429); expect(headers['Retry-After']).toBe(20);
    const hc=await r.healthCheck(); expect(hc).toMatchObject({redis:true,mode:'redis',singleton:true,usedMemory:'12.3M'}); expect(hc.url).not.toContain('secret'); await r.disconnect();
  });

  it('covers connection event degradation, reconnect recovery signals, and safe subscription teardown',async()=>{
    const r=load(); await r.applyAdapter({adapter:jest.fn()});
    const logger=require('../lib/logger').default;
    pub.emitEvent('error',new Error('pub event down'));
    expect(r.isRedisAvailable()).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({event:'redis.pub.error',err:'pub event down'}),expect.any(String));
    pub.emitEvent('ready');
    pub.emitEvent('reconnecting');
    expect(r.isRedisAvailable()).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({event:'redis.reconnecting'}),expect.any(String));
    pub.emitEvent('ready');
    sub.emitEvent('error','sub string error');
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({event:'redis.sub.error',err:'sub string error'}),expect.any(String));

    const unsub=await r.subscribeToChannel('edge',jest.fn());
    sub.unsubscribe.mockRejectedValueOnce(new Error('already closed'));
    await expect(unsub!()).resolves.toBeUndefined();
    await r.disconnect();
  });

  it('validates distributed lock arguments and times out without executing business state',async()=>{
    const r=load(); await r.applyAdapter({adapter:jest.fn()}); const c:any=r.cache;
    const fn=jest.fn().mockResolvedValue(1);
    await expect(c.withKeyLock('',fn)).rejects.toThrow(/non-empty bounded string/);
    await expect(c.withKeyLock('x'.repeat(513),fn)).rejects.toThrow(/non-empty bounded string/);
    await expect(c.withKeyLock('x',null as any)).rejects.toThrow(/fn must be a function/);
    for (const options of [
      {leaseSeconds:0},{leaseSeconds:61},{leaseSeconds:1.5},
      {waitMs:-1},{waitMs:30001},{waitMs:1.5},
      {retryMs:0},{retryMs:1001},{retryMs:1.5},
    ]) await expect(c.withKeyLock('x',fn,options as any)).rejects.toThrow(/invalid lock timing/);

    const realSet=pub.set.getMockImplementation();
    pub.set.mockImplementation(async(k:string,v:string,o?:any)=>k==='bridge:lock:mutation:busy' ? null : realSet!(k,v,o));
    await expect(c.withKeyLock('busy',fn,{waitMs:0,retryMs:1,leaseSeconds:1})).rejects.toThrow(/lock timeout/);
    expect(fn).not.toHaveBeenCalled();
    await r.disconnect();
  });

  it('preserves a successful mutation when best-effort distributed unlock fails',async()=>{
    const r=load(); await r.applyAdapter({adapter:jest.fn()}); const c:any=r.cache;
    const logger=require('../lib/logger').default;
    pub.eval.mockRejectedValueOnce(new Error('unlock transport lost'));
    await expect(c.withKeyLock('release-failure',async()=>42)).resolves.toBe(42);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({event:'redis.mutation_lock_release_failed',key:'release-failure'}),expect.any(String));
    await r.disconnect();
  });

  it('rejects corrupt Redis numeric results instead of weakening counters or cooldowns',async()=>{
    const r=load(); await r.applyAdapter({adapter:jest.fn()}); const c:any=r.cache;
    pub.eval.mockResolvedValueOnce(0);
    await expect(c.increment('corrupt-counter',5)).rejects.toThrow(/invalid counter/);
    pub.eval.mockResolvedValueOnce(10_001);
    await expect(c.claimCooldown('corrupt-cooldown',10_000,15_000,100_000)).rejects.toThrow(/invalid remaining interval/);
    pub.eval.mockResolvedValueOnce(0);
    await expect(c.slidingWindowCount('corrupt-window',10_000,100_000)).rejects.toThrow(/invalid count/);
    await expect(c.slidingWindowCount('bad-window',0,100_000)).rejects.toThrow(/positive safe/);
    await expect(c.slidingWindowCount('bad-now',10_000,-1)).rejects.toThrow(/positive safe/);
    await expect(c.claimCooldown('bad-now',10_000,15_000,-1)).rejects.toThrow(/non-negative safe integer/);
    await r.disconnect();
  });

  it('configured authority loss rejects counter/cooldown/window operations instead of silently splitting quota state',async()=>{
    const r=load(); await r.applyAdapter({adapter:jest.fn()}); const c:any=r.cache;
    pub.emitEvent('end');
    await expect(c.increment('quota',60)).rejects.toThrow(/counter authority unavailable/);
    await expect(c.decrement('quota')).rejects.toThrow(/counter authority unavailable/);
    await expect(c.claimCooldown('quota',1000,6000,1000)).rejects.toThrow(/cooldown authority unavailable/);
    await expect(c.slidingWindowCount('quota',1000,1000)).rejects.toThrow(/sliding-window authority unavailable/);
    await expect(c.withKeyLock('quota',async()=>1)).rejects.toThrow(/coordination unavailable/);
    await r.disconnect();
  });

  it('handles Redis health info without a used-memory field',async()=>{
    const r=load(); await r.applyAdapter({adapter:jest.fn()});
    pub.info.mockResolvedValueOnce('redis_version:7.2.0\\r\\n');
    await expect(r.healthCheck()).resolves.toMatchObject({redis:true,usedMemory:'unknown'});
    await r.disconnect();
  });

  it('health failure returns error and disconnect logs quit failures but resets singleton',async()=>{
    const r=load(); await r.applyAdapter({adapter:jest.fn()}); pub.ping.mockRejectedValueOnce(new Error('ping down')); expect(await r.healthCheck()).toMatchObject({redis:false,error:'ping down'});
    pub.quit.mockRejectedValueOnce(new Error('pub quit')); sub.quit.mockRejectedValueOnce(new Error('sub quit')); await expect(r.disconnect()).resolves.toBeUndefined(); expect(r.redisClient()).toBeNull(); expect(r.isRedisAvailable()).toBe(false);
  });
});

describe('redisAdapter connection/adapter failure branches',()=>{
  beforeEach(()=>resetFakes());
  it('missing redis package falls back cleanly',async()=>{ packageAvailable=false; const r=load(); await expect(r.applyAdapter({adapter:jest.fn()})).resolves.toBe(false); expect(r.isRedisAvailable()).toBe(false); });
  it('configured Redis outage never degrades a distributed mutation lock to process-local state',async()=>{ packageAvailable=false; const r=load(); await expect(r.applyAdapter({adapter:jest.fn()})).resolves.toBe(false); await expect(r.cache.withKeyLock('stage-room:c1',async()=>1)).rejects.toThrow(/coordination unavailable/); });
  it('connect rejection resets clients and permits later fallback',async()=>{ connectReject=true; const r=load(); await expect(r.applyAdapter({adapter:jest.fn()})).resolves.toBe(false); expect(r.redisClient()).toBeNull(); });
  it('a partial pub/sub connection failure closes every client created for the failed attempt',async()=>{
    subConnectReject=true;
    const r=load();
    await expect(r.applyAdapter({adapter:jest.fn()})).resolves.toBe(false);
    expect(pub.quit).toHaveBeenCalledTimes(1);
    expect(sub.quit).toHaveBeenCalledTimes(1);
    expect(r.redisClient()).toBeNull();
    expect(r.isRedisAvailable()).toBe(false);
  });
  it('concurrent disconnect prevents an in-flight connection from resurrecting stale Redis state',async()=>{
    deferConnect=true;
    const r=load();
    const io={adapter:jest.fn()};
    const applying=r.applyAdapter(io);
    while(connectResolvers.length<2) await new Promise(resolve=>setImmediate(resolve));
    await r.disconnect();
    for(const resolve of connectResolvers) resolve();
    await expect(applying).resolves.toBe(false);
    expect(r.redisClient()).toBeNull();
    expect(r.isRedisAvailable()).toBe(false);
    expect(io.adapter).not.toHaveBeenCalled();
  });
  it('missing adapter package keeps Redis connected but returns false',async()=>{ adapterAvailable=false; const r=load(); await expect(r.applyAdapter({adapter:jest.fn()})).resolves.toBe(false); expect(r.isRedisAvailable()).toBe(true); await r.disconnect(); });
  it('adapter creation error is contained',async()=>{ adapterThrows=true; const r=load(); await expect(r.applyAdapter({adapter:jest.fn()})).resolves.toBe(false); expect(r.isRedisAvailable()).toBe(true); await r.disconnect(); });
  it('io without adapter function still establishes Redis and marks setup idempotent',async()=>{ const r=load(); await expect(r.applyAdapter({})).resolves.toBe(true); await expect(r.applyAdapter({})).resolves.toBe(true); await r.disconnect(); });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
