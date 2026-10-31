import {describe,expect,it} from 'vitest';
import {
  chooseHotSeatIllegalBreak,newLocalHotSeatMatch,playLocalHotSeatTurn,
} from '../js/core/activities/pool-local-hotseat.ts';
import {localPoolShotSummary} from '../js/core/activities/pool-hotseat-shot-summary.ts';

describe('offline 8-Ball narration from resolved physics and rules only',()=>{
  it('narrates no previous shot before the break or after a genuine physical re-rack',()=>{
    const opening=newLocalHotSeatMatch();
    expect(localPoolShotSummary(opening)).toBeNull();
    const after=playLocalHotSeatTurn(opening,0,0,10,{kind:'break'});
    expect(after?.rules.phase).toBe('illegal-break-choice');
    const display=localPoolShotSummary(after!);
    expect(display).toEqual({
      actor:0,pocketed:0,foul:after!.rules.last!.foul,
      outcome:'decision',player:1,
    });
    const rerack=chooseHotSeatIllegalBreak(after!,1,'rerack-incoming-break');
    expect(rerack?.rules.currentPlayer).toBe(1);
    expect(rerack?.table.shots).toBe(0);
    expect(localPoolShotSummary(rerack!)).toBeNull();
  });

  it('refuses unverified or contradictory snapshots rather than invent a foul or result',()=>{
    const opening=newLocalHotSeatMatch();
    const after=playLocalHotSeatTurn(opening,0,0,10,{kind:'break'})!;
    expect(localPoolShotSummary({...after,table:{...after.table,shots:0}})).toBeNull();
    expect(localPoolShotSummary({...after,rules:{...after.rules,
      last:{...after.rules.last!,actor:3 as 0}}})).toBeNull();
    expect(localPoolShotSummary({...after,rules:{...after.rules,
      last:{...after.rules.last!,pocketed:[1,1]}}})).toBeNull();
    expect(localPoolShotSummary({...after,rules:{...after.rules,
      last:{...after.rules.last!,foul:'unknown' as 'scratch'}}})).toBeNull();
    expect(localPoolShotSummary({...after,rules:{...after.rules,
      phase:'finished',winner:null}})).toBeNull();
  });

  it('distinguishes decision, next shot and winner using adjudicated flags only',()=>{
    const after=playLocalHotSeatTurn(newLocalHotSeatMatch(),0,0,10,{kind:'break'})!;
    const open={...after,rules:{...after.rules,phase:'open' as const}};
    expect(localPoolShotSummary(open)?.outcome).toBe('next-turn');
    expect(localPoolShotSummary(open)?.player).toBe(1);
    // Pure presentation sample, not a physically proven eight-ball win.
    const finished={...after,rules:{...after.rules,
      phase:'finished' as const,winner:1 as const}};
    expect(localPoolShotSummary(finished)?.outcome).toBe('winner');
    expect(localPoolShotSummary(finished)?.player).toBe(1);
  });
});
