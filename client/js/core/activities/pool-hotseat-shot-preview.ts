import {POOL_POCKETS} from './pool-practice-physics.ts';
import {declareLocalPoolCall} from './pool-called-pocket.ts';
import {type EightBallPlayer} from './pool-eight-ball-rules.ts';
import {type LocalHotSeatMatch} from './pool-local-hotseat.ts';
import {localHotSeatInventory} from './pool-hotseat-inventory.ts';

/** Display-only guidance; the live session independently authenticates each shot. */
export type LocalPoolShotPreview=
  |{readonly kind:'break';readonly player:EightBallPlayer}
  |{readonly kind:'safety';readonly player:EightBallPlayer}
  |{readonly kind:'ball';readonly player:EightBallPlayer;
    readonly ballId:number;readonly pocketIndex:number};

export function localPoolShotPreview(
  match:LocalHotSeatMatch,safety:boolean,ballId:number,pocketIndex:number,
):LocalPoolShotPreview|null {
  if(!match||!match.rules||!match.table||!localHotSeatInventory(match)||
      match.table.status!=='ready'||
      match.rules.winner!==null||match.rules.ballInHand!==null||
      (match.rules.currentPlayer!==0&&match.rules.currentPlayer!==1))return null;
  const {rules,table}=match;
  if(rules.phase==='break')return table.shots===0&&rules.shotsResolved===0
    ?{kind:'break',player:rules.currentPlayer}:null;
  if(rules.phase!=='open'&&rules.phase!=='assigned')return null;
  if(safety===true){
    const declaration=declareLocalPoolCall(rules,table,rules.currentPlayer,'safety');
    return declaration?{kind:'safety',player:rules.currentPlayer}:null;
  }
  if(safety!==false||!Number.isSafeInteger(ballId)||
      !Number.isSafeInteger(pocketIndex)||pocketIndex<0||
      pocketIndex>=POOL_POCKETS.length)return null;
  const declaration=declareLocalPoolCall(rules,table,rules.currentPlayer,
    'ball',ballId,pocketIndex);
  return declaration&&declaration.kind==='ball'
    ?{kind:'ball',player:declaration.player,
      ballId:declaration.ballId,pocketIndex:declaration.pocketIndex}:null;
}
