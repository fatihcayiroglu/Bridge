/** Test the actual Mini Golf handler without substituting server score logic. */
const readCache = new Map<string, unknown>();
let redisUp = true;
const members = jest.fn();
const permissions = jest.fn();
const hasPermission = jest.fn();
jest.mock('../db/repositories', () => ({ Members: { findOne: (...args: unknown[]) => members(...args) } }));
jest.mock('../lib/permissions', () => ({
  PERMS: { VIEW_CHANNELS: 1, CONNECT: 65536 },
  resolvePermissions: (...a: unknown[]) => permissions(...a),
  hasPermission: (...a: unknown[]) => hasPermission(...a),
}));
jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: () => redisUp,
  cache: {
    getAuthoritative: async (key: string) => readCache.get(key) ?? null,
    setAuthoritative: async (key: string, state: unknown) => { readCache.set(key, structuredClone(state)); },
    delAuthoritative: async (key: string) => { readCache.delete(key); },
    withKeyLock: async (_key: string, action: () => Promise<unknown>) => action(),
  },
}));
jest.mock('../lib/logger', () => ({
  __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
import { registerMiniGolfHandlers } from '../socket/handlers/mini-golf';
import { golfMatchStore, resolveGolfShot, emptyGolfMatch, GOLF_MAX_STROKES } from '../socket/handlers/mini-golf-match';

let seq=0;
function socket(userId: string, serverId: string) {
  const id='golf-unit-socket-'+(++seq), rooms=new Set(['server:'+serverId]);
  const emitted: Array<{ name: string; payload: unknown }>=[];
  const listeners=new Map<string,(payload?:unknown)=>Promise<unknown>>();
  const sock={
    id, userId, rooms, emitted, listeners, isBot: false,
    emit(name:string,payload:unknown){emitted.push({name,payload});},
    on(name:string,handler:(payload?:unknown)=>Promise<unknown>){listeners.set(name,handler);},
    to(){return {emit(){}};},
    async trigger(name:string,payload?:unknown){
      const handler=listeners.get(name);
      if(!handler)throw Error('listener missing '+name);
      await handler(payload);
    },
    join(room:string){rooms.add(room);},
    leave(room:string){rooms.delete(room);},
    last(name:string){return emitted.filter(e=>e.name===name).at(-1)?.payload;},
  };
  registerMiniGolfHandlers(sock as never, {to(){return {emit(){}};}} as never, userId);
  return sock;
}
const sid=()=> 'test-golf-'+(++seq);
beforeEach(()=>{
  process.env.BRIDGE_MINI_GOLF_MULTIPLAYER='1';redisUp=true;readCache.clear();
  members.mockReset().mockResolvedValue({ banned:false });
  permissions.mockReset().mockResolvedValue(65537);
  hasPermission.mockReset().mockReturnValue(true);
});
afterAll(()=>delete process.env.BRIDGE_MINI_GOLF_MULTIPLAYER);

describe('two-player Mini Golf authority',()=>{
  it('does not register socket listeners when the feature flag is off',async()=>{
    delete process.env.BRIDGE_MINI_GOLF_MULTIPLAYER;
    const s=socket('a',sid());
    expect(s.listeners.size).toBe(0);
  });
  it('denies missing membership and forged server without disclosing match state',async()=>{
    const server=sid(),a=socket('a',server);
    await a.trigger('mini-golf:join',{serverId:'other'});
    expect(a.last('mini-golf:state')).toBeUndefined();
    members.mockResolvedValue(null);
    await a.trigger('mini-golf:join',{serverId:server});
    expect(a.last('mini-golf:error')).toEqual({code:'GOLF_UNAVAILABLE',serverId:server});
    expect(readCache.size).toBe(0);
  });
  it('requires real Redis; no silent local multiplayer on cluster outage',async()=>{
    const server=sid(),a=socket('a',server);
    redisUp=false;
    await a.trigger('mini-golf:join',{serverId:server});
    expect(a.last('mini-golf:state')).toBeUndefined();
    expect(a.last('error:message')).toMatchObject({event:'mini-golf:join'});
  });
  it('makes a 2-player waiting/playing match with authenticated owner IDs',async()=>{
    const server=sid(),a=socket('a',server),b=socket('b',server);
    await a.trigger('mini-golf:join',{serverId:server,userId:'b',strokes:99});
    expect(a.last('mini-golf:state')).toMatchObject({phase:'waiting',turnUserId:null});
    await b.trigger('mini-golf:join',{serverId:server,userId:'fake',x:900});
    expect(b.last('mini-golf:state')).toMatchObject({phase:'playing',turnUserId:'a'});
    await a.trigger('mini-golf:sync',{serverId:server});
    const data=a.last('mini-golf:state') as { players:Array<{userId:string;strokes:number}> };
    expect(data.players).toEqual(expect.arrayContaining([
      expect.objectContaining({userId:'a',strokes:0}),
      expect.objectContaining({userId:'b',strokes:0}),
    ]));
    expect(JSON.stringify(data)).not.toContain(a.id);
    const duplicate=socket('a',server);
    await duplicate.trigger('mini-golf:join',{serverId:server});
    expect(duplicate.last('mini-golf:error')).toMatchObject({code:'GOLF_UNAVAILABLE'});
  });
  it('server resolves scored shot, rejects replay/out-of-turn/forged coordinates',async()=>{
    const server=sid(),a=socket('a',server),b=socket('b',server);
    await a.trigger('mini-golf:join',{serverId:server});
    await b.trigger('mini-golf:join',{serverId:server});
    await b.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    expect(b.last('mini-golf:error')).toMatchObject({code:'GOLF_INVALID_TURN'});
    await a.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60,x:-999,strokes:99});
    const first=a.last('mini-golf:state') as {turnUserId:string;players:Array<{x:number;z:number;strokes:number;won:boolean}>};
    expect(first.players[0]).toMatchObject({x:0,z:-3.8,strokes:1,won:true});
    expect(first.turnUserId).toBe('b');
    await a.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    expect(a.last('mini-golf:error')).toMatchObject({code:'GOLF_INVALID_TURN'});
    await b.trigger('mini-golf:sync',{serverId:server});
    expect(b.last('mini-golf:state')).toMatchObject({turnUserId:'b'});
    await b.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    expect(b.last('mini-golf:state')).toMatchObject({phase:'finished',turnUserId:null});
  });
  it('does not coerce invalid inputs; bounds score and shot simulation',async()=>{
    const server=sid(),a=socket('a',server),b=socket('b',server);
    await a.trigger('mini-golf:join',{serverId:server});
    await b.trigger('mini-golf:join',{serverId:server});
    for(const [degrees,power] of [['0',60],[0,Infinity],[0,0],[71,10]]) {
      await a.trigger('mini-golf:shoot',{serverId:server,degrees,power});
      expect(a.last('mini-golf:error')).toMatchObject({serverId:server});
    }
    const saved=await golfMatchStore.load(server);
    expect(saved.players[0]?.strokes).toBe(0);
    expect(resolveGolfShot({socketId:'x',userId:'y',x:0,z:3.6,strokes:GOLF_MAX_STROKES,won:false},0,60)).toBeNull();
    expect(emptyGolfMatch(server)).toMatchObject({phase:'waiting',players:[]});
  });
  it('revokes access before a state read or shot and does not send secret roster',async()=>{
    const server=sid(),a=socket('a',server),b=socket('b',server);
    await a.trigger('mini-golf:join',{serverId:server});
    await b.trigger('mini-golf:join',{serverId:server});
    const before=b.emitted.length;
    members.mockResolvedValue(null);
    await b.trigger('mini-golf:sync',{serverId:server});
    expect(b.emitted.slice(before).some(x=>x.name==='mini-golf:state')).toBe(false);
    expect(b.last('mini-golf:error')).toMatchObject({code:'GOLF_UNAVAILABLE'});
    expect((await golfMatchStore.load(server)).players.map(p=>p.userId)).toEqual(['a']);
  });
  it('leaving drops player and resets remaining round; disconnect cleans match',async()=>{
    const server=sid(),a=socket('a',server),b=socket('b',server);
    await a.trigger('mini-golf:join',{serverId:server});
    await b.trigger('mini-golf:join',{serverId:server});
    await a.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    await b.trigger('mini-golf:leave',{serverId:server});
    expect(await golfMatchStore.load(server)).toMatchObject({
      phase:'waiting',turn:0,players:[{userId:'a',socketId:a.id,x:0,z:3.6,won:false,strokes:0}],
    });
    await a.trigger('disconnect');
    expect((await golfMatchStore.load(server)).players).toEqual([]);
  });
  it('cancels an in-flight join BEFORE the first awaited membership check, no ghost slot',async()=>{
    const server=sid(),a=socket('a',server);
    let authStarted: (()=>void)|undefined;
    let releaseAuth: ((v: { banned: boolean })=>void)|undefined;
    const entered=new Promise<void>(resolve=>{authStarted=resolve;});
    members.mockImplementationOnce(() => {
      authStarted?.();
      return new Promise<{ banned:boolean }>(resolve=>{releaseAuth=resolve;});
    });
    const pending=a.trigger('mini-golf:join',{serverId:server});
    await entered;
    await a.trigger('mini-golf:leave',{serverId:server});
    expect(a.last('mini-golf:left')).toEqual({serverId:server});
    releaseAuth?.({banned:false});
    await pending;
    expect(a.last('mini-golf:state')).toBeUndefined();
    expect((await golfMatchStore.load(server)).players).toEqual([]);
  });

  it('isolates server-specific match records and rejects another tenant',async()=>{
    const first=sid(),second=sid(),a=socket('a',first);
    await a.trigger('mini-golf:join',{serverId:first});
    await a.trigger('mini-golf:join',{serverId:second});
    expect(a.last('mini-golf:error')).toMatchObject({serverId:second});
    expect((await golfMatchStore.load(second)).players).toEqual([]);
    expect((await golfMatchStore.load(first)).players).toHaveLength(1);
  });
});
