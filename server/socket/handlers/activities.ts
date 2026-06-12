// server/socket/handlers/activities.ts
// Sprint 82: Activities socket handler
// Sesli kanaldaki iframe tabanlı mini uygulama oturumlarını yönetir.

import { v4 as uuidv4 } from 'uuid';
import logger from '../../lib/logger';
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
import { resolvePermissions, hasPermission, PERMS } from '../../lib/permissions';
import type { Socket, Server as IOServer } from 'socket.io';
// Sprint 83: Draw Together aktivitesi
import { registerDrawTogetherHandlers } from './activities/draw-together';
// Sprint 85: Chess sunucu arbiter
import { registerChessHandlers } from './activities/chess-arbiter';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ActivitySession {
  activityId:   string;
  channelId:    string;
  serverId:     string;
  hostUserId:   string;
  participants: Set<string>;
  startedAt:    number;
  sessionId:    string;
}

// ── State (in-memory; production'da Redis'e taşı) ─────────────────────────────

const _sessions = new Map<string, ActivitySession>(); // channelId → session

// ── Allowed activity IDs (allowlist) ─────────────────────────────────────────

const ALLOWED_ACTIVITY_IDS = new Set([
  'watch-together',
  'chess',
  'draw-together',
  'word-snack',
  'trivia',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Handler ───────────────────────────────────────────────────────────────────

export function registerActivityHandlers(
  socket: Socket,
  io:     IOServer,
  userId: string,
): void {

  // ── activity:start ──────────────────────────────────────────────────────────
  socket.on('activity:start', async (payload: { activityId: string; channelId: string; serverId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.activityStart).valid) return;
    try {
      const { activityId, channelId, serverId } = payload ?? {};

      if (!activityId || !channelId || !serverId) return;
      if (!ALLOWED_ACTIVITY_IDS.has(activityId)) {
        socket.emit('activity:error', { message: 'Bilinmeyen aktivite ID.' });
        return;
      }

      // Zaten aktif aktivite varsa yeni başlatmayı reddet
      if (_sessions.has(channelId)) {
        socket.emit('activity:error', { message: 'Bu kanalda zaten bir aktivite aktif.' });
        return;
      }

      // İzin kontrolü: CONNECT gerekiyor
      const perms = await resolvePermissions(userId, serverId, channelId);
      if (!hasPermission(perms, PERMS.CONNECT)) {
        socket.emit('activity:error', { message: 'Bu kanala bağlanma izniniz yok.' });
        return;
      }

      const session: ActivitySession = {
        activityId,
        channelId,
        serverId,
        hostUserId:   userId,
        participants: new Set([userId]),
        startedAt:    Date.now(),
        sessionId:    uuidv4(),
      };

      _sessions.set(channelId, session);

      const serialized = _serializeSession(session);

      // Kanaldaki herkese duyur
      io.to(`channel:${channelId}`).emit('activity:started', serialized);

      logger.info(
        { event: 'activity.started', activityId, channelId, hostUserId: userId, sessionId: session.sessionId },
        'Activity started',
      );
    } catch (err) {
      logger.error({ event: 'activity.start.error', err }, 'activity:start handler error');
    }
  });

  // ── activity:join ───────────────────────────────────────────────────────────
  socket.on('activity:join', async (payload: { channelId: string; sessionId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.activityJoin).valid) return;
    try {
      const { channelId, sessionId } = payload ?? {};
      if (!channelId || !sessionId) return;

      const session = _sessions.get(channelId);
      if (!session || session.sessionId !== sessionId) {
        socket.emit('activity:error', { message: 'Aktivite oturumu bulunamadı.' });
        return;
      }

      session.participants.add(userId);

      io.to(`channel:${channelId}`).emit('activity:participants_updated', {
        channelId,
        participants: [...session.participants],
      });

      socket.emit('activity:join_ok', _serializeSession(session));

      logger.info({ event: 'activity.joined', channelId, userId, sessionId }, 'User joined activity');
    } catch (err) {
      logger.error({ event: 'activity.join.error', err }, 'activity:join handler error');
    }
  });

  // ── activity:leave ──────────────────────────────────────────────────────────
  socket.on('activity:leave', (payload: { channelId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.activityChannelId).valid) return;
    try {
      const { channelId } = payload ?? {};
      if (!channelId) return;

      const session = _sessions.get(channelId);
      if (!session) return;

      session.participants.delete(userId);

      if (session.participants.size === 0 || session.hostUserId === userId) {
        // Herkes çıktı veya host çıktı → aktiviteyi sonlandır
        _sessions.delete(channelId);
        io.to(`channel:${channelId}`).emit('activity:ended', { channelId });
        logger.info({ event: 'activity.ended', channelId, sessionId: session.sessionId }, 'Activity ended');
      } else {
        io.to(`channel:${channelId}`).emit('activity:participants_updated', {
          channelId,
          participants: [...session.participants],
        });
      }
    } catch (err) {
      logger.error({ event: 'activity.leave.error', err }, 'activity:leave handler error');
    }
  });

  // ── activity:list ───────────────────────────────────────────────────────────
  socket.on('activity:list', (payload: { channelId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.activityChannelId).valid) return;
    const { channelId } = payload ?? {};
    if (!channelId) return;
    const session = _sessions.get(channelId);
    socket.emit('activity:list_result', session ? _serializeSession(session) : null);
  });

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
  socket.on('disconnect', () => {
    for (const [channelId, session] of _sessions) {
      if (!session.participants.has(userId)) continue;

      session.participants.delete(userId);

      if (session.participants.size === 0 || session.hostUserId === userId) {
        _sessions.delete(channelId);
        io.to(`channel:${channelId}`).emit('activity:ended', { channelId });
      } else {
        io.to(`channel:${channelId}`).emit('activity:participants_updated', {
          channelId,
          participants: [...session.participants],
        });
      }
    }
  });
}

// ── Exports (test / admin kullanımı için) ─────────────────────────────────────
export function getActivitySession(channelId: string): ActivitySession | undefined {
  return _sessions.get(channelId);
}

export function getAllActivitySessions(): ActivitySession[] {
  return [..._sessions.values()];
}

export function _clearAllSessions_TEST_ONLY(): void {
  _sessions.clear();
}
