import {describe,it,expect} from 'vitest';
import {
  TOWER_BLOCK_COUNT,TOWER_LAYERS,TOWER_MAX_MOVES,
  isTowerMatch,newTowerChaos,removeTowerChaosBlock,towerBlockPose,
  towerLegalBlockIds,type TowerMatch,
} from '../js/core/activities/tower-chaos-physics.ts';

describe('Tower Chaos deterministic offline two-person arcade rules',()=>{
  it('starts a complete alternating six-layer stack with a bounded 15-block playfield',()=>{
    const game=newTowerChaos();
    expect(isTowerMatch(game)).toBe(true);
    expect(game.blocks).toHaveLength(TOWER_BLOCK_COUNT);
    expect(game.blocks.map(b=>b.id)).toEqual(Array.from({length:18},(_,i)=>i));
    expect(TOWER_LAYERS).toBe(6);
    expect(TOWER_MAX_MOVES).toBe(15);
    expect(towerLegalBlockIds(game)).toEqual(Array.from({length:15},(_,i)=>i));
    expect(game.winner).toBeNull();
    const poses=game.blocks.map(towerBlockPose);
    expect(poses.every(p=>p!==null)).toBe(true);
    expect(poses.every(p=>Object.values(p!).every(Number.isFinite))).toBe(true);
    expect(poses[0]).toEqual({x:-0.62,y:0.18,z:0,rotationY:0});
    expect(poses[4]).toEqual({x:0,y:0.54,z:0,rotationY:Math.PI/2});
  });

  it('a center pull is stable with two exterior supports; then one outer pull loses',()=>{
    const opening=newTowerChaos();
    const first=removeTowerChaosBlock(opening,0,1)!;
    expect(first).not.toBeNull();
    expect(first.phase).toBe('playing');
    expect(first.currentPlayer).toBe(1);
    expect(first.winner).toBeNull();
    expect(first.last).toEqual({player:0,blockId:1,collapsed:false});
    expect(first.moves).toBe(1);
    expect(opening.moves).toBe(0);
    expect(opening.blocks[1]?.removed).toBe(false);
    const end=removeTowerChaosBlock(first,1,0)!;
    expect(end.phase).toBe('collapsed');
    expect(end.winner).toBe(0);
    expect(end.currentPlayer).toBe(1);
    expect(end.last).toEqual({player:1,blockId:0,collapsed:true});
    expect(isTowerMatch(end)).toBe(true);
    expect(towerLegalBlockIds(end)).toEqual([]);
    expect(removeTowerChaosBlock(end,1,2)).toBeNull();
    expect(towerBlockPose(end.blocks[0]!)).toBeNull();
    expect(towerBlockPose(end.blocks[1]!)).toBeNull();
    expect(towerBlockPose(end.blocks[2]!)).not.toBeNull();
  });

  it('allows deliberate removal across distinct lower layers and alternates each turn',()=>{
    let game=newTowerChaos();
    for(const blockId of [1,4,7,10,13]){
      const next=removeTowerChaosBlock(game,game.currentPlayer,blockId);
      expect(next?.phase).toBe('playing');
      expect(isTowerMatch(next)).toBe(true);
      game=next!;
    }
    expect(game.moves).toBe(5);
    expect(game.currentPlayer).toBe(1);
    expect(towerLegalBlockIds(game)).toHaveLength(10);
    expect(towerLegalBlockIds(game)).not.toContain(16);
    const loser=removeTowerChaosBlock(game,1,3)!;
    expect(loser.phase).toBe('collapsed');
    expect(loser.winner).toBe(0);
  });

  it('never accepts top-row removal, out-of-turn input, duplicate or nonfinite ID',()=>{
    const g=newTowerChaos();
    for(const id of [15,16,17,-1,18,1.1,NaN,Infinity,-Infinity]){
      expect(removeTowerChaosBlock(g,0,id)).toBeNull();
    }
    expect(removeTowerChaosBlock(g,1,1)).toBeNull();
    const after=removeTowerChaosBlock(g,0,1)!;
    expect(removeTowerChaosBlock(after,0,4)).toBeNull();
    expect(removeTowerChaosBlock(after,1,1)).toBeNull();
  });

  it('rejects fabricated match state without silently awarding wins',()=>{
    const g=newTowerChaos();
    const fail=(m:TowerMatch)=>{
      expect(isTowerMatch(m)).toBe(false);
      expect(towerLegalBlockIds(m)).toEqual([]);
      expect(removeTowerChaosBlock(m,0,1)).toBeNull();
    };
    fail({...g,blocks:g.blocks.slice(1)});
    fail({...g,blocks:g.blocks.map((b,i)=>i===2?{...b,id:0}:b)});
    fail({...g,blocks:g.blocks.map((b,i)=>i===2?{...b,slot:1 as const}:b)});
    fail({...g,blocks:g.blocks.map((b,i)=>i===16?{...b,removed:true}:b),
      moves:1});
    fail({...g,blocks:g.blocks.map((b,i)=>i===1?{...b,removed:true}:b)});
    fail({...g,phase:'collapsed',winner:1});
    fail({...g,moves:-1});
    fail({...g,moves:Infinity});
    const after=removeTowerChaosBlock(g,0,1)!;
    fail({...after,phase:'collapsed',winner:1});
    fail({...after,last:{player:1,blockId:1,collapsed:false}});
    const collapsed=removeTowerChaosBlock(after,1,0)!;
    fail({...collapsed,winner:1});
    fail({...collapsed,phase:'playing',winner:null});
    fail({...collapsed,currentPlayer:0});
    fail({...collapsed,last:{player:1,blockId:2,collapsed:true}});
  });

  it('does not confuse meshes with move outcomes or mutate prior snapshots',()=>{
    const g=newTowerChaos();
    const snapshot=JSON.stringify(g);
    const next=removeTowerChaosBlock(g,0,4)!;
    const expected=JSON.stringify(next);
    const pose=towerBlockPose(next.blocks[3]!);
    expect(pose).toEqual({x:0,y:0.54,z:-.62,rotationY:Math.PI/2});
    expect(JSON.stringify(g)).toEqual(snapshot);
    expect(JSON.stringify(next)).toEqual(expected);
    expect(towerBlockPose({...g.blocks[4]!,id:200})).toBeNull();
    expect(towerBlockPose({...g.blocks[4]!,layer:5})).toBeNull();
  });
});
