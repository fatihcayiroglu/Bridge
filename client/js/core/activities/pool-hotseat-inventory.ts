import {type LocalHotSeatMatch} from './pool-local-hotseat.ts';

export interface LocalHotSeatInventory {
  readonly solidsRemaining:number;
  readonly stripesRemaining:number;
  readonly eightOnTable:boolean;
}

/**
 * Read-only inventory from the last VERIFIED local match snapshot. This must
 * never trust a renderer-provided aggregate score or invent missing balls.
 */
export function localHotSeatInventory(match:LocalHotSeatMatch):LocalHotSeatInventory|null {
  const {table,rules}=match;
  if(!table||!rules||(table.status!=='ready'&&table.status!=='complete')||
      !Number.isSafeInteger(table.shots)||table.shots<0||
      table.shots!==rules.shotsResolved||
      !Number.isSafeInteger(table.pocketed)||table.pocketed<0||
      table.pocketed>15||!Array.isArray(table.balls)||
      table.balls.length!==16)return null;
  const seen=new Set<number>();
  let solidsRemaining=0,stripesRemaining=0,pocketed=0,eightOnTable=false;
  for(const ball of table.balls){
    if(!ball||!Number.isSafeInteger(ball.id)||ball.id<0||ball.id>15||
        seen.has(ball.id)||typeof ball.pocketed!=='boolean')return null;
    seen.add(ball.id);
    if(ball.id===0){
      if(ball.pocketed)return null;
      continue;
    }
    if(ball.pocketed)pocketed++;
    else if(ball.id<=7)solidsRemaining++;
    else if(ball.id===8)eightOnTable=true;
    else stripesRemaining++;
  }
  if(seen.size!==16||pocketed!==table.pocketed)return null;
  return {solidsRemaining,stripesRemaining,eightOnTable};
}
