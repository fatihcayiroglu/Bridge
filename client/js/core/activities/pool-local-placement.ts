import {
  POOL_HALF_LENGTH, POOL_HALF_WIDTH, POOL_POCKETS, POOL_RADIUS,
  type PoolBall, type PoolState,
} from './pool-practice-physics.ts';

/**
 * A very narrow LOCAL-only bridge between future hot-seat rules and the 3D
 * renderer. This does not decide *whether* the caller may place a cue or
 * re-spot the eight: the unfinished rule prototype owns that permission.
 *
 * It accepts only a settled physical cue reposition and/or a spotted 8 on the
 * long string after an actual opening break. All other object positions,
 * score evidence, shot sequence, and pocket events must remain unchanged.
 * The renderer owns a defensive copy, not the caller's mutable snapshot.
 */
export function acceptLocalPoolPlacement(
  current: PoolState, proposed: PoolState,
): PoolState | null {
  if (!current || !proposed || current.status !== 'ready' ||
      proposed.status !== 'ready' ||
      !Number.isSafeInteger(current.shots) || current.shots < 0 ||
      proposed.shots !== current.shots ||
      !Number.isSafeInteger(current.scratches) || current.scratches < 0 ||
      proposed.scratches !== current.scratches ||
      !Number.isSafeInteger(current.pocketed) ||
      !Number.isSafeInteger(proposed.pocketed) ||
      current.pocketed < 0 || current.pocketed > 15 ||
      proposed.pocketed < 0 || proposed.pocketed > 15 ||
      current.firstObjectHit !== proposed.firstObjectHit ||
      current.railAfterContact !== proposed.railAfterContact ||
      !Array.isArray(current.breakObjectRails) ||
      !Array.isArray(proposed.breakObjectRails) ||
      current.breakObjectRails.length !== proposed.breakObjectRails.length ||
      current.breakObjectRails.some((id,i)=>id !== proposed.breakObjectRails[i]) ||
      !Array.isArray(current.pocketEvents) ||
      !Array.isArray(proposed.pocketEvents) ||
      current.pocketEvents.length !== proposed.pocketEvents.length ||
      current.pocketEvents.some((e,i)=>e.ballId !== proposed.pocketEvents[i]?.ballId ||
        e.pocketIndex !== proposed.pocketEvents[i]?.pocketIndex) ||
      !Array.isArray(current.balls) || !Array.isArray(proposed.balls) ||
      current.balls.length !== 16 || proposed.balls.length !== 16) return null;

  const ids = new Set<number>();
  const active:PoolBall[] = [];
  let currentTargets=0, proposedTargets=0, cueChanged=false, eightSpotted=false;
  for(let i=0;i<16;i++){
    const old=current.balls[i]!, next=proposed.balls[i]!;
    if(!old || !next || !Number.isSafeInteger(old.id) ||
        old.id < 0 || old.id > 15 || next.id !== old.id ||
        ids.has(old.id) || typeof old.pocketed !== 'boolean' ||
        typeof next.pocketed !== 'boolean' ||
        ![old.x,old.z,old.vx,old.vz,next.x,next.z,next.vx,next.vz].every(Number.isFinite) ||
        old.vx !== 0 || old.vz !== 0 || next.vx !== 0 || next.vz !== 0)return null;
    ids.add(old.id);
    if(old.id > 0){
      if(old.pocketed)currentTargets++;
      if(next.pocketed)proposedTargets++;
    }
    const changed=old.x!==next.x || old.z!==next.z || old.pocketed!==next.pocketed;
    if(old.id===0) {
      if(old.pocketed || next.pocketed)return null;
      cueChanged=changed;
    } else if(old.id===8 && changed) {
      // An 8 re-spot is only valid on the first actual break and ONLY
      // along the vertical long string after pocket evidence was captured.
      if(!old.pocketed || next.pocketed || next.x!==0 ||
          current.shots!==1 ||
          !current.pocketEvents.some(e=>e.ballId===8 &&
            Number.isSafeInteger(e.pocketIndex) &&
            e.pocketIndex>=0 && e.pocketIndex<POOL_POCKETS.length))return null;
      eightSpotted=true;
    } else if(changed) return null;
    if(!next.pocketed) {
      if(Math.abs(next.x)>POOL_HALF_WIDTH-POOL_RADIUS-0.002 ||
         Math.abs(next.z)>POOL_HALF_LENGTH-POOL_RADIUS-0.002 ||
         (changed && POOL_POCKETS.some(p=>
           Math.hypot(next.x-p.x,next.z-p.z)<.31+POOL_RADIUS)))
        return null;
      active.push(next);
    }
  }
  if(ids.size!==16 || !ids.has(0) || currentTargets!==current.pocketed ||
      proposedTargets!==proposed.pocketed ||
      proposed.pocketed!==current.pocketed-(eightSpotted?1:0) ||
      (!cueChanged && !eightSpotted)) return null;
  for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length;j++)
    if(Math.hypot(active[i]!.x-active[j]!.x,active[i]!.z-active[j]!.z)
      < 2*POOL_RADIUS+0.002)return null;
  return {
    ...current,
    pocketed:proposed.pocketed,
    balls:proposed.balls.map(b=>({...b})),
    breakObjectRails:[...current.breakObjectRails],
    pocketEvents:current.pocketEvents.map(e=>({...e})),
  };
}
