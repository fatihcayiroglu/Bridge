import {describe,expect,it} from 'vitest';
import {newPoolPractice,strikePool,stepPool,POOL_POCKETS,type PoolState}
  from '../js/core/activities/pool-practice-physics.ts';
import {declarePracticePocketCall,settlePracticePocketCall} from
  '../js/core/activities/pool-practice-call.ts';

function completed(callBall=1,pocket=0):PoolState {
  const original=newPoolPractice(),point=POOL_POCKETS[pocket]!;
  const before={...original,shots:2,balls:original.balls.map(b=>b.id===callBall?
    {...b,x:point.x+.01,z:point.z+.01}:b)};
  let state=strikePool(before,0,45);
  for(let i=0;i<6000&&state.status==='moving';i++)state=stepPool(state);
  expect(state.status).not.toBe('moving');
  return state;
}
describe('solo-only opt-in called-pocket challenge (not tournament 8-ball)',()=>{
  it('creates a bounded declaration only before a stroke and for a visible target',()=>{
    const initial=newPoolPractice();
    expect(declarePracticePocketCall(initial,1,0)).toEqual({shot:1,ballId:1,pocketIndex:0});
    for(const id of [0,-1,16,1.5,NaN,Infinity])
      expect(declarePracticePocketCall(initial,id,0)).toBeNull();
    for(const pocket of [-1,6,1.5,NaN,Infinity])
      expect(declarePracticePocketCall(initial,1,pocket)).toBeNull();
    expect(declarePracticePocketCall({...initial,status:'moving'},1,0)).toBeNull();
    expect(declarePracticePocketCall({...initial,shots:999},1,0)).toBeNull();
    expect(declarePracticePocketCall({...initial,balls:initial.balls.map(b=>b.id===1?
      {...b,pocketed:true}:b)},1,0)).toBeNull();
  });
  it('real fixed-step physics accepts the EXACT chosen pocket, not any pocket',()=>{
    const finished=completed(1,0);
    expect(finished.pocketEvents).toContainEqual({ballId:1,pocketIndex:0});
    expect(settlePracticePocketCall(finished,{shot:3,ballId:1,pocketIndex:0})).toBe('made');
    expect(settlePracticePocketCall(finished,{shot:3,ballId:1,pocketIndex:5})).toBe('missed');
    expect(settlePracticePocketCall(finished,{shot:3,ballId:9,pocketIndex:0})).toBe('missed');
  });
  it('rejects moving/stale shot, forged pocket inventory and duplicate events',()=>{
    const complete=completed();
    const call={shot:3,ballId:1,pocketIndex:0};
    expect(settlePracticePocketCall({...complete,status:'moving'},call)).toBeNull();
    expect(settlePracticePocketCall({...complete,shots:4},call)).toBeNull();
    expect(settlePracticePocketCall({...complete,pocketed:15},call)).toBeNull();
    expect(settlePracticePocketCall({...complete,pocketEvents:[]},call)).toBe('missed');
    expect(settlePracticePocketCall({...complete,pocketEvents:[
      ...complete.pocketEvents,...complete.pocketEvents]},call)).toBeNull();
    expect(settlePracticePocketCall({...complete,pocketEvents:[
      {ballId:1,pocketIndex:6}]},call)).toBeNull();
    expect(settlePracticePocketCall({...complete,balls:complete.balls.slice(1)},call)).toBeNull();
    expect(settlePracticePocketCall(complete,{...call,shot:2})).toBeNull();
    expect(settlePracticePocketCall(complete,{...call,pocketIndex:6})).toBeNull();
  });
});
