// server/socket/handlers/stage.ts
// Stage kanalı socket handler'ları
//
// Sprint 44: stageRooms in-memory Map → Redis-backed (cluster-safe)
// Önceki: her PM2 worker'ı ayrı Map tutuyordu; cluster modunda state tutarsızlığı.
// Şimdi: Redis pub/sub yerine Redis hash + JSON; tüm worker'lar aynı store'u görür.
// Fallback: Redis yoksa in-memory Map çalışmaya devam eder (tek-node deployment).
//
// Permission düzeltmesi: stage:promote artık sadece host değil server admin/owner da yapabilir.

import type { ClusterServer, HandlerSocket } from '../handler-contracts';
import { Channels, Members, Servers } from '../../db/repositories';
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
import { PERMS, hasPermission, resolvePermissions } from '../../lib/permissions';
import { isolateSocketHandler } from '../handlerIsolation';
import { isMemberTimedOut } from '../../lib/memberTimeout';
import { cache, isRedisAvailable } from '../../lib/redisAdapter';
import { revokeStagePublishers } from './mediasoup/rooms';


// ── Types ─────────────────────────────────────────────────────────────────────

export interface StageUser {
  userId:      string;
  displayName: string;
  avatarColor: string;
  muted:       boolean;
  handRaised:  boolean;
  speaking:    boolean;
  socketId:    string;
}

export interface StageRoom {
  speakers:  StageUser[];
  listeners: StageUser[];
  topic:     string;
  live:      boolean;
}

export interface AuthenticatedUser {
  _id:          string;
  displayName?: string;
  avatarColor?: string;
}

type StageAck = (result: { ok: boolean; code?: string; canManage?: boolean }) => void;

// ── Redis-backed store ────────────────────────────────────────────────────────
// All production Redis access goes through the canonical redisAdapter singleton.
// The previous `_bridgeRedis` global was never populated by production startup,
// so the code labelled "cluster-safe" actually stayed process-local forever.

const STAGE_ROOM_TTL_S = 4 * 60 * 60;

// In-memory fallback is allowed only for an explicitly single-node deployment.
const _memRooms = new Map<string, StageRoom>();

async function _loadRoom(channelId: string): Promise<StageRoom | null> {
  if (isRedisAvailable()) return cache.getAuthoritative<StageRoom>(`stage:room:${channelId}`);
  if (process.env.REDIS_URL) throw new Error('Stage Redis coordination unavailable');
  return _memRooms.get(channelId) ?? null;
}

async function _saveRoom(channelId: string, room: StageRoom): Promise<void> {
  if (isRedisAvailable()) {
    await cache.setAuthoritative(`stage:room:${channelId}`, room, STAGE_ROOM_TTL_S);
    return;
  }
  if (process.env.REDIS_URL) throw new Error('Stage Redis coordination unavailable');
  _memRooms.set(channelId, room);
}

async function _deleteRoom(channelId: string): Promise<void> {
  if (isRedisAvailable()) {
    await cache.delAuthoritative(`stage:room:${channelId}`);
    return;
  }
  if (process.env.REDIS_URL) throw new Error('Stage Redis coordination unavailable');
  _memRooms.delete(channelId);
}

async function _withRoomMutation<T>(channelId: string, fn: (room: StageRoom | null) => Promise<T> | T): Promise<T> {
  return cache.withKeyLock(`stage-room:${channelId}`, async () => fn(await _loadRoom(channelId)));
}

function _emptyRoom(): StageRoom {
  return { speakers: [], listeners: [], topic: '', live: false };
}

// Geriye dönük uyumluluk: tests / single-node callers can still inspect the
// process-local fallback. Redis remains the canonical store whenever connected.
export const stageRooms = _memRooms;

// ── Room helpers ──────────────────────────────────────────────────────────────

async function getOrCreateRoom(channelId: string): Promise<StageRoom> {
  return _withRoomMutation(channelId, async (existing) => {
    if (existing) return existing;
    const room = _emptyRoom();
    await _saveRoom(channelId, room);
    return room;
  });
}

async function removeUserFromRoom(channelId: string, userId: string, socketId: string): Promise<boolean> {
  return _withRoomMutation(channelId, async (room) => {
    if (!room) return false;
    const before = room.speakers.length + room.listeners.length;
    // A stale tab must not evict a newer tab for the same account.
    room.speakers = room.speakers.filter(u => !(u.userId === userId && u.socketId === socketId));
    room.listeners = room.listeners.filter(u => !(u.userId === userId && u.socketId === socketId));
    if (before === room.speakers.length + room.listeners.length) return false;
    if (!room.speakers.length && !room.listeners.length) await _deleteRoom(channelId);
    else await _saveRoom(channelId, room);
    return true;
  });
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
    const perms = await resolvePermissions(userId, String((channel as unknown as { serverId: string }).serverId), channelId);
    if (hasPermission(perms, PERMS.ADMINISTRATOR) || hasPermission(perms, PERMS.MANAGE_CHANNELS) || hasPermission(perms, PERMS.MANAGE_SERVER)) return true;
  } catch { /* ignore */ }
  return false;
}

/** Resolve the authoritative stage channel and server membership.
 * Client supplied serverId/role values are deliberately ignored. */
async function _stageAccess(channelId: string, userId: string, requireSpeak = false): Promise<{ serverId: string } | null> {
  try {
    const channel = await Channels.findById(channelId);
    const serverId = (channel as unknown as { serverId?: string } | null)?.serverId;
    if (!channel || channel.type !== 'stage' || !serverId) return null;
    const membership = await Members.findOne(userId, serverId);
    if (!membership || isMemberTimedOut(membership.timeoutUntil)) return null;
    const perms = await resolvePermissions(userId, serverId, channelId);
    if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.CONNECT)) return null;
    if (requireSpeak && !hasPermission(perms, PERMS.SPEAK)) return null;
    return { serverId };
  } catch {
    return null;
  }
}

/** Canonical stage membership query for sibling media/grid features. */
export async function isStageParticipant(channelId: string, userId: string, socketId?: string): Promise<boolean> {
  // Redis stage state can outlive a membership/permission change briefly. A
  // sibling media feature must never treat that stale state as authority.
  if (!await _stageAccess(channelId, userId)) return false;
  const room = await _loadRoom(channelId).catch(() => null);
  if (!room) return false;
  return [...room.speakers, ...room.listeners].some((participant) =>
    participant.userId === userId && (!socketId || participant.socketId === socketId));
}

/** Canonical media-publish authority for Stage. CONNECT/SPEAK alone is not
 * enough: the account must currently own a speaker slot in the Stage control
 * plane. The optional socketId is used by same-socket metadata owners; SFU
 * signaling may legitimately move to a dedicated owner-node socket. */
export async function isStageSpeaker(channelId: string, userId: string, socketId?: string): Promise<boolean> {
  if (!await _stageAccess(channelId, userId, true)) return false;
  const room = await _loadRoom(channelId).catch(() => null);
  if (!room) return false;
  return room.speakers.some((participant) =>
    participant.userId === userId && (!socketId || participant.socketId === socketId));
}

/** Canonical stage-management query; never infer host from video-grid join order. */
export async function canManageStage(channelId: string, userId: string): Promise<boolean> {
  if (!await _stageAccess(channelId, userId)) return false;
  const room = await _loadRoom(channelId).catch(() => null);
  if (!room) return false;
  return _isAuthorized(channelId, userId, room);
}

function _joined(socket: HandlerSocket, channelId: string): boolean {
  return socket.rooms.has(`stage:${channelId}`);
}

const _clusterMediaBound = new WeakSet<ClusterServer>();

/** Bind one server-side cluster listener per Socket.IO server. Redis adapter
 * transports `serverSideEmit` to the node that owns the mediasoup room. */
export function bindStageMediaClusterControl(io: ClusterServer): void {
  if (_clusterMediaBound.has(io)) return;
  _clusterMediaBound.add(io);
  io.on('stage:media-revoke', (payload: unknown) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const { channelId, userId } = payload as { channelId?: unknown; userId?: unknown };
    if (typeof channelId !== 'string' || !channelId || channelId.length > 128 ||
        typeof userId !== 'string' || !userId || userId.length > 128) return;
    revokeStagePublishers(channelId, userId);
  });
}

async function _revokeStageMedia(io: ClusterServer, channelId: string, userId: string): Promise<void> {
  revokeStagePublishers(channelId, userId);
  if (!process.env.REDIS_URL) return;
  try {
    io.serverSideEmit('stage:media-revoke', { channelId, userId });
  } catch {
    // If Redis is configured but the adapter cannot carry the revocation, the
    // Stage mutation remains authoritative and later SFU operations fail their
    // role check. The local owner was already revoked above.
  }
}

// ── Handler registration ──────────────────────────────────────────────────────

export function registerStageHandlers(
  socket: HandlerSocket,
  // Sahne (stage) medya yetkisi Redis adapter'i uzerinden DIGER dugumlere
  // tasiniyor; bu yuzden sozlesme `ClusterServer`dir. Bagimlilik imzada
  // gorunur olsun diye daraltilmadi — gercekten var.
  io:     ClusterServer,
  user:   AuthenticatedUser
): void {

  const joinedStageChannels = new Set<string>();

  // ── stage:join ───────────────────────────────────────────────────────────
  socket.on('stage:join', isolateSocketHandler(socket, 'stage:join', (payload: unknown, ack?: StageAck) => {
    if (!validateSocketPayload(payload, socketSchemas.stageChannelId).valid) { ack?.({ ok: false, code: 'STAGE_UNAVAILABLE' }); return; }
    const { channelId } = payload as { channelId: string };
    return (async () => {
      if (!(await _stageAccess(channelId, user._id))) { ack?.({ ok: false, code: 'STAGE_UNAVAILABLE' }); return; }
      const room = await getOrCreateRoom(channelId);
      joinedStageChannels.add(channelId);
      socket.join(`stage:${channelId}`);
      socket.emit('stage:state', { channelId, ...room });
      ack?.({ ok: true, canManage: await _isAuthorized(channelId, user._id, room) });
    })();
  }));

  // ── stage:setRole ────────────────────────────────────────────────────────
  socket.on('stage:setRole', isolateSocketHandler(socket, 'stage:setRole', (payload: unknown, ack?: StageAck) => {
    if (!validateSocketPayload(payload, socketSchemas.stageSetRole).valid) { ack?.({ ok: false, code: 'STAGE_ROLE_REJECTED' }); return; }
    const { channelId, role, displayName, avatarColor } = payload as { channelId: string; role: 'speaker' | 'listener'; displayName?: string; avatarColor?: string };
    return (async () => {
      const access = await _stageAccess(channelId, user._id, role === 'speaker');
      if (!access || !_joined(socket, channelId)) { ack?.({ ok: false, code: 'STAGE_ROLE_REJECTED' }); return; }
      const userObj: StageUser = {
        userId:      user._id,
        displayName: user.displayName ?? displayName ?? '',
        avatarColor: user.avatarColor ?? avatarColor ?? '',
        muted:       role === 'speaker',
        handRaised:  false,
        speaking:    false,
        socketId:    socket.id,
      };
      const room = await _withRoomMutation(channelId, async (existing) => {
        const next = existing ?? _emptyRoom();
        next.speakers = next.speakers.filter(u => u.userId !== user._id);
        next.listeners = next.listeners.filter(u => u.userId !== user._id);
        if (role === 'speaker') next.speakers.push(userObj);
        else next.listeners.push(userObj);
        await _saveRoom(channelId, next);
        return next;
      });
      if (role === 'listener') await _revokeStageMedia(io, channelId, user._id);
      io.to(`stage:${channelId}`).emit('stage:userJoined', { channelId, role, user: userObj });
      io.to(`stage:${channelId}`).emit('stage:state', { channelId, ...room });
      ack?.({ ok: true });
    })();
  }));

  // ── stage:updateMute ─────────────────────────────────────────────────────
  socket.on('stage:updateMute', isolateSocketHandler(socket, 'stage:updateMute', (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.stageUpdateMute).valid) return;
    const { channelId, muted } = payload as { channelId: string; muted: boolean };
    return (async () => {
      if (!(await _stageAccess(channelId, user._id)) || !_joined(socket, channelId)) return;
      const changed = await _withRoomMutation(channelId, async (room) => {
        if (!room) return false;
        const sp = room.speakers.find(u => u.userId === user._id);
        if (!sp) return false;
        sp.muted = muted;
        if (muted) sp.speaking = false;
        await _saveRoom(channelId, room);
        return true;
      });
      if (changed) io.to(`stage:${channelId}`).emit('stage:muteUpdate', { channelId, userId: user._id, muted });
    })();
  }));

  // ── stage:speaking (VAD) ─────────────────────────────────────────────────
  socket.on('stage:speaking', isolateSocketHandler(socket, 'stage:speaking', (payload: unknown) => {
    if (!validateSocketPayload(payload, socketSchemas.stageSpeaking).valid) return;
    const { channelId, speaking } = payload as { channelId: string; speaking: boolean };
    return (async () => {
      if (!(await _stageAccess(channelId, user._id)) || !_joined(socket, channelId)) return;
      const nextSpeaking = await _withRoomMutation(channelId, async (room) => {
        if (!room) return null;
        const sp = room.speakers.find(u => u.userId === user._id);
        if (!sp || sp.muted) return null;
        sp.speaking = !!speaking;
        await _saveRoom(channelId, room);
        return sp.speaking;
      });
      if (nextSpeaking !== null) io.to(`stage:${channelId}`).emit('stage:speaking', { channelId, userId: user._id, speaking: nextSpeaking });
    })();
  }));

  // ── stage:handRaise ──────────────────────────────────────────────────────
  socket.on('stage:handRaise', isolateSocketHandler(socket, 'stage:handRaise', (payload: unknown, ack?: StageAck) => {
    if (!validateSocketPayload(payload, socketSchemas.stageHandRaise).valid) { ack?.({ ok: false, code: 'STAGE_ACTION_REJECTED' }); return; }
    const { channelId, raised } = payload as { channelId: string; raised: boolean };
    return (async () => {
      if (!(await _stageAccess(channelId, user._id)) || !_joined(socket, channelId)) { ack?.({ ok: false, code: 'STAGE_ACTION_REJECTED' }); return; }
      const changed = await _withRoomMutation(channelId, async (room) => {
        if (!room) return false;
        const u = [...room.speakers, ...room.listeners].find(x => x.userId === user._id);
        if (!u) return false;
        u.handRaised = raised;
        await _saveRoom(channelId, room);
        return true;
      });
      if (changed) {
        io.to(`stage:${channelId}`).emit('stage:handRaise', { channelId, userId: user._id, raised });
        ack?.({ ok: true });
      } else ack?.({ ok: false, code: 'STAGE_ACTION_REJECTED' });
    })();
  }));

  // ── stage:promote (host veya server owner) ───────────────────────────────
  socket.on('stage:promote', isolateSocketHandler(socket, 'stage:promote', async (payload: unknown, ack?: StageAck) => {
    if (!validateSocketPayload(payload, socketSchemas.stageTarget).valid) { ack?.({ ok: false, code: 'STAGE_ACTION_REJECTED' }); return; }
    const { channelId, targetUserId } = payload as { channelId: string; targetUserId: string };
    const access = await _stageAccess(channelId, user._id);
    // Promotion creates a speaker. The target must independently possess
    // SPEAK; host authority cannot manufacture a permission the target lacks.
    if (!access || !_joined(socket, channelId) || !(await _stageAccess(channelId, targetUserId, true))) { ack?.({ ok: false, code: 'STAGE_ACTION_REJECTED' }); return; }
    const room = await _withRoomMutation(channelId, async (current) => {
      if (!current || !(await _isAuthorized(channelId, user._id, current))) return null;
      const li = current.listeners.findIndex(u => u.userId === targetUserId);
      if (li === -1) return null;
      const [promoted] = current.listeners.splice(li, 1);
      // `splice` sonucu tip olarak kesin degildir; eksik bir kayit
      // `undefined.muted` ile handler'i cokertirdi.
      if (!promoted) return null;
      promoted.muted = true;
      promoted.handRaised = false;
      promoted.speaking = false;
      current.speakers.push(promoted);
      await _saveRoom(channelId, current);
      return current;
    });
    if (!room) { ack?.({ ok: false, code: 'STAGE_ACTION_REJECTED' }); return; }
    io.to(`stage:${channelId}`).emit('stage:promoted', { channelId, userId: targetUserId });
    io.to(`stage:${channelId}`).emit('stage:state', { channelId, ...room });
    ack?.({ ok: true });
  }));

  // ── stage:demote (host veya server owner) ────────────────────────────────
  socket.on('stage:demote', isolateSocketHandler(socket, 'stage:demote', async (payload: unknown, ack?: StageAck) => {
    if (!validateSocketPayload(payload, socketSchemas.stageTarget).valid) { ack?.({ ok: false, code: 'STAGE_ACTION_REJECTED' }); return; }
    const { channelId, targetUserId } = payload as { channelId: string; targetUserId: string };
    const access = await _stageAccess(channelId, user._id);
    if (!access || !_joined(socket, channelId) || !(await _stageAccess(channelId, targetUserId))) { ack?.({ ok: false, code: 'STAGE_ACTION_REJECTED' }); return; }
    const room = await _withRoomMutation(channelId, async (current) => {
      if (!current || !(await _isAuthorized(channelId, user._id, current))) return null;
      const idx = current.speakers.findIndex(u => u.userId === targetUserId);
      if (idx === -1) return null;
      const [demoted] = current.speakers.splice(idx, 1);
      if (!demoted) return null;
      demoted.muted = false;
      demoted.handRaised = false;
      demoted.speaking = false;
      current.listeners.push(demoted);
      await _saveRoom(channelId, current);
      return current;
    });
    if (!room) { ack?.({ ok: false, code: 'STAGE_ACTION_REJECTED' }); return; }
    await _revokeStageMedia(io, channelId, targetUserId);
    io.to(`stage:${channelId}`).emit('stage:demoted', { channelId, userId: targetUserId });
    io.to(`stage:${channelId}`).emit('stage:state', { channelId, ...room });
    ack?.({ ok: true });
  }));

  // ── stage:setTopic (host veya server owner, max 200 chars) ───────────────
  socket.on('stage:setTopic', isolateSocketHandler(socket, 'stage:setTopic', (payload: unknown, ack?: StageAck) => {
    if (!validateSocketPayload(payload, socketSchemas.stageSetTopic).valid) { ack?.({ ok: false, code: 'STAGE_ACTION_REJECTED' }); return; }
    const { channelId, topic } = payload as { channelId: string; topic?: string };
    return (async () => {
      if (!(await _stageAccess(channelId, user._id)) || !_joined(socket, channelId)) { ack?.({ ok: false, code: 'STAGE_ACTION_REJECTED' }); return; }
      const nextTopic = await _withRoomMutation(channelId, async (room) => {
        if (!room || !(await _isAuthorized(channelId, user._id, room))) return null;
        room.topic = (topic ?? '').slice(0, 200);
        await _saveRoom(channelId, room);
        return room.topic;
      });
      if (nextTopic !== null) {
        io.to(`stage:${channelId}`).emit('stage:topicUpdate', { channelId, topic: nextTopic });
        ack?.({ ok: true });
      } else ack?.({ ok: false, code: 'STAGE_ACTION_REJECTED' });
    })();
  }));

  // ── stage:setLive (host veya server owner) ───────────────────────────────
  socket.on('stage:setLive', isolateSocketHandler(socket, 'stage:setLive', (payload: unknown, ack?: StageAck) => {
    if (!validateSocketPayload(payload, socketSchemas.stageSetLive).valid) { ack?.({ ok: false, code: 'STAGE_ACTION_REJECTED' }); return; }
    const { channelId, live } = payload as { channelId: string; live: boolean };
    return (async () => {
      if (!(await _stageAccess(channelId, user._id)) || !_joined(socket, channelId)) { ack?.({ ok: false, code: 'STAGE_ACTION_REJECTED' }); return; }
      const nextLive = await _withRoomMutation(channelId, async (room) => {
        if (!room || !(await _isAuthorized(channelId, user._id, room))) return null;
        room.live = !!live;
        await _saveRoom(channelId, room);
        return room.live;
      });
      if (nextLive !== null) {
        io.to(`stage:${channelId}`).emit('stage:liveUpdate', { channelId, live: nextLive });
        ack?.({ ok: true });
      } else ack?.({ ok: false, code: 'STAGE_ACTION_REJECTED' });
    })();
  }));

  // ── stage:leave ──────────────────────────────────────────────────────────
  socket.on('stage:leave', isolateSocketHandler(socket, 'stage:leave', (payload: unknown, ack?: StageAck) => {
    if (!validateSocketPayload(payload, socketSchemas.stageChannelId).valid) { ack?.({ ok: false, code: 'STAGE_LEAVE_REJECTED' }); return; }
    const { channelId } = payload as { channelId: string };
    return (async () => {
      if (!(await _stageAccess(channelId, user._id)) || !_joined(socket, channelId)) { ack?.({ ok: true }); return; }
      const removed = await removeUserFromRoom(channelId, user._id, socket.id);
      if (removed) await _revokeStageMedia(io, channelId, user._id);
      joinedStageChannels.delete(channelId);
      socket.leave(`stage:${channelId}`);
      if (removed) io.to(`stage:${channelId}`).emit('stage:userLeft', { channelId, userId: user._id });
      const room = await _loadRoom(channelId);
      if (room) io.to(`stage:${channelId}`).emit('stage:state', { channelId, ...room });
      ack?.({ ok: true });
    })();
  }));

  // ── disconnect — tüm stage room'larını temizle ───────────────────────────
  // Cluster-safe: socket.rooms üzerinden iterate edilir.
  // socket.rooms her zaman bu socket'in Socket.IO odalarını içerir — hem
  // single-node hem Redis-cluster modunda doğru çalışır.
  // _memRooms iteration artık kullanılmıyor: Redis modunda başka bir
  // worker'a bağlanan kullanıcılar _memRooms'a yazılmadığından hayalet
  // olarak kalırdı.
  socket.on('disconnect', isolateSocketHandler(socket, 'disconnect', () => {
    return (async () => {
      const channels = new Set(joinedStageChannels);
      for (const room of socket.rooms) if (room.startsWith('stage:')) channels.add(room.slice('stage:'.length));
      joinedStageChannels.clear();
      for (const channelId of channels) {
        const removed = await removeUserFromRoom(channelId, user._id, socket.id);
        if (removed) {
          await _revokeStageMedia(io, channelId, user._id);
          io.to(`stage:${channelId}`).emit('stage:userLeft', { channelId, userId: user._id });
        }
        const current = await _loadRoom(channelId);
        if (current) io.to(`stage:${channelId}`).emit('stage:state', { channelId, ...current });
      }
    })();
  }));
}
