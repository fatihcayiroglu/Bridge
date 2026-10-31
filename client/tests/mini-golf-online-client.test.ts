import { afterEach, describe, expect, it, vi } from 'vitest';
import { joinOnlineMiniGolf } from '../js/core/activities/mini-golf-client.ts';
import type { SocialSocket } from '../js/core/activities/social-room-client.ts';

function transport() {
  let connected = true;
  const listeners = new Map<string, Set<(d?: unknown) => void>>();
  const outgoing: Array<{ name: string; data: unknown }> = [];
  const socket = {
    get connected() { return connected; },
    on(name: string, fn: (d?: unknown) => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
    },
    off(name: string, fn: (d?: unknown) => void) { listeners.get(name)?.delete(fn); },
    emit(name: string, data?: unknown) { outgoing.push({ name, data }); },
  } as SocialSocket;
  return {
    socket, outgoing,
    incoming(name: string, data?: unknown) { for (const fn of listeners.get(name) ?? []) fn(data); },
    disconnect() { connected = false; for (const fn of listeners.get('disconnect') ?? []) fn(); },
    count(name: string) { return outgoing.filter(o => o.name === name).length; },
  };
}
const waiting = {
  serverId: 'server1', revision: 1, phase: 'waiting', you: 'alice',
  turnUserId: null, minPlayers: 2, maxPlayers: 8, rematchReady: [], results: [], players: [{ userId: 'alice', x: 0, z: 3.6, strokes: 0, won: false }],
} as const;
const playing = {
  serverId: 'server1', revision: 2, phase: 'playing', you: 'alice', turnUserId: 'alice', minPlayers: 2, maxPlayers: 8, rematchReady: [], results: [],
  players: [
    { userId: 'alice', x: 0, z: 3.6, strokes: 0, won: false },
    { userId: 'bob', x: 0, z: 3.6, strokes: 0, won: false },
  ],
} as const;
afterEach(() => { vi.useRealTimers(); });
describe('Mini Golf experimental client is explicit, bounded and server owned', () => {
  it('does not join without a connected authenticated socket or valid server', () => {
    const t=transport(), updates=vi.fn(), statuses=vi.fn();
    const denied=joinOnlineMiniGolf(t.socket,'../bad',updates,statuses);
    expect(denied.active).toBe(false);
    expect(t.count('mini-golf:join')).toBe(0);
    expect(statuses).toHaveBeenCalledWith('unavailable');
  });
  it('joins explicitly, waits for validated self, and accepts a second member', () => {
    const t=transport(), updates=vi.fn(), statuses=vi.fn();
    const session=joinOnlineMiniGolf(t.socket,'server1',updates,statuses);
    expect(t.count('mini-golf:join')).toBe(1);
    expect(session.active).toBe(false);
    t.incoming('mini-golf:state',waiting);
    expect(session.active).toBe(true);
    expect(session.match?.phase).toBe('waiting');
    t.incoming('mini-golf:state',{...playing,phase:'waiting',turnUserId:null});
    expect(session.start()).toBe(true);
    expect(t.count('mini-golf:start')).toBe(1);
    t.incoming('mini-golf:state',{...playing,revision:3});
    expect(session.match?.players).toHaveLength(2);
    expect(statuses).toHaveBeenCalledWith('playing');
    session.dispose();
    expect(t.count('mini-golf:leave')).toBe(1);
  });
  it('filters other servers and rejects corrupt self-scoped frames without trusting them', () => {
    const t=transport(), updates=vi.fn(), statuses=vi.fn();
    const session=joinOnlineMiniGolf(t.socket,'server1',updates,statuses);
    t.incoming('mini-golf:state',{...playing,serverId:'server2'});
    expect(updates).not.toHaveBeenCalled();
    t.incoming('mini-golf:state',{...playing,players:[{...playing.players[0],x:Infinity}]});
    expect(session.active).toBe(false);
    expect(statuses).toHaveBeenCalledWith('invalid');
    expect(t.count('mini-golf:leave')).toBe(1);
  });
  it('allows only own-turn shots, without optimistic client score or coordinates', () => {
    const t=transport();
    const session=joinOnlineMiniGolf(t.socket,'server1',vi.fn(),vi.fn());
    t.incoming('mini-golf:state',waiting);
    expect(session.shoot(0,60)).toBe(false);
    t.incoming('mini-golf:state',playing);
    expect(session.shoot(0,60)).toBe(true);
    expect(session.busy).toBe(true);
    expect(session.match?.players[0]?.strokes).toBe(0);
    expect(session.shoot(0,60)).toBe(false);
    expect(t.count('mini-golf:shoot')).toBe(1);
    t.incoming('mini-golf:state',{...playing,revision:3,turnUserId:'bob',
      players:[{...playing.players[0],x:0,z:-3.8,strokes:1,won:true},playing.players[1]]});
    expect(session.busy).toBe(false);
    expect(session.shoot(0,60)).toBe(false);
    session.dispose();
  });
  it('cleans up late joins and never auto rejoins after disconnection', () => {
    const t=transport(), updates=vi.fn(),statuses=vi.fn();
    const session=joinOnlineMiniGolf(t.socket,'server1',updates,statuses);
    session.dispose();
    t.incoming('mini-golf:state',waiting);
    expect(updates).not.toHaveBeenCalled();
    expect(t.count('mini-golf:leave')).toBe(1);
    expect(t.count('mini-golf:join')).toBe(1);
    const other=joinOnlineMiniGolf(t.socket,'server1',updates,statuses);
    t.disconnect();
    expect(other.active).toBe(false);
    expect(statuses).toHaveBeenCalledWith('disconnected');
    expect(t.count('mini-golf:join')).toBe(2);
  });
  it('stops a connection on scope-matched server errors but ignores foreign errors', () => {
    const t=transport(), statuses=vi.fn();
    const session=joinOnlineMiniGolf(t.socket,'server1',vi.fn(),statuses);
    t.incoming('mini-golf:error',{serverId:'elsewhere',code:'GOLF_UNAVAILABLE'});
    expect(t.count('mini-golf:leave')).toBe(0);
    t.incoming('mini-golf:error',{serverId:'server1',code:'GOLF_UNAVAILABLE'});
    expect(session.active).toBe(false);
    expect(statuses).toHaveBeenCalledWith('unavailable');
    expect(t.count('mini-golf:leave')).toBe(1);
  });
  it('accepts eight legitimate seats and rejects a ninth seat from the server', () => {
    const t=transport(), statuses=vi.fn();
    const session=joinOnlineMiniGolf(t.socket,'server1',vi.fn(),statuses);
    const players=Array.from({length:8},(_,i)=>({
      userId:i===0?'alice':'g'+i,x:0,z:3.6,strokes:0,won:false,
    }));
    t.incoming('mini-golf:state',{...waiting,revision:5,players});
    expect(session.match?.players).toHaveLength(8);
    expect(session.start()).toBe(true);
    t.incoming('mini-golf:state',{...playing,revision:6,players});
    expect(session.match?.phase).toBe('playing');
    session.dispose();
    const second=joinOnlineMiniGolf(t.socket,'server1',vi.fn(),statuses);
    t.incoming('mini-golf:state',{...waiting,players:[...players,
      {userId:'g8',x:0,z:3.6,strokes:0,won:false}]});
    expect(second.active).toBe(false);
    expect(statuses).toHaveBeenCalledWith('invalid');
  });
  it('rejects shots when a peer is reconnecting, resumes only with newer server revision', () => {
    const t=transport(), updates=vi.fn();
    const session=joinOnlineMiniGolf(t.socket,'server1',updates,vi.fn());
    t.incoming('mini-golf:state',playing);
    const paused={...playing,revision:3,players:[
      {...playing.players[0],reconnecting:false},
      {...playing.players[1],reconnecting:true},
    ]};
    t.incoming('mini-golf:state',paused);
    expect(session.match?.players[1]?.reconnecting).toBe(true);
    expect(session.shoot(0,60)).toBe(false);
    expect(t.count('mini-golf:shoot')).toBe(0);
    t.incoming('mini-golf:state',{...playing,revision:2});
    expect(session.match?.revision).toBe(3);
    t.incoming('mini-golf:state',{...paused,revision:4,players:[
      {...playing.players[0],reconnecting:false},
      {...playing.players[1],reconnecting:false},
    ]});
    expect(session.match?.players[1]?.reconnecting).toBe(false);
    expect(session.shoot(0,60)).toBe(true);
    session.dispose();
  });
  it('does not silently auto rejoin after transport disconnect', () => {
    const t=transport(), statuses=vi.fn();
    const session=joinOnlineMiniGolf(t.socket,'server1',vi.fn(),statuses);
    t.incoming('mini-golf:state',playing);
    t.disconnect();
    expect(session.active).toBe(false);
    expect(statuses).toHaveBeenCalledWith('disconnected');
    expect(t.count('mini-golf:join')).toBe(1);
    expect(t.count('mini-golf:leave')).toBe(0);
  });
  it('emits rematch consent only once on finished rounds, then accepts a new round', () => {
    const t=transport();
    const session=joinOnlineMiniGolf(t.socket,'server1',vi.fn(),vi.fn());
    t.incoming('mini-golf:state',playing);
    expect(session.rematch()).toBe(false);
    const finished={...playing,revision:3,phase:'finished',turnUserId:null,
      players:[{...playing.players[0],strokes:1,won:true},
        {...playing.players[1],strokes:1,won:true}],
      results:[{userId:'alice',rank:1,strokes:1,holed:true},
        {userId:'bob',rank:1,strokes:1,holed:true}]};
    t.incoming('mini-golf:state',finished);
    expect(session.rematch()).toBe(true);
    expect(session.rematch()).toBe(false);
    expect(t.count('mini-golf:rematch')).toBe(1);
    t.incoming('mini-golf:state',{...finished,revision:4,rematchReady:['alice']});
    expect(session.match?.rematchReady).toEqual(['alice']);
    expect(session.rematch()).toBe(false);
    t.incoming('mini-golf:state',{...playing,revision:5});
    expect(session.match?.phase).toBe('playing');
    expect(session.match?.players[0]?.strokes).toBe(0);
    session.dispose();
  });
  it('refuses corrupt and duplicate rematch votes, or rematch while a peer reconnects', () => {
    const t=transport(), statuses=vi.fn();
    const finished={...playing,revision:3,phase:'finished',turnUserId:null,
      players:[{...playing.players[0],strokes:1,won:true},
        {...playing.players[1],strokes:1,won:true}],
      results:[{userId:'alice',rank:1,strokes:1,holed:true},
        {userId:'bob',rank:1,strokes:1,holed:true}]};
    const one=joinOnlineMiniGolf(t.socket,'server1',vi.fn(),statuses);
    t.incoming('mini-golf:state',{...finished,rematchReady:['alice','alice']});
    expect(one.active).toBe(false);
    expect(statuses).toHaveBeenCalledWith('invalid');
    const two=joinOnlineMiniGolf(t.socket,'server1',vi.fn(),statuses);
    t.incoming('mini-golf:state',{...finished,rematchReady:['outside']});
    expect(two.active).toBe(false);
    const three=joinOnlineMiniGolf(t.socket,'server1',vi.fn(),statuses);
    t.incoming('mini-golf:state',{...finished,players:[
      {...finished.players[0],reconnecting:false},
      {...finished.players[1],reconnecting:true},
    ]});
    expect(three.rematch()).toBe(false);
    expect(t.count('mini-golf:rematch')).toBe(0);
    three.dispose();
  });
  it('trusts only exact official results with stable tied ranks and clears them on rematch', () => {
    const t=transport(),statuses=vi.fn();
    const session=joinOnlineMiniGolf(t.socket,'server1',vi.fn(),statuses);
    const players=[
      {...playing.players[0],strokes:1,won:true},
      {...playing.players[1],strokes:1,won:true},
    ];
    const finished={...playing,phase:'finished',turnUserId:null,revision:5,
      players,results:[
        {userId:'alice',rank:1,strokes:1,holed:true},
        {userId:'bob',rank:1,strokes:1,holed:true},
      ]};
    t.incoming('mini-golf:state',finished);
    expect(session.active).toBe(true);
    expect(session.match?.results.map(x=>x.rank)).toEqual([1,1]);
    t.incoming('mini-golf:state',{...playing,revision:6});
    expect(session.match?.results).toEqual([]);
    session.dispose();
  });
  it('rejects forged results, wrong rank and premature standings, fail closed', () => {
    const bad=[
      {...playing,results:[{userId:'alice',rank:1,strokes:0,holed:false}]},
      {...playing,phase:'finished',turnUserId:null,revision:4,
        players:[{...playing.players[0],strokes:1,won:true},
          {...playing.players[1],strokes:1,won:true}],
        results:[{userId:'alice',rank:1,strokes:1,holed:true},
          {userId:'bob',rank:2,strokes:1,holed:true}]},
      {...playing,phase:'finished',turnUserId:null,revision:4,
        players:[{...playing.players[0],strokes:1,won:true},
          {...playing.players[1],strokes:8,won:false}],
        results:[{userId:'bob',rank:1,strokes:8,holed:false},
          {userId:'alice',rank:2,strokes:1,holed:true}]},
    ];
    for (const frame of bad) {
      const t=transport(),statuses=vi.fn();
      const session=joinOnlineMiniGolf(t.socket,'server1',vi.fn(),statuses);
      t.incoming('mini-golf:state',frame);
      expect(session.active).toBe(false);
      expect(statuses).toHaveBeenCalledWith('invalid');
      expect(t.count('mini-golf:leave')).toBe(1);
    }
  });
  it('times out pending admissions and leaves without creating a ghost session', () => {
    vi.useFakeTimers();
    const t=transport(), statuses=vi.fn();
    const session=joinOnlineMiniGolf(t.socket,'server1',vi.fn(),statuses);
    vi.advanceTimersByTime(12001);
    expect(session.active).toBe(false);
    expect(t.count('mini-golf:leave')).toBe(1);
    expect(statuses).toHaveBeenCalledWith('unavailable');
  });
});
