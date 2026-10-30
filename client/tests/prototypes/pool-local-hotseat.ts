import {
  newPoolPractice, stepPool, strikePool, type PoolState,
} from '../../js/core/activities/pool-practice-physics.ts';
import {
  chooseLocalBreakFoul, chooseLocalEightBallGroup, chooseLocalIllegalBreak,
  newLocalEightBallRules, resolveLocalEightBallShot,
  type EightBallGroup, type EightBallPlayer, type IllegalBreakChoice,
  type LocalEightBallRules,
} from './pool-eight-ball-rules.ts';
import {
  declareLocalPoolCall, resolveLocalCalledEightBallShot,
} from './pool-called-pocket.ts';
import { chooseLocalEightOnBreak, type LocalEightBreakChoice } from './pool-eight-on-break.ts';
import { placeLocalCueBall } from './pool-ball-in-hand.ts';

/**
 * Pure, offline-only hot-seat coordinator. No UI, multiplayer protocol, stored
 * wins or official WPA acceptance. Callers must not treat this prototype as a
 * server authority: it only sequences existing physical/rules contracts.
 */
export interface LocalHotSeatMatch {
  readonly table: PoolState;
  readonly rules: LocalEightBallRules;
}
export type LocalTurnIntent =
  | { readonly kind: 'break' }
  | { readonly kind: 'safety' }
  | { readonly kind: 'ball'; readonly ballId: number; readonly pocketIndex: number };

const MAX_PHYSICS_STEPS=6000;

export function newLocalHotSeatMatch():LocalHotSeatMatch {
  return {table:newPoolPractice(),rules:newLocalEightBallRules()};
}

function readyInventory(table:PoolState):boolean {
  if(table.status!=='ready'||!Number.isSafeInteger(table.shots)||
      table.shots<0||table.shots>=999||
      !Number.isSafeInteger(table.scratches)||table.scratches<0||
      table.scratches>table.shots||!Number.isSafeInteger(table.pocketed)||
      table.pocketed<0||table.pocketed>15||!Array.isArray(table.balls)||
      table.balls.length!==16)return false;
  const ids=new Set<number>();
  let pocketed=0;
  for(const ball of table.balls) {
    if(!ball||!Number.isSafeInteger(ball.id)||ball.id<0||ball.id>15||
        ids.has(ball.id)||typeof ball.pocketed!=='boolean'||
        ![ball.x,ball.z,ball.vx,ball.vz].every(Number.isFinite)||
        ball.vx!==0||ball.vz!==0||
        (ball.id===0&&ball.pocketed))return false;
    ids.add(ball.id);
    if(ball.id!==0&&ball.pocketed)pocketed++;
  }
  return ids.size===16&&pocketed===table.pocketed;
}

/**
 * Simulate one whole local turn with the same fixed-step physics as the WebGL
 * practice renderer. No client-provided "after shot" evidence is accepted;
 * rulings use only the trace emitted by stepPool. No truncated shot can win.
 */
export function playLocalHotSeatTurn(
  match:LocalHotSeatMatch, actor:EightBallPlayer,
  angle:number, power:number, intent:LocalTurnIntent,
):LocalHotSeatMatch|null {
  if(!match||!match.rules||!match.table||!intent||
      (actor!==0&&actor!==1)||actor!==match.rules.currentPlayer||
      match.rules.winner!==null||match.rules.ballInHand!==null||
      match.table.shots!==match.rules.shotsResolved||
      !readyInventory(match.table)||!Number.isFinite(angle)||
      !Number.isFinite(power))return null;
  const opening=match.rules.phase==='break';
  if(opening ? intent.kind!=='break' :
      (match.rules.phase!=='open'&&match.rules.phase!=='assigned')||
      intent.kind==='break')return null;
  const call=opening?null:declareLocalPoolCall(
    match.rules,match.table,actor,intent.kind,
    intent.kind==='ball'?intent.ballId:undefined,
    intent.kind==='ball'?intent.pocketIndex:undefined,
  );
  if(!opening&&!call)return null;
  let next=strikePool(match.table,angle,power);
  if(next===match.table||next.status!=='moving')return null;
  for(let step=0;step<MAX_PHYSICS_STEPS&&next.status==='moving';step++)
    next=stepPool(next);
  if(next.status==='moving')return null;
  const rules=opening
    ?resolveLocalEightBallShot(match.rules,match.table,next)
    :resolveLocalCalledEightBallShot(match.rules,match.table,next,call!)?.rules??null;
  if(!rules)return null;
  return {table:next,rules};
}

export function chooseHotSeatGroup(
  match:LocalHotSeatMatch,actor:EightBallPlayer,group:EightBallGroup,
):LocalHotSeatMatch|null {
  if(!match||actor!==match.rules.currentPlayer||
      match.table.shots!==match.rules.shotsResolved)return null;
  const rules=chooseLocalEightBallGroup(match.rules,group);
  return rules?{table:match.table,rules}:null;
}
export function chooseHotSeatIllegalBreak(
  match:LocalHotSeatMatch,actor:EightBallPlayer,choice:IllegalBreakChoice,
):LocalHotSeatMatch|null {
  if(!match||actor!==match.rules.currentPlayer)return null;
  const result=chooseLocalIllegalBreak(match.rules,match.table,choice);
  return result?{table:result.table,rules:result.rules}:null;
}
export function chooseHotSeatBreakFoul(
  match:LocalHotSeatMatch,actor:EightBallPlayer,
  choice:'take-head-string'|'accept-position',
):LocalHotSeatMatch|null {
  if(!match||actor!==match.rules.currentPlayer)return null;
  const rules=chooseLocalBreakFoul(match.rules,match.table,choice);
  return rules?{table:match.table,rules}:null;
}
export function chooseHotSeatEightOnBreak(
  match:LocalHotSeatMatch,actor:EightBallPlayer,choice:LocalEightBreakChoice,
):LocalHotSeatMatch|null {
  if(!match||actor!==match.rules.currentPlayer)return null;
  const result=chooseLocalEightOnBreak(match.rules,match.table,actor,choice);
  return result?{table:result.table,rules:result.rules}:null;
}
export function placeHotSeatCue(
  match:LocalHotSeatMatch,actor:EightBallPlayer,x:number,z:number,
):LocalHotSeatMatch|null {
  if(!match||actor!==match.rules.currentPlayer)return null;
  const result=placeLocalCueBall(match.rules,match.table,actor,x,z);
  return result?{table:result.table,rules:result.rules}:null;
}
