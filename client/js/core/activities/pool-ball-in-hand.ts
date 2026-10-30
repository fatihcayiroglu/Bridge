import {
  POOL_HALF_LENGTH, POOL_HALF_WIDTH, POOL_POCKETS, POOL_RADIUS,
  type PoolState,
} from './pool-practice-physics.ts';
import type {
  EightBallPlayer, LocalEightBallRules,
} from './pool-eight-ball-rules.ts';

/**
 * Local-only two-player cue placement for a future rules-based 8-ball match.
 * Coordinates use the existing tabletop plane (head rail at positive z).
 * Official match UI/server acceptance is NOT provided here.
 */
export const POOL_HEAD_STRING_Z = 2;
const CLEARANCE = 0.002;
export interface LocalCuePlacement {
  readonly rules: LocalEightBallRules;
  readonly table: PoolState;
}

export function placeLocalCueBall(
  rules: LocalEightBallRules, table: PoolState,
  player: EightBallPlayer, x: number, z: number,
): LocalCuePlacement | null {
  if((rules.ballInHand!=='anywhere'&&rules.ballInHand!=='head-string')||
      rules.winner!==null||
      !rules.last||rules.last.foul===null||
      rules.last.actor===player||
      rules.last.actor!==0&&rules.last.actor!==1||
      (rules.phase!=='open'&&rules.phase!=='assigned')||
      (player!==0&&player!==1)||rules.currentPlayer!==player||
      table.status!=='ready'||table.shots!==rules.shotsResolved||
      !Number.isSafeInteger(table.shots)||!Number.isSafeInteger(table.scratches)||
      table.scratches<0||!Number.isSafeInteger(table.pocketed)||
      table.pocketed<0||table.pocketed>15||
      !Number.isFinite(x)||!Number.isFinite(z)||
      Math.abs(x)>POOL_HALF_WIDTH-POOL_RADIUS-CLEARANCE||
      Math.abs(z)>POOL_HALF_LENGTH-POOL_RADIUS-CLEARANCE||
      (rules.ballInHand==='head-string'&&z<POOL_HEAD_STRING_Z)||
      table.balls.length!==16)return null;
  const ids=new Set<number>();
  const cue=table.balls.find(b=>b.id===0);
  if(!cue||cue.pocketed) return null;
  for(const ball of table.balls) {
    if(!Number.isSafeInteger(ball.id)||ball.id<0||ball.id>15||
        ids.has(ball.id)||typeof ball.pocketed!=='boolean'||
        ![ball.x,ball.z,ball.vx,ball.vz].every(Number.isFinite)||
        ball.vx!==0||ball.vz!==0)return null;
    ids.add(ball.id);
    if(ball.id!==0&&!ball.pocketed&&
        Math.hypot(x-ball.x,z-ball.z)<2*POOL_RADIUS+CLEARANCE)return null;
  }
  if(ids.size!==16||table.pocketed!==table.balls.filter(b=>b.id!==0&&b.pocketed).length)return null;
  // A candidate cannot start in the pocket opening, regardless of its
  // distance to a ball. Do not clamp or silently choose another point.
  if(POOL_POCKETS.some(p=>Math.hypot(x-p.x,z-p.z)<.31+POOL_RADIUS))
    return null;
  const next:PoolState={
    ...table,
    balls:table.balls.map(b=>b.id===0?{...b,x,z,vx:0,vz:0}:b),
  };
  return {table:next,rules:{...rules,ballInHand:null}};
}
