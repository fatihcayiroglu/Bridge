import { POOL_POCKETS, type PoolState } from './pool-practice-physics.ts';

/**
 * Offline solo practice challenge only. A player chooses an exact visible ball
 * and one of six pockets before striking. This never grants a competitive
 * turn, group or win; official 8-ball logic is separately gated.
 */
export interface PracticePocketCall {
  readonly shot:number;
  readonly ballId:number;
  readonly pocketIndex:number;
  readonly pocketedBefore:number;
  readonly scratchesBefore:number;
}
export type PracticePocketResult = 'made' | 'missed';

/** A declaration may only refer to a genuine settled 16-ball practice inventory. */
function validReadyInventory(state:PoolState):boolean {
  if(!Array.isArray(state.balls)||state.balls.length!==16)return false;
  const ids=new Set<number>();
  let targets=0;
  for(const ball of state.balls) {
    if(!ball||!Number.isSafeInteger(ball.id)||ball.id<0||ball.id>15||
        ids.has(ball.id)||typeof ball.pocketed!=='boolean'||
        ![ball.x,ball.z,ball.vx,ball.vz].every(Number.isFinite)||
        ball.vx!==0||ball.vz!==0||
        (ball.id===0&&ball.pocketed))return false;
    ids.add(ball.id);
    if(ball.id!==0&&ball.pocketed)targets++;
  }
  return ids.size===16&&targets===state.pocketed;
}

export function declarePracticePocketCall(
  state:PoolState, ballId:number, pocketIndex:number,
):PracticePocketCall|null {
  if(state.status!=='ready'||!Number.isSafeInteger(state.shots)||
      state.shots<0||state.shots>=999||
      !Number.isSafeInteger(ballId)||ballId<1||ballId>15||
      !Number.isSafeInteger(pocketIndex)||pocketIndex<0||
      pocketIndex>=POOL_POCKETS.length||
      !Number.isSafeInteger(state.pocketed)||state.pocketed<0||state.pocketed>15||
      !Number.isSafeInteger(state.scratches)||state.scratches<0||
      state.scratches>state.shots||!validReadyInventory(state)||
      !state.balls.some(b=>b.id===ballId&&!b.pocketed))return null;
  return {shot:state.shots+1,ballId,pocketIndex,
    pocketedBefore:state.pocketed,scratchesBefore:state.scratches};
}

export function settlePracticePocketCall(
  state:PoolState,call:PracticePocketCall,
):PracticePocketResult|null {
  if(!Number.isSafeInteger(call.shot)||state.shots!==call.shot||
      !Number.isSafeInteger(call.ballId)||call.ballId<1||call.ballId>15||
      !Number.isSafeInteger(call.pocketIndex)||call.pocketIndex<0||
      call.pocketIndex>=POOL_POCKETS.length||
      (state.status!=='ready'&&state.status!=='complete')||
      !Number.isSafeInteger(state.pocketed)||
      !Number.isSafeInteger(state.scratches)||
      !Number.isSafeInteger(call.pocketedBefore)||call.pocketedBefore<0||
      !Number.isSafeInteger(call.scratchesBefore)||call.scratchesBefore<0||
      !Array.isArray(state.pocketEvents)||
      state.pocketEvents.length>16||state.balls.length!==16)return null;
  const ids=new Set<number>();
  for(const ball of state.balls) {
    if(!Number.isSafeInteger(ball.id)||ball.id<0||ball.id>15||
        ids.has(ball.id)||typeof ball.pocketed!=='boolean')return null;
    ids.add(ball.id);
  }
  if(ids.size!==16||state.pocketed!==state.balls.filter(b=>b.id!==0&&b.pocketed).length)
    return null;
  const events=new Set<number>();
  let found=false,objectsPocketed=0,cueScratched=0;
  for(const event of state.pocketEvents) {
    if(!Number.isSafeInteger(event.ballId)||event.ballId<0||event.ballId>15||
        !Number.isSafeInteger(event.pocketIndex)||event.pocketIndex<0||
        event.pocketIndex>=POOL_POCKETS.length||events.has(event.ballId))return null;
    events.add(event.ballId);
    if(event.ballId===0)cueScratched++;
    else {
      objectsPocketed++;
      if(!state.balls.some(b=>b.id===event.ballId&&b.pocketed))return null;
    }
    if(event.ballId===call.ballId&&event.pocketIndex===call.pocketIndex)found=true;
  }
  // This trace must describe every object pocket and scratch *this shot*.
  // Missing events are unverified, never mislabeled a missed call.
  if(state.pocketed-call.pocketedBefore!==objectsPocketed||
      state.scratches-call.scratchesBefore!==cueScratched)return null;
  return found?'made':'missed';
}
