'use strict';
process.env.NODE_ENV='test';

type Fake = ReturnType<typeof fakeRedis>;
function fakeRedis() {
  const store=new Map<string,string>();
  const ttls=new Map<string,number>();
  return {
    store,ttls,
    connect: jest.fn(async()=>undefined), quit: jest.fn(async()=>undefined), destroy: jest.fn(), on: jest.fn(),
    set: jest.fn(async(k:string,v:string,o:{NX?:boolean;EX?:number})=>{
      if(o.NX && store.has(k)) return null;
      store.set(k,v); if(o.EX) ttls.set(k,o.EX); return 'OK';
    }),
    setEx: jest.fn(async(k:string,s:number,v:string)=>{store.set(k,v);ttls.set(k,s);return 'OK';}),
    get: jest.fn(async(k:string)=>store.get(k)??null),
    del: jest.fn(async(k:string)=>store.delete(k)?1:0),
    expire: jest.fn(async(k:string,s:number)=>{ if(!store.has(k)) return 0; ttls.set(k,s); return 1; }),
    // Models the registry's atomic scripts (claim / re-assert / release) with
    // the same decision table the Lua implements; real-Redis semantics are
    // proven in tests/pg-integration/redis-sfu-ownership.pgtest.ts.
    eval: jest.fn(async(script:string,opts:{keys:string[];arguments:string[]})=>{
      const key=opts.keys[0]!;
      const a=opts.arguments;
      if(script.includes("redis.call('TIME')")){
        const now=Date.now();
        if(!store.has(opts.keys[1]!)) store.set(opts.keys[1]!,String(now));
        const epoch=Number(store.get(opts.keys[1]!));
        store.set(opts.keys[2]!,a[4]!);                                  // own node lease
        const owner=store.get(key);
        const claim=script.includes("'takeover'");
        if(owner===a[0]){ttls.set(key,Number(a[1]));return claim?['owned',a[0]]:1;}
        if(owner===undefined){
          if(claim && now-epoch<Number(a[2])) return ['settling',''];
          store.set(key,a[0]!);ttls.set(key,Number(a[1]));return claim?['owned',a[0]]:1;
        }
        if(!claim) return 0;
        if(store.has(`${a[3]}${owner}`)) return ['remote',owner];
        store.set(key,a[0]!);ttls.set(key,Number(a[1]));return ['takeover',owner];
      }
      if(store.get(key)!==a[0]) return 0;
      if(script.includes("redis.call('DEL'")) return store.delete(key)?1:0;
      return 0;
    }),
    keys: jest.fn(async(pattern:string)=>{const p=pattern.replace(/\*$/,'');return [...store.keys()].filter(k=>k.startsWith(p));}),
    ttl: jest.fn(async(k:string)=>ttls.get(k)??-1),
  };
}

async function load(opts:{redis?:Fake|null; redisUrl?:boolean; instance?:string; createThrows?:Error; connectReject?:Error; commandTimeoutMs?:number}={}) {
  jest.resetModules();
  process.env.INSTANCE_ID=opts.instance ?? 'node-test';
  if(opts.commandTimeoutMs !== undefined) process.env.REDIS_COMMAND_TIMEOUT_MS=String(opts.commandTimeoutMs);
  else delete process.env.REDIS_COMMAND_TIMEOUT_MS;
  if(opts.redisUrl===false) delete process.env.REDIS_URL; else process.env.REDIS_URL='redis://review';
  const r=opts.redis ?? fakeRedis();
  if(opts.connectReject) r.connect.mockRejectedValueOnce(opts.connectReject);
  jest.doMock('../lib/_optional-require',()=>({tryRequire: jest.fn(()=> {
    if(opts.createThrows) return {createClient:()=>{throw opts.createThrows;}};
    if(opts.redis===null) return null;
    return {createClient:()=>r};
  })}));
  const mod=await import('../lib/sfuRegistry');
  return {mod,r};
}

const K=(id:string)=>`bridge:sfu:room:${id}`;

describe('sfuRegistry ownership state machine',()=>{
  afterEach(async()=>{ delete process.env.REDIS_URL; delete process.env.INSTANCE_ID; delete process.env.REDIS_COMMAND_TIMEOUT_MS; jest.restoreAllMocks(); });

  it('single-node mode owns everything and returns empty cluster lists/stats',async()=>{
    const {mod}=await load({redisUrl:false});
    expect(await mod.claimRoom('c')).toEqual({owned:true,owner:'node-test'});
    expect(await mod.getRoomOwner('c')).toBe('node-test');
    expect(await mod.isLocalRoom('c')).toBe(true);
    await expect(mod.releaseRoom('c')).resolves.toBeUndefined();
    await expect(mod.refreshRoom('c')).resolves.toBe(true);
    expect(await mod.listLocalRooms()).toEqual([]);
    expect(await mod.listAllRooms()).toEqual([]);
    expect(await mod.getStats()).toEqual({mode:'single-node',instanceId:'node-test',totalRooms:0,localRooms:0,rooms:[]});
  });

  it('missing optional redis module fails closed when REDIS_URL declares cluster coordination',async()=>{
    const {mod}=await load({redis:null});
    await expect(mod.claimRoom('c')).rejects.toThrow(/redis package unavailable/i);
  });

  it('redis create/connect errors fail closed and do not cache a dead client',async()=>{
    let x=await load({createThrows:new Error('create down')});
    await expect(x.mod.getRoomOwner('c')).rejects.toThrow('create down');
    await x.mod._closeForTest();
    x=await load({connectReject:new Error('connect down')});
    await expect(x.mod.getRoomOwner('c')).rejects.toThrow('connect down');
    // A failed connect is not left in the module singleton; the next lookup
    // retries connect rather than returning the disconnected candidate.
    await expect(x.mod.getRoomOwner('c')).resolves.toBeNull();
    expect(x.r.connect).toHaveBeenCalledTimes(2);
  });

  it('black-holed ownership command is bounded, destroys the stale client and retries from a fresh connection',async()=>{
    const {mod,r}=await load({commandTimeoutMs:100});
    r.get.mockImplementationOnce(()=>new Promise<string|null>(()=>undefined));

    await expect(mod.getRoomOwner('hung')).rejects.toThrow(/command timeout/i);
    expect(r.destroy).toHaveBeenCalledTimes(1);

    // Timeout clears the cached private authority. The next ownership read
    // must reconnect instead of reusing the command queue that just hung.
    await expect(mod.getRoomOwner('after-timeout')).resolves.toBeNull();
    expect(r.connect).toHaveBeenCalledTimes(2);
  });

  const settledEpoch=(r:Fake)=>r.store.set('bridge:sfu:registry-epoch',String(Date.now()-10*60_000));
  const alive=(r:Fake,node:string)=>r.store.set(`bridge:sfu:node:${node}`,'nonce');

  it('atomic claim wins once, renews own lease, and reports a LIVE remote owner',async()=>{
    const {mod,r}=await load();
    settledEpoch(r);
    expect(await mod.claimRoom('a')).toEqual({owned:true,owner:'node-test'});
    expect(r.store.get(K('a'))).toBe('node-test');
    expect(r.ttls.get(K('a'))).toBe(3600);
    // One atomic script decides; ownership is never inferred from a separate read.
    expect(r.set).not.toHaveBeenCalled();
    expect(r.get).not.toHaveBeenCalled();

    // second claim observes our own ownership and renews
    r.ttls.set(K('a'),5);
    expect(await mod.claimRoom('a')).toEqual({owned:true,owner:'node-test'});
    expect(r.ttls.get(K('a'))).toBe(3600);
    // claiming keeps this node's liveness lease
    expect(r.store.has('bridge:sfu:node:node-test')).toBe(true);

    r.store.set(K('b'),'node-other'); alive(r,'node-other');
    expect(await mod.claimRoom('b')).toEqual({owned:false,owner:'node-other'});
    expect(r.store.get(K('b'))).toBe('node-other');
    expect(await mod.isLocalRoom('b')).toBe(false);
    expect(await mod.isLocalRoom('unknown')).toBe(true);
  });

  // P1 multi-node SFU-05: a SIGKILLed owner stranded its room for ~1 hour.
  it('takes over a room whose owner node lease has expired (dead owner)',async()=>{
    const {mod,r}=await load();
    settledEpoch(r);
    r.store.set(K('orphan'),'node-dead');           // no bridge:sfu:node:node-dead
    expect(await mod.claimRoom('orphan')).toEqual({owned:true,owner:'node-test'});
    expect(r.store.get(K('orphan'))).toBe('node-test');
  });

  // P1 multi-node SFU-08: Redis restarted empty while a room was live; another
  // node opened a second router for the same channel.
  it('refuses a brand-new claim while a freshly (re)created registry settles',async()=>{
    const {mod,r}=await load();
    // no epoch: registry just (re)created
    await expect(mod.claimRoom('fresh')).rejects.toBeInstanceOf(mod.SfuRegistrySettlingError);
    expect(r.store.has(K('fresh'))).toBe(false);
    // the live owner re-asserts its room during the window (heartbeat)
    await expect(mod.refreshRoom('fresh')).resolves.toBe(true);
    expect(r.store.get(K('fresh'))).toBe('node-test');
  });

  it('release and refresh act only for the canonical local owner',async()=>{
    const {mod,r}=await load();
    r.store.set(K('local'),'node-test'); r.store.set(K('remote'),'node-other');
    r.ttls.set(K('local'),5);
    await expect(mod.refreshRoom('local')).resolves.toBe(true);
    expect(r.ttls.get(K('local'))).toBe(3600);
    await expect(mod.refreshRoom('remote')).resolves.toBe(false);
    expect(r.store.get(K('remote'))).toBe('node-other');
    await mod.releaseRoom('remote'); expect(r.store.get(K('remote'))).toBe('node-other');
    await mod.releaseRoom('local'); expect(r.store.has(K('local'))).toBe(false);
  });

  it('release/refresh cannot delete or extend ownership re-acquired by another node',async()=>{
    const {mod,r}=await load();
    r.store.set(K('race'),'node-other'); r.ttls.set(K('race'),17);
    await mod.releaseRoom('race');
    await expect(mod.refreshRoom('race')).resolves.toBe(false);
    expect(r.store.get(K('race'))).toBe('node-other');
    expect(r.ttls.get(K('race'))).toBe(17);
  });

  it('concurrent first lookups share one Redis connection attempt',async()=>{
    const {mod,r}=await load();
    let release!:()=>void;
    // Ikizin donus tipi `Promise<undefined>`; `Promise<void>` ona uymuyordu.
    r.connect.mockImplementationOnce(()=>new Promise<undefined>(resolve=>{release=()=>resolve(undefined);}));
    const a=mod.getRoomOwner('a'); const b=mod.getRoomOwner('b');
    await Promise.resolve(); release();
    await expect(Promise.all([a,b])).resolves.toEqual([null,null]);
    expect(r.connect).toHaveBeenCalledTimes(1);
  });

  it('lists local/all rooms, skips disappeared entries, and returns TTL-backed stats',async()=>{
    const {mod,r}=await load();
    r.store.set(K('a'),'node-test'); r.ttls.set(K('a'),111);
    r.store.set(K('b'),'node-other'); r.ttls.set(K('b'),222);
    // Simulate a key disappearing between KEYS and GET for listAllRooms.
    r.keys.mockResolvedValueOnce([K('a'),K('b')]);
    expect(await mod.listLocalRooms()).toEqual(['a']);
    expect(await mod.listAllRooms()).toEqual([
      {channelId:'a',nodeId:'node-test'}, {channelId:'b',nodeId:'node-other'},
    ]);
    const stats=await mod.getStats();
    expect(stats).toMatchObject({mode:'cluster',instanceId:'node-test',totalRooms:2,localRooms:1});
    expect(stats.rooms).toEqual(expect.arrayContaining([
      {channelId:'a',nodeId:'node-test',ttlSeconds:111},
      {channelId:'b',nodeId:'node-other',ttlSeconds:222},
    ]));
  });

  it('_closeForTest closes an opened Redis client and tolerates an already-failed quit',async()=>{
    let x=await load();
    await x.mod.getRoomOwner('c');
    await x.mod._closeForTest();
    expect(x.r.quit).toHaveBeenCalledTimes(1);

    x=await load();
    x.r.quit.mockRejectedValueOnce(new Error('already closed'));
    await x.mod.getRoomOwner('c');
    await expect(x.mod._closeForTest()).resolves.toBeUndefined();
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
