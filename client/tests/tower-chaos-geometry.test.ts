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

  it('highlights only a legal selected 3D block without changing geometry or rules',()=>{
    const match=newTowerChaos();
    const before=JSON.stringify(match);
    const plain=towerChaosGeometry(match)!;
    const tinted=towerChaosGeometry(match,0,11)!;
    expect(tinted.length).toBe(plain.length);
    expect([...tinted.slice(0,216)]).toEqual([...plain.slice(0,216)]);
    for(let id=0;id<TOWER_BLOCK_COUNT;id++){
      const start=(id+1)*216;
      if(id!==11)expect([...tinted.slice(start,start+216)])
        .toEqual([...plain.slice(start,start+216)]);
    }
    const firstColor=(11+1)*216+3;
    expect([...tinted.slice(firstColor,firstColor+3)])
      .toEqual([Math.fround(.96),Math.fround(.87),Math.fround(.36)]);
    expect([...tinted.slice(firstColor,firstColor+3)])
      .not.toEqual([...plain.slice(firstColor,firstColor+3)]);
    expect(JSON.stringify(match)).toBe(before);
    for(const invalid of [-1,15,17,1.1,NaN,Infinity])
      expect(towerChaosGeometry(match,0,invalid)).toBeNull();
    const first=removeTowerChaosBlock(match,0,11)!;
    expect(towerChaosGeometry(first,0,11)).toBeNull();
    const done=removeTowerChaosBlock(
      removeTowerChaosBlock(match,0,1)!,1,0)!;
    expect(towerChaosGeometry(done,0,2)).toBeNull();
    expect(towerChaosGeometry(done,0,null)).not.toBeNull();
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
