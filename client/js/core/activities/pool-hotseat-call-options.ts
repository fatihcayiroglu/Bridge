import {type LocalHotSeatMatch} from './pool-local-hotseat.ts';

/**
 * Display-only legal called-ball suggestions for offline hot-seat Pool.
 * The rules engine still validates every declared call; never treat a
 * visible/selectable option as authority to score a shot.
 */
export function localHotSeatCallBallIds(match:LocalHotSeatMatch):readonly number[] {
  const {rules,table}=match;
  if(rules.winner!==null||rules.ballInHand!==null||
      (rules.phase!=='open'&&rules.phase!=='assigned'))return [];
  const remaining=table.balls.filter(b=>b.id>=1&&b.id<=15&&!b.pocketed);
  if(rules.phase==='open')return remaining.filter(b=>b.id!==8).map(b=>b.id).sort((a,b)=>a-b);
  const group=rules.groups[rules.currentPlayer];
  if(group!=='solids'&&group!=='stripes')return [];
  const own=remaining.filter(b=>group==='solids'
    ?b.id<=7:b.id>=9);
  return (own.length?own:remaining.filter(b=>b.id===8))
    .map(b=>b.id).sort((a,b)=>a-b);
}
