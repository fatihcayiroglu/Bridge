import { describe, expect, it } from 'vitest';
import { newPoolPractice, type PoolState } from '../js/core/activities/pool-practice-physics.ts';
import { newLocalEightBallRules, resolveLocalEightBallShot } from
  '../js/core/activities/pool-eight-ball-rules.ts';
import { placeLocalCueBall, POOL_HEAD_STRING_Z } from
  '../js/core/activities/pool-ball-in-hand.ts';

const base=()=>newPoolPractice();
function fullRulesFoul(first:number|null, scratch=false) {
  const rules={...newLocalEightBallRules(),phase:'assigned' as const,
    groups:['solids','stripes'] as const,shotsResolved:2};
  const before={...base(),shots:2};
  const after:PoolState={...before,shots:3,firstObjectHit:first,
    railAfterContact:false,scratches:scratch?1:0};
  const next=resolveLocalEightBallShot(rules,before,after);
  expect(next).not.toBeNull();
  return {rules:next!,table:after,before};
}

describe('local ball-in-hand permission and physical placement',()=>{
  it('awards ANYWHERE placement to opponent after a missed first contact',()=>{
    const {rules,table}=fullRulesFoul(null);
    expect(rules.ballInHand).toBe('anywhere');
    expect(rules.currentPlayer).toBe(1);
    expect(resolveLocalEightBallShot(rules,table,{...table,shots:4})).toBeNull();
    const chosen=placeLocalCueBall(rules,table,1,-1.1,1.4);
    expect(chosen).not.toBeNull();
    expect(chosen?.rules.ballInHand).toBeNull();
    expect(chosen?.table.balls.find(b=>b.id===0)).toMatchObject({
      x:-1.1,z:1.4,pocketed:false,vx:0,vz:0,
    });
    expect(table.balls.find(b=>b.id===0)?.x).toBe(0);
    expect(rules.ballInHand).toBe('anywhere');
  });
  it('blocks original shooter, unauthorized actor and replay after placement',()=>{
    const {rules,table}=fullRulesFoul(null);
    expect(placeLocalCueBall(rules,table,0,0,0)).toBeNull();
    expect(placeLocalCueBall(rules,table,2 as never,0,0)).toBeNull();
    const placed=placeLocalCueBall(rules,table,1,0,0)!;
    expect(placeLocalCueBall(placed.rules,placed.table,1,0,0)).toBeNull();
  });
  it('allows head-string only after a LEGAL break scratch, not anywhere',()=>{
    const before=base();
    const after:PoolState={...before,shots:1,scratches:1,
      pocketed:1,balls:before.balls.map(b=>b.id===1?{...b,pocketed:true}:b),
      firstObjectHit:1,railAfterContact:true};
    const rules=resolveLocalEightBallShot(newLocalEightBallRules(),before,after)!;
    expect(rules.phase).toBe('open');
    expect(rules.currentPlayer).toBe(1);
    expect(rules.ballInHand).toBe('head-string');
    expect(placeLocalCueBall(rules,after,1,0,POOL_HEAD_STRING_Z-.001)).toBeNull();
    const placed=placeLocalCueBall(rules,after,1,0,POOL_HEAD_STRING_Z);
    expect(placed?.table.balls.find(b=>b.id===0)?.z).toBe(POOL_HEAD_STRING_Z);
  });
  it('rejects overlap with ANY remaining object, zero-radius and nonfinite values',()=>{
    const {rules,table}=fullRulesFoul(null);
    const ball=table.balls.find(b=>b.id===1)!;
    expect(placeLocalCueBall(rules,table,1,ball.x,ball.z)).toBeNull();
    expect(placeLocalCueBall(rules,table,1,ball.x+.27,ball.z)).toBeNull();
    for(const v of [NaN,Infinity,-Infinity]){
      expect(placeLocalCueBall(rules,table,1,v,0)).toBeNull();
      expect(placeLocalCueBall(rules,table,1,0,v)).toBeNull();
    }
    expect(placeLocalCueBall(rules,table,1,0,0)).not.toBeNull();
  });
  it('rejects rail overhang and pocket mouths without silently clamping',()=>{
    const {rules,table}=fullRulesFoul(null);
    for(const [x,z] of [[2.1,0],[-2.1,0],[0,4],[0,-4],[1.78,3.60],
      [-1.78,-3.6]]){
      expect(placeLocalCueBall(rules,table,1,x,z)).toBeNull();
    }
    expect(placeLocalCueBall(rules,table,1,-1.4,1.9)?.table.balls[0]?.x).toBe(-1.4);
  });
  it('refuses active motion, corrupt inventories, moving balls and mismatched shot',()=>{
    const {rules,table}=fullRulesFoul(null);
    expect(placeLocalCueBall(rules,{...table,status:'moving'},1,0,0)).toBeNull();
    expect(placeLocalCueBall(rules,{...table,shots:9},1,0,0)).toBeNull();
    expect(placeLocalCueBall(rules,{...table,balls:table.balls.slice(1)},1,0,0)).toBeNull();
    expect(placeLocalCueBall(rules,{...table,balls:table.balls.map(b=>
      b.id===2?{...b,id:1}:b)},1,0,0)).toBeNull();
    expect(placeLocalCueBall(rules,{...table,balls:table.balls.map(b=>
      b.id===1?{...b,vx:.1}:b)},1,0,0)).toBeNull();
    expect(placeLocalCueBall(rules,{...table,balls:table.balls.map(b=>
      b.id===0?{...b,pocketed:true}:b)},1,0,0)).toBeNull();
  });
  it('does not permit placement during a completed game or illegal-break choice',()=>{
    const {rules,table}=fullRulesFoul(null);
    expect(placeLocalCueBall({...rules,phase:'finished',winner:0},table,1,0,0)).toBeNull();
    expect(placeLocalCueBall({...rules,phase:'illegal-break-choice'},table,1,0,0)).toBeNull();
    expect(placeLocalCueBall({...rules,ballInHand:null},table,1,0,0)).toBeNull();
  });
  it('requires explicit placement after wrong first ball or scratch, not only misses',()=>{
    for(const [hit,scratch] of [[10,false],[1,true]] as const) {
      const {rules,table}=fullRulesFoul(hit,scratch);
      expect(rules.currentPlayer).toBe(1);
      expect(rules.ballInHand).toBe('anywhere');
      const next=placeLocalCueBall(rules,table,1,0,0);
      expect(next?.rules.ballInHand).toBeNull();
    }
  });
});
