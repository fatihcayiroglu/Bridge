import {
  isTowerMatch,towerLegalBlockIds,towerBlockPose,type TowerMatch,
} from './tower-chaos-physics.ts';

/**
 * Portable six-float (xyz + RGB) triangle geometry for a future WebGL1/2
 * Tower Chaos renderer. The arcade rules NEVER read these draw vertices.
 * No external textures, assets, network messages or claimed multiplayer.
 */
type Color=readonly [number,number,number];
const BASE:Color=[.23,.26,.30];
const WOOD_A:Color=[.70,.43,.19];
const WOOD_B:Color=[.83,.58,.29];
const SELECTED:Color=[.96,.87,.36];

function box(out:number[],x:number,y:number,z:number,
  width:number,height:number,length:number,rotation:number,color:Color):void {
  const local=[
    [-width/2,0,-length/2],[width/2,0,-length/2],
    [width/2,height,-length/2],[-width/2,height,-length/2],
    [-width/2,0,length/2],[width/2,0,length/2],
    [width/2,height,length/2],[-width/2,height,length/2],
  ] as const;
  const sin=Math.sin(rotation),cos=Math.cos(rotation);
  const vertices=local.map(v=>[
    x+v[0]*cos-v[2]*sin,y+v[1],z+v[0]*sin+v[2]*cos,
  ]);
  const faces=[
    [4,5,6,7,1],[1,0,3,2,.65],[0,4,7,3,.82],
    [5,1,2,6,.78],[3,7,6,2,1],[0,1,5,4,.57],
  ] as const;
  for(const [a,b,c,d,shade] of faces){
    for(const i of [a,b,c,a,c,d]){
      const v=vertices[i]!;
      out.push(v[0]!,v[1]!,v[2]!,
        ...color.map(channel=>Math.min(1,channel*shade)));
    }
  }
}
export function towerChaosGeometry(match:TowerMatch,collapseProgress=0,
  selectedId:number|null=null):Float32Array|null{
  if(!isTowerMatch(match)||!Number.isFinite(collapseProgress)||
      collapseProgress<0||collapseProgress>1||
      (match.phase!=='collapsed'&&collapseProgress!==0)||
      (selectedId!==null&&(!Number.isSafeInteger(selectedId)||
        !towerLegalBlockIds(match).includes(selectedId))))return null;
  const vertices:number[]=[];
  box(vertices,0,-.16,0,3.7,.14,3.7,0,BASE);
  for(const block of match.blocks){
    if(block.removed)continue;
    const pose=towerBlockPose(block);
    if(!pose)return null;
    // A cosmetic collapse sweep after adjudication, not an outcome oracle.
    const shift=match.phase==='collapsed'
      ?collapseProgress*collapseProgress*.23*(block.layer+1):0;
    const drop=match.phase==='collapsed'
      ?collapseProgress*collapseProgress*.10*block.layer:0;
    box(vertices,pose.x+shift,pose.y-drop,pose.z,
      .57,.32,1.88,pose.rotationY,
      block.id===selectedId?SELECTED:block.layer%2===0?WOOD_A:WOOD_B);
  }
  if(vertices.length===0||vertices.length%36!==0||
      !vertices.every(Number.isFinite))return null;
  return new Float32Array(vertices);
}
