import { describe, expect, it } from 'vitest';
import {
  POOL_POCKETS, newPoolPractice, stepPool, strikePool, type PoolState,
} from '../js/core/activities/pool-practice-physics.ts';
import {
  chooseLocalEightBallGroup, chooseLocalIllegalBreak, newLocalEightBallRules, resolveLocalEightBallShot,
  type LocalEightBallRules,
} from '../js/core/activities/pool-eight-ball-rules.ts';

type Options={
  pocket?:readonly number[]; first?:number|null; rail?:boolean; scratch?:boolean;
  breakRailIds?:readonly number[];
};
function shot(before:PoolState, o:Options={}) {
  const newly=new Set(o.pocket??[]);
  const balls=before.balls.map(b=>newly.has(b.id)?{...b,pocketed:true}:b);
  return {...before,balls,shots:before.shots+1,scratches:before.scratches+(o.scratch?1:0),
    pocketed:balls.filter(b=>b.id!==0&&b.pocketed).length,
    firstObjectHit:o.first??null,railAfterContact:o.rail??false,
    breakObjectRails:o.breakRailIds??[],status:'ready' as const};
}
function resolve(rules:LocalEightBallRules,before:PoolState,o:Options={}) {
  const after=shot(before,o);
  const next=resolveLocalEightBallShot(rules,before,after);
  expect(next).not.toBeNull();
  return {rules:next!,after};
}
function assigned(groups:readonly ['solids','stripes'] | readonly ['stripes','solids']=['solids','stripes']) {
  return {...newLocalEightBallRules(),phase:'assigned' as const,groups,shotsResolved:2};
}
describe('8-ball local-only adjudication foundation — no online or official rules claim',()=>{
  it('records a first cue/object collision from the real 120 Hz physics, not a guessed UI target',()=>{
    const initial=newPoolPractice();
    const balls=initial.balls.map(b=>b.id===1?{...b,x:0,z:2.35}:b);
    let running=strikePool({...initial,balls},0,70);
    expect(running.firstObjectHit).toBeNull();
    expect(running.railAfterContact).toBe(false);
    for(let i=0;i<45&&running.firstObjectHit===null;i++)running=stepPool(running);
    expect(running.firstObjectHit).toBe(1);
    const forcedRail=running.balls.map(b=>b.id===2?
      {...b,x:1.97,z:1.0,vx:1.6,vz:0}:b);
    const afterRail=stepPool({...running,balls:forcedRail,status:'moving'});
    expect(afterRail.firstObjectHit).toBe(1);
    expect(afterRail.railAfterContact).toBe(true);
    expect(afterRail.breakObjectRails).toContain(2);
    const duplicate=stepPool({...afterRail,balls:forcedRail,status:'moving'});
    expect(duplicate.breakObjectRails.filter(id=>id===2)).toHaveLength(1);
    const nextShot=strikePool({...afterRail,status:'ready'},0,50);
    expect(nextShot.firstObjectHit).toBeNull();
    expect(nextShot.railAfterContact).toBe(false);
    expect(nextShot.breakObjectRails).toEqual([]);
  });
  it('can score a full real 15-ball break using only emitted physics evidence',()=>{
    const before=newPoolPractice();
    let after=strikePool(before,0,100);
    for(let i=0;i<6000&&after.status==='moving';i++)after=stepPool(after);
    expect(after.status).not.toBe('moving');
    expect(after.shots).toBe(1);
    const next=resolveLocalEightBallShot(newLocalEightBallRules(),before,after);
    expect(next).not.toBeNull();
    expect(next?.shotsResolved).toBe(1);
    expect(next?.last?.firstObjectHit).toBe(after.firstObjectHit);
    expect(next?.last?.pocketed).toEqual(after.balls
      .filter(ball=>ball.id!==0&&ball.pocketed).map(ball=>ball.id).sort((a,b)=>a-b));
    expect(next?.winner).toBeNull();
  });
  it('keeps groups open on break and passes an empty legal shot',()=>{
    const {rules,after}=resolve(newLocalEightBallRules(),newPoolPractice(),
      {first:1,rail:true,breakRailIds:[1,2,3,4]});
    expect(rules.phase).toBe('open');
    expect(rules.currentPlayer).toBe(1);
    expect(rules.groups).toEqual([null,null]);
    expect(rules.last).toMatchObject({actor:0,pocketed:[],foul:null,retainedTurn:false});
    expect(after.shots).toBe(1);
  });
  it('blocks an illegal break with only three distinct cushions and requires incoming choice',()=>{
    const {rules,after}=resolve(newLocalEightBallRules(),newPoolPractice(),
      {first:1,rail:true,breakRailIds:[1,2,3]});
    expect(rules.phase).toBe('illegal-break-choice');
    expect(rules.currentPlayer).toBe(1);
    expect(rules.last?.foul).toBe('illegal-break');
    expect(rules.winner).toBeNull();
    expect(resolveLocalEightBallShot(rules,after,shot(after,{first:2}))).toBeNull();
  });
  it('requires the incoming player to choose acceptance or an ACTUAL fresh rack',()=>{
    const before=newPoolPractice();
    const {rules,after}=resolve(newLocalEightBallRules(),before,
      {first:1,rail:true,breakRailIds:[1,2]});
    const accept=chooseLocalIllegalBreak(rules,after,'accept-position');
    expect(accept?.rules.phase).toBe('open');
    expect(accept?.rules.currentPlayer).toBe(1);
    expect(accept?.table).toBe(after);
    expect(accept?.table.shots).toBe(1);
    const incoming=chooseLocalIllegalBreak(rules,after,'rerack-incoming-break');
    const original=chooseLocalIllegalBreak(rules,after,'rerack-original-break');
    expect(incoming?.rules).toMatchObject({phase:'break',currentPlayer:1,shotsResolved:0});
    expect(original?.rules).toMatchObject({phase:'break',currentPlayer:0,shotsResolved:0});
    expect(incoming?.table).toEqual(newPoolPractice());
    expect(original?.table).toEqual(newPoolPractice());
    expect(incoming?.table).not.toBe(after);
    expect(chooseLocalIllegalBreak(accept!.rules,after,'accept-position')).toBeNull();
    expect(chooseLocalIllegalBreak(rules,after,'arbitrary' as never)).toBeNull();
    expect(chooseLocalIllegalBreak(rules,{...after,status:'moving'},'accept-position')).toBeNull();
    expect(chooseLocalIllegalBreak(rules,{...after,shots:99},'accept-position')).toBeNull();
  });
  it('never accepts a scratched break via the practice auto-respot workaround',()=>{
    const {rules,after}=resolve(newLocalEightBallRules(),newPoolPractice(),
      {first:1,rail:true,breakRailIds:[1],scratch:true});
    expect(rules.phase).toBe('illegal-break-choice');
    expect(rules.last?.foul).toBe('scratch');
    expect(chooseLocalIllegalBreak(rules,after,'accept-position')).toBeNull();
    expect(chooseLocalIllegalBreak(rules,after,'rerack-incoming-break')?.rules.currentPlayer).toBe(1);
  });
  it('four DIFFERENT object cushions qualify even if nothing is pocketed',()=>{
    const {rules}=resolve(newLocalEightBallRules(),newPoolPractice(),
      {first:1,rail:true,breakRailIds:[1,2,3,4]});
    expect(rules.phase).toBe('open');
    expect(rules.last?.foul).toBeNull();
    expect(rules.currentPlayer).toBe(1);
  });
  it('a pocketed object qualifies an otherwise quiet break without four rail contacts',()=>{
    const {rules}=resolve(newLocalEightBallRules(),newPoolPractice(),
      {first:1,pocket:[5],rail:false,breakRailIds:[]});
    expect(rules.phase).toBe('open');
    expect(rules.currentPlayer).toBe(0);
    expect(rules.last?.pocketed).toEqual([5]);
  });
  it('rejects fabricated, duplicate or malformed break rail IDs before adjudication',()=>{
    const before=newPoolPractice(),r=newLocalEightBallRules();
    for(const ids of [[1,1,2,3],[0,1,2,3],[16,1,2,3],[-1,2,3,4],
      [1.5,2,3,4],[1,2,3,NaN]]) {
      expect(resolveLocalEightBallShot(r,before,shot(before,{
        first:1,rail:true,breakRailIds:ids,
      }))).toBeNull();
    }
    expect(resolveLocalEightBallShot(r,before,shot(before,{
      first:null,rail:true,breakRailIds:[1,2,3,4],
    }))).toBeNull();
    expect(resolveLocalEightBallShot(r,before,shot(before,{
      first:1,rail:false,breakRailIds:[1,2,3,4],
    }))).toBeNull();
  });
  it('rejects inherited break-rail evidence on a subsequent ordinary shot',()=>{
    const before={...newPoolPractice(),shots:2};
    const r=assigned();
    expect(resolveLocalEightBallShot(r,before,shot(before,{
      first:1,rail:true,breakRailIds:[1],
    }))).toBeNull();
  });
  it('never assigns solids or stripes on the break, even if one is pocketed',()=>{
    const {rules}=resolve(newLocalEightBallRules(),newPoolPractice(),
      {first:1,rail:true,pocket:[1,3]});
    expect(rules.phase).toBe('open');
    expect(rules.groups).toEqual([null,null]);
    expect(rules.currentPlayer).toBe(0);
  });
  it('recognizes scratch on break, passes turn and never claims a winner',()=>{
    const {rules}=resolve(newLocalEightBallRules(),newPoolPractice(),
      {first:1,rail:true,pocket:[2],scratch:true});
    expect(rules.last?.foul).toBe('scratch');
    expect(rules.currentPlayer).toBe(1);
    expect(rules.winner).toBeNull();
  });
  it('assigns correct groups after first legal post-break solid or stripe pocket',()=>{
    const first=resolve(newLocalEightBallRules(),newPoolPractice(),
      {first:1,rail:true,breakRailIds:[1,2,3,4]});
    const second=resolve(first.rules,first.after,{first:10,pocket:[10],rail:true});
    expect(second.rules.groups).toEqual(['solids','stripes']);
    expect(second.rules.phase).toBe('assigned');
    expect(second.rules.currentPlayer).toBe(1);
    expect(second.rules.last?.retainedTurn).toBe(true);
  });
  it('requires explicit selection on mixed open-table pocket, never arbitrarily assigns',()=>{
    const first=resolve(newLocalEightBallRules(),newPoolPractice(),
      {first:1,rail:true,breakRailIds:[1,2,3,4]});
    const second=resolve(first.rules,first.after,
      {first:2,pocket:[2,9],rail:true});
    expect(second.rules.phase).toBe('choose-group');
    expect(second.rules.groups).toEqual([null,null]);
    expect(resolveLocalEightBallShot(second.rules,second.after,shot(second.after,{first:1}))).toBeNull();
    const chose=chooseLocalEightBallGroup(second.rules,'stripes');
    expect(chose?.groups).toEqual(['solids','stripes']);
    expect(chose?.phase).toBe('assigned');
    expect(chooseLocalEightBallGroup(chose!,'solids')).toBeNull();
    expect(chooseLocalEightBallGroup(second.rules,'invalid' as never)).toBeNull();
  });
  it('detects no contact, wrong first ball and missing post-contact rail without awarding a turn',()=>{
    const base=assigned();
    const table={...newPoolPractice(),shots:2};
    for(const [option,code] of [
      [{first:null},'no-first-contact'],
      [{first:10,pocket:[3],rail:true},'illegal-first-contact'],
      [{first:1},'no-rail-after-contact'],
    ] as const) {
      const {rules}=resolve(base,table,option);
      expect(rules.last?.foul).toBe(code);
      expect(rules.currentPlayer).toBe(1);
      expect(rules.winner).toBeNull();
    }
  });
  it('pockets own class to retain turn, opponent class alone passes turn',()=>{
    const base=assigned();
    const table={...newPoolPractice(),shots:2};
    const own=resolve(base,table,{first:1,pocket:[1],rail:true});
    expect(own.rules.currentPlayer).toBe(0);
    expect(own.rules.last?.retainedTurn).toBe(true);
    const opponent=resolve(base,table,{first:1,pocket:[9],rail:true});
    expect(opponent.rules.currentPlayer).toBe(1);
    expect(opponent.rules.last?.retainedTurn).toBe(false);
  });
  it('early eight-ball loses even when a target is also pocketed',()=>{
    const base=assigned(),table={...newPoolPractice(),shots:2};
    const {rules}=resolve(base,table,{first:1,pocket:[1,8],rail:true});
    expect(rules.phase).toBe('finished');
    expect(rules.winner).toBe(1);
    expect(rules.last?.eightPocketed).toBe(true);
  });
  it('only a legal eight shot AFTER own group is cleared wins',()=>{
    const base=assigned();
    const initial=newPoolPractice();
    const before={...initial,shots:2,balls:initial.balls.map(b=>
      b.id>0&&b.id<=7?{...b,pocketed:true}:b),pocketed:7};
    const winner=resolve(base,before,{first:8,pocket:[8],rail:true}).rules;
    expect(winner.phase).toBe('finished');
    expect(winner.winner).toBe(0);
    const scratched=resolve(base,before,{first:8,pocket:[8],scratch:true}).rules;
    expect(scratched.winner).toBe(1);
    expect(resolveLocalEightBallShot(winner,before,shot(before,{first:8}))).toBeNull();
  });
  it('eight pocketed on the break requires physical respot, NEVER an auto win/loss',()=>{
    const {rules,after}=resolve(newLocalEightBallRules(),newPoolPractice(),
      {first:1,pocket:[8],rail:true});
    expect(rules.phase).toBe('eight-respot-required');
    expect(rules.winner).toBeNull();
    expect(resolveLocalEightBallShot(rules,after,shot(after,{first:2}))).toBeNull();
  });
  it('rejects replay, moving tables, counterfeit pocket counts, missing balls and resurrection',()=>{
    const base=assigned(),before={...newPoolPractice(),shots:2};
    const legal=shot(before,{first:1,pocket:[1]});
    expect(resolveLocalEightBallShot(base,before,{...legal,status:'moving'})).toBeNull();
    expect(resolveLocalEightBallShot(base,before,{...legal,shots:9})).toBeNull();
    expect(resolveLocalEightBallShot(base,before,{...legal,pocketed:4})).toBeNull();
    expect(resolveLocalEightBallShot(base,before,{...legal,firstObjectHit:0})).toBeNull();
    expect(resolveLocalEightBallShot(base,before,{...legal,firstObjectHit:22})).toBeNull();
    expect(resolveLocalEightBallShot(base,before,{...legal,balls:legal.balls.slice(1)})).toBeNull();
    expect(resolveLocalEightBallShot(base,before,{...legal,scratches:-1})).toBeNull();
    expect(resolveLocalEightBallShot(base,{...before,status:'moving'},legal)).toBeNull();
    expect(resolveLocalEightBallShot({...base,shotsResolved:3},before,legal)).toBeNull();
    const a=resolve(base,before,{first:1,pocket:[1]});
    const resurrect={...shot(a.after,{first:2}),balls:a.after.balls.map(b=>
      b.id===1?{...b,pocketed:false}:b)};
    expect(resolveLocalEightBallShot(a.rules,a.after,resurrect)).toBeNull();
  });
  it('cue scratching in the actual physics counts independently of target pockets',()=>{
    const initial=newPoolPractice();
    const point=POOL_POCKETS[0];
    const balls=initial.balls.map(b=>b.id===0?{
      ...b,x:point.x+.01,z:point.z+.01,vx:.1,vz:0,
    }:b);
    const after=stepPool({...initial,balls,status:'moving'});
    expect(after.scratches).toBe(1);
    expect(after.firstObjectHit).toBeNull();
    expect(after.pocketed).toBe(0);
  });
});
