/**
 * Experimental Mini Golf 2–8 player match authority. OFF by default.
 *
 * Only Redis-backed, serialized match state. No client-provided coordinates,
 * scores, identities, round transitions or timing. The caller must check
 * current PostgreSQL membership before every mutation AND state read.
 * No Socket.IO room broadcast: a revoked socket never receives a cached
 * match snapshot through another authorized player's action.
 */
import { cache, isRedisAvailable } from '../../lib/redisAdapter';

export const GOLF_MAX_STROKES = 8;
export const GOLF_MIN_PLAYERS = 2;
export const GOLF_MAX_PLAYERS = 8;
/** Short, bounded ownership reservation following a real transport disconnect. */
export const GOLF_RECONNECT_GRACE_MS = 20_000;
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
  /** Server-generated expiry; NEVER serialized into client-facing snapshots. */
  reconnectUntil?: number;
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
      !Array.isArray(game.players) || game.players.length > GOLF_MAX_PLAYERS ||
      !Number.isSafeInteger(game.turn) || (game.turn ?? -1) < 0 ||
      (game.players.length > 0 && (game.turn ?? 0) >= game.players.length) ||
      (game.players.length === 0 && game.turn !== 0) ||
      !game.players.every(p => p && idOk(p.socketId) && idOk(p.userId) &&
        Number.isFinite(p.x) && Number.isFinite(p.z) &&
        Math.abs(p.x) <= 2.25 && Math.abs(p.z) <= 4.6 &&
        Number.isSafeInteger(p.strokes) && p.strokes >= 0 && p.strokes <= GOLF_MAX_STROKES &&
        typeof p.won === 'boolean' &&
        (p.reconnectUntil === undefined ||
          (Number.isSafeInteger(p.reconnectUntil) && p.reconnectUntil > 0))) ||
      (game.phase === 'playing' && game.players.length < GOLF_MIN_PLAYERS) ||
      (game.phase === 'finished' && game.players.length < GOLF_MIN_PLAYERS) ||
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
export function golfPlayerFinished(player: GolfPlayer): boolean {
  return player.won || player.strokes >= GOLF_MAX_STROKES;
}

/** Next eligible player by circular ordering; no extra turns after holing. */
export function currentGolfTurn(game: GolfMatch): number {
  const count = game.players.length;
  if (count < GOLF_MIN_PLAYERS || count > GOLF_MAX_PLAYERS) return 0;
  for (let offset = 1; offset <= count; offset++) {
    const index = (game.turn + offset) % count;
    if (!golfPlayerFinished(game.players[index]!)) return index;
  }
  return game.turn;
}
export function golfGameOver(game: GolfMatch): boolean {
  return game.players.length >= GOLF_MIN_PLAYERS &&
    game.players.every(golfPlayerFinished);
}

/**
 * A departing player must not give a free turn to the wrong neighbour.
 * Same turn index now points to the next player when a previous index leaves.
 * If current player leaves, select the next eligible player starting at their
 * former seat, not the first player and not the departed user's socket.
 */
export function removeGolfPlayer(game: GolfMatch, socketId: string): boolean {
  const removedIndex = game.players.findIndex(p => p.socketId === socketId);
  if (removedIndex === -1) return false;
  const wasPlaying = game.phase === 'playing';
  const wasCurrent = wasPlaying && removedIndex === game.turn;
  game.players.splice(removedIndex, 1);
  game.revision++;
  if (game.players.length < GOLF_MIN_PLAYERS) {
    game.phase = 'waiting'; game.turn = 0;
    for (const player of game.players) {
      player.x = 0; player.z = 3.6; player.strokes = 0; player.won = false;
    }
  } else if (wasPlaying) {
    // A completed match retains its final score; a running one never admits
    // new players, but may shrink from 8 down to the minimum of 2.
    if (golfGameOver(game)) { game.phase = 'finished'; game.turn = 0; }
    else if (wasCurrent) {
      const start = removedIndex % game.players.length;
      game.turn = start;
      for (let i = 0; i < game.players.length; i++) {
        const next = (start + i) % game.players.length;
        if (!golfPlayerFinished(game.players[next]!)) { game.turn = next; break; }
      }
    } else {
      if (removedIndex < game.turn) game.turn--;
      if (golfPlayerFinished(game.players[game.turn]!)) {
        game.turn = currentGolfTurn(game);
      }
    }
  } else {
    game.turn = Math.min(game.turn, game.players.length - 1);
  }
  return true;
}
/** Reserve a seat for a short period after a real disconnect, never on leave. */
export function suspendGolfSeat(game: GolfMatch, socketId: string, now: number): boolean {
  if (!Number.isSafeInteger(now) || now < 0) throw Error('GOLF_BAD_CLOCK');
  const player = game.players.find(p => p.socketId === socketId);
  if (!player || player.reconnectUntil !== undefined) return false;
  player.reconnectUntil = now + GOLF_RECONNECT_GRACE_MS;
  game.revision++;
  return true;
}

/**
 * Authenticated user reclaim only. The handler rechecks DB membership before
 * invoking this under the same Redis lock; an active socket is never replaced.
 */
export function resumeGolfSeat(
  game: GolfMatch, userId: string, socketId: string, now: number,
): boolean {
  if (!idOk(userId) || !idOk(socketId) || !Number.isSafeInteger(now) || now < 0) return false;
  const player = game.players.find(p => p.userId === userId);
  if (!player || player.reconnectUntil === undefined ||
      player.reconnectUntil <= now ||
      game.players.some(p => p.socketId === socketId && p.userId !== userId)) return false;
  player.socketId = socketId;
  delete player.reconnectUntil;
  game.revision++;
  return true;
}

/** Prune only expired disconnected seats; preserve ongoing 2–8 player scores. */
export function expireGolfSeats(game: GolfMatch, now: number): boolean {
  if (!Number.isSafeInteger(now) || now < 0) throw Error('GOLF_BAD_CLOCK');
  let changed = false;
  for (const player of [...game.players]) {
    if (player.reconnectUntil !== undefined && player.reconnectUntil <= now) {
      changed = removeGolfPlayer(game, player.socketId) || changed;
    }
  }
  return changed;
}

export function publicGolfMatch(game: GolfMatch) {
  return {
    serverId: game.serverId, revision: game.revision, phase: game.phase,
    turnUserId: game.phase === 'playing' ? game.players[game.turn]?.userId ?? null : null,
    minPlayers: GOLF_MIN_PLAYERS, maxPlayers: GOLF_MAX_PLAYERS,
    players: game.players.map(({ userId, x, z, strokes, won, reconnectUntil }) => ({
      userId, x, z, strokes, won, reconnecting: reconnectUntil !== undefined,
    })),
  };
}
