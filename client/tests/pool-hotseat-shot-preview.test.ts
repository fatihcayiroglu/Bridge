import {describe,expect,it} from 'vitest';
import {newLocalHotSeatMatch,type LocalHotSeatMatch} from
  '../js/core/activities/pool-local-hotseat.ts';
import {localPoolShotPreview} from
  '../js/core/activities/pool-hotseat-shot-preview.ts';

describe('pre-shot 8-Ball declaration only from verified local table and rules',()=>{
  const initial=newLocalHotSeatMatch();
  const open:LocalHotSeatMatch={...initial,rules:{...initial.rules,
    phase:'open',currentPlayer:1}};
  it('announces only the live break actor before group assignments',()=>{
    expect(localPoolShotPreview(initial,false,1,0))
      .toEqual({kind:'break',player:0});
    expect(localPoolShotPreview({...initial,rules:{...initial.rules,
      currentPlayer:1}},true,0,-1))
      .toEqual({kind:'break',player:1});
  });
  it('shows declared ball/pocket and explicit safety without inventing turn authority',()=>{
    expect(localPoolShotPreview(open,false,2,5))
      .toEqual({kind:'ball',player:1,ballId:2,pocketIndex:5});
    expect(localPoolShotPreview(open,true,2,5))
      .toEqual({kind:'safety',player:1});
    for(const invalid of [-1,6,9,NaN,Infinity]){
      expect(localPoolShotPreview(open,false,2,invalid)).toBeNull();
    }
    expect(localPoolShotPreview(open,false,8,0)).toBeNull();
    expect(localPoolShotPreview(open,false,1.5,0)).toBeNull();
  });
  it('never calls the other player group or the early eight',()=>{
    const assigned:LocalHotSeatMatch={...open,rules:{...open.rules,
      phase:'assigned',groups:['solids','stripes']}};
    expect(localPoolShotPreview(assigned,false,1,0)).toBeNull();
    expect(localPoolShotPreview(assigned,false,8,0)).toBeNull();
    expect(localPoolShotPreview(assigned,false,12,2))
      .toEqual({kind:'ball',player:1,ballId:12,pocketIndex:2});
    expect(localPoolShotPreview({...assigned,rules:{...assigned.rules,currentPlayer:0}},
      false,12,2)).toBeNull();
  });
  it('suppresses moving, invalid, finished or decision-only declarations',()=>{
    for(const phase of ['illegal-break-choice','choose-group',
      'break-foul-choice','eight-respot-required','finished'] as const){
      expect(localPoolShotPreview({...open,rules:{...open.rules,phase}},false,1,0))
        .toBeNull();
    }
    expect(localPoolShotPreview({...open,table:{...open.table,status:'moving'}},
      false,1,0)).toBeNull();
    expect(localPoolShotPreview({...initial,table:{...initial.table,status:'complete'}},
      false,1,0)).toBeNull();
    expect(localPoolShotPreview({...initial,table:{...initial.table,shots:1},
      rules:{...initial.rules,shotsResolved:1}},false,1,0)).toBeNull();
    expect(localPoolShotPreview({...open,table:{...open.table,pocketed:3}},
      false,1,0)).toBeNull();
    expect(localPoolShotPreview({...open,rules:{...open.rules,
      ballInHand:'head-string'}},true,1,0)).toBeNull();
    expect(localPoolShotPreview({...open,rules:{...open.rules,
      winner:0}},false,1,0)).toBeNull();
  });
});
