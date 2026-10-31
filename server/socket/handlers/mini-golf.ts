/**
 * Experimental server-authoritative 2–8 player Mini Golf Socket.IO contract.
 * Feature-gated OFF by default. No broadcast subscription / unsafe stale
 * membership delivery. The second player explicitly syncs the shared result.
 */
import type { HandlerSocket, HandlerServer } from '../handler-contracts';
import { isolateSocketHandler } from '../handlerIsolation';
import { Members } from '../../db/repositories';
import { resolvePermissions, hasPermission, PERMS } from '../../lib/permissions';
import {
  golfMatchStore, emptyGolfMatch, resolveGolfShot, currentGolfTurn,
  golfGameOver, publicGolfMatch, removeGolfPlayer,
  expireGolfSeats, suspendGolfSeat, resumeGolfSeat, voteGolfRematch,
  GOLF_MIN_PLAYERS, GOLF_MAX_PLAYERS,
} from './mini-golf-match';

const validId = (raw: unknown): raw is string =>
  typeof raw === 'string' && raw.length <= 64 && raw.length > 0 &&
  /^[a-zA-Z0-9_-]+$/.test(raw);
function serverFrom(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const serverId = (raw as Record<string, unknown>).serverId;
  return validId(serverId) ? serverId : null;
}
async function authorized(socket: HandlerSocket, userId: string, serverId: string) {
  if (!userId || socket.isBot || !socket.rooms.has('server:' + serverId)) return false;
  const membership = await Members.findOne(userId, serverId).catch(() => null);
  if (!membership) return false;
  const bits = await resolvePermissions(userId, serverId).catch(() => 0);
  return hasPermission(bits, PERMS.VIEW_CHANNELS) && hasPermission(bits, PERMS.CONNECT);
}
export function registerMiniGolfHandlers(
  socket: HandlerSocket, _io: HandlerServer, userId: string,
): void {
  // Never wire a privileged listener if the experiment is disabled.
  if (process.env.BRIDGE_MINI_GOLF_MULTIPLAYER !== '1') return;
  const joined = new Set<string>();
  const joining = new Set<string>();
  const canceledJoins = new Set<string>();
  let disconnected = false;
  const reject = (serverId: string | null, code = 'GOLF_UNAVAILABLE') =>
    socket.emit('mini-golf:error', { code, ...(serverId ? { serverId } : {}) });
  const reply = (game: ReturnType<typeof emptyGolfMatch>) =>
    socket.emit('mini-golf:state', { ...publicGolfMatch(game), you: userId });

  /** All reconciliation happens under the same Redis lock as every shot. */
  async function loadFresh(serverId: string) {
    const game = await golfMatchStore.load(serverId);
    if (expireGolfSeats(game, Date.now())) await golfMatchStore.save(serverId, game);
    return game;
  }

  async function remove(serverId: string): Promise<void> {
    await golfMatchStore.withLock(serverId, async () => {
      const game = await loadFresh(serverId);
      if (!removeGolfPlayer(game, socket.id)) return;
      await golfMatchStore.save(serverId, game);
    });
    joined.delete(serverId);
  }

  async function suspend(serverId: string): Promise<void> {
    await golfMatchStore.withLock(serverId, async () => {
      const game = await loadFresh(serverId);
      if (suspendGolfSeat(game, socket.id, Date.now())) {
        await golfMatchStore.save(serverId, game);
      }
    });
    joined.delete(serverId);
  }

  socket.on('mini-golf:join', isolateSocketHandler(socket, 'mini-golf:join', async (payload: unknown) => {
    const serverId = serverFrom(payload);
    // Mark pending BEFORE awaiting PostgreSQL. A leave may be processed
    // while authorization awaits, and must cancel that pending admission.
    if (!serverId || disconnected || joining.has(serverId)) {
      reject(serverId); return;
    }
    joining.add(serverId);
    try {
    if (!await authorized(socket, userId, serverId)) {
      if (!canceledJoins.has(serverId)) reject(serverId);
      return;
    }
    if (disconnected || canceledJoins.has(serverId)) return;
    let denial = false;
    const game = await golfMatchStore.withLock(serverId, async () => {
      // Authorization before lock is not enough; a membership kick may race it.
      if (!await authorized(socket, userId, serverId) || disconnected) { denial = true; return null; }
      const state = await loadFresh(serverId);
      const existing = state.players.find(p => p.socketId === socket.id && p.userId === userId);
      if (existing) return state;
      // Reclaim only a server-reserved seat belonging to this authenticated
      // PostgreSQL member; no client-provided resume token or userId trusted.
      if (resumeGolfSeat(state, userId, socket.id, Date.now())) {
        await golfMatchStore.save(serverId, state);
        return state;
      }
      if (state.players.length >= GOLF_MAX_PLAYERS || state.phase !== 'waiting' ||
          state.players.some(p => p.userId === userId || p.socketId === socket.id)) {
        denial = true; return null;
      }
      state.players.push({ socketId: socket.id, userId, x: 0, z: 3.6, strokes: 0, won: false });
      // Explicit host start locks the roster. No silent match start at two:
      // the lobby must let members join up to eight before playing.
      state.phase = 'waiting';
      state.turn = 0;
      state.revision++;
      await golfMatchStore.save(serverId, state);
      return state;
    });
    if (denial || !game || disconnected || canceledJoins.has(serverId) ||
        !await authorized(socket, userId, serverId)) {
      if (game && game.players.some(p => p.socketId === socket.id)) await remove(serverId);
      if (!disconnected && !canceledJoins.has(serverId)) reject(serverId);
      return;
    }
    joined.add(serverId);
    reply(game);
    } finally {
      joining.delete(serverId);
      canceledJoins.delete(serverId);
    }
  }));

  socket.on('mini-golf:start', isolateSocketHandler(socket, 'mini-golf:start', async (payload: unknown) => {
    const serverId = serverFrom(payload);
    if (!serverId || disconnected || !joined.has(serverId) ||
        !await authorized(socket, userId, serverId)) {
      reject(serverId); return;
    }
    let denied = false;
    const game = await golfMatchStore.withLock(serverId, async () => {
      if (disconnected || !await authorized(socket, userId, serverId)) {
        denied = true; return null;
      }
      const state = await loadFresh(serverId);
      if (state.phase !== 'waiting' ||
          state.players.some(p => p.reconnectUntil !== undefined) ||
          state.players.length < GOLF_MIN_PLAYERS ||
          state.players.length > GOLF_MAX_PLAYERS ||
          state.players[0]?.userId !== userId ||
          state.players[0]?.socketId !== socket.id) {
        denied = true; return null;
      }
      state.phase = 'playing';
      state.turn = 0;
      state.revision++;
      await golfMatchStore.save(serverId, state);
      return state;
    });
    if (denied || !game) { reject(serverId, 'GOLF_CANNOT_START'); return; }
    if (!await authorized(socket, userId, serverId)) {
      await remove(serverId); reject(serverId); return;
    }
    reply(game);
  }));

  socket.on('mini-golf:sync', isolateSocketHandler(socket, 'mini-golf:sync', async (payload: unknown) => {
    const serverId = serverFrom(payload);
    if (!serverId || disconnected || !joined.has(serverId) ||
        !await authorized(socket, userId, serverId)) {
      if (serverId && joined.has(serverId)) await remove(serverId);
      reject(serverId); return;
    }
    const game = await golfMatchStore.withLock(serverId, async () => {
      if (disconnected || !await authorized(socket, userId, serverId)) return null;
      const state = await loadFresh(serverId);
      return state.players.some(p => p.socketId === socket.id && p.userId === userId)
        ? state : null;
    });
    if (!game || disconnected || !await authorized(socket, userId, serverId)) {
      if (joined.has(serverId)) await remove(serverId);
      reject(serverId); return;
    }
    reply(game);
  }));

  socket.on('mini-golf:shoot', isolateSocketHandler(socket, 'mini-golf:shoot', async (payload: unknown) => {
    const serverId = serverFrom(payload);
    if (!serverId || disconnected || !joined.has(serverId) ||
        !await authorized(socket, userId, serverId) ||
        !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      reject(serverId); return;
    }
    const data = payload as Record<string, unknown>;
    // Values are not coerced; invalid client input cannot mutate state.
    if (typeof data.degrees !== 'number' || typeof data.power !== 'number') {
      reject(serverId, 'GOLF_INVALID_SHOT'); return;
    }
    let denial = false;
    const game = await golfMatchStore.withLock(serverId, async () => {
      if (!await authorized(socket, userId, serverId) || disconnected) { denial = true; return null; }
      const state = await loadFresh(serverId);
      const player = state.players[state.turn];
      // Freeze shots for a short, explicit reconnect grace. No one silently
      // advances a match while another player's WebSocket is disconnected.
      if (state.phase !== 'playing' ||
          state.players.some(p => p.reconnectUntil !== undefined) ||
          !player || player.userId !== userId ||
          player.socketId !== socket.id) { denial = true; return null; }
      const result = resolveGolfShot(player, data.degrees as number, data.power as number);
      if (!result) { denial = true; return null; }
      state.players[state.turn] = result;
      state.phase = golfGameOver(state) ? 'finished' : 'playing';
      if (state.phase === 'playing') state.turn = currentGolfTurn(state);
      state.revision++;
      await golfMatchStore.save(serverId, state);
      return state;
    });
    if (denial || !game) { reject(serverId, 'GOLF_INVALID_TURN'); return; }
    if (!await authorized(socket, userId, serverId)) { await remove(serverId); reject(serverId); return; }
    reply(game);
  }));

  socket.on('mini-golf:rematch', isolateSocketHandler(socket, 'mini-golf:rematch', async (payload: unknown) => {
    const serverId = serverFrom(payload);
    if (!serverId || disconnected || !joined.has(serverId) ||
        !await authorized(socket, userId, serverId)) {
      reject(serverId); return;
    }
    let denied = false;
    const game = await golfMatchStore.withLock(serverId, async () => {
      if (disconnected || !await authorized(socket, userId, serverId)) {
        denied = true; return null;
      }
      const state = await loadFresh(serverId);
      if (!voteGolfRematch(state, userId, socket.id)) {
        denied = true; return null;
      }
      await golfMatchStore.save(serverId, state);
      return state;
    });
    if (denied || !game || disconnected) {
      reject(serverId, 'GOLF_REMATCH_UNAVAILABLE'); return;
    }
    if (!await authorized(socket, userId, serverId)) {
      await remove(serverId); reject(serverId); return;
    }
    reply(game);
  }));

  socket.on('mini-golf:leave', isolateSocketHandler(socket, 'mini-golf:leave', async (payload: unknown) => {
    const serverId = serverFrom(payload);
    if (!serverId) { reject(null); return; }
    if (!joined.has(serverId) && joining.has(serverId)) {
      canceledJoins.add(serverId);
      socket.emit('mini-golf:left', { serverId });
      return;
    }
    if (!joined.has(serverId)) { reject(serverId); return; }
    await remove(serverId);
    socket.emit('mini-golf:left', { serverId });
  }));
  socket.on('disconnect', isolateSocketHandler(socket, 'mini-golf:disconnect', async () => {
    disconnected = true;
    for (const serverId of joining) canceledJoins.add(serverId);
    for (const serverId of [...joined]) await suspend(serverId);
  }));
}
