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
}
export type PracticePocketResult = 'made' | 'missed';

export function declarePracticePocketCall(
  state:PoolState, ballId:number, pocketIndex:number,
):PracticePocketCall|null {
  if(state.status!=='ready'||!Number.isSafeInteger(state.shots)||state.shots>=999||
      !Number.isSafeInteger(ballId)||ballId<1||ballId>15||
      !Number.isSafeInteger(pocketIndex)||pocketIndex<0||
      pocketIndex>=POOL_POCKETS.length||
      state.balls.length!==16||
      !state.balls.some(b=>b.id===ballId&&!b.pocketed))return null;
  return {shot:state.shots+1,ballId,pocketIndex};
}

export function settlePracticePocketCall(
  state:PoolState,call:PracticePocketCall,
):PracticePocketResult|null {
  if(!Number.isSafeInteger(call.shot)||state.shots!==call.shot||
      state.status==='moving'||!Array.isArray(state.pocketEvents)||
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
  let found=false;
  for(const event of state.pocketEvents) {
    if(!Number.isSafeInteger(event.ballId)||event.ballId<0||event.ballId>15||
        !Number.isSafeInteger(event.pocketIndex)||event.pocketIndex<0||
        event.pocketIndex>=POOL_POCKETS.length||events.has(event.ballId))return null;
    events.add(event.ballId);
    if(event.ballId!==0&&!state.balls.some(b=>b.id===event.ballId&&b.pocketed))
      return null;
    if(event.ballId===call.ballId&&event.pocketIndex===call.pocketIndex)found=true;
  }
  if(state.pocketEvents.some(e=>e.ballId===0)!==(state.scratches>0&&
      state.pocketEvents.some(e=>e.ballId===0))) {
    // Reserved for strict per-shot scratch consistency in full rules mode.
  }
  return found?'made':'missed';
}
