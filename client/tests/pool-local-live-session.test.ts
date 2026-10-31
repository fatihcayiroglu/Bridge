import {describe,expect,it,vi} from 'vitest';
import {
  newPoolPractice,stepPool,strikePool,type PoolState,
} from '../js/core/activities/pool-practice-physics.ts';
import {acceptLocalPoolPlacement} from '../js/core/activities/pool-local-placement.ts';
import {type PoolPracticeHandle} from '../js/core/activities/pool-practice-webgl.ts';
import {startLocalHotSeatLiveSession} from './prototypes/pool-local-live-session.ts';

function fakeRealPhysics() {
  const hooks:{lost:null|(()=>void),emit:null|((s:PoolState)=>void)}={lost:null,emit:null};
  const factory=(_canvas:HTMLCanvasElement,onState:(s:PoolState)=>void,onLost?:()=>void):PoolPracticeHandle=>{
    let current=newPoolPractice(),disposed=false;
    hooks.emit=onState;hooks.lost=onLost??null;onState(current);
    return {
      get state(){return current;},
      get isGraphicsAvailable(){return !disposed;},
      shoot(angle,power){
        if(disposed)return false;
        const shot=strikePool(current,angle,power);
        if(shot===current)return false;
        current=shot;onState(current);
        for(let i=0;i<6000&&current.status==='moving';i++)current=stepPool(current);
        if(current.status==='moving')throw Error('REAL_POOL_PHYSICS_DID_NOT_SETTLE');
        onState(current);return true;
      },
      placeLocalTable(next){
        if(disposed)return false;
        const accepted=acceptLocalPoolPlacement(current,next);
        if(!accepted)return false;
        current=accepted;onState(current);return true;
      },
      reset(){if(disposed)return;current=newPoolPractice();onState(current);},
      dispose(){disposed=true;},
    };
  };
  return {factory,hooks};
}

describe('8-ball live WebGL turn bridge (offline prototype; no server scoring)',()=>{
  it('uses genuine fixed-step renderer output and never trusts mutable spectator snapshots',()=>{
    const graphics=fakeRealPhysics(),observed:PoolState[]=[];
    const session=startLocalHotSeatLiveSession(document.createElement('canvas'),
      snapshot=>{
        observed.push(snapshot.table);
        (snapshot.table.balls[0] as {x:number}).x=777;
        (snapshot.rules as {shotsResolved:number}).shotsResolved=777;
      },graphics.factory);
    expect(session).not.toBeNull();
    expect(session?.match.table.shots).toBe(0);
    expect(session?.match.table.balls[0]?.x).toBe(0);
    const exported=session!.match;
    (exported.table.balls[0] as {x:number}).x=999;
    expect(session?.match.table.balls[0]?.x).toBe(0);
    expect(session?.shoot(1,0,100,{kind:'break'})).toBe(false);
    expect(session?.shoot(0,0,100,{kind:'ball',ballId:1,pocketIndex:0})).toBe(false);
    expect(session?.shoot(0,0,100,{kind:'break'})).toBe(true);
    expect(session?.status).toBe('ready');
    expect(session?.match.table.shots).toBe(1);
    expect(session?.match.rules.shotsResolved).toBe(1);
    expect(session?.match.rules.last?.actor).toBe(0);
    expect(session?.match.rules.last?.pocketed).toEqual(session?.match.table.balls
      .filter(b=>b.id!==0&&b.pocketed).map(b=>b.id).sort((a,b)=>a-b));
    expect(observed.length).toBeGreaterThan(1);
    expect(session?.match.rules.winner).toBeNull();
    session?.dispose();
    expect(session?.status).toBe('disposed');
  });

  it('requires a real pending break choice and correct actor before another physical shot',()=>{
    const gfx=fakeRealPhysics();
    const session=startLocalHotSeatLiveSession(document.createElement('canvas'),vi.fn(),gfx.factory)!;
    expect(session.shoot(0,0,100,{kind:'break'})).toBe(true);
    const m=session.match;
    if(m.rules.phase==='illegal-break-choice'){
      expect(session.shoot(m.rules.currentPlayer,0,60,{kind:'safety'})).toBe(false);
      const opponent=m.rules.currentPlayer===0?1:0;
      expect(session.chooseIllegalBreak(opponent,'rerack-incoming-break')).toBe(false);
      expect(session.chooseIllegalBreak(m.rules.currentPlayer,'rerack-incoming-break')).toBe(true);
      expect(session.match.rules.phase).toBe('break');
      expect(session.match.table.shots).toBe(0);
      expect(session.match.rules.currentPlayer).toBe(m.rules.currentPlayer);
    } else {
      expect(m.rules.shotsResolved).toBe(1);
      expect(session.chooseIllegalBreak(m.rules.currentPlayer,'rerack-incoming-break')).toBe(false);
    }
    expect(session.chooseGroup(session.match.rules.currentPlayer,'solids')).toBe(false);
    expect(session.chooseBreakFoul(session.match.rules.currentPlayer,'accept-position')).toBe(false);
    expect(session.placeCue(session.match.rules.currentPlayer,0,2.7)).toBe(false);
    expect(session.chooseEightOnBreak(session.match.rules.currentPlayer,'spot-eight')).toBe(false);
    session.dispose();
  });

  it('fails closed on a forged settled frame and will never grant a turn or pocket score',()=>{
    const hooks:{emit?:((s:PoolState)=>void)}={};
    const factory=(_canvas:HTMLCanvasElement,onState:(s:PoolState)=>void):PoolPracticeHandle=>{
      const initial=newPoolPractice();hooks.emit=onState;onState(initial);
      return {
        get state(){return initial;},isGraphicsAvailable:true,
        shoot(){onState({...initial,shots:1,status:'ready',pocketed:15});return true;},
        reset(){},placeLocalTable(){return false;},dispose(){},
      };
    };
    const session=startLocalHotSeatLiveSession(document.createElement('canvas'),vi.fn(),factory)!;
    expect(session.shoot(0,0,80,{kind:'break'})).toBe(true);
    expect(session.status).toBe('blocked');
    expect(session.match.table.shots).toBe(0);
    expect(session.match.rules.shotsResolved).toBe(0);
    expect(session.shoot(0,0,80,{kind:'break'})).toBe(false);
    hooks.emit?.(newPoolPractice());
    expect(session.match.table.shots).toBe(0);
    session.dispose();
  });

  it('invalidates the shot when WebGL is lost and does not revive on later callbacks',()=>{
    let lose:(()=>void)|undefined;
    const hooks:{emit?:((s:PoolState)=>void)}={};
    const factory=(_canvas:HTMLCanvasElement,onState:(s:PoolState)=>void,onLost?:()=>void):PoolPracticeHandle=>{
      let current=newPoolPractice();
      hooks.emit=onState;lose=onLost;onState(current);
      return {
        get state(){return current;},isGraphicsAvailable:true,
        shoot(a,p){current=strikePool(current,a,p);onState(current);return true;},
        reset(){},placeLocalTable(){return false;},dispose(){},
      };
    };
    const session=startLocalHotSeatLiveSession(document.createElement('canvas'),vi.fn(),factory)!;
    expect(session.shoot(0,0,60,{kind:'break'})).toBe(true);
    expect(session.status).toBe('moving');
    lose?.();
    expect(session.status).toBe('blocked');
    expect(session.graphicsAvailable).toBe(false);
    hooks.emit?.({...newPoolPractice(),shots:1});
    expect(session.match.table.shots).toBe(0);
    expect(session.shoot(0,0,60,{kind:'break'})).toBe(false);
    session.dispose();
  });
});
