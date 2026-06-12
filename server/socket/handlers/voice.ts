// server/socket/handlers/voice.ts
//
// voiceRooms: Redis-backed (cluster-safe), in-memory Map fallback.
// stageRooms pattern'iyle aynı yaklaşım — bkz. stage.ts
//
// Redis key: bridge:voice:room:<channelId>  (JSON, TTL=4 saat)
// Peer kaydı: { socketId, userId, displayName, avatarColor }

import { getQueue } from '../../music';
import { cache } from '../../lib/redisAdapter';
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';

const VOICE_ROOM_TTL_S = 4 * 60 * 60; // 4 saat — aktif ses kanalı
// Sprint 121 FIX 20: Ses kanalı katılımcı limiti — env ile yapılandırılabilir
const MAX_VOICE_PEERS  = parseInt(process.env.MAX_VOICE_PEERS || '25', 10);

// In-memory fallback (Redis yoksa / test ortamında)
const _fallback = new Map<string, VoicePeer[]>();

interface VoicePeer {
  socketId:    string;
  userId:      string;
  displayName: string;
  avatarColor: string;
}

// ── Redis yardımcıları ─────────────────────────────────────────

async function _loadRoom(channelId: string): Promise<VoicePeer[]> {
  try {
    const raw = await cache.get<VoicePeer[]>(`voice:room:${channelId}`);
    if (raw) return raw;
  } catch { /* fall through */ }
  return _fallback.get(channelId) ?? [];
}

async function _saveRoom(channelId: string, peers: VoicePeer[]): Promise<void> {
  _fallback.set(channelId, peers);
  try {
    if (peers.length === 0) {
      await cache.del(`voice:room:${channelId}`);
      _fallback.delete(channelId);
    } else {
      await cache.set(`voice:room:${channelId}`, peers, VOICE_ROOM_TTL_S);
    }
  } catch { /* fallback zaten güncellendi */ }
}

// ── Public API ─────────────────────────────────────────────────

async function leaveVoice(
  socket: { id: string; userId?: string; currentVoiceChannel?: string | null; currentVoiceServer?: string | null; leave(room: string): void; to(room: string): { emit(ev: string, data: unknown): void } },
  channelId: string,
  serverId:  string | undefined,
  io:        { to(room: string): { emit(ev: string, data: unknown): void } } | undefined
): Promise<void> {
  const peers = await _loadRoom(channelId);
  const updated = peers.filter(p => p.socketId !== socket.id);
  await _saveRoom(channelId, updated);

  socket.leave(`voice:${channelId}`);
  socket.to(`voice:${channelId}`).emit('voice:peer-left', { socketId: socket.id, userId: socket.userId });
  if (serverId && io) io.to(`server:${serverId}`).emit('voice:room-update', { channelId, peers: updated });

  socket.currentVoiceChannel = null;
  socket.currentVoiceServer  = null;
}

function registerVoiceHandlers(
  socket: {
    id: string;
    userId?: string;
    currentVoiceChannel?: string | null;
    currentVoiceServer?: string | null;
    rooms: Set<string>;
    on<TPayload = unknown>(event: string, handler: (payload: TPayload) => void): void;
    emit(ev: string, data: unknown): void;
    join(room: string): void;
    leave(room: string): void;
    to(room: string): { emit(ev: string, data: unknown): void };
  },
  io: { to(room: string): { emit(ev: string, data: unknown): void } },
  user: { _id: string; displayName: string; avatarColor: string }
) {
  socket.on('voice:join', (payload: { channelId: string; serverId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.voiceJoin).valid) return;
    const { channelId, serverId } = payload;
    return (async () => {
      const peers = await _loadRoom(channelId);

      if (peers.length >= MAX_VOICE_PEERS) {
        socket.emit('voice:full', { channelId, max: MAX_VOICE_PEERS });
        return;
      }

      // Var olan peer'ları yeni katılana gönder
      socket.emit('voice:existing-peers', peers.map(p => ({
        socketId: p.socketId, userId: p.userId, displayName: p.displayName, avatarColor: p.avatarColor,
      })));

      const peerInfo: VoicePeer = {
        socketId:    socket.id,
        userId:      user._id,
        displayName: user.displayName,
        avatarColor: user.avatarColor,
      };
      peers.push(peerInfo);
      await _saveRoom(channelId, peers);

      socket.currentVoiceChannel = channelId;
      socket.currentVoiceServer  = serverId;
      socket.join(`voice:${channelId}`);
      socket.to(`voice:${channelId}`).emit('voice:peer-joined', peerInfo);
      io.to(`server:${serverId}`).emit('voice:room-update', { channelId, peers });

      const q = getQueue(channelId);
      if (q.current) socket.emit('music:play', { channelId, track: q.current });
    })();
  });

  socket.on('voice:leave', (payload: { channelId: string; serverId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.voiceJoin).valid) return;
    return leaveVoice(socket, payload.channelId, payload.serverId, io);
  });

  socket.on('webrtc:offer', (payload: { targetSocketId: string; offer: unknown; channelId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.webrtcSignal).valid) return;
    io.to(payload.targetSocketId).emit('webrtc:offer', { fromSocketId: socket.id, offer: payload.offer, channelId: payload.channelId });
  });
  socket.on('webrtc:answer', (payload: { targetSocketId: string; answer: unknown }) => {
    if (!validateSocketPayload(payload, socketSchemas.webrtcSignal).valid) return;
    io.to(payload.targetSocketId).emit('webrtc:answer', { fromSocketId: socket.id, answer: payload.answer });
  });
  socket.on('webrtc:ice-candidate', (payload: { targetSocketId: string; candidate: unknown }) => {
    if (!validateSocketPayload(payload, socketSchemas.webrtcSignal).valid) return;
    io.to(payload.targetSocketId).emit('webrtc:ice-candidate', { fromSocketId: socket.id, candidate: payload.candidate });
  });

  socket.on('voice:state-update', (payload: { channelId: string; muted: boolean; deafened: boolean; screensharing: boolean; video: boolean }) => {
    if (!validateSocketPayload(payload, socketSchemas.voiceStateUpdate).valid) return;
    const { channelId, muted, deafened, screensharing, video } = payload;
    socket.to(`voice:${channelId}`).emit('voice:peer-state', { socketId: socket.id, userId: user._id, muted, deafened, screensharing, video });
  });

  socket.on('voice:activity', (payload: { channelId: string; speaking: boolean }) => {
    if (!validateSocketPayload(payload, socketSchemas.voiceActivity).valid) return;
    socket.to(`voice:${payload.channelId}`).emit('voice:activity', { socketId: socket.id, userId: user._id, speaking: payload.speaking });
  });

  // ── Voice E2E key exchange ─────────────────────────────────
  socket.on('voice:e2e-key', (payload: { channelId: string; targetUserId: string; encryptedKey: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.voiceE2eKey).valid) return;
    const { channelId, targetUserId, encryptedKey } = payload;
    return (async () => {
      const room   = await _loadRoom(channelId);
      const target = room.find(p => p.userId === targetUserId);
      if (target?.socketId) {
        io.to(target.socketId).emit('voice:e2e-key', { fromUserId: user._id, encryptedKey });
      }
    })();
  });
}

// voiceRooms export: geriye dönük uyumluluk için (in-memory fallback referansı)
// Hem Map API'sini (.get/.set/.entries/.delete) hem eski object erişimini
// (voiceRooms[channelId], Object.keys, delete voiceRooms[channelId]) destekler.
type VoiceRoomsCompat = Map<string, VoicePeer[]> & Record<string, VoicePeer[] | undefined>;
const voiceRooms = new Proxy(_fallback as unknown as VoiceRoomsCompat, {
  get(target, prop, receiver) {
    if (typeof prop === 'string' && !(prop in target)) return _fallback.get(prop);
    const value = Reflect.get(target, prop, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
  set(_target, prop, value) {
    if (typeof prop === 'string') { _fallback.set(prop, value as VoicePeer[]); return true; }
    return false;
  },
  deleteProperty(_target, prop) {
    if (typeof prop === 'string') return _fallback.delete(prop);
    return false;
  },
  ownKeys() { return [..._fallback.keys()]; },
  getOwnPropertyDescriptor(_target, prop) {
    if (typeof prop === 'string' && _fallback.has(prop)) return { enumerable: true, configurable: true };
    return undefined;
  },
}) as VoiceRoomsCompat;
const voiceActivity = new Map<string, number>();

export { registerVoiceHandlers, leaveVoice, voiceRooms, voiceActivity };
