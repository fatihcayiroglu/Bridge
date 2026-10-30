/**
 * Deterministic, local-only 3D billiards pocket practice.
 * This is NOT a full 8-ball rules engine or a networked match.
 * All game state is per-panel memory and no score is uploaded.
 */
export const POOL_DT = 1 / 120;
export const POOL_RADIUS = 0.14;
export const POOL_HALF_WIDTH = 2.1;
export const POOL_HALF_LENGTH = 4;
const FRICTION = 0.86;
const RESTITUTION = 0.91;
const STOP = 0.018;
const MAX_BALLS = 6;
export const POOL_POCKETS = Object.freeze([
  { x: -2.03, z: -3.90 }, { x: 2.03, z: -3.90 },
  { x: -2.03, z: 0 }, { x: 2.03, z: 0 },
  { x: -2.03, z: 3.90 }, { x: 2.03, z: 3.90 },
] as const);
export interface PoolBall {
  readonly id: number;
  readonly x: number; readonly z: number;
  readonly vx: number; readonly vz: number;
  readonly pocketed: boolean;
}
export interface PoolState {
  readonly balls: readonly PoolBall[];
  readonly shots: number;
  readonly scratches: number;
  readonly pocketed: number;
  readonly status: 'ready' | 'moving' | 'complete';
}
const base = (id:number,x:number,z:number):PoolBall =>
  ({ id,x,z,vx:0,vz:0,pocketed:false });

export function newPoolPractice():PoolState {
  return {
    balls: [base(0,0,2.7), base(1,0,-1.15),base(2,-.30,-1.55),
      base(3,.30,-1.55),base(4,-.15,-1.96),base(5,.15,-1.96)],
    shots:0,scratches:0,pocketed:0,status:'ready',
  };
}
export function strikePool(s:PoolState, angle:number, power:number):PoolState {
  if(s.status!=='ready' || !Number.isFinite(angle) || !Number.isFinite(power) ||
     Math.abs(angle)>70 || power<10 || power>100 || s.shots>=999) return s;
  const cue=s.balls.find(b=>b.id===0);
  if(!cue || cue.pocketed || s.balls.length!==MAX_BALLS) return s;
  const r=angle*Math.PI/180, speed=power*.075;
  return {
    ...s,shots:s.shots+1,status:'moving',
    balls:s.balls.map(b=>b.id===0 ? {...b,vx:Math.sin(r)*speed,vz:-Math.cos(r)*speed} : b),
  };
}
type MutableBall={-readonly [K in keyof PoolBall]:PoolBall[K]};
const nearPocket=(b:PoolBall):boolean =>
  POOL_POCKETS.some(p=>Math.hypot(b.x-p.x,b.z-p.z)<.31);

/** One fixed, bounded physics tick. Ball/rail collisions and pocket claims are local only. */
export function stepPool(s:PoolState):PoolState {
  if(s.status!=='moving')return s;
  const balls:MutableBall[]=s.balls.map(b=>({...b}));
  let pocketed=s.pocketed, scratches=s.scratches;
  for(const b of balls) {
    if(b.pocketed)continue;
    const v=Math.hypot(b.vx,b.vz);
    if(!Number.isFinite(v))throw Error('POOL_NONFINITE_VELOCITY');
    if(v>0) {
      const next=Math.max(0,v-FRICTION*POOL_DT);
      b.vx*=next/v;b.vz*=next/v;
      b.x+=b.vx*POOL_DT;b.z+=b.vz*POOL_DT;
    }
    if(nearPocket(b)) {
      b.pocketed=true;b.vx=0;b.vz=0;
      if(b.id===0)scratches++;
      else pocketed++;
      continue;
    }
    const boundX=POOL_HALF_WIDTH-POOL_RADIUS;
    const boundZ=POOL_HALF_LENGTH-POOL_RADIUS;
    if(Math.abs(b.x)>boundX) {
      b.x=Math.sign(b.x)*boundX;b.vx*=-RESTITUTION;
    }
    if(Math.abs(b.z)>boundZ) {
      b.z=Math.sign(b.z)*boundZ;b.vz*=-RESTITUTION;
    }
  }
  // Each unordered pair at most once: deterministic ordering by immutable ball id.
  for(let i=0;i<balls.length;i++)for(let j=i+1;j<balls.length;j++) {
    const a=balls[i]!,b=balls[j]!;
    if(a.pocketed||b.pocketed)continue;
    const dx=b.x-a.x,dz=b.z-a.z,d=Math.hypot(dx,dz);
    if(d>=2*POOL_RADIUS)continue;
    const nx=d<1e-9?1:dx/d,nz=d<1e-9?0:dz/d;
    const penetration=2*POOL_RADIUS-d;
    a.x-=nx*penetration*.5;a.z-=nz*penetration*.5;
    b.x+=nx*penetration*.5;b.z+=nz*penetration*.5;
    const approaching=(b.vx-a.vx)*nx+(b.vz-a.vz)*nz;
    if(approaching<0) {
      const impulse=-(1+RESTITUTION)*approaching*.5;
      a.vx-=impulse*nx;a.vz-=impulse*nz;
      b.vx+=impulse*nx;b.vz+=impulse*nz;
    }
  }
  const moving=balls.some(b=>!b.pocketed&&Math.hypot(b.vx,b.vz)>=STOP);
  if(!moving) {
    for(const b of balls){b.vx=0;b.vz=0;}
    // A scratch re-spots the cue after motion stops; it never counts as an object pocket.
    const cue=balls[0]!;
    if(cue.pocketed) {
      const spawnZ=2.7;
      if(balls.some(b=>b.id!==0&&!b.pocketed&&
        Math.hypot(b.x,b.z-spawnZ)<POOL_RADIUS*2.2)) {
        // Fallback back-half spot, away from the normal cue position.
        cue.x=0;cue.z=3.35;
      } else {cue.x=0;cue.z=spawnZ;}
      cue.pocketed=false;cue.vx=0;cue.vz=0;
    }
  }
  const allPocketed=pocketed===MAX_BALLS-1;
  return {balls,shots:s.shots,scratches,pocketed,status:
    allPocketed?'complete':moving?'moving':'ready'};
}
