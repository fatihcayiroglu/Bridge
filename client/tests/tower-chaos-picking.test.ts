import {describe,expect,it} from 'vitest';
import {
  newTowerChaos,removeTowerChaosBlock,towerBlockPose,
} from '../js/core/activities/tower-chaos-physics.ts';
import {
  towerPickBlock,towerProjectPoint,
} from '../js/core/activities/tower-chaos-picking.ts';

describe('Tower Chaos real camera ray selection, not rules adjudication',()=>{
  it('maps finite screen rays to distinct visible lower-layer blocks only',()=>{
    const start=newTowerChaos();
    const hits=new Set<number>();
    for(let xi=0;xi<=80;xi++)for(let yi=0;yi<=80;yi++){
      const picked=towerPickBlock(start,xi/40-1,yi/40-1,1.6);
      if(picked!==null){expect(picked).toBeLessThan(15);hits.add(picked);}
    }
    expect(hits.size).toBeGreaterThan(4);
    expect(hits.has(0)||hits.has(1)||hits.has(2)).toBe(true);
    expect(hits.has(12)||hits.has(13)||hits.has(14)).toBe(true);
  });
  it('refuses a protected top-layer hit rather than selecting through it',()=>{
    const state=newTowerChaos();
    const top=towerBlockPose(state.blocks[16]!)!;
    const screen=towerProjectPoint([top.x,top.y+.16,top.z],1.6)!;
    expect(screen).not.toBeNull();
    expect(Math.abs(screen.x)).toBeLessThan(1);
    expect(Math.abs(screen.y)).toBeLessThan(1);
    expect(towerPickBlock(state,screen.x,screen.y,1.6)).toBeNull();
  });
  it('rejects out-of-viewport, nonfinite, malformed, or finished selections',()=>{
    const s=newTowerChaos();
    for(const [x,y,aspect] of [
      [1.01,0,1.6],[-1.01,0,1.6],[0,1.1,1.6],[0,-1.1,1.6],
      [NaN,0,1],[0,Infinity,1],[0,0,0],[0,0,-2],[0,0,Infinity],
      [0,0,20],
    ])expect(towerPickBlock(s,x,y,aspect)).toBeNull();
    expect(towerPickBlock({...s,blocks:[]},0,0,1.6)).toBeNull();
    const a=removeTowerChaosBlock(s,0,1)!;
    const terminal=removeTowerChaosBlock(a,1,0)!;
    expect(towerPickBlock(terminal,0,0,1.6)).toBeNull();
    expect(towerProjectPoint([0,0,0],0)).toBeNull();
    expect(towerProjectPoint([NaN,0,0],1.6)).toBeNull();
    expect(towerProjectPoint([5,5.5,9],1.6)).toBeNull();
  });
  it('does not select removed blocks even if their old screen position is tapped',()=>{
    const original=newTowerChaos();
    const edited=removeTowerChaosBlock(original,0,4)!;
    const hits=new Set<number>();
    for(let xi=0;xi<=80;xi++)for(let yi=0;yi<=80;yi++){
      const pick=towerPickBlock(edited,xi/40-1,yi/40-1,1.6);
      if(pick!==null)hits.add(pick);
    }
    expect(hits.has(4)).toBe(false);
    expect(hits.size).toBeGreaterThan(3);
    expect(original.blocks[4]?.removed).toBe(false);
    expect(edited.blocks[4]?.removed).toBe(true);
  });
});
