import {describe,expect,it} from 'vitest';
import {newLocalHotSeatMatch,type LocalHotSeatMatch} from
  '../js/core/activities/pool-local-hotseat.ts';
import {localHotSeatCallBallIds} from
  '../js/core/activities/pool-hotseat-call-options.ts';

function withPocketed(match:LocalHotSeatMatch,ids:readonly number[]):LocalHotSeatMatch {
  return {...match,table:{...match.table,
    balls:match.table.balls.map(b=>ids.includes(b.id)?{...b,pocketed:true}:b),
    pocketed:ids.length}};
}
describe('local 8-ball legal called-ball UI hints (never rules authority)',()=>{
  const base=newLocalHotSeatMatch();
  it('shows no non-break calls until a valid playable phase',()=>{
    expect(localHotSeatCallBallIds(base)).toEqual([]);
    for(const phase of ['choose-group','illegal-break-choice','break-foul-choice',
      'eight-respot-required','finished'] as const){
      expect(localHotSeatCallBallIds({...base,rules:{...base.rules,phase}})).toEqual([]);
    }
  });
  it('allows all 14 object classes but never the eight on an open table',()=>{
    const match={...base,rules:{...base.rules,phase:'open' as const}};
    expect(localHotSeatCallBallIds(match)).toEqual([
      1,2,3,4,5,6,7,9,10,11,12,13,14,15]);
    expect(localHotSeatCallBallIds(withPocketed(match,[3,10]))).toEqual([
      1,2,4,5,6,7,9,11,12,13,14,15]);
  });
  it('offers only the active player group, then the eight after clearing their seven',()=>{
    const match={...base,rules:{...base.rules,phase:'assigned' as const,
      groups:['solids','stripes'] as const}};
    expect(localHotSeatCallBallIds(match)).toEqual([1,2,3,4,5,6,7]);
    expect(localHotSeatCallBallIds({...match,rules:{...match.rules,currentPlayer:1}}))
      .toEqual([9,10,11,12,13,14,15]);
    const cleared=withPocketed(match,[1,2,3,4,5,6,7]);
    expect(localHotSeatCallBallIds(cleared)).toEqual([8]);
    expect(localHotSeatCallBallIds(withPocketed(cleared,[1,2,3,4,5,6,7,8])))
      .toEqual([]);
    expect(localHotSeatCallBallIds({...cleared,rules:{...cleared.rules,ballInHand:'anywhere'}}))
      .toEqual([]);
  });
  it('fails closed when the assigned phase has not established a group',()=>{
    const match={...base,rules:{...base.rules,phase:'assigned' as const}};
    expect(localHotSeatCallBallIds(match)).toEqual([]);
  });
});
