/**
 * Tower Chaos — deterministic, offline, two-person arcade rules foundation.
 *
 * This is NOT a general rigid-body simulator or an online authoritative match.
 * Each layer has three blocks; the central block OR both outer blocks must
 * remain to support the layer. An unstable removal ends the round immediately.
 * The future WebGL scene must render this model, never decide its outcomes.
 */
export type TowerPlayer = 0 | 1;
export type TowerPhase = 'playing' | 'collapsed';
export interface TowerBlock {
  readonly id: number;
  readonly layer: number;
  readonly slot: 0 | 1 | 2;
  readonly removed: boolean;
}
export interface TowerMove {
  readonly player: TowerPlayer;
  readonly blockId: number;
  readonly collapsed: boolean;
}
export interface TowerMatch {
  readonly blocks: readonly TowerBlock[];
  readonly currentPlayer: TowerPlayer;
  readonly moves: number;
  readonly phase: TowerPhase;
  readonly winner: TowerPlayer | null;
  readonly last: TowerMove | null;
}
export const TOWER_LAYERS = 6;
export const TOWER_BLOCKS_PER_LAYER = 3;
export const TOWER_BLOCK_COUNT = TOWER_LAYERS * TOWER_BLOCKS_PER_LAYER;
export const TOWER_MAX_MOVES = (TOWER_LAYERS-1)*TOWER_BLOCKS_PER_LAYER;

export function newTowerChaos():TowerMatch {
  return {
    blocks:Array.from({length:TOWER_BLOCK_COUNT},(_,id):TowerBlock=>({
      id,layer:Math.floor(id/TOWER_BLOCKS_PER_LAYER),
      slot:(id%TOWER_BLOCKS_PER_LAYER) as 0|1|2,removed:false,
    })),
    currentPlayer:0,moves:0,phase:'playing',winner:null,last:null,
  };
}

function supported(blocks:readonly TowerBlock[],layer:number):boolean {
  const row=blocks.slice(layer*3,layer*3+3);
  return !!row[1]&&!row[1].removed ||
    (!!row[0]&&!row[0].removed&&!!row[2]&&!row[2].removed);
}

/** Structural verification for UI and transitions: malformed evidence fails closed. */
export function isTowerMatch(match:TowerMatch|null|undefined):match is TowerMatch {
  if(!match||!Array.isArray(match.blocks)||match.blocks.length!==TOWER_BLOCK_COUNT||
    !Number.isSafeInteger(match.moves)||match.moves<0||match.moves>TOWER_MAX_MOVES||
    (match.currentPlayer!==0&&match.currentPlayer!==1)||
    (match.phase!=='playing'&&match.phase!=='collapsed')||
    (match.winner!==null&&match.winner!==0&&match.winner!==1))return false;
  let removed=0;
  for(let id=0;id<TOWER_BLOCK_COUNT;id++){
    const b=match.blocks[id];
    if(!b||b.id!==id||b.layer!==Math.floor(id/3)||
      b.slot!==id%3||typeof b.removed!=='boolean')return false;
    if(b.removed){removed++;if(b.layer===TOWER_LAYERS-1)return false;}
  }
  if(removed!==match.moves)return false;
  const stable=Array.from({length:TOWER_LAYERS-1},(_,i)=>supported(match.blocks,i))
    .every(Boolean);
  if(match.moves===0){
    return match.phase==='playing'&&match.winner===null&&match.last===null&&
      match.currentPlayer===0&&stable;
  }
  const last=match.last;
  if(!last||(last.player!==0&&last.player!==1)||
    last.player!==(match.moves-1)%2||
    !Number.isSafeInteger(last.blockId)||last.blockId<0||
    last.blockId>=(TOWER_LAYERS-1)*3||
    !match.blocks[last.blockId]?.removed||
    typeof last.collapsed!=='boolean')return false;
  if(stable){
    if(last.collapsed||match.phase!=='playing'||match.winner!==null||
      match.currentPlayer!==match.moves%2)return false;
  }else{
    if(!last.collapsed||match.phase!=='collapsed'||
      match.winner!==(1-last.player)||match.currentPlayer!==last.player)
      return false;
    // The losing move must itself cause the collapse; no already collapsed
    // state or fabricated winner can be used as a basis for more moves.
    const before=match.blocks.map(b=>b.id===last.blockId?{...b,removed:false}:b);
    if(!Array.from({length:TOWER_LAYERS-1},(_,i)=>supported(before,i)).every(Boolean))
      return false;
  }
  return true;
}

export function towerLegalBlockIds(match:TowerMatch):readonly number[] {
  if(!isTowerMatch(match)||match.phase!=='playing')return [];
  return match.blocks.filter(b=>b.layer<TOWER_LAYERS-1&&!b.removed)
    .map(b=>b.id);
}

/** One conscious player move; no random fall, implicit auto-play, or scoring API. */
export function removeTowerChaosBlock(match:TowerMatch,player:TowerPlayer,
  blockId:number):TowerMatch|null {
  if(!isTowerMatch(match)||match.phase!=='playing'||
    player!==match.currentPlayer||
    !Number.isSafeInteger(blockId)||!towerLegalBlockIds(match).includes(blockId))
    return null;
  const blocks=match.blocks.map(b=>b.id===blockId?{...b,removed:true}:b);
  const collapse=Array.from({length:TOWER_LAYERS-1},(_,i)=>supported(blocks,i))
    .some(ok=>!ok);
  const next:TowerMatch={
    blocks,moves:match.moves+1,phase:collapse?'collapsed':'playing',
    currentPlayer:collapse?player:(1-player) as TowerPlayer,
    winner:collapse?(1-player) as TowerPlayer:null,
    last:{player,blockId,collapsed:collapse},
  };
  return isTowerMatch(next)?next:null;
}

/** Drawing pose only. Rule authority never consumes this presentation result. */
export interface TowerPose {
  readonly x:number;readonly y:number;readonly z:number;
  readonly rotationY:number;
}
export function towerBlockPose(block:TowerBlock):TowerPose|null {
  if(block.removed||!Number.isSafeInteger(block.id)||
    block.id<0||block.id>=TOWER_BLOCK_COUNT||
    block.layer!==Math.floor(block.id/3)||block.slot!==block.id%3)
    return null;
  const horizontal=block.layer%2===0;
  const cross=(block.slot-1)*0.62;
  return {x:horizontal?cross:0,y:0.18+block.layer*0.36,
    z:horizontal?0:cross,rotationY:horizontal?0:Math.PI/2};
}
