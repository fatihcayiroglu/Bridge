/**
 * Experimental Mini Golf two-player match authority. OFF by default.
 *
 * Only Redis-backed, serialized match state. No client-provided coordinates,
 * scores, identities, round transitions or timing. The caller must check
 * current PostgreSQL membership before every mutation AND state read.
 * No Socket.IO room broadcast: a revoked socket never receives a cached
 * match snapshot through another authorized player's action.
 */
import { cache, isRedisAvailable } from '../../lib/redisAdapter';

export const GOLF_MAX_STROKES = 8;
const KEY = 'bridge-mini-golf:v1:';
const TTL_SECONDS = 30 * 60;
export type GolfPhase = 'waiting' | 'playing' | 'finished';
export interface GolfPlayer {
  socketId: string;
  userId: string;
  x: number;
  z: number;
  strokes: number;
  won: boolean;
}
export interface GolfMatch {
  serverId: string;
  revision: number;
  phase: GolfPhase;
  turn: number;
  players: GolfPlayer[];
}
const idOk = (s: unknown): s is string => typeof s === 'string' &&
  s.length > 0 && s.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(s);

function validate(serverId: string, raw: unknown): GolfMatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('GOLF_CORRUPT');
  const game = raw as Partial<GolfMatch>;
  if (game.serverId !== serverId || !Number.isSafeInteger(game.revision) ||
      (game.revision ?? -1) < 0 || !['waiting', 'playing', 'finished'].includes(game.phase ?? '') ||
      !Array.isArray(game.players) || game.players.length > 2 ||
      !Number.isSafeInteger(game.turn) || (game.turn ?? -1) < 0 ||
      (game.players.length > 0 && (game.turn ?? 0) >= game.players.length) ||
      (game.players.length === 0 && game.turn !== 0) ||
      !game.players.every(p => p && idOk(p.socketId) && idOk(p.userId) &&
        Number.isFinite(p.x) && Number.isFinite(p.z) &&
        Math.abs(p.x) <= 2.25 && Math.abs(p.z) <= 4.6 &&
        Number.isSafeInteger(p.strokes) && p.strokes >= 0 && p.strokes <= GOLF_MAX_STROKES &&
        typeof p.won === 'boolean') ||
      (game.phase === 'playing' && game.players.length !== 2) ||
      (game.phase === 'waiting' && game.players.length === 2) ||
      new Set(game.players.map(p => p.userId)).size !== game.players.length ||
      new Set(game.players.map(p => p.socketId)).size !== game.players.length) {
    throw Error('GOLF_CORRUPT');
  }
  return {
    serverId, revision: game.revision!, phase: game.phase!, turn: game.turn!,
    players: game.players.map(p => ({ ...p })),
  };
}
export function emptyGolfMatch(serverId: string): GolfMatch {
  if (!idOk(serverId)) throw Error('GOLF_BAD_ID');
  return { serverId, revision: 0, phase: 'waiting', turn: 0, players: [] };
}
export const golfMatchStore = {
  async withLock<T>(serverId: string, action: () => Promise<T>): Promise<T> {
    if (!idOk(serverId)) throw Error('GOLF_BAD_ID');
    if (!isRedisAvailable()) throw Error('GOLF_REDIS_REQUIRED');
    return cache.withKeyLock('bridge-mini-golf:lock:' + serverId, action,
      { leaseSeconds: 5, waitMs: 2000, retryMs: 10 });
  },
  async load(serverId: string): Promise<GolfMatch> {
    if (!idOk(serverId)) throw Error('GOLF_BAD_ID');
    if (!isRedisAvailable()) throw Error('GOLF_REDIS_REQUIRED');
    const raw = await cache.getAuthoritative<GolfMatch>(KEY + serverId);
    return raw === null ? emptyGolfMatch(serverId) : validate(serverId, raw);
  },
  async save(serverId: string, match: GolfMatch): Promise<void> {
    if (!isRedisAvailable()) throw Error('GOLF_REDIS_REQUIRED');
    const safe = validate(serverId, match);
    if (!safe.players.length) await cache.delAuthoritative(KEY + serverId);
    else await cache.setAuthoritative(KEY + serverId, safe, TTL_SECONDS);
  },
};

/** Resolves shot authority to a final resting position in bounded CPU time. */
export function resolveGolfShot(player: GolfPlayer, degrees: number, power: number): GolfPlayer | null {
  if (!Number.isFinite(degrees) || !Number.isFinite(power) ||
      Math.abs(degrees) > 70 || power < 10 || power > 100 ||
      player.won || player.strokes >= GOLF_MAX_STROKES) return null;
  const radians = degrees * Math.PI / 180;
  let vx = Math.sin(radians) * power * .1;
  let vz = -Math.cos(radians) * power * .1;
  let x = player.x, z = player.z, won = false;
  const dt = 1 / 120, ballRadius = .14, wallX = 2.25 - ballRadius, wallZ = 4.6 - ballRadius;
  let stopped = false;
  for (let i = 0; i < 2400; i++) {
    const speed = Math.hypot(vx, vz);
    if (speed < .025) { stopped = true; break; }
    const next = Math.max(0, speed - 2.3 * dt);
    vx *= next / speed; vz *= next / speed;
    x += vx * dt; z += vz * dt;
    if (x < -wallX || x > wallX) { x = Math.max(-wallX, Math.min(wallX, x)); vx *= -.5; }
    if (z < -wallZ || z > wallZ) { z = Math.max(-wallZ, Math.min(wallZ, z)); vz *= -.5; }
    if (Math.hypot(x, z + 3.8) < .32) {
      x = 0; z = -3.8; won = true; stopped = true; break;
    }
  }
  if (!stopped) throw Error('GOLF_SIMULATION_NOT_SETTLED');
  return { ...player, x, z, strokes: player.strokes + 1, won };
}
export function currentGolfTurn(game: GolfMatch): number {
  if (game.players.length !== 2) return 0;
  for (let i = 1; i <= 2; i++) {
    const index = (game.turn + i) % 2, p = game.players[index]!;
    if (!p.won && p.strokes < GOLF_MAX_STROKES) return index;
  }
  return game.turn;
}
export function golfGameOver(game: GolfMatch): boolean {
  return game.players.length === 2 &&
    game.players.every(p => p.won || p.strokes >= GOLF_MAX_STROKES);
}
export function publicGolfMatch(game: GolfMatch) {
  return {
    serverId: game.serverId, revision: game.revision, phase: game.phase,
    turnUserId: game.phase === 'playing' ? game.players[game.turn]?.userId ?? null : null,
    players: game.players.map(({ userId, x, z, strokes, won }) => ({ userId, x, z, strokes, won })),
  };
}
