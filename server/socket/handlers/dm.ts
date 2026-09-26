import type { HandlerSocket, HandlerServer } from '../handler-contracts';
export type SocketUserMap = Map<string, { _id?: string; id?: string; username?: string; displayName?: string; avatarColor?: string; avatarUrl?: string | null }>;

// server/socket/handlers/dm.ts
import { v4 as uuidv4 } from 'uuid';
import { Dms, GroupDms, Users } from '../../db/repositories';
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
// Sprint 122 FIX 6: Redis-backed rate limiting (cluster-safe)
import { cache } from '../../lib/redisAdapter';
// `joinGroupRooms().catch(...)` icinde kullaniliyordu ama IMPORT EDILMEMISTI.
// Sonuc: GDM oda senkronizasyonu hata verdiginde catch gövdesinin KENDISI
// `ReferenceError: logger is not defined` firlatiyor ve bu, catch'i olmayan
// bir promise reddine donusuyordu. Node varsayilan `unhandled-rejections=throw`
// politikasiyla bu SUNUCU SURECINI DUSURUR — yani gecici bir DB hatasi,
// soket baglanisinda tum node'u indirebilirdi.
import logger from '../../lib/logger';
import { evaluateDmAccess, isDmBlocked } from '../../lib/dmAccessPolicy';
import { isolateSocketHandler } from '../handlerIsolation';
import { envSafeInt } from '../../lib/envNumbers';
import { dmCallStore, type ActiveDmCall } from './dm-call-store';

const DM_RATE_MAX = envSafeInt('RL_DM_SOCKET_MAX', 20, { min: 1, max: 10_000 });
const DM_RATE_WIN = envSafeInt('RL_DM_SOCKET_WIN', 60_000, { min: 1_000, max: 24 * 60 * 60_000 });
const GDM_RATE_MAX = envSafeInt('RL_GDM_SOCKET_MAX', 20, { min: 1, max: 10_000 });
const GDM_RATE_WIN = envSafeInt('RL_GDM_SOCKET_WIN', 60_000, { min: 1_000, max: 24 * 60 * 60_000 });
const REDIS_CONFIGURED = Boolean(process.env.REDIS_URL);

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

async function socketMessageRate(
  kind: 'dm' | 'gdm', userId: string, max: number, windowMs: number, fallback: Map<string, number[]>,
): Promise<boolean> {
  const now = Date.now();
  try {
    const count = await cache.slidingWindowCount(`${kind}:rate:${userId}`, windowMs, now);
    if (count !== null) return count <= max;
  } catch (err) {
    logger.warn({ event: `${kind}.rate.redis_error`, userId, err: err instanceof Error ? err.message : String(err) },
      'Socket message rate-limit authority failed');
    if (REDIS_CONFIGURED) return false;
  }

  const hits = (fallback.get(userId) ?? []).filter(t => now - t < windowMs);
  hits.push(now);
  fallback.set(userId, hits);
  if (fallback.size > 50_000) {
    const cutoff = now - windowMs;
    for (const [key, values] of fallback) {
      if (!values.some(t => t > cutoff)) fallback.delete(key);
    }
  }
  return hits.length <= max;
}

async function _checkDmRate(userId: string): Promise<boolean> {
  return socketMessageRate('dm', userId, DM_RATE_MAX, DM_RATE_WIN, _dmRateWindows);
}

async function _checkGdmRate(userId: string): Promise<boolean> {
  return socketMessageRate('gdm', userId, GDM_RATE_MAX, GDM_RATE_WIN, _gdmRateWindows);
}

// Sprint 122 FIX 6: Eski sync DM rate limiter kaldırıldı (yukarıda Redis-backed async versiyonu var)

// Sprint 122 FIX 6: Eski process-local GDM rate limiter kaldırıldı (yukarıda Redis-backed versiyonu var)
// Helper: find all socket IDs for a userId
/**
 * ════════════════════════════════════════════════════════════════════════════
 * COK ORNEKLI TESLIMAT — SUREC-YEREL HARITA YERINE ODA
 * ════════════════════════════════════════════════════════════════════════════
 * KAPATILAN GERCEK KUSUR: `socketUsers` SUREC-YERELDIR. Iki ornek ayni Redis
 * ve PostgreSQL'e baglıyken bile, A ornegine bagli bir kullaniciya B
 * ornegi uzerinden gonderilen DM ve arama olaylari HIC ULASMIYORDU:
 * B'nin haritasinda o kullanicinin soketi YOKTUR.
 *
 * Olcum (iki ornek, ayni Redis): `dm:call:start` B'den yayildi, A'daki
 * istemci `dm:call:incoming` ALMADI.
 *
 * Cozum ZATEN VARDI ve ayni dosyada kullaniliyordu: her soket baglanirken
 * `user:<id>` odasina katilir (socket/index.ts:186) ve Socket.IO'nun Redis
 * adaptoru oda yayinlarini ornekler arasinda tasir. `inbox:changed` dogru
 * bicimde odaya yayiliyordu; DM teslimi ve arama sinyalleri ise yerel
 * haritayi kullaniyordu.
 *
 * Anlamsal fark YOK: her iki yol da o kullanicinin TUM soketlerine yayar.
 * Kullanici cevrimdisiysa yerel harita bos dizi, oda ise etkisiz yayin verir.
 */
function emitToUser(io: HandlerServer, userId: string, event: string, payload: unknown): void {
  io.to(`user:${userId}`).emit(event, payload);
}

/** Normalize untrusted persisted JSON without inheriting prototype keys. */
function normalizeDmReactions(value: unknown): Record<string, string[]> {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) as unknown; }
    catch { parsed = null; }
  }

  const normalized = Object.create(null) as Record<string, string[]>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return normalized;
  for (const [emoji, rawUsers] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(rawUsers)) continue;
    normalized[emoji] = [...new Set(rawUsers
      .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128))];
  }
  return normalized;
}

/**
 * `findSocketsForUser` KALDIRILDI. Surec-yerel haritadan soket kimligi
 * toplayip ona yayin yapmak, cok ornekli kurulumda olayi SESSIZCE DUSURUR.
 * Yeniden eklemeyin: kullanici hedefli her yayin `emitToUser` ile yapilir.
 */

function registerDmHandlers(socket: HandlerSocket, io: HandlerServer, user: { _id: string; username?: string; displayName?: string; avatarColor?: string; avatarUrl?: string | null }, _socketUsers: SocketUserMap): void {
  // ── DM CALL: Initiate ──────────────────────────────────────
  // type: 'voice' | 'video'
  /**
   * FAZ G — 1:1 ARAMA KATILIMCI DENETIMI (kanonik).
   *
   * Faz C4'te GDM arama olaylari (`gdm:call:*`) icin ayni sinif kusur
   * duzeltilmisti; DM esdegerleri ATLANMISTI. Olcum:
   *   · `dm:call:end`    — katilimci denetimi YOK: callId'yi bilen HERHANGI
   *     bir kullanici baskasinin gorusmesini SONLANDIRABILIYORDU.
   *   · `dm:call:decline`— ayni.
   *   · `dm:call:offer/answer/ice` — HIC denetim yok: payload'daki
   *     `targetUserId`ye dogrudan sinyal gonderiliyordu. Yani herhangi bir
   *     kullanici, herhangi birine ISTENMEYEN WebRTC teklifi enjekte
   *     edebiliyordu (arama yokken bile).
   *
   * Kural: cagiran, o `callId`nin IKI ucundan biri OLMALIDIR; hedef de
   * gorusmenin DIGER ucu olmalidir. Aksi halde olay sessizce dusurulur.
   */
  async function callParticipant(callId: unknown): Promise<ActiveDmCall | null> {
    if (typeof callId !== 'string' || !callId || callId.length > 128) return null;
    const call = await dmCallStore.get(callId);
    if (!call) return null;
    if (call.callerId !== user._id && call.calleeId !== user._id) return null;
    return call;
  }

  /** Sinyalin gidecegi mesru karsi taraf. Baska hicbir hedefe izin verilmez. */
  async function signalPeer(callId: unknown, targetUserId: unknown): Promise<string | null> {
    const call = await callParticipant(callId);
    if (!call) return null;
    const other = call.callerId === user._id ? call.calleeId : call.callerId;
    if (typeof targetUserId !== 'string' || targetUserId !== other) return null;
    if (await isDmBlocked(user._id, other)) return null;
    return other;
  }

  // Only calls actually owned/accepted by this socket are ended on its
  // disconnect. The old user-wide process-local scan both failed cross-node
  // and could tear down another browser tab's call.
  const socketCallIds = new Set<string>();

  socket.on('dm:call:start', isolateSocketHandler(socket, 'dm:call:start', async (payload) => {
    const { valid } = validateSocketPayload(payload, socketSchemas.dmCallStart);
    if (!valid) return;
    const { toUserId, type = 'voice' } = payload as { toUserId: string; type?: string };
    if (!['voice', 'video'].includes(type)) return;
    const target = await Users.findById(toUserId);
    if (!target) return;
    // Calls are a DM initiation surface and obey the same canonical block and
    // recipient privacy policy as a new message/conversation.
    const access = await evaluateDmAccess(user._id, target as { _id: string; dmPrivacy?: unknown });
    if (!access.allowed) return;

    const callId = uuidv4();
    await dmCallStore.set({
      callId,
      callerId:  user._id,
      calleeId:  toUserId,
      type: type as 'voice' | 'video',
      startedAt: Date.now(),
      status:    'ringing',
    });
    socketCallIds.add(callId);

    const callerInfo = {
      callId,
      type,
      callerId:          user._id,
      callerDisplayName: user.displayName,
      callerAvatarColor: user.avatarColor,
    };

    // Send ring to callee
    emitToUser(io, toUserId, 'dm:call:incoming', callerInfo);

    // Confirm to caller
    socket.emit('dm:call:outgoing', { callId, type, toUserId });

    // Auto-cancel if not answered in 30s
    setTimeout(() => {
      void dmCallStore.withLock(callId, async () => {
        const call = await dmCallStore.get(callId);
        if (call?.status !== 'ringing') return;
        await dmCallStore.del(callId);
        socketCallIds.delete(callId);
        socket.emit('dm:call:missed', { callId });
        emitToUser(io, toUserId, 'dm:call:missed', { callId });
      }).catch(err => logger.warn({ err, callId, event: 'dm.call.timeout_failed' }, 'DM call timeout cleanup failed'));
    }, 30_000).unref();
  }));

  // ── DM CALL: Accept ───────────────────────────────────────
  socket.on('dm:call:accept', isolateSocketHandler(socket, 'dm:call:accept', async (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.dmCallId).valid) return;
    const { callId } = payload as { callId: string };
    const pending = await dmCallStore.get(callId);
    if (!pending || await isDmBlocked(user._id, pending.callerId)) return;
    const call = await dmCallStore.withLock(callId, async () => {
      const current = await dmCallStore.get(callId);
      if (!current || current.calleeId !== user._id || current.status !== 'ringing') return null;
      const active: ActiveDmCall = { ...current, status: 'active' };
      await dmCallStore.set(active);
      return active;
    });
    if (!call) return;
    socketCallIds.add(callId);

    // Notify caller
    emitToUser(io, call.callerId, 'dm:call:accepted', {
      callId,
      type:              call.type,
      calleeDisplayName: user.displayName,
      calleeAvatarColor: user.avatarColor,
    });
    // Tell both sides to start WebRTC — use a shared channelId = callId
    socket.emit('dm:call:ready', { callId, channelId: callId, role: 'callee', type: call.type });
    emitToUser(io, call.callerId, 'dm:call:ready', { callId, channelId: callId, role: 'caller', type: call.type });
  }));

  // ── DM CALL: Decline ──────────────────────────────────────
  socket.on('dm:call:decline', isolateSocketHandler(socket, 'dm:call:decline', async (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.dmCallId).valid) return;
    const { callId } = payload as { callId: string };
    const call = await dmCallStore.withLock(callId, async () => {
      const current = await callParticipant(callId);
      if (!current || current.status !== 'ringing') return null;
      await dmCallStore.del(callId);
      return current;
    });
    if (!call) return;
    socketCallIds.delete(callId);
    emitToUser(io, call.callerId, 'dm:call:declined', { callId });
  }));

  // ── DM CALL: End (hang up) ────────────────────────────────
  socket.on('dm:call:end', isolateSocketHandler(socket, 'dm:call:end', async (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.dmCallId).valid) return;
    const { callId } = payload as { callId: string };
    const call = await dmCallStore.withLock(callId, async () => {
      const current = await callParticipant(callId);
      if (!current) return null;
      await dmCallStore.del(callId);
      return current;
    });
    if (!call) return;
    socketCallIds.delete(callId);
    const otherUserId = call.callerId === user._id ? call.calleeId : call.callerId;
    emitToUser(io, otherUserId, 'dm:call:ended', { callId });
    socket.emit('dm:call:ended', { callId });
  }));

  // ── DM CALL: Disconnect temizliği ────────────────────────
  // Socket bağlantısı kesilirse (ağ kopması, tarayıcı kapatma vs.)
  // bu kullanıcıya ait aktif DM aramalarını sonlandır ve karşı tarafı bilgilendir.
  socket.on('disconnect', isolateSocketHandler(socket, 'disconnect', async () => {
    const callIds = [...socketCallIds];
    socketCallIds.clear();
    for (const callId of callIds) {
      const call = await dmCallStore.withLock(callId, async () => {
        const current = await dmCallStore.get(callId);
        if (!current || (current.callerId !== user._id && current.calleeId !== user._id)) return null;
        await dmCallStore.del(callId);
        return current;
      });
      if (!call) continue;
      const otherUserId = call.callerId === user._id ? call.calleeId : call.callerId;
      emitToUser(io, otherUserId, 'dm:call:ended', { callId, reason: 'disconnect' });
    }
  }));

  // ── DM CALL: WebRTC signaling (routed through server) ─────
  // Sprint 75: validateSocketPayload eklendi — eksik/geçersiz callId veya
  // targetUserId ile gelen event'ler artık silentle drop ediliyor.
  socket.on('dm:call:offer', isolateSocketHandler(socket, 'dm:call:offer', async (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.dmCallSignal).valid) return;
    const { callId, targetUserId, offer } = payload as { callId: string; targetUserId: string; offer: unknown };
    const peer = await signalPeer(callId, targetUserId);
    if (!peer) return;   // cagiran katilimci degil VEYA hedef karsi taraf degil
    emitToUser(io, peer, 'dm:call:offer', { callId, fromSocketId: socket.id, offer });
  }));
  socket.on('dm:call:answer', isolateSocketHandler(socket, 'dm:call:answer', async (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.dmCallSignal).valid) return;
    const { callId, targetUserId, answer } = payload as { callId: string; targetUserId: string; answer: unknown };
    const peer = await signalPeer(callId, targetUserId);
    if (!peer) return;   // cagiran katilimci degil VEYA hedef karsi taraf degil
    emitToUser(io, peer, 'dm:call:answer', { callId, fromSocketId: socket.id, answer });
  }));
  socket.on('dm:call:ice', isolateSocketHandler(socket, 'dm:call:ice', async (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.dmCallSignal).valid) return;
    const { callId, targetUserId, candidate } = payload as { callId: string; targetUserId: string; candidate: unknown };
    const peer = await signalPeer(callId, targetUserId);
    if (!peer) return;   // cagiran katilimci degil VEYA hedef karsi taraf degil
    emitToUser(io, peer, 'dm:call:ice', { callId, fromSocketId: socket.id, candidate });
  }));

  // ─────────────────────────────────────────────────────────
  socket.on('dm:send', isolateSocketHandler(socket, 'dm:send', async (payload) => {
    const raw = payload as { toUserId?: unknown; content?: unknown; clientNonce?: unknown } | null;
    const clientNonce = typeof raw?.clientNonce === 'string' && raw.clientNonce.length <= 64
      ? raw.clientNonce : undefined;
    const reject = (code: string, message: string, legacyEvent = 'error:message'): void => {
      if (legacyEvent === 'error:message') {
        socket.emit('error:message', { event: 'dm:send', code, message, ...(clientNonce ? { clientNonce } : {}) });
      } else {
        socket.emit(legacyEvent, { error: message, code, ...(clientNonce ? { clientNonce } : {}) });
      }
    };

    // The schema trims before its `min: 1` check, so a whitespace-only body
    // used to be reported as the generic INVALID_PAYLOAD and the specific
    // EMPTY_MESSAGE branch below was unreachable dead code. Claim the most
    // common client mistake first; every other field still goes through the
    // schema unchanged.
    if (typeof raw?.content === 'string' && !raw.content.trim()) {
      reject('EMPTY_MESSAGE', 'Boş mesaj gönderilemez.');
      return;
    }
    if (!validateSocketPayload(payload, socketSchemas.dmSend).valid) {
      reject('INVALID_PAYLOAD', 'Mesaj isteği geçersiz.');
      return;
    }
    const { toUserId, content } = payload as { toUserId: string; content: string; clientNonce?: string };
    const isE2E = content.startsWith('🔒e2e:');
    const maxLen = isE2E ? 20_000 : 2000;
    if (content.length > maxLen) { reject('MESSAGE_TOO_LONG', `Mesaj çok uzun (en fazla ${maxLen} karakter).`); return; }

    const other = await Users.findById(toUserId);
    if (!other) { reject('USER_NOT_FOUND', 'Bu kullanıcı artık kullanılamıyor.'); return; }
    // Canonical DM policy: block always wins; privacy gates only NEW conversations.
    // Store failures propagate to the socket isolation boundary so policy outages fail closed.
    const access = await evaluateDmAccess(user._id, other as { _id: string; dmPrivacy?: unknown });
    if (!access.allowed) {
      const error = access.reason === 'blocked'
        ? 'Bu kullanıcıyla mesajlaşamazsınız.'
        : access.reason === 'privacy_none'
          ? 'Bu kullanıcı DM almıyor.'
          : 'Bu kullanıcı yalnızca arkadaşlarından DM kabul ediyor.';
      reject('DM_POLICY_DENIED', error, 'error:dm_privacy');
      return;
    }

    // Conversation identity is deterministic and can be checked WITHOUT
    // creating/touching a conversation. Rejected nonce conflicts and pure
    // retries must be side-effect free.
    const dmId = Dms.buildDmId(user._id, toUserId);
    if (clientNonce) {
      const existing = await Dms.findByClientNonce(user._id, clientNonce);
      if (existing) {
        if (String(existing.dmId ?? '') !== dmId) {
          reject('NONCE_CONFLICT', 'Mesaj yeniden gönderilemedi. Yeni bir mesaj olarak tekrar deneyin.');
          return;
        }
        socket.emit('dm:message', { ...existing, clientNonce });
        return;
      }
    }

    // Retries with a persisted nonce are resolved above and DO NOT consume a
    // second rate-limit slot. Only a genuinely new mutation reaches the gate —
    // and the gate must come BEFORE that mutation: running it after
    // findOrCreateConversation let a rate-limited caller keep creating
    // conversation rows for every denied send.
    if (!await _checkDmRate(user._id)) {
      reject('RATE_LIMITED', 'Çok fazla mesaj gönderiyorsunuz. Yavaşlayın.', 'error:dm_rate');
      return;
    }

    // Only a genuinely new, rate-approved mutation may create/touch state.
    await Dms.findOrCreateConversation(user._id, toUserId);

    let msg: Awaited<ReturnType<typeof Dms.insertMessage>>;
    try {
      msg = await Dms.insertMessage({
        dmId,
        userId: user._id, displayName: user.displayName, avatarColor: user.avatarColor,
        content: content.trim(),
        reactions: {},
        e2e: isE2E,
        ...(clientNonce ? { clientNonce } : {}),
      });
    } catch (err) {
      // Two tabs/reconnect paths may race with the SAME nonce. The unique index
      // is the final authority; the loser returns the winner instead of
      // surfacing a false failure or writing a duplicate.
      if (clientNonce) {
        const existing = await Dms.findByClientNonce(user._id, clientNonce).catch(() => null);
        if (existing && String(existing.dmId ?? '') === dmId) {
          socket.emit('dm:message', { ...existing, clientNonce });
          return;
        }
      }
      throw err;
    }

    // The nonce is private delivery metadata. Echo it only to the sender so the
    // optimistic row can be reconciled exactly; peers receive the canonical
    // persisted message without the client-local key.
    socket.emit('dm:message', { ...msg, ...(clientNonce ? { clientNonce } : {}) });
    const { clientNonce: _privateNonce, ...publicMsg } = msg;
    emitToUser(io, toUserId, 'dm:message', publicMsg);
    io.to(`user:${toUserId}`).emit('inbox:changed', { reason: 'dm' });
  }));

  // Faz 10 — OKUNDU BİLDİRİMİ. İstemci bunu zaten yayıyordu; sunucu tarafı
  // hiç uygulanmamıştı, bu yüzden okunmamış sayacı temizlenemiyordu.
  // Yetki repository'de: yalnız katılımcı KENDİ imlecini günceller.
  socket.on('dm:read', isolateSocketHandler(socket, 'dm:read', async (payload) => {
    const dmId = typeof payload === 'string'
      ? payload
      : (payload as { dmId?: unknown } | null)?.dmId;
    if (typeof dmId !== 'string' || !dmId || dmId.length > 128) return;

    // Hata SESSİZCE yutulmaz: ilk uygulamada `.catch(() => {})` gerçek bir
    // "Unknown column" hatasını gizledi ve okundu bildirimi hiç çalışmadığı
    // hâlde her şey normal görünüyordu.
    try {
      await Dms.markRead(dmId, user._id);
      io.to(`user:${user._id}`).emit('inbox:changed', { reason: 'dm-read' });
    } catch (err) {
      socket.emit('error:dm_read', { error: 'Okundu bilgisi kaydedilemedi.' });
      console.error('[dm:read] markRead başarısız:', (err as Error)?.message);
    }
  }));

  socket.on('dm:join', isolateSocketHandler(socket, 'dm:join', async (dmId) => {
    if (typeof dmId !== 'string' || dmId.length > 128) return;
    const conversation = await Dms.findConversation(dmId).catch(() => null);
    if (!conversation || !conversation.participants.includes(user._id)) return;
    for (const room of socket.rooms) if (room.startsWith('dm:')) socket.leave(room);
    socket.join(`dm:${dmId}`);
  }));

  // ── DM REACTIONS ─────────────────────────────────────────────
  socket.on('dm:react', isolateSocketHandler(socket, 'dm:react', async (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.dmReact).valid) return;
    const { messageId, dmId, emoji } = payload as { messageId: string; dmId: string; emoji: string };
    if (!messageId || !dmId || !emoji) return;
    if (typeof emoji !== 'string' || emoji.length > 16) return;

    const msg  = await Dms.findMessage(messageId, dmId);
    if (!msg) return;

    const conv = await Dms.findConversation(dmId);
    const participants = Array.isArray(conv?.participants) ? conv.participants.map(String) : [];
    if (!participants.includes(user._id)) return;
    const peerId = participants.find(id => id !== user._id);
    // Blocking is an unconditional DM boundary, including mutations on old
    // messages in an existing conversation.
    if (!peerId || await isDmBlocked(user._id, peerId)) return;

    const reactions = normalizeDmReactions(msg.reactions);

    const users = reactions[emoji] || [];
    const idx   = users.indexOf(user._id);
    if (idx === -1) users.push(user._id); else users.splice(idx, 1);
    if (users.length === 0) delete reactions[emoji]; else reactions[emoji] = users;

    await Dms.updateMessage(messageId, { reactions });
    io.to(`dm:${dmId}`).emit('dm:reaction', { messageId, dmId, reactions });
  }));
}


// ── GROUP DM SOCKET HANDLERS ──────────────────────────────────────────────────
function registerGroupDmHandlers(socket: HandlerSocket, io: HandlerServer, user: { _id: string; username?: string; displayName?: string; avatarColor?: string; avatarUrl?: string | null }, _socketUsers: SocketUserMap): void {
  /**
   * FAZ C4.4 — GÜNCEL üyelik kontrolü (tek kaynak).
   *
   * Odada BULUNMAK yetki DEĞİLDİR: soket bağlanırken tüm gruplara katılır
   * (`joinGroupRooms`), üyelik sonradan iptal edilebilir ve istemci eski bir
   * olayı yeniden gönderebilir. Bu yüzden güvenliğe duyarlı her olay,
   * bağlanma anındaki anlık görüntüye değil, ARKA UÇTAKİ GÜNCEL duruma bakar.
   * Hata durumunda fail-closed davranılır.
   */
  async function isGroupMember(groupId: string, userId: string): Promise<boolean> {
    if (!groupId || typeof groupId !== 'string' || groupId.length > 128) return false;
    return Boolean(await GroupDms.findMember(groupId, userId).catch(() => null));
  }

  async function joinGroupRooms() {
    const memberships = await GroupDms.findGroupsByUser(user._id);
    for (const m of memberships) socket.join(`gdm:${m.groupId}`);
  }
  joinGroupRooms().catch((err: Error) => {
    logger.warn({ err: err.message, userId: user._id, event: 'gdm.initial_room_join_failed' }, '[GDM] Initial room membership sync failed.');
  });

  socket.on('gdm:send', isolateSocketHandler(socket, 'gdm:send', async (payload) => {
    const raw = payload as { groupId?: unknown; content?: unknown; clientNonce?: unknown } | null;
    const clientNonce = typeof raw?.clientNonce === 'string' && raw.clientNonce.length <= 64
      ? raw.clientNonce : undefined;
    const reject = (code: string, message: string, legacyEvent = 'error:message'): void => {
      if (legacyEvent === 'error:message') {
        socket.emit('error:message', { event: 'gdm:send', code, message, ...(clientNonce ? { clientNonce } : {}) });
      } else {
        socket.emit(legacyEvent, { error: message, code, ...(clientNonce ? { clientNonce } : {}) });
      }
    };

    // The schema trims before its `min: 1` check, so a whitespace-only body
    // used to be reported as the generic INVALID_PAYLOAD and the specific
    // EMPTY_MESSAGE branch below was unreachable dead code. Claim the most
    // common client mistake first; every other field still goes through the
    // schema unchanged.
    if (typeof raw?.content === 'string' && !raw.content.trim()) {
      reject('EMPTY_MESSAGE', 'Boş mesaj gönderilemez.');
      return;
    }
    if (!validateSocketPayload(payload, socketSchemas.gdmSend).valid) {
      reject('INVALID_PAYLOAD', 'Mesaj isteği geçersiz.');
      return;
    }
    const { groupId, content } = payload as { groupId: string; content: string; clientNonce?: string };
    if (content.length > 2000) { reject('MESSAGE_TOO_LONG', 'Mesaj çok uzun (en fazla 2000 karakter).'); return; }

    // Current membership remains the authorization authority even for retries.
    const member = await GroupDms.findMember(groupId, user._id);
    if (!member) { reject('NOT_A_MEMBER', 'Bu grup konuşmasına artık erişiminiz yok.'); return; }

    if (clientNonce) {
      const existing = await GroupDms.findByClientNonce(user._id, clientNonce);
      if (existing) {
        if (String(existing.groupId ?? '') !== groupId) {
          reject('NONCE_CONFLICT', 'Mesaj yeniden gönderilemedi. Yeni bir mesaj olarak tekrar deneyin.');
          return;
        }
        socket.emit('gdm:message', { ...existing, clientNonce });
        return;
      }
    }

    if (!await _checkGdmRate(user._id)) {
      reject('RATE_LIMITED', 'Çok fazla mesaj gönderiyorsunuz. Yavaşlayın.', 'error:gdm_rate');
      return;
    }

    const now = Date.now();
    let msg: Awaited<ReturnType<typeof GroupDms.insertMessage>>;
    try {
      msg = await GroupDms.insertMessage({
        groupId,
        userId:      user._id,
        displayName: user.displayName,
        avatarColor: user.avatarColor || '#2d9cdb',
        content:     content.trim(),
        type:        'normal',
        ...(clientNonce ? { clientNonce } : {}),
      });
    } catch (err) {
      if (clientNonce) {
        const existing = await GroupDms.findByClientNonce(user._id, clientNonce).catch(() => null);
        if (existing && String(existing.groupId ?? '') === groupId) {
          socket.emit('gdm:message', { ...existing, clientNonce });
          return;
        }
      }
      throw err;
    }
    await GroupDms.update(groupId, { lastMessageAt: now });

    socket.emit('gdm:message', { ...msg, ...(clientNonce ? { clientNonce } : {}) });
    const { clientNonce: _privateNonce, ...publicMsg } = msg;
    socket.to(`gdm:${groupId}`).emit('gdm:message', publicMsg);
    socket.to(`gdm:${groupId}`).emit('inbox:changed', { reason: 'gdm' });
  }));

  socket.on('gdm:read', isolateSocketHandler(socket, 'gdm:read', async (payload) => {
    const groupIdRaw = typeof payload === 'string'
      ? payload
      : (payload as { groupId?: unknown } | null)?.groupId;
    if (typeof groupIdRaw !== 'string') return;
    const groupId = groupIdRaw.trim();
    if (!groupId || groupId.length > 128) return;
    if (await GroupDms.markRead(groupId, user._id)) {
      io.to(`user:${user._id}`).emit('inbox:changed', { reason: 'gdm-read' });
    }
  }));

  socket.on('gdm:join', isolateSocketHandler(socket, 'gdm:join', async (groupId) => {
    if (typeof groupId !== 'string' || groupId.length > 128) return;
    const member = await GroupDms.findMember(groupId, user._id).catch(() => null);
    if (!member) return;
    socket.join(`gdm:${groupId}`);
  }));

  socket.on('gdm:typing', isolateSocketHandler(socket, 'gdm:typing', async (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.gdmGroupId).valid) return;
    const { groupId } = payload as { groupId: string };
    // Faz 10.6 — ÜYELİK KONTROLÜ. Öncesinde yalnız payload şekli doğrulanıyor,
    // ardından doğrudan `gdm:<groupId>` odasına yayın yapılıyordu: üyesi
    // olmadığı özel bir gruba sahte "yazıyor" (varlık) sinyali enjekte etmek
    // mümkündü. Kimlik DAİMA doğrulanmış `user._id`'dir; diğer gdm
    // handler'larıyla (join/send/call) aynı kalıp kullanılır.
    const member = await GroupDms.findMember(groupId, user._id).catch(() => null);
    if (!member) return;

    socket.to(`gdm:${groupId}`).emit('gdm:typing', {
      groupId,
      userId:      user._id,
      displayName: user.displayName,
    });
  }));

  // ── GROUP DM VOICE CALL ───────────────────────────────────
  // Active group calls: groupId → Set of participant userIds
  // Uses a shared socket room: gdm:voice:<groupId>

  socket.on('gdm:call:start', isolateSocketHandler(socket, 'gdm:call:start', async (payload) => {
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
  }));

  socket.on('gdm:call:join', isolateSocketHandler(socket, 'gdm:call:join', async (payload) => {
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
  }));

  socket.on('gdm:call:leave', isolateSocketHandler(socket, 'gdm:call:leave', async (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.gdmGroupId).valid) return;
    const { groupId } = payload as { groupId: string };
    // FAZ C4.4 — ÜYELİK KONTROLÜ. Öncesinde yalnız payload şekli doğrulanıyordu:
    // üyesi olmadığı bir grubun sesli oda yayınına sahte "peer:left" enjekte
    // etmek mümkündü. Kimlik DAİMA doğrulanmış `user._id`'dir.
    if (!await isGroupMember(groupId, user._id)) return;
    // Group membership alone is not call participation. A member who never
    // joined this voice room must not inject a fake peer:left event.
    if (!socket.rooms.has(`gdm:voice:${groupId}`)) return;
    socket.leave(`gdm:voice:${groupId}`);
    socket.to(`gdm:voice:${groupId}`).emit('gdm:call:peer:left', {
      groupId,
      userId:   user._id,
      socketId: socket.id,
    });
    socket.emit('gdm:call:left', { groupId });
  }));

  // Socket.IO removes room membership automatically on disconnect, but peers
  // need an explicit lifecycle signal while `socket.rooms` still contains the
  // voice rooms. Without this `disconnecting` hook, an abrupt network/tab
  // failure leaves remote WebRTC peers/UI stale until transport-level timeout.
  // No DB lookup is performed here: admission to this room was already gated
  // by group membership in start/join, and disconnect cleanup must keep working
  // even if PostgreSQL is temporarily unavailable.
  socket.on('disconnecting', isolateSocketHandler(socket, 'gdm:call:disconnecting', () => {
    for (const room of [...socket.rooms]) {
      if (!room.startsWith('gdm:voice:')) continue;
      const groupId = room.slice('gdm:voice:'.length);
      if (!groupId) continue;
      socket.to(room).emit('gdm:call:peer:left', {
        groupId,
        userId: user._id,
        socketId: socket.id,
        reason: 'disconnect',
      });
    }
  }));

  socket.on('gdm:call:end', isolateSocketHandler(socket, 'gdm:call:end', async (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.gdmGroupId).valid) return;
    const { groupId } = payload as { groupId: string };
    // FAZ C4.4 — KAPATILAN GERÇEK AÇIK.
    // Eski yorum "basitlik için herkes bitirebilir" diyordu ve HİÇBİR kontrol
    // yoktu: kimliği doğrulanmış HERHANGİ bir kullanıcı, üyesi olmadığı bir
    // grubun `groupId`'sini tahmin ederek o grubun sesli görüşmesini herkes
    // için sonlandırabiliyor ve tüm katılımcıları odadan attırabiliyordu.
    // Bu, özel bir görüşmeye karşı uzaktan tetiklenen bir kesinti saldırısıydı.
    //
    // Güvenlik sınırı ÜYELİKTİR. "Yalnız başlatan bitirebilir" ayrı bir ÜRÜN
    // kararıdır ve burada tek taraflı olarak dayatılmaz.
    if (!await isGroupMember(groupId, user._id)) return;
    // Call control is room-scoped just like signaling/state. A group member
    // who never joined the active call cannot terminate everybody else's call.
    if (!socket.rooms.has(`gdm:voice:${groupId}`)) return;
    io.to(`gdm:voice:${groupId}`).emit('gdm:call:ended', { groupId, byUserId: user._id });
    // Force all sockets in the voice room to leave it
    const roomSockets = await fetchSocketsInRoom(io, `gdm:voice:${groupId}`);
    for (const s of roomSockets) { if (typeof s.leave === 'function') s.leave(`gdm:voice:${groupId}`); }
  }));

  // WebRTC signaling — peer-to-peer via server relay
  // Sprint 75: validateSocketPayload eklendi — geçersiz groupId/targetSocketId drop edilir.
  //
  // FAZ C4.4 — İKİ AŞAMALI YETKİLENDİRME.
  // Öncesinde yalnız payload ŞEKLİ doğrulanıyordu; ne gönderenin `groupId`
  // üyeliği ne de hedefin O GÖRÜŞMEYE ait olduğu kanıtlanıyordu. Sonuç:
  // sinyalleşme mesajları sunucudaki HERHANGİ bir sokete yönlendirilebiliyordu.
  // C2 dersi burada da geçerlidir: kimlik iç içe geçmiş olması aidiyet
  // KANITLAMAZ — hedefin bu görüşmenin odasında olduğu ayrıca doğrulanır.
  async function relaySignal(
    event: 'gdm:call:offer' | 'gdm:call:answer' | 'gdm:call:ice',
    payload: unknown,
    pick: (p: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    if (!validateSocketPayload(payload, socketSchemas.gdmCallSignal).valid) return;
    const p = payload as Record<string, unknown>;
    const groupId       = String(p.groupId ?? '');
    const targetSocketId = String(p.targetSocketId ?? '');

    // 1) gönderen gerçekten bu grubun üyesi mi?
    if (!await isGroupMember(groupId, user._id)) return;

    // 2) gönderen BU görüşmenin aktif voice room'unda mı? Grup üyesi olmak
    // tek başına signaling yetkisi değildir.
    if (!socket.rooms.has(`gdm:voice:${groupId}`)) return;

    // 3) hedef soket gerçekten BU görüşmenin odasında mı?
    const roomSockets = await fetchSocketsInRoom(io, `gdm:voice:${groupId}`);
    if (!roomSockets.some(s => s.id === targetSocketId)) return;

    io.to(targetSocketId).emit(event, { groupId, fromSocketId: socket.id, ...pick(p) });
  }

  // Promise GERİ DÖNDÜRÜLÜR (void ile yutulmaz): aksi hâlde handler, asenkron
  // yetki kontrolleri tamamlanmadan dönerdi ve çağıran tarafın tamamlanmayı
  // bekleme imkânı kalmazdı.
  socket.on('gdm:call:offer',  isolateSocketHandler(socket, 'gdm:call:offer', (payload) => relaySignal('gdm:call:offer',  payload, p => ({ offer: p.offer }))));
  socket.on('gdm:call:answer', isolateSocketHandler(socket, 'gdm:call:answer', (payload) => relaySignal('gdm:call:answer', payload, p => ({ answer: p.answer }))));
  socket.on('gdm:call:ice',    isolateSocketHandler(socket, 'gdm:call:ice', (payload) => relaySignal('gdm:call:ice',    payload, p => ({ candidate: p.candidate }))));

  // Mute/video state broadcast within group call
  socket.on('gdm:call:state', isolateSocketHandler(socket, 'gdm:call:state', async (payload) => {
    if (!validateSocketPayload(payload, socketSchemas.gdmCallState).valid) return;
    const { groupId, muted, video } = payload as { groupId: string; muted?: boolean; video?: boolean };
    // FAZ C4.4 — ÜYELİK KONTROLÜ: aksi hâlde yabancı bir kullanıcı, üyesi
    // olmadığı bir görüşmeye sahte "peer state" (mute/video) enjekte edebilirdi.
    if (!await isGroupMember(groupId, user._id)) return;
    // State is call-scoped: a group member outside the active voice room may
    // not impersonate an in-call participant's mute/video state.
    if (!socket.rooms.has(`gdm:voice:${groupId}`)) return;
    socket.to(`gdm:voice:${groupId}`).emit('gdm:call:peer:state', {
      groupId, socketId: socket.id, userId: user._id, muted, video,
    });
  }));
}

export { registerDmHandlers, registerGroupDmHandlers };
