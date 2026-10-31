/**
 * Deterministic, offline-only mini golf practice for Bridge Activities.
 * No achievements, room membership, server score or multiplayer claims.
 * Pure state transitions allow real-time and unit acceptance to use the same
 * motion/collision contract, including when the browser is backgrounded.
 */
export type GolfStatus = 'ready' | 'moving' | 'won';
export interface GolfState {
  readonly x: number;
  readonly z: number;
  readonly vx: number;
  readonly vz: number;
  readonly strokes: number;
  readonly status: GolfStatus;
}
export const GOLF_START = Object.freeze({ x: 0, z: 3.6 });
export const GOLF_HOLE = Object.freeze({ x: 0, z: -3.8 });
export const GOLF_LIMITS = Object.freeze({ x: 2.25, z: 4.6 });
export const GOLF_FIXED_DT = 1 / 120;
const DECELERATION = 2.3;
const BALL_RADIUS = 0.14;
const HOLE_RADIUS = 0.32;

export function newGolfRound(): GolfState {
  return { ...GOLF_START, vx: 0, vz: 0, strokes: 0, status: 'ready' };
}

/** A shot is only legal once the ball has stopped and before winning. */
export function strikeGolf(state: GolfState, degrees: number, power: number): GolfState {
  if (state.status !== 'ready' || !Number.isFinite(degrees) ||
      !Number.isFinite(power) || Math.abs(degrees) > 70 ||
      power < 10 || power > 100 || state.strokes >= 99) return state;
  const radians = degrees * Math.PI / 180;
  const speed = power * 0.1;
  return {
    ...state, vx: Math.sin(radians) * speed, vz: -Math.cos(radians) * speed,
    strokes: state.strokes + 1, status: 'moving',
  };
}

/** One fixed physics tick. No wall-clock or nondeterministic randomness. */
export function stepGolf(state: GolfState): GolfState {
  if (state.status !== 'moving') return state;
  const speed = Math.hypot(state.vx, state.vz);
  if (!Number.isFinite(speed) || speed <= 0.01) {
    return { ...state, vx: 0, vz: 0, status: 'ready' };
  }
  const nextSpeed = Math.max(0, speed - DECELERATION * GOLF_FIXED_DT);
  // Symplectic bounded integration (position advances at the new velocity).
  let vx = state.vx * nextSpeed / speed;
  let vz = state.vz * nextSpeed / speed;
  let x = state.x + vx * GOLF_FIXED_DT;
  let z = state.z + vz * GOLF_FIXED_DT;
  const maxX = GOLF_LIMITS.x - BALL_RADIUS;
  const maxZ = GOLF_LIMITS.z - BALL_RADIUS;
  if (x < -maxX || x > maxX) {
    x = Math.max(-maxX, Math.min(maxX, x));
    vx = -vx * 0.50;
  }
  if (z < -maxZ || z > maxZ) {
    z = Math.max(-maxZ, Math.min(maxZ, z));
    vz = -vz * 0.50;
  }
  if (Math.hypot(x - GOLF_HOLE.x, z - GOLF_HOLE.z) < HOLE_RADIUS) {
    return { x: GOLF_HOLE.x, z: GOLF_HOLE.z, vx: 0, vz: 0, strokes: state.strokes, status: 'won' };
  }
  if (Math.hypot(vx, vz) < 0.025) {
    return { x, z, vx: 0, vz: 0, strokes: state.strokes, status: 'ready' };
  }
  return { x, z, vx, vz, strokes: state.strokes, status: 'moving' };
}
