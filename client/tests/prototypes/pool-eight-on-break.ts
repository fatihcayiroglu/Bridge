import {
  POOL_FOOT_SPOT_Z, POOL_HALF_LENGTH, POOL_RADIUS, newPoolPractice,
  type PoolState,
} from '../../js/core/activities/pool-practice-physics.ts';
import { newLocalEightBallRules, type EightBallPlayer,
  type LocalEightBallRules } from './pool-eight-ball-rules.ts';

/**
 * LOCAL ONLY. WPA 8-Ball 4.3(e)/(f) and 1.5: when 8 falls on the opening
 * break, the authorized player chooses re-rack or spotting the 8 on the
 * long string near the foot spot. This does not adjudicate other fouls,
 * off-table balls or an official/server-authoritative rack.
 */
export type LocalEightBreakChoice = 'spot-eight' | 'rerack';
export interface LocalEightBreakResolution {
  readonly rules: LocalEightBallRules;
  readonly table: PoolState;
}

const CUE_CLEARANCE = 0.003;
const TARGET_CLEARANCE = 0.001;
const LIMIT_MARGIN = 0.003;
const other = (player:EightBallPlayer):EightBallPlayer => player===0?1:0;

/** Closest non-overlapping candidate to the foot spot, favoring the foot rail. */
function chooseLongStringPosition(table:PoolState):number|null {
  const others=table.balls.filter(b=>b.id!==8&&!b.pocketed);
  const minZ=-POOL_HALF_LENGTH+POOL_RADIUS+LIMIT_MARGIN;
  const maxZ=POOL_HALF_LENGTH-POOL_RADIUS-LIMIT_MARGIN;
  const candidates=[POOL_FOOT_SPOT_Z];
  for(const b of others) {
    const safe=POOL_RADIUS*2+(b.id===0?CUE_CLEARANCE:TARGET_CLEARANCE);
    if(Math.abs(b.x)>=safe)continue;
    const d=Math.sqrt(Math.max(0,safe*safe-b.x*b.x))+1e-6;
    candidates.push(b.z-d,b.z+d);
  }
  // WPA 1.5: search toward the foot rail first. Only if the entire region
  // is blocked, search on the head side of the foot spot.
  const fits=(z:number):boolean=>
    Number.isFinite(z)&&z>=minZ&&z<=maxZ&&
    others.every(b=>Math.hypot(b.x,b.z-z)>=
      2*POOL_RADIUS+(b.id===0?CUE_CLEARANCE:TARGET_CLEARANCE));
  const footward=candidates.filter(z=>z<=POOL_FOOT_SPOT_Z&&fits(z))
    .sort((a,b)=>b-a);
  if(footward.length>0)return footward[0]!;
  const headward=candidates.filter(z=>z>POOL_FOOT_SPOT_Z&&fits(z))
    .sort((a,b)=>a-b);
  return headward.length>0?headward[0]!:null;
}

function validatedEightBreak(
  rules:LocalEightBallRules,table:PoolState,actor:EightBallPlayer,
):boolean {
  const last=rules.last;
  if(rules.phase!=='eight-respot-required'||rules.winner!==null||
      rules.ballInHand!==null||!last||!last.eightPocketed||!Array.isArray(last.pocketed)||
      !last.pocketed.includes(8)||
      (last.actor!==0&&last.actor!==1)||
      (rules.currentPlayer!==0&&rules.currentPlayer!==1)||
      (actor!==0&&actor!==1)||
      actor!==rules.currentPlayer||
      rules.currentPlayer!==(last.foul?other(last.actor):last.actor)||
      table.status!=='ready'||rules.shotsResolved!==1||table.shots!==1||
      !Number.isSafeInteger(table.pocketed)||table.pocketed<1||
      !Number.isSafeInteger(table.scratches)||table.scratches<0||table.scratches>1||
      table.balls.length!==16||!Array.isArray(table.pocketEvents))return false;
  const ids=new Set<number>();
  for(const b of table.balls) {
    if(!Number.isSafeInteger(b.id)||b.id<0||b.id>15||ids.has(b.id)||
        typeof b.pocketed!=='boolean'||
        ![b.x,b.z,b.vx,b.vz].every(Number.isFinite)||
        b.vx!==0||b.vz!==0)return false;
    ids.add(b.id);
  }
  if(ids.size!==16||!table.balls.find(b=>b.id===8)?.pocketed||
      table.balls.find(b=>b.id===0)?.pocketed)return false;
  const actual=table.balls.filter(b=>b.id!==0&&b.pocketed).map(b=>b.id);
  if(actual.length!==table.pocketed||actual.length!==last.pocketed.length||
      actual.some(id=>!last.pocketed.includes(id)))return false;
  const eventIds=new Set<number>();
  for(const event of table.pocketEvents) {
    if(!Number.isSafeInteger(event.ballId)||
        !Number.isSafeInteger(event.pocketIndex)||
        event.ballId<0||event.ballId>15||
        event.pocketIndex<0||event.pocketIndex>=6||
        eventIds.has(event.ballId))return false;
    eventIds.add(event.ballId);
  }
  if(actual.some(id=>!eventIds.has(id))||
      [...eventIds].some(id=>id!==0&&!actual.includes(id))||
      eventIds.has(0)!==(last.foul==='scratch')||
      (table.scratches>0)!==(last.foul==='scratch'))return false;
  return true;
}

/**
 * Explicit actor-checked decision. No mutation of the existing snapshot.
 * If physical spotting is impossible, fails closed and the original state
 * remains pending, so the player can still choose to re-rack.
 */
export function chooseLocalEightOnBreak(
  rules:LocalEightBallRules,table:PoolState,actor:EightBallPlayer,
  choice:LocalEightBreakChoice,
):LocalEightBreakResolution|null {
  if(!validatedEightBreak(rules,table,actor)||
      (choice!=='spot-eight'&&choice!=='rerack'))return null;
  const breaker=rules.last!.actor;
  const foul=rules.last!.foul!==null;
  if(choice==='rerack') {
    // A legal 8-on-break rerack stays with the original breaker.
    // A fouled 8-on-break rerack is awarded to the incoming opponent.
    return {rules:{...newLocalEightBallRules(),currentPlayer:foul?other(breaker):breaker},
      table:newPoolPractice()};
  }
  const z=chooseLongStringPosition(table);
  if(z===null)return null;
  const nextTable:PoolState={...table,pocketed:table.pocketed-1,
    balls:table.balls.map(b=>b.id===8?{
      ...b,x:0,z,pocketed:false,vx:0,vz:0,
    }:b),
    // Preserve historical pocket events for the just-completed break.
    // The next strike clears this shot trace as normal.
  };
  return {table:nextTable,rules:{...rules,phase:'open',
    currentPlayer:foul?other(breaker):breaker,
    ballInHand:foul?'head-string':null}};
}
