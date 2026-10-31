import {describe,expect,it} from 'vitest';
import {newTowerChaos,removeTowerChaosBlock} from
  '../js/core/activities/tower-chaos-physics.ts';
import {towerHitTest} from '../js/core/activities/tower-chaos-hit-test.ts';

describe('true camera ray hit test for visible Tower Chaos blocks',()=>{
  it('hits a visible lower-layer object with real view/FOV at 600x440 CSS',()=>{
    const match=newTowerChaos();
    // Center of physical block #11 from the actual 3D camera.
    expect(towerHitTest(match,289.8,219.2,600,440)).toBe(11);
    // Ray intersecting an unremovable top block is NOT allowed to select
    // an occluded lower block through the upper tower.
    expect(towerHitTest(match,289.5,198.4,600,440)).toBeNull();
  });
  it('never removes a block or trusts an expired turn through picking',()=>{
    const match=newTowerChaos();
    const copy=JSON.stringify(match);
    const picked=towerHitTest(match,289.8,219.2,600,440);
    expect(picked).toBe(11);
    expect(JSON.stringify(match)).toBe(copy);
    const next=removeTowerChaosBlock(match,0,11)!;
    expect(towerHitTest(next,289.8,219.2,600,440)).not.toBe(11);
    const collapsed=removeTowerChaosBlock(removeTowerChaosBlock(match,0,1)!,1,0)!;
    expect(towerHitTest(collapsed,289.8,219.2,600,440)).toBeNull();
  });
  it('rejects unsafe dimensions, edges, nonfinite pointer positions and malformed state',()=>{
    const match=newTowerChaos();
    for(const args of [
      [-1,200,600,440],[601,200,600,440],[200,-1,600,440],
      [200,441,600,440],[200,200,0,440],[200,200,600,-1],
      [200,200,8193,400],[200,200,600,8193],
      [NaN,200,600,440],[Infinity,200,600,440],
      [200,200,NaN,440],[200,200,600,Infinity],
    ]){
      expect(towerHitTest(match,...args as [number,number,number,number])).toBeNull();
    }
    expect(towerHitTest({...match,moves:5},289.8,219.2,600,440)).toBeNull();
    expect(towerHitTest(match,0,0,600,440)).toBeNull();
    expect(towerHitTest(match,600,440,600,440)).toBeNull();
  });
});
