import { describe,expect,it } from 'vitest';
import { POOL_POCKETS, newPoolPractice, strikePool, stepPool,
  type PoolState, type PoolPocketEvent } from '../js/core/activities/pool-practice-physics.ts';
import { newLocalEightBallRules, type LocalEightBallRules } from
  '../js/core/activities/pool-eight-ball-rules.ts';
import { declareLocalPoolCall, evaluateLocalPoolCall } from
  '../js/core/activities/pool-called-pocket.ts';

const assigned=(group:'solids'|'stripes'='solids'):LocalEightBallRules=>({
  ...newLocalEightBallRules(),phase:'assigned',shotsResolved:2,currentPlayer:0,
  groups:group==='solids'?['solids','stripes']:['stripes','solids'],
});
const table=(pocketed:readonly number[]=[]):PoolState=>{
  const initial=newPoolPractice();
  return {...initial,shots:2,balls:initial.balls.map(b=>pocketed.includes(b.id)?
    {...b,pocketed:true}:b),pocketed:pocketed.length};
};
function afterShot(before:PoolState,events:readonly PoolPocketEvent[],
  cueScratch=false):PoolState {
  const ids=new Set(events.map(e=>e.ballId).filter(id=>id!==0));
  return {...before,shots:before.shots+1,status:'ready',
    balls:before.balls.map(b=>ids.has(b.id)?{...b,pocketed:true}:b),
    pocketed:before.pocketed+ids.size,
    scratches:before.scratches+(cueScratch?1:0),
    pocketEvents:events};
}
describe('8-ball called shot/pocket contract: local-only, not an official match',()=>{
  it('requires a pre-shot ball and valid named pocket for the active player',()=>{
    const rules=assigned(), before=table();
    expect(declareLocalPoolCall(rules,before,0,'ball',1,3)).toEqual({
      kind:'ball',player:0,shot:3,ballId:1,pocketIndex:3});
    for(const id of [0,8,9,15,-1,16,NaN,Infinity]){
      expect(declareLocalPoolCall(rules,before,0,'ball',id,3)).toBeNull();
    }
    for(const i of [-1,6,1.5,NaN,Infinity]){
      expect(declareLocalPoolCall(rules,before,0,'ball',1,i)).toBeNull();
    }
    expect(declareLocalPoolCall(rules,before,1,'ball',1,3)).toBeNull();
    expect(declareLocalPoolCall(rules,before,0,'ball',1)).toBeNull();
    expect(declareLocalPoolCall(rules,before,0,'ball',1,3.1)).toBeNull();
    expect(declareLocalPoolCall(rules,before,0,'ball',1,3)).not.toBeNull();
  });
  it('checks actual pocket identity, not just the selected ball pocketed boolean',()=>{
    const rules=assigned(),before=table();
    const call=declareLocalPoolCall(rules,before,0,'ball',1,0)!;
    const correct=afterShot(before,[{ballId:1,pocketIndex:0}]);
    const wrong=afterShot(before,[{ballId:1,pocketIndex:5}]);
    expect(evaluateLocalPoolCall(rules,before,correct,call)).toMatchObject({
      calledBallInPocket:true,safety:false,eightPocketedOutsideCall:false});
    expect(evaluateLocalPoolCall(rules,before,wrong,call)?.calledBallInPocket).toBe(false);
    expect(evaluateLocalPoolCall(rules,before,afterShot(before,[
      {ballId:9,pocketIndex:0}]),call)?.calledBallInPocket).toBe(false);
  });
  it('safety is distinct from a ball call and remains safety if objects pocket',()=>{
    const rules=assigned(),before=table();
    const call=declareLocalPoolCall(rules,before,0,'safety');
    expect(call).toEqual({kind:'safety',player:0,shot:3});
    expect(declareLocalPoolCall(rules,before,0,'safety',1,0)).toBeNull();
    expect(evaluateLocalPoolCall(rules,before,
      afterShot(before,[{ballId:1,pocketIndex:5}]),call!)).toMatchObject({
        safety:true,calledBallInPocket:false,scratched:false});
  });
  it('open table allows either object class but blocks provisional black calls',()=>{
    const rules={...newLocalEightBallRules(),phase:'open' as const,shotsResolved:2};
    const before=table();
    expect(declareLocalPoolCall(rules,before,0,'ball',1,0)).not.toBeNull();
    expect(declareLocalPoolCall(rules,before,0,'ball',9,5)).not.toBeNull();
    expect(declareLocalPoolCall(rules,before,0,'ball',8,0)).toBeNull();
    expect(declareLocalPoolCall({...rules,phase:'break'},before,0,'ball',1,0)).toBeNull();
  });
  it('permits called eight ONLY when own assigned seven targets were cleared before shot',()=>{
    const rules=assigned();
    const withOne=table([1,2,3,4,5,6]);
    const clear=table([1,2,3,4,5,6,7]);
    expect(declareLocalPoolCall(rules,withOne,0,'ball',8,1)).toBeNull();
    expect(declareLocalPoolCall(rules,clear,0,'ball',8,1)).toEqual({
      kind:'ball',player:0,shot:3,ballId:8,pocketIndex:1});
    expect(declareLocalPoolCall(rules,clear,0,'ball',7,1)).toBeNull();
    const proper=afterShot(clear,[{ballId:8,pocketIndex:1}]);
    const wrong=afterShot(clear,[{ballId:8,pocketIndex:0}]);
    const call=declareLocalPoolCall(rules,clear,0,'ball',8,1)!;
    expect(evaluateLocalPoolCall(rules,clear,proper,call)).toMatchObject({
      calledBallInPocket:true,eightPocketedOutsideCall:false});
    expect(evaluateLocalPoolCall(rules,clear,wrong,call)).toMatchObject({
      calledBallInPocket:false,eightPocketedOutsideCall:true});
  });
  it('reports uncalled eight separately, never silently claiming a legitimate win',()=>{
    const rules=assigned(), before=table();
    const call=declareLocalPoolCall(rules,before,0,'ball',1,2)!;
    const outcome=evaluateLocalPoolCall(rules,before,
      afterShot(before,[{ballId:1,pocketIndex:2},{ballId:8,pocketIndex:4}]),call);
    expect(outcome).toMatchObject({calledBallInPocket:true,eightPocketedOutsideCall:true});
  });
  it('rejects before-shot declaration after active motion, ball-in-hand, finished state or replay',()=>{
    const r=assigned(),b=table();
    expect(declareLocalPoolCall(r,{...b,status:'moving'},0,'ball',1,0)).toBeNull();
    expect(declareLocalPoolCall({...r,ballInHand:'anywhere'},b,0,'ball',1,0)).toBeNull();
    expect(declareLocalPoolCall({...r,phase:'finished',winner:1},b,0,'ball',1,0)).toBeNull();
    expect(declareLocalPoolCall(r,{...b,shots:99},0,'ball',1,0)).toBeNull();
    const c=declareLocalPoolCall(r,b,0,'ball',1,0)!;
    expect(evaluateLocalPoolCall(r,b,{...afterShot(b,[{ballId:1,pocketIndex:0}]),shots:8},c)).toBeNull();
    expect(evaluateLocalPoolCall(r,b,afterShot(b,[{ballId:1,pocketIndex:0}]),
      {...c,shot:4})).toBeNull();
  });
  it('rejects forged pocket evidence, duplicated IDs and wrong pocket counts',()=>{
    const r=assigned(),b=table();
    const call=declareLocalPoolCall(r,b,0,'ball',1,2)!;
    const proper=afterShot(b,[{ballId:1,pocketIndex:2}]);
    const invalid=[
      {...proper,pocketEvents:[]},
      {...proper,pocketEvents:[...proper.pocketEvents,...proper.pocketEvents]},
      {...proper,pocketEvents:[{ballId:2,pocketIndex:2}]},
      {...proper,pocketEvents:[{ballId:1,pocketIndex:6}]},
      {...proper,pocketEvents:[{ballId:1,pocketIndex:-1}]},
      {...proper,pocketEvents:[{ballId:1,pocketIndex:1.5}]},
      {...proper,pocketEvents:[{ballId:1,pocketIndex:NaN}]},
      {...proper,pocketed:4},
      {...proper,status:'moving' as const},
      {...proper,balls:proper.balls.slice(1)},
      {...proper,balls:proper.balls.map(x=>x.id===2?{...x,id:1}:x)},
      {...proper,balls:proper.balls.map(x=>x.id===2?{...x,pocketed:true}:x)},
    ];
    for(const v of invalid)expect(evaluateLocalPoolCall(r,b,v,call)).toBeNull();
  });
  it('requires cue pocket evidence to match scratch difference, not auto-respot ambiguity',()=>{
    const r=assigned(),b=table();
    const call=declareLocalPoolCall(r,b,0,'ball',1,0)!;
    const after=afterShot(b,[{ballId:1,pocketIndex:0},{ballId:0,pocketIndex:2}],true);
    expect(evaluateLocalPoolCall(r,b,after,call)).toMatchObject({
      calledBallInPocket:true,scratched:true});
    expect(evaluateLocalPoolCall(r,b,{...after,pocketEvents:[
      {ballId:1,pocketIndex:0}]},call)).toBeNull();
    expect(evaluateLocalPoolCall(r,b,{...after,scratches:b.scratches},call)).toBeNull();
  });
  it('real fixed-step physics emits actual pocket index, survives shot settle and resets on next strike',()=>{
    const init=newPoolPractice();
    const position=POOL_POCKETS[0];
    const before={...init,shots:2,balls:init.balls.map(b=>b.id===1?
      {...b,x:position.x+.02,z:position.z+.02}:b)};
    let running=strikePool(before,0,45);
    running=stepPool(running);
    expect(running.pocketEvents).toContainEqual({ballId:1,pocketIndex:0});
    for(let i=0;i<6000&&running.status==='moving';i++)running=stepPool(running);
    expect(running.status).not.toBe('moving');
    const call=declareLocalPoolCall(assigned(),before,0,'ball',1,0)!;
    expect(evaluateLocalPoolCall(assigned(),before,running,call)?.calledBallInPocket).toBe(true);
    const next=strikePool(running,0,30);
    expect(next.pocketEvents).toEqual([]);
    expect(running.pocketEvents).toContainEqual({ballId:1,pocketIndex:0});
  });
});
