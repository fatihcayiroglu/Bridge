/**
 * Deterministic, local-only 3D billiards pocket practice.
 * This is NOT a full 8-ball rules engine or a networked match.
 * All game state is per-panel memory and no score is uploaded.
 */
export const POOL_DT = 1 / 120;
export const POOL_RADIUS = 0.14;
export const POOL_HALF_WIDTH = 2.1;
export const POOL_HALF_LENGTH = 4;
/** Foot spot at the apex of the current 15-object rack, in table coordinates. */
export const POOL_FOOT_SPOT_Z = -1.14;
const FRICTION = 0.86;
const RESTITUTION = 0.91;
const STOP = 0.018;
/** Standard practice inventory: 15 targets plus one cue. Not competitive 8-ball rules. */
export const POOL_TARGET_COUNT = 15;
const MAX_BALLS = POOL_TARGET_COUNT + 1;
// Eight sits at the center of the third row. One solid and one striped ball
// occupy the last-row corners; all numbers appear exactly once.
const RACK_ORDER = [1, 9, 2, 4, 8, 10, 11, 3, 12, 5, 6, 13, 7, 14, 15] as const;
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
/** 0-5 indexes refer to the six fixed pockets, in POOL_POCKETS order. */
export interface PoolPocketEvent {
  readonly ballId:number;
  readonly pocketIndex:number;
}
export interface PoolState {
  readonly balls: readonly PoolBall[];
  readonly shots: number;
  readonly scratches: number;
  readonly pocketed: number;
  readonly status: 'ready' | 'moving' | 'complete';
  /** First object ball contacted by the cue this shot, or null. For future local rule validation. */
  readonly firstObjectHit: number | null;
  /** At least one rail hit after first cue/object contact, not a tournament break-rail count. */
  readonly railAfterContact: boolean;
  /** Unique object IDs driven to a rail after first cue contact on the break. */
  readonly breakObjectRails: readonly number[];
  /** This shot's actual pocket events; no inferred pocket from a boolean. */
  readonly pocketEvents: readonly PoolPocketEvent[];
}
const base = (id:number,x:number,z:number):PoolBall =>
  ({ id,x,z,vx:0,vz:0,pocketed:false });

export function newPoolPractice():PoolState {
  return {
    balls: [base(0, 0, 2.7), ...RACK_ORDER.map((id, index) => {
      // A compact five-row triangle with a safe non-overlapping clearance.
      const row = Math.floor((Math.sqrt(8 * index + 1) - 1) / 2);
      const column = index - row * (row + 1) / 2;
      const spacing = POOL_RADIUS * 2 + 0.010;
      const depth = POOL_RADIUS * Math.sqrt(3) + 0.012;
      return base(id, (column - row / 2) * spacing, POOL_FOOT_SPOT_Z - row * depth);
    })],
    shots:0,scratches:0,pocketed:0,status:'ready',
    firstObjectHit:null,railAfterContact:false,breakObjectRails:[],pocketEvents:[],
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
    firstObjectHit:null,railAfterContact:false,breakObjectRails:[],pocketEvents:[],
    balls:s.balls.map(b=>b.id===0 ? {...b,vx:Math.sin(r)*speed,vz:-Math.cos(r)*speed} : b),
  };
}
type MutableBall={-readonly [K in keyof PoolBall]:PoolBall[K]};
const pocketIndex=(b:PoolBall):number =>
  POOL_POCKETS.findIndex(p=>Math.hypot(b.x-p.x,b.z-p.z)<.31);

/** One fixed, bounded physics tick. Ball/rail collisions and pocket claims are local only. */
export function stepPool(s:PoolState):PoolState {
  if(s.status!=='moving')return s;
  const balls:MutableBall[]=s.balls.map(b=>({...b}));
  let pocketed=s.pocketed, scratches=s.scratches;
  let firstObjectHit=s.firstObjectHit, railAfterContact=s.railAfterContact;
  const breakObjectRails=[...s.breakObjectRails];
  const pocketEvents=[...s.pocketEvents];
  for(const b of balls) {
    if(b.pocketed)continue;
    const v=Math.hypot(b.vx,b.vz);
    if(!Number.isFinite(v))throw Error('POOL_NONFINITE_VELOCITY');
    if(v>0) {
      const next=Math.max(0,v-FRICTION*POOL_DT);
      b.vx*=next/v;b.vz*=next/v;
      b.x+=b.vx*POOL_DT;b.z+=b.vz*POOL_DT;
    }
    const pocket=pocketIndex(b);
    if(pocket!==-1) {
      b.pocketed=true;b.vx=0;b.vz=0;
      pocketEvents.push({ballId:b.id,pocketIndex:pocket});
      if(b.id===0)scratches++;
      else pocketed++;
      continue;
    }
    const boundX=POOL_HALF_WIDTH-POOL_RADIUS;
    const boundZ=POOL_HALF_LENGTH-POOL_RADIUS;
    if(Math.abs(b.x)>boundX) {
      b.x=Math.sign(b.x)*boundX;b.vx*=-RESTITUTION;
      if(firstObjectHit!==null) {
        railAfterContact=true;
        if(s.shots===1 && b.id!==0 && !breakObjectRails.includes(b.id))
          breakObjectRails.push(b.id);
      }
    }
    if(Math.abs(b.z)>boundZ) {
      b.z=Math.sign(b.z)*boundZ;b.vz*=-RESTITUTION;
      if(firstObjectHit!==null) {
        railAfterContact=true;
        if(s.shots===1 && b.id!==0 && !breakObjectRails.includes(b.id))
          breakObjectRails.push(b.id);
      }
    }
  }
  // Each unordered pair at most once: deterministic ordering by immutable ball id.
  for(let i=0;i<balls.length;i++)for(let j=i+1;j<balls.length;j++) {
    const a=balls[i]!,b=balls[j]!;
    if(a.pocketed||b.pocketed)continue;
    const dx=b.x-a.x,dz=b.z-a.z,d=Math.hypot(dx,dz);
    if(d>=2*POOL_RADIUS)continue;
    if(firstObjectHit===null && (a.id===0 || b.id===0))
      firstObjectHit=a.id===0?b.id:a.id;
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
      // Search a bounded back-half grid: never respot the cue intersecting
      // a surviving target, even when the normal point is blocked.
      const xOptions = [0, -.35, .35, -.70, .70, -1.05, 1.05, -1.40, 1.40, -1.75, 1.75];
      const zOptions = [2.7, 3.05, 3.40, 3.75, 2.35, 2.0, 1.65];
      let found = false;
      for(const z of zOptions) {
        for(const x of xOptions) {
          if(balls.some(b=>b.id!==0&&!b.pocketed&&
            Math.hypot(b.x-x,b.z-z)<POOL_RADIUS*2.1))continue;
          cue.x=x;cue.z=z;found=true;break;
        }
        if(found)break;
      }
      if(!found)throw Error('POOL_CUE_RESPOT_BLOCKED');
      cue.pocketed=false;cue.vx=0;cue.vz=0;
    }
  }
  const allPocketed=pocketed===POOL_TARGET_COUNT;
  // Do not freeze the cue or remaining motion when the final target falls.
  // Completion is only announced once the entire table has settled.
  return {balls,shots:s.shots,scratches,pocketed,
    firstObjectHit,railAfterContact,breakObjectRails,pocketEvents,status:
    moving?'moving':allPocketed?'complete':'ready'};
}
