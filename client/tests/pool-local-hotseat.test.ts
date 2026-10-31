import {describe,expect,it} from 'vitest';
import {newPoolPractice, type PoolState} from '../js/core/activities/pool-practice-physics.ts';
import {resolveLocalEightBallShot} from './prototypes/pool-eight-ball-rules.ts';
import {
  chooseHotSeatBreakFoul,chooseHotSeatEightOnBreak,chooseHotSeatGroup,
  chooseHotSeatIllegalBreak,newLocalHotSeatMatch,placeHotSeatCue,
  playLocalHotSeatTurn,
} from './prototypes/pool-local-hotseat.ts';

describe('offline-only hot-seat turn coordinator (not public 8-ball acceptance)',()=>{
  it('runs a real full-rack break through fixed-step physics before granting a turn',()=>{
    const initial=newLocalHotSeatMatch();
    const result=playLocalHotSeatTurn(initial,0,0,100,{kind:'break'});
    expect(result).not.toBeNull();
    expect(initial.table.shots).toBe(0);
    expect(initial.rules.phase).toBe('break');
    expect(result!.table.shots).toBe(1);
    expect(result!.table.status).not.toBe('moving');
    expect(result!.rules.shotsResolved).toBe(1);
    expect(result!.rules.last?.actor).toBe(0);
    expect(result!.rules.last?.firstObjectHit).toBe(result!.table.firstObjectHit);
    expect(result!.rules.last?.pocketed).toEqual(result!.table.balls
      .filter(b=>b.id!==0&&b.pocketed).map(b=>b.id).sort((a,b)=>a-b));
    expect(result!.rules.winner).toBeNull();
    expect(playLocalHotSeatTurn(result!,result!.rules.currentPlayer,
      0,50,{kind:'break'})).toBeNull();
  });

  it('rejects opponent action, pre-break calls, missing call, bad power and moving inventory',()=>{
    const initial=newLocalHotSeatMatch();
    expect(playLocalHotSeatTurn(initial,1,0,80,{kind:'break'})).toBeNull();
    expect(playLocalHotSeatTurn(initial,0,0,80,{kind:'safety'})).toBeNull();
    expect(playLocalHotSeatTurn(initial,0,0,80,{kind:'ball',ballId:1,pocketIndex:0})).toBeNull();
    expect(playLocalHotSeatTurn(initial,0,0,101,{kind:'break'})).toBeNull();
    expect(playLocalHotSeatTurn(initial,0,Number.NaN,80,{kind:'break'})).toBeNull();
    expect(playLocalHotSeatTurn({
      ...initial,table:{...initial.table,status:'moving'},
    },0,0,80,{kind:'break'})).toBeNull();
    const malformed:PoolState={...initial.table,balls:initial.table.balls.map(
      b=>b.id===2?{...b,id:1}:b)};
    expect(playLocalHotSeatTurn({...initial,table:malformed},0,0,80,
      {kind:'break'})).toBeNull();
    expect(initial.table.shots).toBe(0);
  });

  it('requires an actual pre-shot called target/pocket (or deliberate safety) in assigned phase',()=>{
    const initial=newLocalHotSeatMatch();
    const match={table:{...initial.table,shots:2},rules:{
      ...initial.rules,phase:'assigned' as const,shotsResolved:2,
      groups:['solids','stripes'] as const,
    }};
    expect(playLocalHotSeatTurn(match,0,0,60,{kind:'break'})).toBeNull();
    expect(playLocalHotSeatTurn(match,1,0,60,{kind:'safety'})).toBeNull();
    expect(playLocalHotSeatTurn(match,0,0,60,{kind:'ball',ballId:8,pocketIndex:0})).toBeNull();
    expect(playLocalHotSeatTurn(match,0,0,60,{kind:'ball',ballId:1,pocketIndex:6})).toBeNull();
    const result=playLocalHotSeatTurn(match,0,0,60,{kind:'ball',ballId:1,pocketIndex:0});
    expect(result).not.toBeNull();
    expect(result!.table.shots).toBe(3);
    expect(result!.table.status).not.toBe('moving');
    expect(result!.rules.shotsResolved).toBe(3);
    expect(result!.rules.last?.actor).toBe(0);
    expect(match.table.shots).toBe(2);
  });

  it('keeps unresolved opening-break choices blocked and actor-checked',()=>{
    const initial=newLocalHotSeatMatch();
    const after={...newPoolPractice(),shots:1,firstObjectHit:1};
    const pending=resolveLocalEightBallShot(initial.rules,initial.table,after);
    expect(pending?.phase).toBe('illegal-break-choice');
    const match={table:after,rules:pending!};
    expect(playLocalHotSeatTurn(match,1,0,60,{kind:'ball',ballId:1,pocketIndex:0})).toBeNull();
    expect(chooseHotSeatIllegalBreak(match,0,'rerack-incoming-break')).toBeNull();
    const choice=chooseHotSeatIllegalBreak(match,1,'rerack-incoming-break');
    expect(choice).not.toBeNull();
    expect(choice?.table.shots).toBe(0);
    expect(choice?.rules.phase).toBe('break');
    expect(choice?.rules.currentPlayer).toBe(1);
    expect(pending!.phase).toBe('illegal-break-choice');
    expect(chooseHotSeatBreakFoul(match,1,'take-head-string')).toBeNull();
    expect(chooseHotSeatGroup(match,1,'solids')).toBeNull();
    expect(chooseHotSeatEightOnBreak(match,1,'spot-eight')).toBeNull();
    expect(placeHotSeatCue(match,1,0,2.7)).toBeNull();
  });
});
