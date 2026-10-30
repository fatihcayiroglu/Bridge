import {describe,expect,it} from 'vitest';
import {
  POOL_FOOT_SPOT_Z, POOL_HALF_LENGTH, POOL_RADIUS, newPoolPractice,
  strikePool, type PoolState,
} from '../js/core/activities/pool-practice-physics.ts';
import {newLocalEightBallRules,resolveLocalEightBallShot} from
  '../js/core/activities/pool-eight-ball-rules.ts';
import {chooseLocalEightOnBreak} from
  '../js/core/activities/pool-eight-on-break.ts';
import {placeLocalCueBall} from '../js/core/activities/pool-ball-in-hand.ts';

function pocketedEightBreak(scratched=false,extra:number[]=[]){
  const before=newPoolPractice();
  const pockets=new Set([8,...extra]);
  const balls=before.balls.map(b=>pockets.has(b.id)?{...b,pocketed:true}:b);
  const events=[...pockets].map(ballId=>({ballId,pocketIndex:0}));
  if(scratched)events.push({ballId:0,pocketIndex:5});
  const table:PoolState={...before,shots:1,status:'ready',
    balls,pocketed:pockets.size,scratches:scratched?1:0,
    firstObjectHit:1,railAfterContact:true,
    pocketEvents:events};
  const rules=resolveLocalEightBallShot(newLocalEightBallRules(),before,table);
  expect(rules?.phase).toBe('eight-respot-required');
  expect(rules?.winner).toBeNull();
  return {rules:rules!,table};
}
describe('local-only WPA 8-ball-on-break choices and physical respot',()=>{
  it('a legal break with black pocketed gives the original breaker the choice',()=>{
    const {rules,table}=pocketedEightBreak(false,[1]);
    expect(rules.currentPlayer).toBe(0);
    expect(chooseLocalEightOnBreak(rules,table,1,'spot-eight')).toBeNull();
    const spotted=chooseLocalEightOnBreak(rules,table,0,'spot-eight');
    expect(spotted?.rules).toMatchObject({
      phase:'open',currentPlayer:0,winner:null,ballInHand:null,shotsResolved:1,
    });
    expect(spotted?.table.shots).toBe(1);
    expect(spotted?.table.pocketed).toBe(1);
    expect(spotted?.table.balls.find(b=>b.id===8)?.pocketed).toBe(false);
    expect(spotted?.table.balls.find(b=>b.id===1)?.pocketed).toBe(true);
    expect(spotted?.table.pocketEvents).toEqual(table.pocketEvents);
    expect(table.balls.find(b=>b.id===8)?.pocketed).toBe(true);
    expect(chooseLocalEightOnBreak(spotted!.rules,spotted!.table,0,'spot-eight')).toBeNull();
    const nextStroke=strikePool(spotted!.table,0,50);
    expect(nextStroke.pocketEvents).toEqual([]);
    expect(nextStroke.status).toBe('moving');
  });
  it('the legal breaker may rerack and break again, never awarding an instant win',()=>{
    const {rules,table}=pocketedEightBreak();
    const rerack=chooseLocalEightOnBreak(rules,table,0,'rerack');
    expect(rerack?.rules).toMatchObject({
      phase:'break',currentPlayer:0,shotsResolved:0,ballInHand:null,winner:null,
    });
    expect(rerack?.table).toEqual(newPoolPractice());
    expect(rerack?.table).not.toBe(table);
    expect(rules.phase).toBe('eight-respot-required');
  });
  it('a scratch + eight pocketed awards options to opponent, not breaker',()=>{
    const {rules,table}=pocketedEightBreak(true,[3]);
    expect(rules.currentPlayer).toBe(1);
    expect(chooseLocalEightOnBreak(rules,table,0,'rerack')).toBeNull();
    const spotted=chooseLocalEightOnBreak(rules,table,1,'spot-eight');
    expect(spotted?.rules).toMatchObject({
      phase:'open',currentPlayer:1,ballInHand:'head-string',winner:null,
    });
    expect(placeLocalCueBall(spotted!.rules,spotted!.table,0,0,2.7)).toBeNull();
    expect(placeLocalCueBall(spotted!.rules,spotted!.table,1,0,1.8)).toBeNull();
    const placed=placeLocalCueBall(spotted!.rules,spotted!.table,1,0,2.7);
    expect(placed?.rules.ballInHand).toBeNull();
    expect(placed?.table.pocketed).toBe(table.pocketed-1);
    const rerack=chooseLocalEightOnBreak(rules,table,1,'rerack');
    expect(rerack?.rules).toMatchObject({phase:'break',currentPlayer:1,shotsResolved:0});
    expect(rerack?.table).toEqual(newPoolPractice());
  });
  it('physical spot is on the long string and never intersects a surviving ball',()=>{
    const {rules,table}=pocketedEightBreak(false);
    const result=chooseLocalEightOnBreak(rules,table,0,'spot-eight');
    expect(result).not.toBeNull();
    const eight=result!.table.balls.find(b=>b.id===8)!;
    expect(eight.x).toBe(0);
    expect(eight.z).toBeLessThanOrEqual(POOL_FOOT_SPOT_Z);
    expect(eight.z).toBeGreaterThan(-POOL_HALF_LENGTH+POOL_RADIUS);
    for(const b of result!.table.balls){
      if(b.id===8||b.pocketed)continue;
      expect(Math.hypot(eight.x-b.x,eight.z-b.z)).toBeGreaterThan(POOL_RADIUS*2);
    }
  });
  it('foot spot is selected exactly when free; nearest below when it is blocked',()=>{
    const {rules,table}=pocketedEightBreak(false);
    const clear={...table,balls:table.balls.map(b=>
      b.id===0?b:b.id===8?b:{...b,pocketed:true}),
      pocketed:15,
      pocketEvents:[...table.pocketEvents,...table.balls.filter(b=>b.id!==0&&b.id!==8)
        .map(b=>({ballId:b.id,pocketIndex:1}))]};
    // Build a coherent entire-break snapshot, since the selector refuses
    // stale/forged pocket totals and event histories.
    const otherPocketed=clear.balls.filter(b=>b.id>0&&b.pocketed).map(b=>b.id);
    const readyRules={...rules,last:{...rules.last!,
      pocketed:otherPocketed,eightPocketed:true}};
    const free=chooseLocalEightOnBreak(readyRules,clear,0,'spot-eight');
    expect(free?.table.balls.find(b=>b.id===8)?.z).toBeCloseTo(POOL_FOOT_SPOT_Z,8);
    const blocker={...table,balls:table.balls.map(b=>b.id===1?
      {...b,x:0,z:POOL_FOOT_SPOT_Z}:b)};
    const blocked=chooseLocalEightOnBreak(rules,blocker,0,'spot-eight');
    expect(blocked).not.toBeNull();
    expect(blocked!.table.balls.find(b=>b.id===8)!.z).toBeLessThan(POOL_FOOT_SPOT_Z);
  });
  it('refuses fabricated pocket events, wrong phases, moving balls and wrong turns',()=>{
    const {rules,table}=pocketedEightBreak();
    expect(chooseLocalEightOnBreak(rules,table,2 as never,'spot-eight')).toBeNull();
    expect(chooseLocalEightOnBreak(rules,table,0,'invalid' as never)).toBeNull();
    expect(chooseLocalEightOnBreak({...rules,phase:'finished'},table,0,'spot-eight')).toBeNull();
    expect(chooseLocalEightOnBreak(rules,{...table,status:'moving'},0,'spot-eight')).toBeNull();
    expect(chooseLocalEightOnBreak({...rules,last:{...rules.last!,actor:4 as never}},table,0,'spot-eight')).toBeNull();
    expect(chooseLocalEightOnBreak({...rules,last:{...rules.last!,pocketed:null as never}},table,0,'spot-eight')).toBeNull();
    expect(chooseLocalEightOnBreak(rules,{...table,scratches:2},0,'spot-eight')).toBeNull();
    expect(chooseLocalEightOnBreak(rules,{...table,shots:2},0,'spot-eight')).toBeNull();
    expect(chooseLocalEightOnBreak(rules,{...table,pocketed:3},0,'spot-eight')).toBeNull();
    expect(chooseLocalEightOnBreak(rules,{...table,pocketEvents:[]},0,'spot-eight')).toBeNull();
    expect(chooseLocalEightOnBreak(rules,{...table,pocketEvents:[
      {ballId:8,pocketIndex:0},{ballId:8,pocketIndex:1}]},0,'spot-eight')).toBeNull();
    expect(chooseLocalEightOnBreak(rules,{...table,balls:table.balls.map(b=>
      b.id===1?{...b,vx:1}:b)},0,'spot-eight')).toBeNull();
  });
  it('a completely occupied long string fails closed without reracking silently',()=>{
    const {rules,table}=pocketedEightBreak();
    const blockers=table.balls.filter(b=>b.id!==8);
    const from=-3.7,to=3.7;
    const balls=table.balls.map(b=>{
      if(b.id===8)return b;
      const i=blockers.findIndex(x=>x.id===b.id);
      return {...b,x:0,z:from+(to-from)*i/(blockers.length-1)};
    });
    const blocked={...table,balls};
    expect(chooseLocalEightOnBreak(rules,blocked,0,'spot-eight')).toBeNull();
    expect(chooseLocalEightOnBreak(rules,blocked,0,'rerack')?.rules.phase).toBe('break');
  });
});
