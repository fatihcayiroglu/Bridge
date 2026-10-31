import {type LocalHotSeatMatch} from './pool-local-hotseat.ts';
import {type EightBallFoul,type EightBallPlayer} from './pool-eight-ball-rules.ts';

export interface LocalPoolShotSummary {
  readonly actor:EightBallPlayer;
  readonly pocketed:number;
  readonly foul:EightBallFoul|null;
  readonly outcome:'decision'|'next-turn'|'winner';
  readonly player:EightBallPlayer;
}

/**
 * Read-only, post-adjudication match narration. Never infer a score or foul
 * from moving balls or an unverified renderer callback. Re-racks intentionally
 * clear "last" so the preceding rack is not narrated as the current shot.
 */
export function localPoolShotSummary(match:LocalHotSeatMatch):LocalPoolShotSummary|null {
  const {rules,table}=match;
  const last=rules.last;
  if(!last||rules.shotsResolved!==table.shots||
      !Number.isSafeInteger(rules.shotsResolved)||rules.shotsResolved<1||
      (last.actor!==0&&last.actor!==1)||
      (rules.currentPlayer!==0&&rules.currentPlayer!==1)||
      !Array.isArray(last.pocketed)||last.pocketed.length>15||
      last.pocketed.some(id=>!Number.isSafeInteger(id)||id<1||id>15)||
      new Set(last.pocketed).size!==last.pocketed.length||
      (rules.winner!==null&&rules.winner!==0&&rules.winner!==1))return null;
  const foul:readonly EightBallFoul[]=[
    'scratch','no-first-contact','illegal-first-contact',
    'no-rail-after-contact','illegal-break',
  ];
  if(last.foul!==null&&!foul.includes(last.foul))return null;
  const decision=rules.phase==='choose-group'||rules.phase==='illegal-break-choice'||
    rules.phase==='break-foul-choice'||rules.phase==='eight-respot-required'||
    rules.ballInHand!==null;
  if(rules.phase==='finished'&&rules.winner===null)return null;
  const outcome:LocalPoolShotSummary['outcome']=rules.winner!==null?'winner':
    decision?'decision':'next-turn';
  return {actor:last.actor,pocketed:last.pocketed.length,foul:last.foul,
    outcome,player:rules.winner??rules.currentPlayer};
}
