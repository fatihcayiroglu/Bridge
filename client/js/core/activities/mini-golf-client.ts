import type { SocialSocket } from './social-room-client.ts';

/** A validated server-owned game result; socket IDs are never sent to the UI. */
export interface OnlineGolfPlayer {
  readonly userId: string;
  readonly x: number;
  readonly z: number;
  readonly strokes: number;
  readonly won: boolean;
  readonly reconnecting: boolean;
}
export interface OnlineGolfRoundResult {
  readonly userId: string;
  readonly rank: number;
  readonly strokes: number;
  readonly holed: boolean;
}
export interface OnlineGolfMatch {
  readonly serverId: string;
  readonly revision: number;
  readonly phase: 'waiting' | 'playing' | 'finished';
  readonly you: string;
  readonly turnUserId: string | null;
  readonly players: readonly OnlineGolfPlayer[];
  readonly minPlayers: 2;
  readonly maxPlayers: 8;
  readonly rematchReady: readonly string[];
  readonly results: readonly OnlineGolfRoundResult[];
}
export type OnlineGolfStatus =
  'connecting' | 'waiting' | 'playing' | 'finished' |
  'unavailable' | 'invalid' | 'disconnected';
export interface OnlineGolfSession {
  readonly active: boolean;
  readonly match: OnlineGolfMatch | null;
  readonly busy: boolean;
  shoot(degrees: number, power: number): boolean;
  start(): boolean;
  rematch(): boolean;
  refresh(): void;
  dispose(): void;
}
const idOk = (v: unknown): v is string => typeof v === 'string' &&
  v.length > 0 && v.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(v);
function readMatch(raw: unknown, serverId: string): OnlineGolfMatch | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.serverId !== serverId || !Number.isSafeInteger(o.revision) ||
      (o.revision as number) < 0 || !idOk(o.you) ||
      !['waiting', 'playing', 'finished'].includes(String(o.phase)) ||
      (o.turnUserId !== null && !idOk(o.turnUserId)) ||
      o.minPlayers !== 2 || o.maxPlayers !== 8 ||
      !Array.isArray(o.players) || o.players.length < 1 || o.players.length > 8 ||
      !Array.isArray(o.rematchReady) || o.rematchReady.length > 8 ||
      !Array.isArray(o.results) || o.results.length > 8 ||
      o.rematchReady.some((u:unknown)=>!idOk(u)) ||
      new Set(o.rematchReady).size !== o.rematchReady.length) return null;
  const players: OnlineGolfPlayer[] = [];
  for (const rawPlayer of o.players as unknown[]) {
    if (!rawPlayer || typeof rawPlayer !== 'object' || Array.isArray(rawPlayer)) return null;
    const p = rawPlayer as Record<string, unknown>;
    if (!idOk(p.userId) || !Number.isFinite(p.x) || !Number.isFinite(p.z) ||
        Math.abs(p.x as number) > 2.25 || Math.abs(p.z as number) > 4.6 ||
        !Number.isSafeInteger(p.strokes) || (p.strokes as number) < 0 ||
        (p.strokes as number) > 8 || typeof p.won !== 'boolean' ||
        (p.reconnecting !== undefined && typeof p.reconnecting !== 'boolean')) return null;
    players.push({
      userId: p.userId, x: p.x as number, z: p.z as number,
      strokes: p.strokes as number, won: p.won, reconnecting: p.reconnecting === true,
    });
  }
  if (new Set(players.map(p => p.userId)).size !== players.length ||
      !players.some(p => p.userId === o.you) ||
      (o.phase === 'playing' && (players.length < 2 ||
        !players.some(p => p.userId === o.turnUserId))) ||
      (o.phase !== 'playing' && o.turnUserId !== null) ||
      (o.phase === 'finished' && players.length < 2) ||
      (o.phase !== 'finished' && o.rematchReady.length > 0) ||
      o.rematchReady.some((u:string) => !players.some(p => p.userId === u))) return null;
  // The server issues final rankings. Validate them against the same
  // authoritative score snapshot; never infer a winner from client input.
  const expected = o.phase === 'finished'
    ? players.map((p, seat) => ({...p, seat})).sort((a, b) =>
        Number(b.won) - Number(a.won) ||
        a.strokes - b.strokes || a.seat - b.seat)
    : [];
  if (o.results.length !== expected.length) return null;
  const results: OnlineGolfRoundResult[] = [];
  let expectedRank = 1;
  for (let i = 0; i < expected.length; i++) {
    const entry = o.results[i] as unknown;
    const player = expected[i]!;
    if (i > 0 && (expected[i-1]!.won !== player.won ||
        expected[i-1]!.strokes !== player.strokes)) expectedRank = i + 1;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const result = entry as Record<string, unknown>;
    if (result.userId !== player.userId || result.rank !== expectedRank ||
        result.strokes !== player.strokes || result.holed !== player.won) return null;
    results.push({
      userId: player.userId, rank: expectedRank, strokes: player.strokes, holed: player.won,
    });
  }
  return {
    serverId, revision: o.revision as number,
    phase: o.phase as OnlineGolfMatch['phase'],
    you: o.you, turnUserId: o.turnUserId as string | null, players,
    minPlayers: 2, maxPlayers: 8, rematchReady: [...o.rematchReady] as string[], results,
  };
}

/**
 * Explicit opt-in: no automatic join on page load / reconnect.
 * Pull-only polling at 3s while visible avoids broadcasting to revoked peers.
 * The server checks live PostgreSQL permissions on EVERY pull and shot.
 */
export function joinOnlineMiniGolf(
  socket: SocialSocket, serverId: string,
  onUpdate: (match: OnlineGolfMatch) => void,
  onStatus: (status: OnlineGolfStatus) => void,
): OnlineGolfSession {
  if (!idOk(serverId) || serverId.length > 64 || !socket.connected) {
    onStatus('unavailable');
    return { active: false, match: null, busy: false,
      shoot: () => false, start: () => false, rematch: () => false, refresh: () => {}, dispose: () => {} };
  }
  let disposed = false, active = false, busy = false;
  let match: OnlineGolfMatch | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  const clear = () => {
    if (timeout) clearTimeout(timeout);
    if (poll) clearInterval(poll);
    timeout = null; poll = null;
    socket.off('mini-golf:state', state);
    socket.off('mini-golf:error', error);
    socket.off('disconnect', disconnect);
    socket.off('membership:revoked', revoked);
  };
  const teardown = (status: OnlineGolfStatus, leave: boolean) => {
    if (disposed) return;
    disposed = true; active = false; busy = false; match = null;
    clear();
    if (leave && socket.connected) socket.emit('mini-golf:leave', { serverId });
    onStatus(status);
  };
  function state(raw?: unknown): void {
    if (disposed) return;
    if (raw && typeof raw === 'object' && 'serverId' in raw &&
        (raw as {serverId?: unknown}).serverId !== serverId) return;
    const parsed = readMatch(raw, serverId);
    if (!parsed) { teardown('invalid', true); return; }
    if (match && parsed.revision < match.revision) return;
    if (busy && match && parsed.revision <= match.revision) return;
    if (timeout) { clearTimeout(timeout); timeout = null; }
    busy = false;
    active = true; match = parsed;
    onUpdate(parsed);
    onStatus(parsed.phase);
    if (!poll) poll = setInterval(() => {
      if (!disposed && socket.connected && !document.hidden) {
        socket.emit('mini-golf:sync', { serverId });
      }
    }, 3000);
  }
  function error(raw?: unknown): void {
    if (disposed || !raw || typeof raw !== 'object' || Array.isArray(raw) ||
        !('serverId' in raw) || (raw as {serverId?: unknown}).serverId !== serverId) return;
    teardown('unavailable', true);
  }
  function disconnect(): void { teardown('disconnected', false); }
  function revoked(raw?: unknown): void {
    if (raw && typeof raw === 'object' && 'serverId' in raw &&
        (raw as {serverId?: unknown}).serverId === serverId) {
      teardown('disconnected', true);
    }
  }
  socket.on('mini-golf:state', state);
  socket.on('mini-golf:error', error);
  socket.on('disconnect', disconnect);
  socket.on('membership:revoked', revoked);
  onStatus('connecting');
  timeout = setTimeout(() => teardown('unavailable', true), 12000);
  socket.emit('mini-golf:join', { serverId });
  return {
    get active() { return !disposed && active; },
    get match() { return match; },
    get busy() { return busy; },
    start() {
      if (disposed || busy || !active || !socket.connected || !match ||
          match.phase !== 'waiting' || match.players.length < match.minPlayers ||
          match.players.length > match.maxPlayers ||
          match.players[0]?.userId !== match.you ||
          match.players.some(p => p.reconnecting)) return false;
      busy = true;
      onStatus('connecting');
      socket.emit('mini-golf:start', { serverId });
      timeout = setTimeout(() => teardown('unavailable', true), 12000);
      return true;
    },
    rematch() {
      if (disposed || busy || !active || !socket.connected || !match ||
          match.phase !== 'finished' ||
          match.players.some(p => p.reconnecting) ||
          match.rematchReady.includes(match.you)) return false;
      busy = true;
      onStatus('connecting');
      socket.emit('mini-golf:rematch', { serverId });
      timeout = setTimeout(() => teardown('unavailable', true), 12000);
      return true;
    },
    shoot(degrees, power) {
      if (disposed || busy || !active || !socket.connected ||
          !match || match.phase !== 'playing' || match.turnUserId !== match.you ||
          match.players.some(p => p.reconnecting) ||
          !Number.isFinite(degrees) || !Number.isFinite(power) ||
          Math.abs(degrees) > 70 || power < 10 || power > 100) return false;
      busy = true;
      // Never optimistically change the ball coordinates or score.
      onStatus('connecting');
      socket.emit('mini-golf:shoot', { serverId, degrees, power });
      timeout = setTimeout(() => teardown('unavailable', true), 12000);
      return true;
    },
    refresh() {
      if (!disposed && active && socket.connected) socket.emit('mini-golf:sync', { serverId });
    },
    dispose() { teardown('disconnected', true); },
  };
}
