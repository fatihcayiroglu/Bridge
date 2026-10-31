import {
  isTowerMatch,towerBlockPose,TOWER_LAYERS,type TowerMatch,
} from './tower-chaos-physics.ts';

/**
 * Camera/picking contract shared with Tower Chaos WebGL. Selection is only a
 * proposed block ID; the game rules remain the sole move/winner authority.
 */
export const TOWER_CAMERA_EYE=Object.freeze([5,5.5,8] as const);
export const TOWER_CAMERA_TARGET=Object.freeze([0,1.15,0] as const);
export const TOWER_TAN_HALF_FOV=Math.tan(Math.PI/5);
type Vec3=readonly [number,number,number];
const dot=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const normalize=(v:Vec3):Vec3=>{
  const n=Math.hypot(...v);
  return [v[0]/n,v[1]/n,v[2]/n];
};
const subtract=(a:Vec3,b:Vec3):Vec3=>
  [a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const add=(a:Vec3,b:Vec3):Vec3=>
  [a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const scale=(a:Vec3,k:number):Vec3=>[a[0]*k,a[1]*k,a[2]*k];

export function towerCameraBasis():{right:Vec3;up:Vec3;back:Vec3}{
  const back=normalize(subtract(TOWER_CAMERA_EYE,TOWER_CAMERA_TARGET));
  const right=normalize([back[2],0,-back[0]]);
  const up:Vec3=[
    back[1]*right[2]-back[2]*right[1],
    back[2]*right[0]-back[0]*right[2],
    back[0]*right[1]-back[1]*right[0],
  ];
  return {right,up,back};
}

/** Returns x/y screen coordinates in [-1,1], with Y increasing upward. */
export function towerProjectPoint(point:Vec3,aspect:number):
  {x:number;y:number}|null {
  if(!point.every(Number.isFinite)||!Number.isFinite(aspect)||
      aspect<=0)return null;
  const {right,up,back}=towerCameraBasis();
  const diff=subtract(point,TOWER_CAMERA_EYE);
  const depth=-dot(diff,back);
  if(depth<=0)return null;
  return {x:dot(diff,right)/(depth*TOWER_TAN_HALF_FOV*aspect),
    y:dot(diff,up)/(depth*TOWER_TAN_HALF_FOV)};
}
function rayBox(eye:Vec3,direction:Vec3,origin:Vec3,rotation:number):
  number|null {
  const c=Math.cos(rotation),s=Math.sin(rotation);
  const offset=subtract(eye,origin);
  // Match the geometry's Y-axis rotation exactly (inverse for ray space).
  const localEye:Vec3=[offset[0]*c+offset[2]*s,offset[1],
    -offset[0]*s+offset[2]*c];
  const localDir:Vec3=[
    direction[0]*c+direction[2]*s,direction[1],
    -direction[0]*s+direction[2]*c,
  ];
  const min:Vec3=[-.57/2,0,-1.88/2],max:Vec3=[.57/2,.32,1.88/2];
  let enter=-Infinity,exit=Infinity;
  for(let i=0;i<3;i++){
    const start=localEye[i],step=localDir[i];
    if(Math.abs(step)<1e-10){
      if(start<min[i]||start>max[i])return null;
      continue;
    }
    const a=(min[i]-start)/step,b=(max[i]-start)/step;
    enter=Math.max(enter,Math.min(a,b));
    exit=Math.min(exit,Math.max(a,b));
    if(enter>exit)return null;
  }
  return exit>0?Math.max(0,enter):null;
}

/** Nearest visible block, including non-removable top blocks as occluders. */
export function towerPickBlock(match:TowerMatch,x:number,y:number,aspect:number):
  number|null {
  if(!isTowerMatch(match)||match.phase!=='playing'||
      !Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(aspect)||
      Math.abs(x)>1||Math.abs(y)>1||aspect<=0||aspect>16)return null;
  const {right,up,back}=towerCameraBasis();
  const dir=normalize(add(add(scale(back,-1),
    scale(right,x*aspect*TOWER_TAN_HALF_FOV)),
    scale(up,y*TOWER_TAN_HALF_FOV)));
  let hit:number|null=null,near=Infinity;
  for(const block of match.blocks){
    const pose=towerBlockPose(block);
    if(!pose)continue;
    const depth=rayBox(TOWER_CAMERA_EYE,dir,
      [pose.x,pose.y,pose.z],pose.rotationY);
    if(depth!==null&&depth<near){near=depth;hit=block.id;}
  }
  // Do not click "through" the protected top row to reach lower blocks.
  return hit!==null&&Math.floor(hit/3)<TOWER_LAYERS-1?hit:null;
}
