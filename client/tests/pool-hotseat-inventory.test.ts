import {describe,expect,it} from 'vitest';
import {newLocalHotSeatMatch,playLocalHotSeatTurn,type LocalHotSeatMatch} from
  '../js/core/activities/pool-local-hotseat.ts';
import {localHotSeatInventory} from
  '../js/core/activities/pool-hotseat-inventory.ts';

function pocketed(match:LocalHotSeatMatch,ids:readonly number[]):LocalHotSeatMatch {
  return {...match,table:{...match.table,
    balls:match.table.balls.map(b=>ids.includes(b.id)?{...b,pocketed:true}:b),
    pocketed:ids.length}};
}
describe('offline local 8-Ball verified inventory display',()=>{
  it('counts the complete physical rack without trusting caller scores',()=>{
    const start=newLocalHotSeatMatch();
    expect(localHotSeatInventory(start)).toEqual({
      solidsRemaining:7,stripesRemaining:7,eightOnTable:true,
    });
    const after=playLocalHotSeatTurn(start,0,0,10,{kind:'break'});
    expect(after?.rules.phase).toBe('illegal-break-choice');
    expect(localHotSeatInventory(after!)).toEqual({
      solidsRemaining:7,stripesRemaining:7,eightOnTable:true,
    });
  });
  it('counts pocketed groups and eight exactly, including the endgame',()=>{
    const start=newLocalHotSeatMatch();
    const partial=pocketed(start,[1,2,9]);
    expect(localHotSeatInventory(partial)).toEqual({
      solidsRemaining:5,stripesRemaining:6,eightOnTable:true,
    });
    const allSolids=pocketed(start,[1,2,3,4,5,6,7]);
    expect(localHotSeatInventory(allSolids)).toEqual({
      solidsRemaining:0,stripesRemaining:7,eightOnTable:true,
    });
    expect(localHotSeatInventory(pocketed(allSolids,[1,2,3,4,5,6,7,8]))).toEqual({
      solidsRemaining:0,stripesRemaining:7,eightOnTable:false,
    });
  });
  it('refuses incomplete, contradictory or moving snapshots',()=>{
    const start=newLocalHotSeatMatch();
    expect(localHotSeatInventory({...start,table:{...start.table,status:'moving'}}))
      .toBeNull();
    expect(localHotSeatInventory({...start,table:{...start.table,pocketed:4}}))
      .toBeNull();
    expect(localHotSeatInventory({...start,rules:{...start.rules,shotsResolved:1}}))
      .toBeNull();
    expect(localHotSeatInventory({...start,table:{...start.table,
      balls:start.table.balls.slice(1)}})).toBeNull();
    expect(localHotSeatInventory({...start,table:{...start.table,
      balls:start.table.balls.map((b,i)=>i===1?{...b,id:0}:b)}})).toBeNull();
    expect(localHotSeatInventory({...start,table:{...start.table,
      balls:start.table.balls.map(b=>b.id===0?{...b,pocketed:true}:b)}})).toBeNull();
  });
});
