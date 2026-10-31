import {
  isTowerMatch,towerLegalBlockIds,towerBlockPose,type TowerMatch,
} from './tower-chaos-physics.ts';

/**
 * Read-only pointer ray cast for the genuine Tower Chaos camera and 18 block
 * bounding boxes. Uses the same eye/target/FOV and .57/.32/1.88 geometry as
 * the WebGL renderer; no color readback, trusting client-supplied block IDs,
 * game-state mutation or automatic removal.
 */
const EYE=[5,5.5,8] as const;
const TARGET=[0,1.15,0] as const;
const HALF_FOV=Math.PI/5;
const UNIT=(a:readonly number[]):[number,number,number]=>{
  const n=Math.hypot(...a);
  return [a[0]!/n,a[1]!/n,a[2]!/n];
};
const BACK=UNIT(EYE.map((v,i)=>v-TARGET[i]!));
const RIGHT=UNIT([BACK[2],0,-BACK[0]]);
const UP:[number,number,number]=[
  BACK[1]*RIGHT[2]-BACK[2]*RIGHT[1],
  BACK[2]*RIGHT[0]-BACK[0]*RIGHT[2],
  BACK[0]*RIGHT[1]-BACK[1]*RIGHT[0],
];
const HALVES=[.57/2,.32/2,1.88/2] as const;
function intersect(ray:readonly number[],position:readonly number[],
  angle:number):number|null {
  const c=Math.cos(angle),s=Math.sin(angle);
  const dx=EYE[0]-position[0]!,dy=EYE[1]-position[1]!,dz=EYE[2]-position[2]!;
  const origin=[dx*c+dz*s,dy,-dx*s+dz*c];
  const dir=[ray[0]!*c+ray[2]!*s,ray[1]!,-ray[0]!*s+ray[2]!*c];
  let near=0,far=Infinity;
  for(let axis=0;axis<3;axis++){
    const o=origin[axis]!,d=dir[axis]!,limit=HALVES[axis]!;
    if(Math.abs(d)<1e-10){
      if(o < -limit || o>limit)return null;
    }else{
      const a=(-limit-o)/d,b=(limit-o)/d;
      near=Math.max(near,Math.min(a,b));
      far=Math.min(far,Math.max(a,b));
      if(near>far)return null;
    }
  }
  return far>=0?near:null;
}
export function towerHitTest(match:TowerMatch,
  xCss:number,yCss:number,widthCss:number,heightCss:number):number|null {
  if(!isTowerMatch(match)||match.phase!=='playing'||
    ![xCss,yCss,widthCss,heightCss].every(Number.isFinite)||
    widthCss<=0||heightCss<=0||widthCss>8192||heightCss>8192||
    xCss<0||yCss<0||xCss>widthCss||yCss>heightCss)return null;
  const aspect=widthCss/heightCss;
  const sx=(2*xCss/widthCss-1)*Math.tan(HALF_FOV)*aspect;
  const sy=(1-2*yCss/heightCss)*Math.tan(HALF_FOV);
  const ray=UNIT([
    RIGHT[0]*sx+UP[0]*sy-BACK[0],
    RIGHT[1]*sx+UP[1]*sy-BACK[1],
    RIGHT[2]*sx+UP[2]*sy-BACK[2],
  ]);
  let nearest=Infinity,hit:null|number=null;
  for(const block of match.blocks){
    const pose=towerBlockPose(block);
    if(!pose)continue;
    const t=intersect(ray,[pose.x,pose.y+.16,pose.z],pose.rotationY);
    if(t!==null&&t<nearest){nearest=t;hit=block.id;}
  }
  // An unremovable top block occludes lower blocks rather than allowing a
  // click-through. Only the already-authorized dropdown target IDs can win.
  return hit!==null&&towerLegalBlockIds(match).includes(hit)?hit:null;
}
