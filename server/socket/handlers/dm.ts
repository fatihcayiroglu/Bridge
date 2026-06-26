import type { Socket, Server } from 'socket.io';
type SocketUserMap = Map<string, { _id?: string; id?: string; username?: string; displayName?: string; avatarColor?: string; avatarUrl?: string | null }>;

// server/socket/handlers/dm.ts
import { v4 as uuidv4 } from 'uuid';
import { Dms, GroupDms, Users, Social } from '../../db/repositories';
import { getDmId } from '../../routes/dm';
import { sanitizeUser } from '../../lib/userUtils';
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
// Sprint 122 FIX 6: Redis-backed rate limiting (cluster-safe)
import { cache } from '../../lib/redisAdapter';

const DM_RATE_MAX = parseInt(process.env.RL_DM_SOCKET_MAX || '20', 10);  // 60s'de max 20 DM
const DM_RATE_WIN = parseInt(process.env.RL_DM_SOCKET_WIN || '60000', 10);
const GDM_RATE_MAX = parseInt(process.env.RL_GDM_SOCKET_MAX || '20', 10);
const GDM_RATE_WIN = parseInt(process.env.RL_GDM_SOCKET_WIN || '60000', 10);

// In-memory fallback (Redis yoksa)
const _dmRateWindows = new Map<string, number[]>();
const _gdmRateWindows = new Map<string, number[]>();

type RoomFetchSocket = { id: string; data?: Record<string, unknown>; leave?: (room: string) => void };

async function fetchSocketsInRoom(io: { in?: (room: string) => unknown }, room: string): Promise<RoomFetchSocket[]> {
  const scope = typeof io.in === 'function' ? await Promise.resolve(io.in(room)) : null;
  const fetchSockets = (scope as { fetchSockets?: unknown } | null)?.fetchSockets;
  if (typeof fetchSockets !== 'function') return [];
  return await (fetchSockets as () => Promise<RoomFetchSocket[]>)();
}

async function _checkDmRate(userId: string): Promise<boolean> {
  const key = `dm:rate:${userId}`;
  const now = Date.now();
  const winSec = Math.ceil(DM_RATE_WIN / 1000);
  try {
    const member = `${now}:${Math.random()}`;
    const client = cache._client?.() as {
      multi(): {
        zAdd(k: string, m: { score: number; value: string }[]): unknown;
        zRemRangeByScore(k: string, min: string, max: number): unknown;
        zCard(k: string): unknown;
        expire(k: string, s: number): unknown;
        exec(): Promise<unknown[]>;
      };
    } | null;
    if (client) {
      const pipe = client.multi();
      pipe.zAdd(key, [{ score: now, value: member }]);
      pipe.zRemRangeByScore(key, '-inf', now - DM_RATE_WIN);
      pipe.zCard(key);
      pipe.expire(key, winSec + 1);
      const results = await pipe.exec();
      return (results[2] as number) <= DM_RATE_MAX;
    }
  } catch { /* Redis yoksa fallback */ }
  // In-memory fallback
  const hits = (_dmRateWindows.get(userId) ?? []).filter((t: number) => now - t < DM_RATE_WIN);
  hits.push(now);
  _dmRateWindows.set(userId, hits);
  if (_dmRateWindows.size > 50_000) {
    const cutoff = now - DM_RATE_WIN;
    for (const [k, v] of _dmRateWindows) { if (!(v as number[]).some((t: number) => t > cutoff)) _dmRateWindows.delete(k); }
  }
  return hits.length <= DM_RATE_MAX;
}

async function _checkGdmRate(userId: string): Promise<boolean> {
  const key = `gdm:rate:${userId}`;
  const now = Date.now();
  const winSec = Math.ceil(GDM_RATE_WIN / 1000);
  try {
    const client = cache._client?.() as {
      multi(): {
        zAdd(k: string, m: { score: number; value: string }[]): unknown;
        zRemRangeByScore(k: string, min: string, max: number): unknown;
        zCard(k: string): unknown;
        expire(k: string, s: number): unknown;
        exec(): Promise<unknown[]>;
      };
    } | null;
    if (client) {
      const member = `${now}:${Math.random()}`;
      const pipe = client.multi();
      pipe.zAdd(key, [{ score: now, value: member }]);
      pipe.zRemRangeByScore(key, '-inf', now - GDM_RATE_WIN);
      pipe.zCard(key);
      pipe.expire(key, winSec + 1);
      const results = await pipe.exec();
      return (results[2] as number) <= GDM_RATE_MAX;
    }
  } catch { /* Redis yoksa fallback */ }
  const hits = (_gdmRateWindows.get(userId) ?? []).filter((t: number) => now - t < GDM_RATE_WIN);
  hits.push(now);
  _gdmRateWindows.set(userId, hits);
  return hits.length <= GDM_RATE_MAX;
}

// Sprint 122 FIX 6: Eski sync DM rate limiter kaldırıldı (yukarıda Redis-backed async versiyonu var)

// Sprint 122 FIX 6: Eski process-local GDM rate limiter kaldırıldı (yukarıda Redis-backed versiyonu var)
const CALL_TTL_MS = 5 * 60_000; // 5 dakika — cevapsız/kopuk aramaları temizler

interface ActiveCall {
  callId: string;
  callerId: string;
  calleeId: string;
  type: string;
  startedAt: number;
  status: string;
}
const activeDmCalls = new Map<string, ActiveCall>();

// TTL temizleyici: 5 dakikadan eski her entry'yi sil (sunucu process boyunca çalışır)
setInterval(() => {
  const now = Date.now();
  for (const [id, call] of activeDmCalls) {
    if (now - call.startedAt > CALL_TTL_MS) activeDmCalls.delete(id);
  }
}, 60_000).unref();

// Helper: find all socket IDs for a userId
function findSocketsForUser(userId: string, socketUsers: SocketUserMap): string[] {
  const sids: string[] = [];
  for (const [sid, su] of socketUsers) {
    if ((su._id || su.id) === userId) sids.push(sid);
  }
  return sids;
}

function registerDmHandlers(socket: Socket, io: Server, user: { _id: string; username?: string; displayName?: string; avatarColor?: string; avatarUrl?: string | null }, socketUsers: SocketUserMap): void {
  // ── DM CALL: Initiate ──────────────────────────────────────
  // type: 'voice' | 'video'
  socket.on('dm:call:start', async (payload) => {
    const { valid } = validateSocketPayload(payload, socketSchemas.dmCallStart);
    if (!valid) return;
    const { toUserId, type = 'voice' } = payload as { toUserId: string; type?: string };
    if (!['voice', 'video'].includes(type)) return;
    // Güvenlik: engelleme kontrolü — engellenen/engelleyen kişiyi arayamazsın
    const block = await Social.findBlock(user._id, toUserId).catch(() => null)
                ?? await Social.findBlock(toUserId, user._id).catch(() => null);
    if (block) return;

    const callId = uuidv4();
    activeDmCalls.set(callId, {
      callId,
      callerId:  user._id,
      calleeId:  toUserId,
      type,
      startedAt: Date.now(),
      status:    'ringing',
    });

    const callerInfo = {
      callId,
      type,
      callerId:          user._id,
      callerDisplayName: user.displayName,
      callerAvatarColor: user.avatarColor,
    };

    // Send ring to callee
    const calleeSockets = findSocketsForUser(toUserId, socketUsers);
    for (const sid of calleeSockets) io.to(sid).emit('dm:call:incoming', callerInfo);

    // Confirm to caller
    socket.emit('dm:call:outgoing', { callId, type, toUserId });

    // Auto-cancel if not answered in 30s
    setTimeout(() => {
      const call = activeDmCalls.get(callId);
      if (call && call.status === 'ringing') {
        activeDmCalls.delete(callId);
        socket.emit('dm:call:missed', { callId });
        for (const sid of findSocketsForUser(toUserId, socketUsers)) {
          io.to(sid).emit('dm:call:missed', { callId });
        }
      }
    }, 30_000).unref();
  });

  // ── DM CALL: Accept ───────────────────────────────────────
  socket.on('dm:call:accept', (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.dmCallId).valid) return;
    const { callId } = payload as { callId: string };
    const call = activeDmCalls.get(callId);
    if (!call || call.calleeId !== user._id) return;
    call.status = 'active';

    // Notify caller
    const callerSockets = findSocketsForUser(call.callerId, socketUsers);
    for (const sid of callerSockets) {
      io.to(sid).emit('dm:call:accepted', {
        callId,
        type:              call.type,
        calleeDisplayName: user.displayName,
        calleeAvatarColor: user.avatarColor,
      });
    }
    // Tell both sides to start WebRTC — use a shared channelId = callId
    socket.emit('dm:call:ready', { callId, channelId: callId, role: 'callee', type: call.type });
    for (const sid of callerSockets) {
      io.to(sid).emit('dm:call:ready', { callId, channelId: callId, role: 'caller', type: call.type });
    }
  });

  // ── DM CALL: Decline ──────────────────────────────────────
  socket.on('dm:call:decline', (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.dmCallId).valid) return;
    const { callId } = payload as { callId: string };
    const call = activeDmCalls.get(callId);
    if (!call) return;
    activeDmCalls.delete(callId);
    const callerSockets = findSocketsForUser(call.callerId, socketUsers);
    for (const sid of callerSockets) io.to(sid).emit('dm:call:declined', { callId });
  });

  // ── DM CALL: End (hang up) ────────────────────────────────
  socket.on('dm:call:end', (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.dmCallId).valid) return;
    const { callId } = payload as { callId: string };
    const call = activeDmCalls.get(callId);
    if (!call) return;
    const otherUserId = call.callerId === user._id ? call.calleeId : call.callerId;
    activeDmCalls.delete(callId);
    const otherSockets = findSocketsForUser(otherUserId, socketUsers);
    for (const sid of otherSockets) io.to(sid).emit('dm:call:ended', { callId });
    socket.emit('dm:call:ended', { callId });
  });

  // ── DM CALL: Disconnect temizliği ────────────────────────
  // Socket bağlantısı kesilirse (ağ kopması, tarayıcı kapatma vs.)
  // bu kullanıcıya ait aktif DM aramalarını sonlandır ve karşı tarafı bilgilendir.
  socket.on('disconnect', () => {
    // Sprint 122 FIX 5: Map iteration sırasında delete güvenli değil.
    // Silinecekleri önce topla, sonra sil.
    const toEnd: string[] = [];
    for (const [callId, call] of activeDmCalls) {
      if (call.callerId === user._id || call.calleeId === user._id) toEnd.push(callId);
    }
    for (const callId of toEnd) {
      const call = activeDmCalls.get(callId);
      if (!call) continue;
      activeDmCalls.delete(callId);
      const otherUserId = call.callerId === user._id ? call.calleeId : call.callerId;
      for (const sid of findSocketsForUser(otherUserId, socketUsers)) {
        io.to(sid).emit('dm:call:ended', { callId, reason: 'disconnect' });
      }
    }
  });

  // ── DM CALL: WebRTC signaling (routed through server) ─────
  // Sprint 75: validateSocketPayload eklendi — eksik/geçersiz callId veya
  // targetUserId ile gelen event'ler artık silentle drop ediliyor.
  socket.on('dm:call:offer', (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.dmCallSignal).valid) return;
    const { callId, targetUserId, offer } = payload as { callId: string; targetUserId: string; offer: unknown };
    for (const sid of findSocketsForUser(targetUserId, socketUsers))
      io.to(sid).emit('dm:call:offer', { callId, fromSocketId: socket.id, offer });
  });
  socket.on('dm:call:answer', (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.dmCallSignal).valid) return;
    const { callId, targetUserId, answer } = payload as { callId: string; targetUserId: string; answer: unknown };
    for (const sid of findSocketsForUser(targetUserId, socketUsers))
      io.to(sid).emit('dm:call:answer', { callId, fromSocketId: socket.id, answer });
  });
  socket.on('dm:call:ice', (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.dmCallSignal).valid) return;
    const { callId, targetUserId, candidate } = payload as { callId: string; targetUserId: string; candidate: unknown };
    for (const sid of findSocketsForUser(targetUserId, socketUsers))
      io.to(sid).emit('dm:call:ice', { callId, fromSocketId: socket.id, candidate });
  });

  // ─────────────────────────────────────────────────────────
  socket.on('dm:send', async (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.dmSend).valid) return;
    const { toUserId, content } = payload as { toUserId: string; content: string };
    if (!content?.trim()) return;
    const isE2E = content.startsWith('🔒e2e:');
    const maxLen = isE2E ? 20_000 : 2000;
    if (content.length > maxLen) return;

    // Sprint 121 FIX 3 / Sprint 122 FIX 6: DM socket rate limit (Redis-backed)
    if (!await _checkDmRate(user._id)) {
      socket.emit('error:dm_rate', { error: 'Çok fazla mesaj gönderiyorsunuz. Yavaşlayın.' });
      return;
    }

    const other = await Users.findById(toUserId);
    if (!other) return;
    // Sprint 121 FIX 8: Çift yönlü engelleme kontrolü — her iki yönde de engel varsa reddet
    const block = await Social.findBlock(user._id, toUserId).catch(() => null)
                ?? await Social.findBlock(toUserId, user._id).catch(() => null);
    if (block) return;

    // Sprint 122 FIX 4: DM gizlilik politikası — alıcının dmPrivacy ayarını kontrol et.
    // 'everyone' (varsayılan) → herkesten DM kabul et
    // 'friends'              → yalnızca karşılıklı kabul edilmiş arkadaşlardan
    // 'none'                 → hiç kimse DM gönderemiyor (kullanıcı kendi başlatabilir)
    const recipientPrivacy = (other as unknown as Record<string, unknown>).dmPrivacy as string | undefined;
    if (recipientPrivacy && recipientPrivacy !== 'everyone') {
      // Mevcut konuşma varsa (geçmişte mesajlaşılmışsa) kısıtlamayı atla
      const existingConv = await Dms.findConversationByParticipants(user._id, toUserId).catch(() => null);
      if (!existingConv) {
        if (recipientPrivacy === 'none') {
          socket.emit('error:dm_privacy', { error: 'Bu kullanıcı DM almıyor.' });
          return;
        }
        if (recipientPrivacy === 'friends') {
          const friendship = await Social.findFriendship(user._id, toUserId).catch(() => null);
          const isMutual = friendship && (friendship as unknown as Record<string, unknown>).status === 'accepted';
          if (!isMutual) {
            socket.emit('error:dm_privacy', { error: 'Bu kullanıcı yalnızca arkadaşlarından DM kabul ediyor.' });
            return;
          }
        }
      }
    }

    const dmId = getDmId(user._id, toUserId);
    const { dmId: _id } = await Dms.findOrCreateConversation(user._id, toUserId);
    const msg = await Dms.insertMessage({
      dmId,
      userId: user._id, displayName: user.displayName, avatarColor: user.avatarColor,
      content: content.trim(),
      reactions: {},
      e2e: isE2E,
    });
    socket.emit('dm:message', msg);
    for (const [sid, su] of socketUsers) {
      if ((su._id || su.id) === toUserId) io.to(sid).emit('dm:message', msg);
    }
  });

  socket.on('dm:join', (dmId) => {
    for (const room of socket.rooms) if (room.startsWith('dm:')) socket.leave(room);
    socket.join(`dm:${dmId}`);
  });

  // ── DM REACTIONS ─────────────────────────────────────────────
  socket.on('dm:react', async (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.dmReact).valid) return;
    const { messageId, dmId, emoji } = payload as { messageId: string; dmId: string; emoji: string };
    if (!messageId || !dmId || !emoji) return;
    if (typeof emoji !== 'string' || emoji.length > 16) return;

    const msg  = await Dms.findMessage(messageId, dmId);
    if (!msg) return;

    const conv = await Dms.findConversation(dmId);
    if (!conv || !conv.participants.includes(user._id)) return;

    let reactions;
    try { reactions = typeof msg.reactions === 'string' ? JSON.parse(msg.reactions) : (msg.reactions || {}); }
    catch { reactions = {}; }

    const users = reactions[emoji] || [];
    const idx   = users.indexOf(user._id);
    if (idx === -1) users.push(user._id); else users.splice(idx, 1);
    if (users.length === 0) delete reactions[emoji]; else reactions[emoji] = users;

    await Dms.updateMessage(messageId, { reactions });
    io.to(`dm:${dmId}`).emit('dm:reaction', { messageId, dmId, reactions });
  });
}


// ── GROUP DM SOCKET HANDLERS ──────────────────────────────────────────────────
function registerGroupDmHandlers(socket: Socket, io: Server, user: { _id: string; username?: string; displayName?: string; avatarColor?: string; avatarUrl?: string | null }, socketUsers: SocketUserMap): void {
  async function joinGroupRooms() {
    const memberships = await GroupDms.findGroupsByUser(user._id);
    for (const m of memberships) socket.join(`gdm:${m.groupId}`);
  }
  joinGroupRooms().catch(() => {});

  socket.on('gdm:send', async (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.gdmSend).valid) return;
    const { groupId, content } = payload as { groupId: string; content: string };
    if (!content?.trim() || content.length > 2000) return;

    // Sprint 121 FIX 3 / Sprint 122 FIX 6: GDM socket rate limit (Redis-backed)
    if (!await _checkGdmRate(user._id)) {
      socket.emit('error:gdm_rate', { error: 'Çok fazla mesaj gönderiyorsunuz. Yavaşlayın.' });
      return;
    }

    const member = await GroupDms.findMember(groupId, user._id);
    if (!member) return;

    const now = Date.now();
    const msg = await GroupDms.insertMessage({
      groupId,
      userId:      user._id,
      displayName: user.displayName,
      avatarColor: user.avatarColor || '#2d9cdb',
      content:     content.trim(),
      type:        'normal',
    });
    await GroupDms.update(groupId, { lastMessageAt: now });
    io.to(`gdm:${groupId}`).emit('gdm:message', msg);
  });

  socket.on('gdm:join', (groupId) => {
    socket.join(`gdm:${groupId}`);
  });

  socket.on('gdm:typing', (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.gdmGroupId).valid) return;
    const { groupId } = payload as { groupId: string };
    socket.to(`gdm:${groupId}`).emit('gdm:typing', {
      groupId,
      userId:      user._id,
      displayName: user.displayName,
    });
  });

  // ── GROUP DM VOICE CALL ───────────────────────────────────
  // Active group calls: groupId → Set of participant userIds
  // Uses a shared socket room: gdm:voice:<groupId>

  socket.on('gdm:call:start', async (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.gdmCallStart).valid) return;
    const { groupId, type = 'voice' } = payload as { groupId: string; type?: string };
    if (!['voice', 'video'].includes(type)) return;
    const member = await GroupDms.findMember(groupId, user._id);
    if (!member) return;

    // Join the voice room
    socket.join(`gdm:voice:${groupId}`);

    // Notify everyone else in the group
    socket.to(`gdm:${groupId}`).emit('gdm:call:incoming', {
      groupId,
      type,
      callerId:          user._id,
      callerDisplayName: user.displayName,
      callerAvatarColor: user.avatarColor,
    });

    // Confirm to caller they started the call
    socket.emit('gdm:call:started', { groupId, type });
  });

  socket.on('gdm:call:join', async (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.gdmCallStart).valid) return;
    const { groupId, type = 'voice' } = payload as { groupId: string; type?: string };
    const member = await GroupDms.findMember(groupId, user._id);
    if (!member) return;

    socket.join(`gdm:voice:${groupId}`);

    // Tell everyone already in the voice room that a new peer joined
    socket.to(`gdm:voice:${groupId}`).emit('gdm:call:peer:joined', {
      groupId,
      userId:      user._id,
      displayName: user.displayName,
      avatarColor: user.avatarColor,
      socketId:    socket.id,
    });

    // Send the joining peer a list of existing participants in the room
    const roomSockets = await fetchSocketsInRoom(io, `gdm:voice:${groupId}`);
    const existingPeers = roomSockets
      .filter(s => s.id !== socket.id)
      .map(s => ({ socketId: s.id, userId: s.data?.userId, displayName: s.data?.displayName }));
    socket.emit('gdm:call:existing:peers', { groupId, peers: existingPeers });

    socket.emit('gdm:call:joined', { groupId, type });
  });

  socket.on('gdm:call:leave', (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.gdmGroupId).valid) return;
    const { groupId } = payload as { groupId: string };
    socket.leave(`gdm:voice:${groupId}`);
    socket.to(`gdm:voice:${groupId}`).emit('gdm:call:peer:left', {
      groupId,
      userId:   user._id,
      socketId: socket.id,
    });
    socket.emit('gdm:call:left', { groupId });
  });

  socket.on('gdm:call:end', async (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.gdmGroupId).valid) return;
    const { groupId } = payload as { groupId: string };
    // Only the call initiator or an admin should be able to end for everyone
    // For simplicity, anyone can end — notify all, kick them from voice room
    io.to(`gdm:voice:${groupId}`).emit('gdm:call:ended', { groupId, byUserId: user._id });
    // Force all sockets in the voice room to leave it
    const roomSockets = await fetchSocketsInRoom(io, `gdm:voice:${groupId}`);
    for (const s of roomSockets) { if (typeof s.leave === 'function') s.leave(`gdm:voice:${groupId}`); }
  });

  // WebRTC signaling — peer-to-peer via server relay
  // Sprint 75: validateSocketPayload eklendi — geçersiz groupId/targetSocketId drop edilir.
  socket.on('gdm:call:offer', (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.gdmCallSignal).valid) return;
    const { groupId, targetSocketId, offer } = payload as { groupId: string; targetSocketId: string; offer: unknown };
    io.to(targetSocketId).emit('gdm:call:offer', { groupId, fromSocketId: socket.id, offer });
  });
  socket.on('gdm:call:answer', (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.gdmCallSignal).valid) return;
    const { groupId, targetSocketId, answer } = payload as { groupId: string; targetSocketId: string; answer: unknown };
    io.to(targetSocketId).emit('gdm:call:answer', { groupId, fromSocketId: socket.id, answer });
  });
  socket.on('gdm:call:ice', (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.gdmCallSignal).valid) return;
    const { groupId, targetSocketId, candidate } = payload as { groupId: string; targetSocketId: string; candidate: unknown };
    io.to(targetSocketId).emit('gdm:call:ice', { groupId, fromSocketId: socket.id, candidate });
  });

  // Mute/video state broadcast within group call
  socket.on('gdm:call:state', (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.gdmCallState).valid) return;
    const { groupId, muted, video } = payload as { groupId: string; muted?: boolean; video?: boolean };
    socket.to(`gdm:voice:${groupId}`).emit('gdm:call:peer:state', {
      groupId, socketId: socket.id, userId: user._id, muted, video,
    });
  });
}

export { registerDmHandlers, registerGroupDmHandlers };
