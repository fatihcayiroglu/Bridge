// server/socket/handlers/activities.ts
// Sprint 82: Activities socket handler
// Sesli kanaldaki iframe tabanlı mini uygulama oturumlarını yönetir.

import type { HandlerSocket, HandlerServer } from '../handler-contracts';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../lib/logger';
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
import { resolvePermissions, hasPermission, PERMS } from '../../lib/permissions';
import { Channels } from '../../db/repositories';
// Sprint 83: Draw Together aktivitesi
import { registerDrawTogetherHandlers } from './activities/draw-together';
// Sprint 85: Chess sunucu arbiter
import { registerChessHandlers } from './activities/chess-arbiter';
import { isolateSocketHandler } from '../handlerIsolation';
import { activityStore, type ActivitySession } from './activity-store';


// ── State is owned by activity-store (Redis in clustered production). ─────────

// ── Allowed activity IDs (allowlist) ─────────────────────────────────────────

const ALLOWED_ACTIVITY_IDS = new Set([
  'watch-together',
  'chess',
  'draw-together',
  'word-snack',
  'trivia',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _authorizeActivityChannel(
  socket: HandlerSocket,
  userId: string,
  channelId: string,
  claimedServerId?: string | null,
): Promise<{ serverId: string } | null> {
  if (!userId || !channelId) return null;
  // Activities are a voice-room feature. Socket.IO room membership is
  // server-owned state established only after an authorized P2P/SFU join.
  if (!socket.rooms.has(`voice:${channelId}`)) return null;
  const channel = await Channels.findById(channelId).catch(() => null);
  if (!channel) return null;
  const actualServerId = String(channel.serverId ?? '');
  if (!actualServerId || (claimedServerId && claimedServerId !== actualServerId)) return null;
  const perms = await resolvePermissions(userId, actualServerId, channelId).catch(() => 0);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.CONNECT)) return null;
  return { serverId: actualServerId };
}

function _serializeSession(s: ActivitySession) {
  return {
    activityId:   s.activityId,
    channelId:    s.channelId,
    serverId:     s.serverId,
    hostUserId:   s.hostUserId,
    participants: [...s.participants],
    startedAt:    s.startedAt,
    sessionId:    s.sessionId,
  };
}

function _participantSockets(session: ActivitySession): Map<string, string> {
  return session.participantSockets ?? (session.participantSockets = new Map());
}

/** Remove only this connection. Returns true when the user has no other
 * joined socket and was therefore removed from the public participant set. */
function _removeParticipantSocket(session: ActivitySession, socketId: string, userId: string): boolean {
  const sockets = _participantSockets(session);
  const hadSocket = sockets.get(socketId) === userId;
  if (hadSocket) sockets.delete(socketId);

  // Legacy persisted sessions did not carry socket ownership. Preserve their
  // old single-socket leave behavior, while all newly written sessions use the
  // exact socket map below.
  const hasOtherSocket = [...sockets.values()].some(id => id === userId);
  if (!hasOtherSocket && (hadSocket || sockets.size === 0)) {
    session.participants.delete(userId);
    return true;
  }
  return false;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export function registerActivityHandlers(
  socket: HandlerSocket,
  io:     HandlerServer,
  userId: string,
): void {

  const joinedActivityChannels = new Set<string>();
  const activitySocketId = typeof socket.id === 'string' && socket.id
    ? socket.id
    : `activity-socket:${uuidv4()}`;

  // ── activity:start ──────────────────────────────────────────────────────────
  socket.on('activity:start', isolateSocketHandler(socket, 'activity:start', async (payload: { activityId: string; channelId: string; serverId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.activityStart).valid) return;
    const { activityId, channelId, serverId } = payload ?? {};
    if (!activityId || !channelId || !serverId) return;
    if (!ALLOWED_ACTIVITY_IDS.has(activityId)) {
      socket.emit('activity:error', { message: 'Bilinmeyen aktivite ID.' });
      return;
    }

    // Authorize before consulting live session state so unauthorized callers
    // cannot use the endpoint as an activity-existence oracle.
    const authority = await _authorizeActivityChannel(socket, userId, channelId, serverId);
    if (!authority) {
      socket.emit('activity:error', { message: 'Bu kanala bağlanma izniniz yok.' });
      return;
    }

    const result = await activityStore.withLock(channelId, async () => {
      if (await activityStore.get(channelId)) return null;
      const session: ActivitySession = {
        activityId, channelId, serverId: authority.serverId, hostUserId: userId,
        participants: new Set([userId]), participantSockets: new Map([[activitySocketId, userId]]),
        startedAt: Date.now(), sessionId: uuidv4(),
      };
      await activityStore.set(channelId, session);
      return session;
    });
    if (!result) {
      socket.emit('activity:error', { message: 'Bu kanalda zaten bir aktivite aktif.' });
      return;
    }
    joinedActivityChannels.add(channelId);
    const serialized = _serializeSession(result);
    io.to(`channel:${channelId}`).emit('activity:started', serialized);
    logger.info({ event: 'activity.started', activityId, channelId, hostUserId: userId, sessionId: result.sessionId }, 'Activity started');
  }));

  // ── activity:join ───────────────────────────────────────────────────────────
  socket.on('activity:join', isolateSocketHandler(socket, 'activity:join', async (payload: { channelId: string; sessionId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.activityJoin).valid) return;
    const { channelId, sessionId } = payload ?? {};
    if (!channelId || !sessionId) return;

    // Read only enough canonical state to derive the server authority, then
    // re-read under the mutation lock before changing participants.
    const observed = await activityStore.get(channelId);
    if (!observed || observed.sessionId !== sessionId) {
      socket.emit('activity:error', { message: 'Aktivite oturumu bulunamadı.' }); return;
    }
    if (!await _authorizeActivityChannel(socket, userId, channelId, observed.serverId)) {
      socket.emit('activity:error', { message: 'Bu aktiviteye erişim izniniz yok.' }); return;
    }
    const joined = await activityStore.withLock(channelId, async () => {
      const session = await activityStore.get(channelId);
      if (!session || session.sessionId !== sessionId || session.serverId !== observed.serverId) return null;
      session.participants.add(userId);
      _participantSockets(session).set(activitySocketId, userId);
      await activityStore.set(channelId, session);
      return session;
    });
    if (!joined) { socket.emit('activity:error', { message: 'Aktivite oturumu bulunamadı.' }); return; }
    joinedActivityChannels.add(channelId);
    io.to(`channel:${channelId}`).emit('activity:participants_updated', { channelId, participants: [...joined.participants] });
    socket.emit('activity:join_ok', _serializeSession(joined));
    logger.info({ event: 'activity.joined', channelId, userId, sessionId }, 'User joined activity');
  }));

  // ── activity:leave ──────────────────────────────────────────────────────────
  socket.on('activity:leave', isolateSocketHandler(socket, 'activity:leave', async (payload: { channelId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.activityChannelId).valid) return;
    const { channelId } = payload ?? {};
    if (!channelId) return;
    const outcome = await activityStore.withLock(channelId, async () => {
      const session = await activityStore.get(channelId);
      if (!session || !session.participants.has(userId)) return null;
      _removeParticipantSocket(session, activitySocketId, userId);
      if (session.participants.size === 0 || !session.participants.has(session.hostUserId)) {
        await activityStore.del(channelId);
        return { ended: true as const, sessionId: session.sessionId, participants: [] as string[] };
      }
      await activityStore.set(channelId, session);
      return { ended: false as const, sessionId: session.sessionId, participants: [...session.participants] };
    });
    joinedActivityChannels.delete(channelId);
    if (!outcome) return;
    if (outcome.ended) {
      io.to(`channel:${channelId}`).emit('activity:ended', { channelId });
      logger.info({ event: 'activity.ended', channelId, sessionId: outcome.sessionId }, 'Activity ended');
    } else {
      io.to(`channel:${channelId}`).emit('activity:participants_updated', { channelId, participants: outcome.participants });
    }
  }));

  // ── activity:list ───────────────────────────────────────────────────────────
  socket.on('activity:list', isolateSocketHandler(socket, 'activity:list', async (payload: { channelId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.activityChannelId).valid) return;
    const { channelId } = payload ?? {};
    if (!channelId) return;
    const session = await activityStore.get(channelId);
    if (!session) return socket.emit('activity:list_result', null);
    const authority = await _authorizeActivityChannel(socket, userId, channelId, session.serverId);
    socket.emit('activity:list_result', authority ? _serializeSession(session) : null);
  }));

  // ── Sprint 83: Draw Together (aktivite bazlı gerçek zamanlı çizim) ─────────────
  // User nesnesini activities.ts'deki user._id yerine string userId'den kur.
  // displayName ve avatarColor socket bağlantısında henüz bilinmediğinden
  // draw-together handler kendi içinde DB'den çeker (lazy fetch).
  // ── Sprint 85: Chess arbiter ────────────────────────────────────────────────
  registerChessHandlers(socket, io, userId);

  // ── Sprint 83: Draw Together ─────────────────────────────────────────────────
  registerDrawTogetherHandlers(socket, io, {
    _id:          userId,
    displayName:  (socket as unknown as { displayName?: string }).displayName ?? userId,
    avatarColor:  (socket as unknown as { avatarColor?: string }).avatarColor  ?? '#2d9cdb',
  });

  // ── Disconnect temizliği ─────────────────────────────────────────────────────
  socket.on('disconnect', isolateSocketHandler(socket, 'disconnect', async () => {
    const channels = [...joinedActivityChannels];
    joinedActivityChannels.clear();
    for (const channelId of channels) {
      const outcome = await activityStore.withLock(channelId, async () => {
        const session = await activityStore.get(channelId);
        if (!session || !session.participants.has(userId)) return null;
        _removeParticipantSocket(session, activitySocketId, userId);
        if (session.participants.size === 0 || !session.participants.has(session.hostUserId)) {
          await activityStore.del(channelId);
          return { ended: true as const, participants: [] as string[] };
        }
        await activityStore.set(channelId, session);
        return { ended: false as const, participants: [...session.participants] };
      });
      if (!outcome) continue;
      if (outcome.ended) io.to(`channel:${channelId}`).emit('activity:ended', { channelId });
      else io.to(`channel:${channelId}`).emit('activity:participants_updated', { channelId, participants: outcome.participants });
    }
  }));
}

// ── Exports (test / admin kullanımı için) ─────────────────────────────────────
export function getActivitySession(channelId: string): ActivitySession | undefined {
  return activityStore._localSessions_TEST_ONLY.get(channelId);
}

export function getAllActivitySessions(): ActivitySession[] {
  return [...activityStore._localSessions_TEST_ONLY.values()];
}

export function _clearAllSessions_TEST_ONLY(): void {
  activityStore._localSessions_TEST_ONLY.clear();
}
