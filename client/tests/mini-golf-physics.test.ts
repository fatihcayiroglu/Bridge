import { describe, expect, it } from 'vitest';
import {
  GOLF_FIXED_DT, GOLF_HOLE, GOLF_LIMITS, newGolfRound, strikeGolf, stepGolf,
} from '../js/core/activities/mini-golf-physics.ts';

function settle(start: ReturnType<typeof newGolfRound>) {
  let s = start;
  for(let i=0;i<2400&&s.status==='moving';i++)s=stepGolf(s);
  return s;
}

describe('Mini Golf isolated solo practice physics', () => {
  it('starts with a clean local stroke count and a stationary ball', () => {
    expect(newGolfRound()).toMatchObject({ x: 0, z: 3.6, strokes: 0, status: 'ready', vx: 0, vz: 0 });
    expect(GOLF_FIXED_DT).toBeCloseTo(1/120, 9);
  });
  it('rejects invalid or premature strokes without mutating state', () => {
    const initial=newGolfRound();
    for(const [degrees,power] of [[Infinity,60],[0,NaN],[80,30],[0,0],[0,101]]) {
      expect(strikeGolf(initial,degrees,power)).toBe(initial);
    }
    const rolling=strikeGolf(initial,0,60);
    expect(rolling.status).toBe('moving');
    expect(strikeGolf(rolling,15,45)).toBe(rolling);
  });
  it('makes a straight reasonable-power stroke reach the hole and lock out new hits', () => {
    const won=settle(strikeGolf(newGolfRound(),0,60));
    expect(won.status).toBe('won');
    expect(won.strokes).toBe(1);
    expect(won.x).toBe(GOLF_HOLE.x);
    expect(won.z).toBe(GOLF_HOLE.z);
    expect(strikeGolf(won,0,60)).toBe(won);
    expect(stepGolf(won)).toBe(won);
  });
  it('counts a miss and a second shot without claiming multiplayer points', () => {
    const stopped=settle(strikeGolf(newGolfRound(),60,35));
    expect(stopped.status).toBe('ready');
    expect(stopped.strokes).toBe(1);
    const second=strikeGolf(stopped,-10,35);
    expect(second.strokes).toBe(2);
    expect(second.status).toBe('moving');
    expect(newGolfRound().strokes).toBe(0);
  });
  it('keeps walls bounded for all initial aimed shots and never produces NaN', () => {
    for (let angle=-70;angle<=70;angle+=10) {
      const state=settle(strikeGolf(newGolfRound(),angle,100));
      expect(Number.isFinite(state.x)&&Number.isFinite(state.z)).toBe(true);
      expect(Math.abs(state.x)).toBeLessThanOrEqual(GOLF_LIMITS.x);
      expect(Math.abs(state.z)).toBeLessThanOrEqual(GOLF_LIMITS.z);
      expect(['ready','won']).toContain(state.status);
    }
  });
  it('is deterministic and does not evolve a stopped ball', () => {
    const hit=strikeGolf(newGolfRound(),25,45);
    expect(settle(hit)).toEqual(settle(hit));
    expect(stepGolf(newGolfRound())).toEqual(newGolfRound());
  });
});
