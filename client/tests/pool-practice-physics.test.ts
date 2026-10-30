import { describe,expect,it } from 'vitest';
import {
  POOL_DT, POOL_POCKETS, POOL_RADIUS, newPoolPractice, strikePool, stepPool,
  type PoolState,
} from '../js/core/activities/pool-practice-physics.ts';

const finish=(initial:PoolState)=>{
  let state=initial;
  for(let i=0;i<6000 && state.status==='moving';i++)state=stepPool(state);
  return state;
};
describe('local 3D pool physics without server scores or multiplayer',()=>{
  it('racks exactly one cue and five object balls with safe stationary positions',()=>{
    const state=newPoolPractice();
    expect(state.status).toBe('ready');
    expect(state.balls.map(b=>b.id)).toEqual([0,1,2,3,4,5]);
    expect(state.shots).toBe(0);
    expect(state.pocketed).toBe(0);
    expect(POOL_DT).toBeCloseTo(1/120,9);
    for(let i=0;i<state.balls.length;i++)for(let j=i+1;j<state.balls.length;j++){
      const a=state.balls[i]!,b=state.balls[j]!;
      expect(Math.hypot(a.x-b.x,a.z-b.z)).toBeGreaterThanOrEqual(POOL_RADIUS*2);
    }
  });
  it('rejects spoofed or invalid shots, does not modify original state',()=>{
    const state=newPoolPractice();
    for(const [angle,power] of [[Infinity,50],[NaN,80],[71,50],[0,9],[0,101]]){
      expect(strikePool(state,angle,power)).toBe(state);
    }
    const shot=strikePool(state,0,55);
    expect(shot.shots).toBe(1);
    expect(shot.status).toBe('moving');
    expect(strikePool(shot,0,55)).toBe(shot);
    expect(state.shots).toBe(0);
  });
  it('transfers energy through a head-on ball collision',()=>{
    const initial=newPoolPractice();
    const balls=initial.balls.map(b=>b.id===1?{...b,x:0,z:1.75}:b);
    const state={...initial,balls};
    let running=strikePool(state,0,55);
    for(let i=0;i<160;i++)running=stepPool(running);
    const target=running.balls.find(b=>b.id===1)!;
    expect(target.z).toBeLessThan(1.75);
    expect(Number.isFinite(target.vz)).toBe(true);
  });
  it('pockets an object and never treats it as a cue scratch',()=>{
    const initial=newPoolPractice();
    const point=POOL_POCKETS[0];
    const balls=initial.balls.map(b=>b.id===1?
      {...b,x:point.x+.03,z:point.z+.03,vx:.1,vz:0}:b);
    const result=stepPool({...initial,status:'moving',balls});
    expect(result.balls[1]?.pocketed).toBe(true);
    expect(result.pocketed).toBe(1);
    expect(result.scratches).toBe(0);
  });
  it('re-spots a scratched cue and counts it separately from object balls',()=>{
    const initial=newPoolPractice();
    const point=POOL_POCKETS[1];
    const balls=initial.balls.map(b=>b.id===0?
      {...b,x:point.x-.02,z:point.z-.02,vx:.05,vz:0}:b);
    const result=stepPool({...initial,status:'moving',balls});
    expect(result.scratches).toBe(1);
    expect(result.pocketed).toBe(0);
    expect(result.balls[0]?.pocketed).toBe(false);
    expect(result.balls[0]?.z).toBeCloseTo(2.7);
    expect(result.status).toBe('ready');
  });
  it('settles within a finite number of ticks without NaN or ghost shots',()=>{
    const result=finish(strikePool(newPoolPractice(),20,50));
    expect(result.status).toBe('ready');
    expect(result.shots).toBe(1);
    expect(result.balls.every(b=>[b.x,b.z,b.vx,b.vz].every(Number.isFinite))).toBe(true);
    expect(stepPool(result)).toBe(result);
    expect(finish(strikePool(newPoolPractice(),20,50))).toEqual(result);
  });
  it('finishes only when every object ball is pocketed',()=>{
    const initial=newPoolPractice();
    const balls=initial.balls.map(b=>b.id===0?b:{...b,pocketed:true});
    const complete=stepPool({...initial,balls,status:'moving',pocketed:5});
    expect(complete.status).toBe('complete');
    expect(strikePool(complete,0,60)).toBe(complete);
    expect(stepPool(complete)).toBe(complete);
  });
});
