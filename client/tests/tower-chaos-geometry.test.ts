import {describe,it,expect} from 'vitest';
import {
  newTowerChaos,removeTowerChaosBlock,
  TOWER_BLOCK_COUNT,
} from '../js/core/activities/tower-chaos-physics.ts';
import {towerChaosGeometry} from '../js/core/activities/tower-chaos-geometry.ts';

describe('Tower Chaos local 3D vertices (not multiplayer or WebGL acceptance)',()=>{
  it('generates a closed colored floor and eighteen real 3D boxes',()=>{
    const mesh=towerChaosGeometry(newTowerChaos());
    expect(mesh).not.toBeNull();
    // Six faces * two triangles * three vertices * six position/RGB values.
    expect(mesh!.length).toBe((TOWER_BLOCK_COUNT+1)*216);
    expect(mesh!.length%18).toBe(0);
    expect([...mesh!].every(Number.isFinite)).toBe(true);
    for(let i=0;i<mesh!.length;i+=6){
      for(let ch=3;ch<6;ch++){
        expect(mesh![i+ch]).toBeGreaterThanOrEqual(0);
        expect(mesh![i+ch]).toBeLessThanOrEqual(1);
      }
    }
    const ys=Array.from({length:mesh!.length/6},(_,i)=>mesh![i*6+1]!);
    expect(Math.max(...ys)).toBeGreaterThan(2);
    expect(Math.min(...ys)).toBeLessThan(0);
    const oddRow=new Set<number>();
    for(let i=0;i<mesh!.length;i+=6)oddRow.add(Math.round(mesh![i]!*100));
    expect(oddRow.size).toBeGreaterThan(6);
  });

  it('removing blocks changes exactly one box without falsifying the result',()=>{
    const start=newTowerChaos();
    const one=removeTowerChaosBlock(start,0,1)!;
    const scene=towerChaosGeometry(one)!;
    expect(scene.length).toBe(TOWER_BLOCK_COUNT*216);
    expect(towerChaosGeometry(start)?.length).toBe((TOWER_BLOCK_COUNT+1)*216);
    const collapsed=removeTowerChaosBlock(one,1,0)!;
    const stationary=towerChaosGeometry(collapsed)!;
    const shifted=towerChaosGeometry(collapsed,1)!;
    expect(stationary.length).toBe((TOWER_BLOCK_COUNT-1)*216);
    expect(shifted.length).toBe(stationary.length);
    expect([...shifted].every(Number.isFinite)).toBe(true);
    expect([...shifted]).not.toEqual([...stationary]);
    expect(collapsed.winner).toBe(0); // renderer did not decide this
    expect(collapsed.phase).toBe('collapsed');
  });

  it('recolors only the selected real block without altering rule state or mesh count',()=>{
    const match=newTowerChaos();
    const snapshot=JSON.stringify(match);
    const plain=towerChaosGeometry(match)!;
    const bright=towerChaosGeometry(match,0,1)!;
    expect(bright).toHaveLength(plain.length);
    // One 216-float box follows the ground and first block. Geometry uses
    // interleaved xyz/RGB so only selected block color channels may change.
    const start=216*2,end=216*3;
    expect([...bright.slice(0,start)]).toEqual([...plain.slice(0,start)]);
    expect([...bright.slice(end)]).toEqual([...plain.slice(end)]);
    let colorDiff=0;
    for(let i=start;i<end;i++){
      if(i%6<3)expect(bright[i]).toBe(plain[i]);
      else if(bright[i]!==plain[i])colorDiff++;
    }
    expect(colorDiff).toBeGreaterThan(20);
    expect(JSON.stringify(match)).toBe(snapshot);
    expect(towerChaosGeometry(match)).toEqual(plain);
    expect(towerChaosGeometry(match,0,null)).toEqual(plain);
  });
  it('never highlights invalid, removed, protected or finished blocks',()=>{
    const game=newTowerChaos();
    for(const id of [-1,15,16,17,18,1.5,NaN,Infinity,-Infinity]){
      expect(towerChaosGeometry(game,0,id)).toBeNull();
    }
    const one=removeTowerChaosBlock(game,0,1)!;
    expect(towerChaosGeometry(one,0,1)).toBeNull();
    expect(towerChaosGeometry(one,0,4)).not.toBeNull();
    const end=removeTowerChaosBlock(one,1,0)!;
    expect(towerChaosGeometry(end,0,4)).toBeNull();
    expect(towerChaosGeometry(end,1,null)).not.toBeNull();
  });
  it('refuses impossible animation or unverified match states',()=>{
    const g=newTowerChaos();
    for(const progress of [-1,0.01,1.01,NaN,Infinity,-Infinity]){
      expect(towerChaosGeometry(g,progress)).toBeNull();
    }
    expect(towerChaosGeometry({...g,moves:2})).toBeNull();
    expect(towerChaosGeometry({...g,blocks:[]})).toBeNull();
    const a=removeTowerChaosBlock(g,0,1)!;
    const done=removeTowerChaosBlock(a,1,0)!;
    expect(towerChaosGeometry(done,0)).not.toBeNull();
    expect(towerChaosGeometry(done,0.5)).not.toBeNull();
    expect(towerChaosGeometry(done,1)).not.toBeNull();
  });
});
