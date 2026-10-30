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
import { golfMatchStore, resolveGolfShot, emptyGolfMatch, golfRoundResults, publicGolfMatch, GOLF_MAX_STROKES, GOLF_MAX_PLAYERS } from '../socket/handlers/mini-golf-match';

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

describe('2–8 player Mini Golf authority',()=>{
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
    expect(b.last('mini-golf:state')).toMatchObject({phase:'waiting',turnUserId:null});
    await b.trigger('mini-golf:start',{serverId:server});
    expect(b.last('mini-golf:error')).toMatchObject({code:'GOLF_CANNOT_START'});
    await a.trigger('mini-golf:start',{serverId:server});
    expect(a.last('mini-golf:state')).toMatchObject({phase:'playing',turnUserId:'a'});
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
    await a.trigger('mini-golf:start',{serverId:server});
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
    await a.trigger('mini-golf:start',{serverId:server});
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
    await a.trigger('mini-golf:start',{serverId:server});
    const before=b.emitted.length;
    members.mockResolvedValue(null);
    await b.trigger('mini-golf:sync',{serverId:server});
    expect(b.emitted.slice(before).some(x=>x.name==='mini-golf:state')).toBe(false);
    expect(b.last('mini-golf:error')).toMatchObject({code:'GOLF_UNAVAILABLE'});
    expect((await golfMatchStore.load(server)).players.map(p=>p.userId)).toEqual(['a']);
  });
  it('explicit leave resets a round; disconnect reserves a short reconnect seat',async()=>{
    const server=sid(),a=socket('a',server),b=socket('b',server);
    await a.trigger('mini-golf:join',{serverId:server});
    await b.trigger('mini-golf:join',{serverId:server});
    await a.trigger('mini-golf:start',{serverId:server});
    await a.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    await b.trigger('mini-golf:leave',{serverId:server});
    expect(await golfMatchStore.load(server)).toMatchObject({
      phase:'waiting',turn:0,players:[{userId:'a',socketId:a.id,x:0,z:3.6,won:false,strokes:0}],
    });
    await a.trigger('disconnect');
    const suspended=await golfMatchStore.load(server);
    expect(suspended.players).toHaveLength(1);
    expect(suspended.players[0]).toMatchObject({userId:'a',socketId:a.id,strokes:0});
    expect(suspended.players[0]?.reconnectUntil).toBeGreaterThan(Date.now());
    const publicFrame=JSON.stringify(a.last('mini-golf:state'));
    expect(publicFrame).not.toContain('reconnectUntil');
  });
  it('reclaims disconnected current-turn seat with fresh authenticated socket and preserves 8-player game',async()=>{
    const server=sid();
    const players=Array.from({length:8},(_,i)=>socket('user'+i,server));
    for(const p of players) await p.trigger('mini-golf:join',{serverId:server});
    await players[0]!.trigger('mini-golf:start',{serverId:server});
    await players[0]!.trigger('disconnect');
    let suspended=await golfMatchStore.load(server);
    expect(suspended).toMatchObject({phase:'playing',turn:0});
    expect(suspended.players).toHaveLength(8);
    expect(suspended.players[0]).toMatchObject({userId:'user0',socketId:players[0]!.id});
    expect(suspended.players[0]?.reconnectUntil).toBeGreaterThan(Date.now());
    // A different user and a second live socket cannot displace this seat.
    await players[1]!.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    expect(players[1]!.last('mini-golf:error')).toMatchObject({code:'GOLF_INVALID_TURN'});
    const impostor=socket('wrong',server);
    await impostor.trigger('mini-golf:join',{serverId:server});
    expect(impostor.last('mini-golf:error')).toMatchObject({code:'GOLF_UNAVAILABLE'});
    const replacement=socket('user0',server);
    await replacement.trigger('mini-golf:join',{serverId:server});
    const resumed=replacement.last('mini-golf:state') as {players:Array<{reconnecting:boolean;userId:string}>};
    expect(resumed.players).toHaveLength(8);
    expect(resumed.players[0]).toMatchObject({userId:'user0',reconnecting:false});
    suspended=await golfMatchStore.load(server);
    expect(suspended.players[0]?.socketId).toBe(replacement.id);
    expect(suspended.players[0]?.reconnectUntil).toBeUndefined();
    await replacement.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    expect((await golfMatchStore.load(server)).players[0]).toMatchObject({strokes:1,won:true});
    // A delayed stale disconnect cannot erase the freshly reclaimed seat.
    await players[0]!.trigger('disconnect');
    expect((await golfMatchStore.load(server)).players[0]?.socketId).toBe(replacement.id);
  });

  it('freezes all shots during grace and returns to play after reconnect',async()=>{
    const server=sid(),a=socket('a',server),b=socket('b',server);
    await a.trigger('mini-golf:join',{serverId:server});
    await b.trigger('mini-golf:join',{serverId:server});
    await a.trigger('mini-golf:start',{serverId:server});
    await b.trigger('disconnect');
    await a.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    expect(a.last('mini-golf:error')).toMatchObject({code:'GOLF_INVALID_TURN'});
    expect((await golfMatchStore.load(server)).players[0]?.strokes).toBe(0);
    await a.trigger('mini-golf:sync',{serverId:server});
    const frame=a.last('mini-golf:state') as {players:Array<{reconnecting:boolean}>};
    expect(frame.players[1]?.reconnecting).toBe(true);
    expect(JSON.stringify(frame)).not.toContain('reconnectUntil');
    const b2=socket('b',server);
    await b2.trigger('mini-golf:join',{serverId:server});
    await a.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    expect((await golfMatchStore.load(server)).players[0]?.won).toBe(true);
    await b2.trigger('mini-golf:sync',{serverId:server});
    expect(b2.last('mini-golf:state')).toMatchObject({turnUserId:'b'});
  });

  it('expires a disconnected seat on an authorized sync without stale roster or lost progress',async()=>{
    const clock=jest.spyOn(Date,'now').mockReturnValue(1_000_000);
    try {
      const server=sid(),a=socket('a',server),b=socket('b',server),c=socket('c',server);
      await a.trigger('mini-golf:join',{serverId:server});
      await b.trigger('mini-golf:join',{serverId:server});
      await c.trigger('mini-golf:join',{serverId:server});
      await a.trigger('mini-golf:start',{serverId:server});
      await a.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
      expect((await golfMatchStore.load(server)).players[0]?.won).toBe(true);
      await c.trigger('disconnect');
      expect((await golfMatchStore.load(server)).players).toHaveLength(3);
      clock.mockReturnValue(1_020_001);
      await b.trigger('mini-golf:sync',{serverId:server});
      const data=b.last('mini-golf:state') as {players:Array<{userId:string;strokes:number;won:boolean}>};
      expect(data.players.map(p=>p.userId)).toEqual(['a','b']);
      expect(data.players[0]).toMatchObject({strokes:1,won:true});
      expect((await golfMatchStore.load(server)).phase).toBe('playing');
      // Expired user cannot overwrite their old live game by reconnecting.
      const c2=socket('c',server);
      await c2.trigger('mini-golf:join',{serverId:server});
      expect(c2.last('mini-golf:error')).toMatchObject({code:'GOLF_UNAVAILABLE'});
    } finally {clock.mockRestore();}
  });

  it('fails closed if the reconnecting account was banned or lost membership',async()=>{
    const server=sid(),a=socket('a',server),b=socket('b',server);
    await a.trigger('mini-golf:join',{serverId:server});
    await b.trigger('mini-golf:join',{serverId:server});
    await a.trigger('mini-golf:start',{serverId:server});
    await a.trigger('disconnect');
    members.mockImplementation(async (id:string) => id==='a'?null:{banned:false});
    const attempt=socket('a',server);
    await attempt.trigger('mini-golf:join',{serverId:server});
    expect(attempt.last('mini-golf:state')).toBeUndefined();
    expect(attempt.last('mini-golf:error')).toMatchObject({code:'GOLF_UNAVAILABLE'});
    expect((await golfMatchStore.load(server)).players[0]?.socketId).toBe(a.id);
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

  it('admits exactly eight players in a waiting lobby and refuses ninth without a roster leak',async()=>{
    const server=sid();
    const users=Array.from({length:GOLF_MAX_PLAYERS+1},(_,i)=>socket('player-'+i,server));
    for (let i=0;i<GOLF_MAX_PLAYERS;i++) {
      await users[i]!.trigger('mini-golf:join',{serverId:server,strokes:200});
      expect((await golfMatchStore.load(server)).players).toHaveLength(i+1);
      expect((await golfMatchStore.load(server)).phase).toBe('waiting');
    }
    await users[8]!.trigger('mini-golf:join',{serverId:server});
    expect(users[8]!.last('mini-golf:error')).toMatchObject({code:'GOLF_UNAVAILABLE'});
    expect(users[8]!.last('mini-golf:state')).toBeUndefined();
    await users[0]!.trigger('mini-golf:start',{serverId:server});
    expect((await golfMatchStore.load(server)).phase).toBe('playing');
    const state=users[0]!.last('mini-golf:state') as {maxPlayers:number;players:unknown[]};
    expect(state).toMatchObject({maxPlayers:8});
    expect(state.players).toHaveLength(8);
    expect(JSON.stringify(state)).not.toContain(users[1]!.id);
  });

  it('cycles all eight seats, skipping holed balls and finishes only when all are done',async()=>{
    const server=sid(),players=Array.from({length:8},(_,i)=>socket('p'+i,server));
    for (const p of players) await p.trigger('mini-golf:join',{serverId:server});
    await players[0]!.trigger('mini-golf:start',{serverId:server});
    for (let i=0;i<8;i++) {
      const p=players[i]!;
      await p.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
      const game=await golfMatchStore.load(server);
      expect(game.players[i]).toMatchObject({strokes:1,won:true});
      expect(game.phase).toBe(i===7?'finished':'playing');
      if(i!==7)expect(game.players[game.turn]?.userId).toBe('p'+(i+1));
      else expect(p.last('mini-golf:state')).toMatchObject({turnUserId:null});
    }
    await players[0]!.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    expect(players[0]!.last('mini-golf:error')).toMatchObject({code:'GOLF_INVALID_TURN'});
  });

  it('keeps the remaining match alive with correct turn when one of eight leaves',async()=>{
    const server=sid(),players=Array.from({length:8},(_,i)=>socket('u'+i,server));
    for(const p of players)await p.trigger('mini-golf:join',{serverId:server});
    await players[0]!.trigger('mini-golf:start',{serverId:server});
    await players[0]!.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    await players[3]!.trigger('mini-golf:leave',{serverId:server});
    let game=await golfMatchStore.load(server);
    expect(game.players).toHaveLength(7);
    expect(game.players[game.turn]?.userId).toBe('u1');
    await players[1]!.trigger('mini-golf:leave',{serverId:server});
    game=await golfMatchStore.load(server);
    expect(game.players).toHaveLength(6);
    expect(game.players[game.turn]?.userId).toBe('u2');
    await players[2]!.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    game=await golfMatchStore.load(server);
    expect(game.players[game.turn]?.userId).toBe('u4');
    for (const i of [4,5,6,7]) await players[i]!.trigger('mini-golf:leave',{serverId:server});
    game=await golfMatchStore.load(server);
    expect(game.phase).toBe('finished');
    expect(game.players).toHaveLength(2);
    // Both remaining players already holed, so their current match is finished.
    // Only a drop below two resets the score into a fresh waiting lobby.
    // Once only one remains, its score resets for an unambiguous fresh lobby.
    await players[2]!.trigger('mini-golf:leave',{serverId:server});
    game=await golfMatchStore.load(server);
    expect(game).toMatchObject({phase:'waiting',players:[{userId:'u0',strokes:0,won:false}]});
  });

  it('rejects starting with fewer than two, and joining a started 2–8 game',async()=>{
    const server=sid(),a=socket('a',server),b=socket('b',server),c=socket('c',server);
    await a.trigger('mini-golf:join',{serverId:server});
    await a.trigger('mini-golf:start',{serverId:server});
    expect(a.last('mini-golf:error')).toMatchObject({code:'GOLF_CANNOT_START'});
    await b.trigger('mini-golf:join',{serverId:server});
    await a.trigger('mini-golf:start',{serverId:server});
    await c.trigger('mini-golf:join',{serverId:server});
    expect(c.last('mini-golf:error')).toMatchObject({code:'GOLF_UNAVAILABLE'});
    expect((await golfMatchStore.load(server)).players).toHaveLength(2);
  });

  it('requires unanimous explicit rematch votes for two players, then resets all scores',async()=>{
    const server=sid(),a=socket('a',server),b=socket('b',server);
    await a.trigger('mini-golf:join',{serverId:server});
    await b.trigger('mini-golf:join',{serverId:server});
    await a.trigger('mini-golf:start',{serverId:server});
    await a.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    await b.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    expect((await golfMatchStore.load(server)).phase).toBe('finished');
    await a.trigger('mini-golf:rematch',{serverId:server,userId:'b',strokes:99});
    let game=await golfMatchStore.load(server);
    expect(game.phase).toBe('finished');
    expect(game.players.map(p=>p.strokes)).toEqual([1,1]);
    expect(game.rematchReady).toEqual(['a']);
    await a.trigger('mini-golf:rematch',{serverId:server});
    expect(a.last('mini-golf:error')).toMatchObject({code:'GOLF_REMATCH_UNAVAILABLE'});
    await b.trigger('mini-golf:rematch',{serverId:server});
    game=await golfMatchStore.load(server);
    expect(game.phase).toBe('playing');
    expect(game.turn).toBe(0);
    expect(game.rematchReady).toEqual([]);
    expect(game.players.map(p=>({strokes:p.strokes,won:p.won,z:p.z}))).toEqual([
      {strokes:0,won:false,z:3.6},{strokes:0,won:false,z:3.6},
    ]);
    await a.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    expect((await golfMatchStore.load(server)).players[0]?.won).toBe(true);
  });

  it('accepts exactly eight votes and keeps 8-player rankings until final consent',async()=>{
    const server=sid(),ps=Array.from({length:8},(_,i)=>socket('rematch'+i,server));
    for(const p of ps)await p.trigger('mini-golf:join',{serverId:server});
    await ps[0]!.trigger('mini-golf:start',{serverId:server});
    for(const p of ps)await p.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    for(let i=0;i<7;i++){
      await ps[i]!.trigger('mini-golf:rematch',{serverId:server});
      const state=await golfMatchStore.load(server);
      expect(state.phase).toBe('finished');
      expect(state.rematchReady).toHaveLength(i+1);
      expect(state.players.every(p=>p.won&&p.strokes===1)).toBe(true);
    }
    const publicState=ps[6]!.last('mini-golf:state') as {rematchReady:string[];players:unknown[]};
    expect(publicState.rematchReady).toHaveLength(7);
    expect(JSON.stringify(publicState)).not.toContain(ps[0]!.id);
    await ps[7]!.trigger('mini-golf:rematch',{serverId:server});
    const started=await golfMatchStore.load(server);
    expect(started).toMatchObject({phase:'playing',turn:0,rematchReady:[]});
    expect(started.players).toHaveLength(8);
    expect(started.players.every(p=>p.strokes===0&&!p.won)).toBe(true);
  });

  it('refuses rematch before finish, after revocation, or while an opponent reconnects',async()=>{
    const server=sid(),a=socket('a',server),b=socket('b',server);
    await a.trigger('mini-golf:join',{serverId:server});
    await b.trigger('mini-golf:join',{serverId:server});
    await a.trigger('mini-golf:rematch',{serverId:server});
    expect(a.last('mini-golf:error')).toMatchObject({code:'GOLF_REMATCH_UNAVAILABLE'});
    await a.trigger('mini-golf:start',{serverId:server});
    await a.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    await b.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    await b.trigger('disconnect');
    await a.trigger('mini-golf:rematch',{serverId:server});
    expect((await golfMatchStore.load(server)).rematchReady).toEqual([]);
    const replacement=socket('b',server);
    await replacement.trigger('mini-golf:join',{serverId:server});
    members.mockImplementation(async (id:string)=>id==='a'?null:{banned:false});
    await a.trigger('mini-golf:rematch',{serverId:server});
    expect((await golfMatchStore.load(server)).rematchReady).toEqual([]);
  });

  it('retains votes for remaining players when a completed-match participant leaves',async()=>{
    const server=sid(),ps=Array.from({length:3},(_,i)=>socket('v'+i,server));
    for(const p of ps)await p.trigger('mini-golf:join',{serverId:server});
    await ps[0]!.trigger('mini-golf:start',{serverId:server});
    for(const p of ps)await p.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    await ps[0]!.trigger('mini-golf:rematch',{serverId:server});
    await ps[1]!.trigger('mini-golf:rematch',{serverId:server});
    await ps[1]!.trigger('mini-golf:leave',{serverId:server});
    const after=await golfMatchStore.load(server);
    expect(after.phase).toBe('finished');
    expect(after.rematchReady).toEqual(['v0']);
    await ps[2]!.trigger('mini-golf:rematch',{serverId:server});
    expect((await golfMatchStore.load(server))).toMatchObject({phase:'playing',rematchReady:[]});
  });

  it('expires a disconnected seat at the exact 20-second boundary; never resurrects votes',async()=>{
    const clock=jest.spyOn(Date,'now').mockReturnValue(1_000_000);
    try{
      const server=sid(),ps=Array.from({length:3},(_,i)=>socket('e'+i,server));
      for(const p of ps)await p.trigger('mini-golf:join',{serverId:server});
      await ps[0]!.trigger('mini-golf:start',{serverId:server});
      for(const p of ps)await p.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
      await ps[0]!.trigger('mini-golf:rematch',{serverId:server});
      await ps[2]!.trigger('disconnect');
      clock.mockReturnValue(1_019_999);
      await ps[1]!.trigger('mini-golf:sync',{serverId:server});
      expect((await golfMatchStore.load(server)).players).toHaveLength(3);
      clock.mockReturnValue(1_020_000);
      await ps[1]!.trigger('mini-golf:sync',{serverId:server});
      const state=await golfMatchStore.load(server);
      expect(state.players).toHaveLength(2);
      expect(state.rematchReady).toEqual(['e0']);
      await ps[1]!.trigger('mini-golf:rematch',{serverId:server});
      expect((await golfMatchStore.load(server))).toMatchObject({phase:'playing',rematchReady:[]});
    }finally{clock.mockRestore();}
  });

  it('ranks holed and stroke-capped players without false winners, stable ties or socket leakage',()=>{
    const game=emptyGolfMatch(sid());
    game.players=[
      {userId:'limit',socketId:'secret0',x:1,z:1,strokes:8,won:false},
      {userId:'winner',socketId:'secret1',x:0,z:-3.8,strokes:1,won:true},
      {userId:'tied',socketId:'secret2',x:0,z:-3.8,strokes:1,won:true},
      {userId:'second',socketId:'secret3',x:0,z:-3.8,strokes:3,won:true},
      {userId:'alsoLimit',socketId:'secret4',x:0,z:0,strokes:8,won:false},
    ];
    game.phase='playing';
    expect(golfRoundResults(game)).toEqual([]);
    expect(publicGolfMatch(game).results).toEqual([]);
    game.phase='finished';
    expect(golfRoundResults(game)).toEqual([
      {userId:'winner',rank:1,strokes:1,holed:true},
      {userId:'tied',rank:1,strokes:1,holed:true},
      {userId:'second',rank:3,strokes:3,holed:true},
      {userId:'limit',rank:4,strokes:8,holed:false},
      {userId:'alsoLimit',rank:4,strokes:8,holed:false},
    ]);
    const visible=JSON.stringify(publicGolfMatch(game));
    expect(visible).toContain('"rank":3');
    expect(visible).not.toContain('secret0');
    expect(visible).not.toContain('socketId');
    expect(visible).not.toContain('reconnectUntil');
  });
  it('returns eight official shared first places for a real completed eight-person game',async()=>{
    const server=sid(),players=Array.from({length:8},(_,i)=>socket('rank'+i,server));
    for(const p of players)await p.trigger('mini-golf:join',{serverId:server});
    await players[0]!.trigger('mini-golf:start',{serverId:server});
    for(const p of players)await p.trigger('mini-golf:shoot',{serverId:server,degrees:0,power:60});
    const snapshot=players[7]!.last('mini-golf:state') as {
      results:Array<{userId:string;rank:number;strokes:number;holed:boolean}>;
    };
    expect(snapshot.results).toHaveLength(8);
    expect(snapshot.results.every(p=>p.rank===1&&p.strokes===1&&p.holed)).toBe(true);
    await players[0]!.trigger('mini-golf:rematch',{serverId:server});
    const voteSnapshot=players[0]!.last('mini-golf:state') as {results:unknown[]};
    expect(voteSnapshot.results).toHaveLength(8);
    for(let i=1;i<8;i++)await players[i]!.trigger('mini-golf:rematch',{serverId:server});
    const next=players[7]!.last('mini-golf:state') as {results:unknown[];phase:string};
    expect(next.phase).toBe('playing');
    expect(next.results).toEqual([]);
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
