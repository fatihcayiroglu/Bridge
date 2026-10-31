import {describe,expect,it} from 'vitest';
import {
  newPoolPractice, POOL_POCKETS, type PoolState,
} from '../js/core/activities/pool-practice-physics.ts';
import {acceptLocalPoolPlacement} from
  '../js/core/activities/pool-local-placement.ts';
import {newLocalEightBallRules,resolveLocalEightBallShot} from
  './prototypes/pool-eight-ball-rules.ts';
import {placeLocalCueBall} from './prototypes/pool-ball-in-hand.ts';
import {chooseLocalEightOnBreak} from './prototypes/pool-eight-on-break.ts';

function eightOnBreak():PoolState {
  const base=newPoolPractice();
  return {...base,shots:1,pocketed:1,firstObjectHit:1,
    railAfterContact:true,
    pocketEvents:[{ballId:8,pocketIndex:0}],
    balls:base.balls.map(b=>b.id===8?{...b,pocketed:true}:b)};
}

describe('strict local-only physical handoff into the WebGL table',()=>{
  it('accepts a safe cue reposition only while settled and copies all state defensively',()=>{
    const state=newPoolPractice();
    const candidate={...state,balls:state.balls.map(b=>b.id===0?{...b,x:.55,z:2.5}:b)};
    const accepted=acceptLocalPoolPlacement(state,candidate);
    expect(accepted).not.toBeNull();
    expect(accepted?.balls.find(b=>b.id===0)).toMatchObject({x:.55,z:2.5});
    expect(state.balls.find(b=>b.id===0)).toMatchObject({x:0,z:2.7});
    expect(accepted?.balls).not.toBe(candidate.balls);
    expect(accepted?.balls[0]).not.toBe(candidate.balls[0]);
    expect(accepted?.pocketEvents).not.toBe(candidate.pocketEvents);
    expect(accepted?.breakObjectRails).not.toBe(candidate.breakObjectRails);
    expect(acceptLocalPoolPlacement(state,state)).toBeNull();
  });
  it('accepts an actual opening-break 8 respot without altering other objects',()=>{
    const state=eightOnBreak();
    const candidate={...state,pocketed:0,
      balls:state.balls.map(b=>b.id===8?{...b,x:0,z:0,pocketed:false}:b)};
    const accepted=acceptLocalPoolPlacement(state,candidate);
    expect(accepted?.pocketed).toBe(0);
    expect(accepted?.balls.find(b=>b.id===8)).toMatchObject({
      x:0,z:0,pocketed:false,vx:0,vz:0,
    });
    expect(accepted?.balls.find(b=>b.id===1)).toEqual(state.balls.find(b=>b.id===1));
    expect(accepted?.pocketEvents).toEqual([{ballId:8,pocketIndex:0}]);
    expect(state.balls.find(b=>b.id===8)?.pocketed).toBe(true);
  });
  it('accepts real prototype ball-in-hand and black-on-break physical outputs without granting permission itself',()=>{
    const old=newPoolPractice(),before={...old,shots:2};
    const after={...before,shots:3,firstObjectHit:null,railAfterContact:false};
    const rules=resolveLocalEightBallShot({
      ...newLocalEightBallRules(),phase:'assigned',shotsResolved:2,
      groups:['solids','stripes'],
    },before,after);
    expect(rules?.ballInHand).toBe('anywhere');
    const placed=placeLocalCueBall(rules!,after,1,-.9,1.2);
    expect(placed).not.toBeNull();
    expect(acceptLocalPoolPlacement(after,placed!.table)?.balls.find(b=>b.id===0))
      .toMatchObject({x:-.9,z:1.2});
    const eightState=eightOnBreak();
    const breakRules=resolveLocalEightBallShot(newLocalEightBallRules(),old,eightState);
    expect(breakRules?.phase).toBe('eight-respot-required');
    const respot=chooseLocalEightOnBreak(breakRules!,eightState,0,'spot-eight');
    expect(respot).not.toBeNull();
    expect(acceptLocalPoolPlacement(eightState,respot!.table)?.balls.find(b=>b.id===8)?.pocketed)
      .toBe(false);
  });
  it('rejects target movement, unpocketing a numbered ball and fake black recovery',()=>{
    const state=newPoolPractice();
    expect(acceptLocalPoolPlacement(state,{...state,balls:state.balls.map(b=>
      b.id===1?{...b,x:1.4}:b)})).toBeNull();
    expect(acceptLocalPoolPlacement(state,{...state,pocketed:-1})).toBeNull();
    const forged={...eightOnBreak(),pocketEvents:[]};
    expect(acceptLocalPoolPlacement(forged,{...forged,pocketed:0,
      balls:forged.balls.map(b=>b.id===8?{...b,pocketed:false,x:0,z:0}:b)})).toBeNull();
    const old=eightOnBreak();
    expect(acceptLocalPoolPlacement({...old,shots:2},{...old,shots:2,pocketed:0,
      balls:old.balls.map(b=>b.id===8?{...b,pocketed:false,x:0,z:0}:b)})).toBeNull();
    expect(acceptLocalPoolPlacement(old,{...old,pocketed:0,
      balls:old.balls.map(b=>b.id===8?{...b,pocketed:false,x:.4,z:0}:b)})).toBeNull();
  });
  it('rejects cue placement on any ball, pocket, rail or NaN coordinates',()=>{
    const state=newPoolPractice(),solid=state.balls.find(b=>b.id===1)!;
    for(const [x,z] of [[solid.x,solid.z],[solid.x+.1,solid.z],
      [2.2,1.5],[0,4.1],[POOL_POCKETS[0].x,POOL_POCKETS[0].z],
      [Infinity,0],[NaN,0],[0,-Infinity]]){
      const candidate={...state,balls:state.balls.map(b=>b.id===0?{...b,x,z}:b)};
      expect(acceptLocalPoolPlacement(state,candidate)).toBeNull();
    }
  });
  it('rejects forged strokes, scratch, motion, duplicate balls and inconsistent counters',()=>{
    const state=newPoolPractice();
    const move={...state,balls:state.balls.map(b=>b.id===0?{...b,x:.9,z:2.6}:b)};
    expect(acceptLocalPoolPlacement({...state,status:'moving'},move)).toBeNull();
    expect(acceptLocalPoolPlacement(state,{...move,status:'moving'})).toBeNull();
    expect(acceptLocalPoolPlacement(state,{...move,shots:1})).toBeNull();
    expect(acceptLocalPoolPlacement(state,{...move,scratches:1})).toBeNull();
    expect(acceptLocalPoolPlacement(state,{...move,pocketed:1})).toBeNull();
    expect(acceptLocalPoolPlacement(state,{...move,railAfterContact:true})).toBeNull();
    expect(acceptLocalPoolPlacement(state,{...move,pocketEvents:[{ballId:1,pocketIndex:0}]})).toBeNull();
    expect(acceptLocalPoolPlacement(state,{...move,breakObjectRails:[1]})).toBeNull();
    expect(acceptLocalPoolPlacement(state,{...move,balls:move.balls.map(b=>
      b.id===2?{...b,id:1}:b)})).toBeNull();
    expect(acceptLocalPoolPlacement(state,{...move,balls:move.balls.slice(1)})).toBeNull();
    expect(acceptLocalPoolPlacement(state,{...move,balls:move.balls.map(b=>
      b.id===2?{...b,vx:.2}:b)})).toBeNull();
  });
});
