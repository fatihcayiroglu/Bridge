import { describe,expect,it } from 'vitest';
import { POOL_POCKETS, newPoolPractice, strikePool, stepPool,
  type PoolState, type PoolPocketEvent } from '../js/core/activities/pool-practice-physics.ts';
import { newLocalEightBallRules, type LocalEightBallRules } from
  './prototypes/pool-eight-ball-rules.ts';
import { declareLocalPoolCall, evaluateLocalPoolCall, resolveLocalCalledEightBallShot } from
  './prototypes/pool-called-pocket.ts';

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
  cueScratch=false,firstObjectHit:number|null=1):PoolState {
  const ids=new Set(events.map(e=>e.ballId).filter(id=>id!==0));
  return {...before,shots:before.shots+1,status:'ready',
    balls:before.balls.map(b=>ids.has(b.id)?{...b,pocketed:true}:b),
    pocketed:before.pocketed+ids.size,
    scratches:before.scratches+(cueScratch?1:0),
    firstObjectHit,railAfterContact:true,pocketEvents:events};
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
  it('real cue scratch and target pocket produce distinct physical pocket IDs before cue respot',()=>{
    const init=newPoolPractice(),cuePocket=POOL_POCKETS[1],targetPocket=POOL_POCKETS[0];
    const before={...init,shots:2,balls:init.balls.map(b=>
      b.id===0?{...b,x:cuePocket.x-.02,z:cuePocket.z+.02}:
      b.id===1?{...b,x:targetPocket.x+.02,z:targetPocket.z+.02}:b)};
    let moving=strikePool(before,0,30);
    moving=stepPool(moving);
    expect(moving.pocketEvents).toContainEqual({ballId:0,pocketIndex:1});
    expect(moving.pocketEvents).toContainEqual({ballId:1,pocketIndex:0});
    expect(moving.scratches).toBe(1);
    expect(moving.balls.find(b=>b.id===0)?.pocketed).toBe(false);
    const call=declareLocalPoolCall(assigned(),before,0,'ball',1,0)!;
    const out=evaluateLocalPoolCall(assigned(),before,moving,call);
    expect(out).toMatchObject({calledBallInPocket:true,scratched:true});
    const next=resolveLocalCalledEightBallShot(assigned(),before,moving,call);
    expect(next?.rules.last?.foul).toBe('scratch');
    expect(next?.rules.ballInHand).toBe('anywhere');
    expect(next?.rules.currentPlayer).toBe(1);
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

describe('local called-pocket integration: never award turn for the wrong pocket',()=>{
  it('retains the assigned-group turn only when the called ball enters the selected pocket',()=>{
    const r=assigned(),b=table();
    const call=declareLocalPoolCall(r,b,0,'ball',1,0)!;
    for(const [pocket,expected] of [[0,0],[1,1]] as const){
      const after=afterShot(b,[{ballId:1,pocketIndex:pocket}]);
      const result=resolveLocalCalledEightBallShot(r,b,after,call);
      expect(result?.rules.currentPlayer).toBe(expected);
      expect(result?.rules.last?.retainedTurn).toBe(pocket===0);
      expect(result?.rules.phase).toBe('assigned');
    }
  });
  it('a legal safety passes even if the shooter pockets an own-class target',()=>{
    const r=assigned(),b=table();
    const safety=declareLocalPoolCall(r,b,0,'safety')!;
    const result=resolveLocalCalledEightBallShot(r,b,
      afterShot(b,[{ballId:1,pocketIndex:0}]),safety)!;
    expect(result.evidence.safety).toBe(true);
    expect(result.rules.currentPlayer).toBe(1);
    expect(result.rules.groups).toEqual(r.groups);
    expect(result.rules.last?.retainedTurn).toBe(false);
  });
  it('open table assigns by the CALLED pocket, not the first mixed ball in the physics list',()=>{
    const r={...newLocalEightBallRules(),phase:'open' as const,shotsResolved:2};
    const b=table();
    const call=declareLocalPoolCall(r,b,0,'ball',9,4)!;
    const a=afterShot(b,[{ballId:1,pocketIndex:0},{ballId:9,pocketIndex:4}]);
    const result=resolveLocalCalledEightBallShot(r,b,a,call);
    expect(result?.rules.groups).toEqual(['stripes','solids']);
    expect(result?.rules.phase).toBe('assigned');
    expect(result?.rules.currentPlayer).toBe(0);
    expect(result?.rules.last?.retainedTurn).toBe(true);
  });
  it('a mixed-group safety or missed call leaves open-table ownership unassigned',()=>{
    const r={...newLocalEightBallRules(),phase:'open' as const,shotsResolved:2};
    const b=table(),events=[{ballId:1,pocketIndex:0},{ballId:9,pocketIndex:1}];
    const safety=declareLocalPoolCall(r,b,0,'safety')!;
    const missed=declareLocalPoolCall(r,b,0,'ball',1,5)!;
    for(const call of [safety,missed]) {
      const result=resolveLocalCalledEightBallShot(r,b,afterShot(b,events),call);
      expect(result?.rules.phase).toBe('open');
      expect(result?.rules.currentPlayer).toBe(1);
      expect(result?.rules.groups).toEqual([null,null]);
    }
  });
  it('uncalled eight falling in any pocket loses, even if another called shot succeeds',()=>{
    const r=assigned(),b=table();
    const call=declareLocalPoolCall(r,b,0,'ball',1,0)!;
    const result=resolveLocalCalledEightBallShot(r,b,
      afterShot(b,[{ballId:1,pocketIndex:0},{ballId:8,pocketIndex:5}]),call)!;
    expect(result.evidence.calledBallInPocket).toBe(true);
    expect(result.evidence.eightPocketedOutsideCall).toBe(true);
    expect(result.rules.phase).toBe('finished');
    expect(result.rules.winner).toBe(1);
    expect(result.rules.last?.retainedTurn).toBe(false);
  });
  it('correctly called eight wins ONLY in the specified pocket after own group clears',()=>{
    const r=assigned(),b=table([1,2,3,4,5,6,7]);
    const call=declareLocalPoolCall(r,b,0,'ball',8,2)!;
    const correct=resolveLocalCalledEightBallShot(r,b,afterShot(b,[
      {ballId:8,pocketIndex:2}],false,8),call);
    expect(correct?.rules.winner).toBe(0);
    expect(correct?.rules.phase).toBe('finished');
    const wrong=resolveLocalCalledEightBallShot(r,b,afterShot(b,[
      {ballId:8,pocketIndex:1}],false,8),call);
    expect(wrong?.rules.winner).toBe(1);
    expect(wrong?.evidence.eightPocketedOutsideCall).toBe(true);
  });
  it('scratch on a called pocket still transfers turn with explicit cue placement required',()=>{
    const r=assigned(),b=table();
    const call=declareLocalPoolCall(r,b,0,'ball',1,0)!;
    const shot=afterShot(b,[{ballId:1,pocketIndex:0},{ballId:0,pocketIndex:3}],true);
    const result=resolveLocalCalledEightBallShot(r,b,shot,call);
    expect(result?.evidence.scratched).toBe(true);
    expect(result?.rules.last?.foul).toBe('scratch');
    expect(result?.rules.last?.retainedTurn).toBe(false);
    expect(result?.rules.ballInHand).toBe('anywhere');
    expect(result?.rules.currentPlayer).toBe(1);
  });
  it('a malformed or replayed pocket trace cannot advance local rule state',()=>{
    const r=assigned(),b=table();
    const call=declareLocalPoolCall(r,b,0,'ball',1,0)!;
    const after=afterShot(b,[{ballId:1,pocketIndex:0}]);
    expect(resolveLocalCalledEightBallShot(r,b,{
      ...after,pocketEvents:[{ballId:1,pocketIndex:0},{ballId:1,pocketIndex:0}]},call)).toBeNull();
    expect(resolveLocalCalledEightBallShot(r,b,{...after,status:'moving'},call)).toBeNull();
    expect(resolveLocalCalledEightBallShot(r,b,after,{...call,shot:4})).toBeNull();
  });
});
