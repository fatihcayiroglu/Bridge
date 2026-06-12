// server/socket/handlers/stage.ts
// Stage kanalı socket handler'ları
//
// Sprint 44: stageRooms in-memory Map → Redis-backed (cluster-safe)
// Önceki: her PM2 worker'ı ayrı Map tutuyordu; cluster modunda state tutarsızlığı.
// Şimdi: Redis pub/sub yerine Redis hash + JSON; tüm worker'lar aynı store'u görür.
// Fallback: Redis yoksa in-memory Map çalışmaya devam eder (tek-node deployment).
//
// Permission düzeltmesi: stage:promote artık sadece host değil server admin/owner da yapabilir.

import { Channels, Servers } from '../../db/repositories';
import type { Socket, Server as IoServer } from 'socket.io';
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';

// ── Types ─────────────────────────────────────────────────────────────────────

interface StageUser {
  userId:      string;
  displayName: string;
  avatarColor: string;
  muted:       boolean;
  handRaised:  boolean;
  speaking:    boolean;
  socketId:    string;
}

interface StageRoom {
  speakers:  StageUser[];
  listeners: StageUser[];
  topic:     string;
  live:      boolean;
}

interface AuthenticatedUser {
  _id:          string;
  displayName?: string;
  avatarColor?: string;
}

// ── Redis-backed store ────────────────────────────────────────────────────────
// Cluster modunda tüm worker'lar aynı Redis store'u okur/yazar.
// Redis yoksa in-memory Map fallback olarak devreye girer.

interface RedisLike {
  status: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

const REDIS_KEY_PREFIX = 'bridge:stage:room:';

function _tryGetRedis(): RedisLike | null {
  try {
    const g = global as unknown as { _bridgeRedis?: RedisLike };
    if (g._bridgeRedis?.status === 'ready') return g._bridgeRedis;
  } catch { /* redis unavailable */ }
  return null;
}

// In-memory fallback (single-node deployment)
const _memRooms = new Map<string, StageRoom>();

async function _loadRoom(channelId: string): Promise<StageRoom | null> {
  const redis = _tryGetRedis();
  if (redis) {
    const raw = await redis.get(`${REDIS_KEY_PREFIX}${channelId}`);
    return raw ? (JSON.parse(raw) as StageRoom) : null;
  }
  return _memRooms.get(channelId) ?? null;
}

async function _saveRoom(channelId: string, room: StageRoom): Promise<void> {
  const redis = _tryGetRedis();
  if (redis) {
    await redis.set(`${REDIS_KEY_PREFIX}${channelId}`, JSON.stringify(room));
  } else {
    _memRooms.set(channelId, room);
  }
}

async function _deleteRoom(channelId: string): Promise<void> {
  const redis = _tryGetRedis();
  if (redis) {
    await redis.del(`${REDIS_KEY_PREFIX}${channelId}`);
  } else {
    _memRooms.delete(channelId);
  }
}

// Geriye dönük uyumluluk: diğer modüller stageRooms'u doğrudan import ediyorsa
// in-memory fallback Map'i export etmeye devam et; asıl state Redis'te.
// Yeni kod _loadRoom / _saveRoom kullanmalı.
export const stageRooms = _memRooms;

// ── Room helpers ──────────────────────────────────────────────────────────────

async function getOrCreateRoom(channelId: string): Promise<StageRoom> {
  const existing = await _loadRoom(channelId);
  if (existing) return existing;
  const room: StageRoom = { speakers: [], listeners: [], topic: '', live: false };
  await _saveRoom(channelId, room);
  return room;
}

async function removeUserFromRoom(channelId: string, userId: string): Promise<void> {
  const room = await _loadRoom(channelId);
  if (!room) return;
  room.speakers  = room.speakers.filter(u => u.userId !== userId);
  room.listeners = room.listeners.filter(u => u.userId !== userId);
  if (!room.speakers.length && !room.listeners.length) {
    await _deleteRoom(channelId);
  } else {
    await _saveRoom(channelId, room);
  }
}

// ── Permission helper ─────────────────────────────────────────────────────────
// Host (ilk konuşmacı) VEYA server owner → yetkili
async function _isAuthorized(channelId: string, userId: string, room: StageRoom): Promise<boolean> {
  if (room.speakers[0]?.userId === userId) return true;
  try {
    const channel = await Channels.findById(channelId);
    if (!channel) return false;
    const server = await Servers.findById((channel as unknown as Record<string, unknown>).serverId as string);
    if (server && (server as unknown as Record<string, unknown>).ownerId === userId) return true;
  } catch { /* ignore */ }
  return false;
}

// ── Handler registration ──────────────────────────────────────────────────────

export function registerStageHandlers(
  socket: Socket,
  io:     IoServer,
  user:   AuthenticatedUser
): void {

  // ── stage:join ───────────────────────────────────────────────────────────
  socket.on('stage:join', (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.stageChannelId).valid) return;
    const { channelId } = payload as { channelId: string };
    return (async () => {
      socket.join(`stage:${channelId}`);
      const room = await getOrCreateRoom(channelId);
      socket.emit('stage:state', { channelId, ...room });
    })();
  });

  // ── stage:setRole ────────────────────────────────────────────────────────
  socket.on('stage:setRole', (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.stageSetRole).valid) return;
    const { channelId, role, displayName, avatarColor } = payload as { channelId: string; role: 'speaker' | 'listener'; displayName?: string; avatarColor?: string };
    return (async () => {
      await removeUserFromRoom(channelId, user._id);
      const room = await getOrCreateRoom(channelId);
      const userObj: StageUser = {
        userId:      user._id,
        displayName: user.displayName ?? displayName ?? '',
        avatarColor: user.avatarColor ?? avatarColor ?? '',
        muted:       role === 'speaker',
        handRaised:  false,
        speaking:    false,
        socketId:    socket.id,
      };
      if (role === 'speaker') room.speakers.push(userObj);
      else                    room.listeners.push(userObj);
      await _saveRoom(channelId, room);
      io.to(`stage:${channelId}`).emit('stage:userJoined', { channelId, role, user: userObj });
      io.to(`stage:${channelId}`).emit('stage:state', { channelId, ...room });
    })();
  });

  // ── stage:updateMute ─────────────────────────────────────────────────────
  socket.on('stage:updateMute', (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.stageUpdateMute).valid) return;
    const { channelId, muted } = payload as { channelId: string; muted: boolean };
    return (async () => {
      const room = await _loadRoom(channelId);
      if (!room) return;
      const sp = room.speakers.find(u => u.userId === user._id);
      if (sp) {
        sp.muted = muted;
        if (muted) sp.speaking = false;
        await _saveRoom(channelId, room);
        io.to(`stage:${channelId}`).emit('stage:muteUpdate', { channelId, userId: user._id, muted });
      }
    })();
  });

  // ── stage:speaking (VAD) ─────────────────────────────────────────────────
  socket.on('stage:speaking', (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.stageSpeaking).valid) return;
    const { channelId, speaking } = payload as { channelId: string; speaking: boolean };
    return (async () => {
      const room = await _loadRoom(channelId);
      if (!room) return;
      const sp = room.speakers.find(u => u.userId === user._id);
      if (sp && !sp.muted) {
        sp.speaking = !!speaking;
        await _saveRoom(channelId, room);
        io.to(`stage:${channelId}`).emit('stage:speaking', { channelId, userId: user._id, speaking: sp.speaking });
      }
    })();
  });

  // ── stage:handRaise ──────────────────────────────────────────────────────
  socket.on('stage:handRaise', (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.stageHandRaise).valid) return;
    const { channelId, raised } = payload as { channelId: string; raised: boolean };
    return (async () => {
      const room = await _loadRoom(channelId);
      if (!room) return;
      const u = [...room.speakers, ...room.listeners].find(x => x.userId === user._id);
      if (u) {
        u.handRaised = raised;
        await _saveRoom(channelId, room);
        io.to(`stage:${channelId}`).emit('stage:handRaise', { channelId, userId: user._id, raised });
      }
    })();
  });

  // ── stage:promote (host veya server owner) ───────────────────────────────
  socket.on('stage:promote', async (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.stageTarget).valid) return;
    const { channelId, targetUserId } = payload as { channelId: string; targetUserId: string };
    const room = await _loadRoom(channelId);
    if (!room) return;
    if (!(await _isAuthorized(channelId, user._id, room))) return;

    const li = room.listeners.findIndex(u => u.userId === targetUserId);
    if (li === -1) return;

    const [promoted] = room.listeners.splice(li, 1);
    promoted.muted      = true;
    promoted.handRaised = false;
    promoted.speaking   = false;
    room.speakers.push(promoted);
    await _saveRoom(channelId, room);

    io.to(`stage:${channelId}`).emit('stage:promoted', { channelId, userId: targetUserId });
    io.to(`stage:${channelId}`).emit('stage:state', { channelId, ...room });
  });

  // ── stage:demote (host veya server owner) ────────────────────────────────
  socket.on('stage:demote', async (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.stageTarget).valid) return;
    const { channelId, targetUserId } = payload as { channelId: string; targetUserId: string };
    const room = await _loadRoom(channelId);
    if (!room) return;
    if (!(await _isAuthorized(channelId, user._id, room))) return;

    const idx = room.speakers.findIndex(u => u.userId === targetUserId);
    if (idx === -1) return;

    const [demoted] = room.speakers.splice(idx, 1);
    demoted.muted      = false;
    demoted.handRaised = false;
    demoted.speaking   = false;
    room.listeners.push(demoted);
    await _saveRoom(channelId, room);

    io.to(`stage:${channelId}`).emit('stage:demoted', { channelId, userId: targetUserId });
    io.to(`stage:${channelId}`).emit('stage:state', { channelId, ...room });
  });

  // ── stage:setTopic (host veya server owner, max 200 chars) ───────────────
  socket.on('stage:setTopic', (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.stageSetTopic).valid) return;
    const { channelId, topic } = payload as { channelId: string; topic?: string };
    return (async () => {
      const room = await _loadRoom(channelId);
      if (!room) return;
      if (!(await _isAuthorized(channelId, user._id, room))) return;
      room.topic = (topic ?? '').slice(0, 200);
      await _saveRoom(channelId, room);
      io.to(`stage:${channelId}`).emit('stage:topicUpdate', { channelId, topic: room.topic });
    })();
  });

  // ── stage:setLive (host veya server owner) ───────────────────────────────
  socket.on('stage:setLive', (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.stageSetLive).valid) return;
    const { channelId, live } = payload as { channelId: string; live: boolean };
    return (async () => {
      const room = await _loadRoom(channelId);
      if (!room) return;
      if (!(await _isAuthorized(channelId, user._id, room))) return;
      room.live = !!live;
      await _saveRoom(channelId, room);
      io.to(`stage:${channelId}`).emit('stage:liveUpdate', { channelId, live: room.live });
    })();
  });

  // ── stage:leave ──────────────────────────────────────────────────────────
  socket.on('stage:leave', (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.stageChannelId).valid) return;
    const { channelId } = payload as { channelId: string };
    return (async () => {
      await removeUserFromRoom(channelId, user._id);
      socket.leave(`stage:${channelId}`);
      io.to(`stage:${channelId}`).emit('stage:userLeft', { channelId, userId: user._id });
      const room = await _loadRoom(channelId);
      if (room) io.to(`stage:${channelId}`).emit('stage:state', { channelId, ...room });
    })();
  });

  // ── disconnect — tüm stage room'larını temizle ───────────────────────────
  // Cluster-safe: socket.rooms üzerinden iterate edilir.
  // socket.rooms her zaman bu socket'in Socket.IO odalarını içerir — hem
  // single-node hem Redis-cluster modunda doğru çalışır.
  // _memRooms iteration artık kullanılmıyor: Redis modunda başka bir
  // worker'a bağlanan kullanıcılar _memRooms'a yazılmadığından hayalet
  // olarak kalırdı.
  socket.on('disconnect', () => {
    return (async () => {
      for (const room of socket.rooms) {
        if (!room.startsWith('stage:')) continue;
        const channelId = room.slice('stage:'.length);
        await removeUserFromRoom(channelId, user._id);
        io.to(`stage:${channelId}`).emit('stage:userLeft', { channelId, userId: user._id });
        const current = await _loadRoom(channelId);
        if (current) io.to(`stage:${channelId}`).emit('stage:state', { channelId, ...current });
      }
    })();
  });
}
