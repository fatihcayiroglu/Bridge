// server/socket/handlers/voice.ts
//
// voiceRooms: Redis-backed (cluster-safe), in-memory Map fallback.
// stageRooms pattern'iyle aynı yaklaşım — bkz. stage.ts
//
// Redis key: bridge:voice:room:<channelId>  (JSON, TTL=4 saat)
// Peer kaydı: { socketId, userId, displayName, avatarColor }

import { readMusicQueue } from '../../music';
import { cache, isRedisAvailable } from '../../lib/redisAdapter';
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
import { Channels, Members } from '../../db/repositories';
import { resolvePermissions, hasPermission, PERMS } from '../../lib/permissions';
import { isolateSocketHandler } from '../handlerIsolation';
import { envSafeInt } from '../../lib/envNumbers';


const VOICE_ROOM_TTL_S = 4 * 60 * 60; // 4 saat — aktif ses kanalı
// Sprint 121 FIX 20: Ses kanalı katılımcı limiti — env ile yapılandırılabilir
const MAX_VOICE_PEERS = envSafeInt('MAX_VOICE_PEERS', 25, { min: 1, max: 10_000 });

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
  if (isRedisAvailable()) {
    return (await cache.getAuthoritative<VoicePeer[]>(`voice:room:${channelId}`)) ?? [];
  }
  // A configured cluster must never silently fork voice membership into a
  // process-local copy when Redis coordination is temporarily unavailable.
  if (process.env.REDIS_URL) throw new Error('Voice Redis coordination unavailable');
  return _fallback.get(channelId) ?? [];
}

async function _saveRoom(channelId: string, peers: VoicePeer[]): Promise<void> {
  if (isRedisAvailable()) {
    if (peers.length === 0) await cache.delAuthoritative(`voice:room:${channelId}`);
    else await cache.setAuthoritative(`voice:room:${channelId}`, peers, VOICE_ROOM_TTL_S);
    return;
  }
  if (process.env.REDIS_URL) throw new Error('Voice Redis coordination unavailable');
  if (peers.length === 0) _fallback.delete(channelId);
  else _fallback.set(channelId, peers);
}

async function _mutateRoom<T>(channelId: string, fn: (peers: VoicePeer[]) => Promise<T> | T): Promise<T> {
  return cache.withKeyLock(`voice-room:${channelId}`, async () => fn(await _loadRoom(channelId)));
}

// ── Public API ─────────────────────────────────────────────────

async function leaveVoice(
  socket: { id: string; userId?: string; currentVoiceChannel?: string | null; currentVoiceServer?: string | null; leave(room: string): void; to(room: string): { emit(ev: string, data: unknown): void } },
  channelId: string,
  serverId:  string | undefined,
  io:        { to(room: string | string[]): { emit(ev: string, data: unknown): void } } | undefined
): Promise<void> {
  const updated = await _mutateRoom(channelId, async (peers) => {
    const next = peers.filter(p => p.socketId !== socket.id);
    await _saveRoom(channelId, next);
    return next;
  });

  socket.leave(`voice:${channelId}`);
  socket.to(`voice:${channelId}`).emit('voice:peer-left', { socketId: socket.id, userId: socket.userId });
  if (serverId && io) io.to([`voice:${channelId}`, `channel:${channelId}`]).emit('voice:room-update', { channelId, peers: updated });

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
  io: { to(room: string | string[]): { emit(ev: string, data: unknown): void } },
  user: { _id: string; displayName: string; avatarColor: string },
  capabilities: { sfuReady?: boolean } = {},
) {
  // One socket has exactly one canonical P2P voice room. A monotonic generation
  // cancels stale async joins and explicit leave invalidates an in-flight join.
  let voiceJoinGeneration = 0;

  // SFU client activation must be negotiated, never inferred from the mere
  // presence of a browser library. Self-hosters may intentionally omit the
  // optional mediasoup server dependency; in that case P2P remains the live
  // path instead of timing out on unregistered `sfu:*` events. This handler is
  // registered unconditionally because the capability question itself must be
  // answerable even when SFU handlers are absent.
  socket.on('voice:get-capabilities', isolateSocketHandler(socket, 'voice:get-capabilities', () => {
    socket.emit('voice:capabilities', { p2p: true, sfu: capabilities.sfuReady === true });
  }));
/**
 * FAZ G6 — SES KANALINA KATILIM YETKISI (kanonik, fail-closed).
 *
 * BULUNAN KUSUR: `voice:join` HICBIR yetki denetimi yapmiyordu. Payload'daki
 * `channelId`/`serverId` dogrudan kullaniliyordu. Sonuc:
 *   · herhangi bir kimligi dogrulanmis kullanici, UYESI OLMADIGI sunucudaki
 *     herhangi bir ses kanalina katilabiliyordu;
 *   · `voice:existing-peers` ile KATILIMCI LISTESINI (userId, displayName)
 *     aliyordu;
 *   · peer listesine eklenip WebRTC sinyallesmesine baslayabiliyordu — yani
 *     gorusmeye FIILEN girebiliyordu.
 *
 * `serverId` payload'dan GELIR ve oda adi olarak kullanilir; bu yuzden
 * kanalin GERCEK `serverId`si ile eslesmesi ayrica dogrulanir — aksi hâlde
 * saldirgan yayini baska bir sunucunun odasina yonlendirebilirdi.
 */
async function mayJoinVoice(userId: string, channelId: string, claimedServerId: string): Promise<boolean> {
  if (!channelId || typeof channelId !== 'string') return false;
  const channel = await Channels.findById(channelId).catch(() => null);
  if (!channel) return false;
  // Istemcinin bildirdigi serverId, kanalin GERCEK sunucusu olmalidir.
  if (String(channel.serverId) !== String(claimedServerId)) return false;
  if (!await Members.findOne(userId, String(channel.serverId)).catch(() => null)) return false;
  const perms = await resolvePermissions(userId, String(channel.serverId), channelId).catch(() => 0);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS)) return false;
  return hasPermission(perms, PERMS.CONNECT);
}

/**
 * FAZ G6 — SINYAL HEDEFI AYNI SES ODASINDA OLMALIDIR.
 *
 * `webrtc:offer/answer/ice` payload'daki `targetSocketId`ye KOSULSUZ
 * iletiliyordu. Yani bir kullanici, hicbir odada olmasa bile herhangi bir
 * sokete SDP/ICE enjekte edebiliyordu (capraz-oda sinyallesmesi).
 *
 * Kural: hem GONDEREN hem HEDEF, gonderenin GERCEK mevcut ses odasinda
 * bulunmalidir. Oda kimligi payload'dan degil soketin durumundan alinir.
 */
async function signalAllowed(socket: { id: string; currentVoiceChannel?: string }, targetSocketId: unknown): Promise<string | null> {
  const room = socket.currentVoiceChannel;
  if (!room || typeof targetSocketId !== 'string' || !targetSocketId) return null;
  // Oda uyeligi ALAN GERCEGIDIR: Socket.IO ic yapilarini ( io.sockets.sockets )
  // yoklamak yerine, sesin kendi peer listesi kullanilir. Hem daha saglam hem
  // de tek dogruluk kaynagi.
  const peers = await _loadRoom(room).catch(() => [] as VoicePeer[]);
  const senderIn = peers.some(p => p.socketId === socket.id);
  const targetIn = peers.some(p => p.socketId === targetSocketId);
  if (!senderIn || !targetIn) return null;
  return targetSocketId;
}

  socket.on('voice:join', isolateSocketHandler(socket, 'voice:join', (payload: { channelId: string; serverId: string; requestId?: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.voiceJoin).valid) return;
    const { channelId, serverId, requestId } = payload;
    const generation = ++voiceJoinGeneration;
    return (async () => {
      // Authorize the destination before disturbing an already-valid current room.
      // Rejection is explicit so the client never keeps a microphone/UI state
      // that the server did not actually admit into the room. The same safe
      // response covers missing/inaccessible channels to avoid an oracle.
      if (!await mayJoinVoice(user._id, channelId, serverId)) {
        socket.emit('voice:join-rejected', { channelId, requestId, code: 'FORBIDDEN' });
        return;
      }
      if (generation !== voiceJoinGeneration) return;

      const previousChannel = socket.currentVoiceChannel;
      const previousServer = socket.currentVoiceServer ?? undefined;
      if (previousChannel && previousChannel !== channelId) {
        await leaveVoice(socket, previousChannel, previousServer, io);
        if (generation !== voiceJoinGeneration) return;
      }

      const peerInfo: VoicePeer = {
        socketId: socket.id, userId: user._id, displayName: user.displayName, avatarColor: user.avatarColor,
      };
      const mutation = await _mutateRoom(channelId, async (peers) => {
        if (generation !== voiceJoinGeneration) return { status: 'stale' as const, peers, existing: peers };
        if (peers.some(p => p.socketId === socket.id)) {
          return { status: 'already' as const, peers, existing: peers.filter(p => p.socketId !== socket.id) };
        }
        if (peers.length >= MAX_VOICE_PEERS) return { status: 'full' as const, peers, existing: peers };
        const nextPeers = [...peers, peerInfo];
        await _saveRoom(channelId, nextPeers);
        return { status: 'joined' as const, peers: nextPeers, existing: peers };
      });

      if (mutation.status === 'stale') return;
      if (mutation.status === 'full') {
        // Keep the legacy event for old clients, but new clients use the
        // request-correlated rejection as the authoritative mutation result.
        socket.emit('voice:full', { channelId, max: MAX_VOICE_PEERS, requestId });
        socket.emit('voice:join-rejected', { channelId, requestId, code: 'FULL', max: MAX_VOICE_PEERS });
        return;
      }

      const nextPeers = mutation.peers;

      // A leave/newer join may have happened while the distributed mutation
      // completed. Remove the stale insertion under the same room lock.
      if (generation !== voiceJoinGeneration) {
        await _mutateRoom(channelId, async (current) => {
          const next = current.filter(p => p.socketId !== socket.id);
          await _saveRoom(channelId, next);
        });
        return;
      }

      socket.currentVoiceChannel = channelId;
      socket.currentVoiceServer = serverId;
      socket.join(`voice:${channelId}`);

      // Publish authoritative admission BEFORE asking this client to create
      // offers. Previously `voice:existing-peers` was emitted while
      // `currentVoiceChannel` was still null, so the first offers could be
      // rejected by `signalAllowed()` even though room persistence succeeded.
      socket.emit('voice:joined', { channelId, requestId, max: MAX_VOICE_PEERS });
      socket.emit('voice:existing-peers', mutation.existing.map(p => ({
        socketId: p.socketId, userId: p.userId, displayName: p.displayName, avatarColor: p.avatarColor,
      })));
      if (mutation.status === 'joined') {
        socket.to(`voice:${channelId}`).emit('voice:peer-joined', peerInfo);
        io.to([`voice:${channelId}`, `channel:${channelId}`]).emit('voice:room-update', { channelId, peers: nextPeers });
      }

      const q = await readMusicQueue(channelId);
      if (q.current) socket.emit('music:play', { channelId, track: q.current });
    })();
  }));

  socket.on('voice:leave', isolateSocketHandler(socket, 'voice:leave', (payload: { channelId: string; serverId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.voiceJoin).valid) return;
    ++voiceJoinGeneration;

    // ── CAPRAZ KIRACI SIZINTISI KAPATILDI ────────────────────────────────
    // Burasi istemcinin bildirdigi `channelId` ve `serverId` degerlerine
    // KOSULSUZ guveniyordu. `voice:join` ayni sinif icin `mayJoinVoice` ile
    // korunuyordu (kanalin GERCEK sunucusu iddia edilenle eslesmeli), ama
    // kardes yol olan `leave` bu denetimden yoksun kalmisti.
    //
    // SOMURU: saldirgan, uyesi OLMADIGI bir sunucudaki ses kanalinin
    // kimligini ve KENDI sunucusunun kimligini gonderiyordu. `leaveVoice`
    // kurban kanalinin gercek katilimci listesini yukluyor ve sonucu
    // saldirganin kendi sunucu odasina yayinliyordu:
    //
    //     io.to('server:<saldirgan>').emit('voice:room-update',
    //       { channelId: <kurban>, peers: <GERCEK KATILIMCILAR> })
    //
    // Saldirgan o odanin uyesi oldugu icin baska bir sunucudaki ses
    // kanalinin userId/displayName listesini aliyordu.
    //
    // DOGRU KAYNAK: soketin KENDI sunucu tarafi durumu. Bir kullanici
    // yalnizca GERCEKTEN icinde oldugu odadan ayrilabilir. Baglanti kopmasi
    // yolu (`infra.ts`) zaten bu guvenilir durumu kullaniyordu.
    const channelId = socket.currentVoiceChannel;
    if (!channelId) return;                    // hicbir odada degil — no-op
    return leaveVoice(socket, channelId, socket.currentVoiceServer ?? undefined, io);
  }));

  socket.on('webrtc:offer', isolateSocketHandler(socket, 'webrtc:offer', (payload: { targetSocketId: string; offer: unknown; channelId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.webrtcSignal).valid) return;
    return (async () => {
      const t = await signalAllowed(socket as never, payload.targetSocketId);
      if (!t) return;
      io.to(t).emit('webrtc:offer', { fromSocketId: socket.id, offer: payload.offer, channelId: socket.currentVoiceChannel });
    })();
  }));
  socket.on('webrtc:answer', isolateSocketHandler(socket, 'webrtc:answer', (payload: { targetSocketId: string; answer: unknown }) => {
    if (!validateSocketPayload(payload, socketSchemas.webrtcSignal).valid) return;
    return (async () => {
      const t = await signalAllowed(socket as never, payload.targetSocketId);
      if (!t) return;
      io.to(t).emit('webrtc:answer', { fromSocketId: socket.id, answer: payload.answer });
    })();
  }));
  socket.on('webrtc:ice-candidate', isolateSocketHandler(socket, 'webrtc:ice-candidate', (payload: { targetSocketId: string; candidate: unknown }) => {
    if (!validateSocketPayload(payload, socketSchemas.webrtcSignal).valid) return;
    return (async () => {
      const t = await signalAllowed(socket as never, payload.targetSocketId);
      if (!t) return;
      io.to(t).emit('webrtc:ice-candidate', { fromSocketId: socket.id, candidate: payload.candidate });
    })();
  }));

  socket.on('voice:state-update', isolateSocketHandler(socket, 'voice:state-update', (payload: { channelId: string; muted: boolean; deafened: boolean; screensharing: boolean; video: boolean }) => {
    if (!validateSocketPayload(payload, socketSchemas.voiceStateUpdate).valid) return;
    const { muted, deafened, screensharing, video } = payload;
    // FAZ G6 — oda payload'dan ALINMAZ: kullanici yalniz GERCEKTEN icinde
    // oldugu odaya durum yayabilir. Aksi halde hic katilmadigi bir odaya
    // sahte mute/screenshare durumu enjekte edilebilirdi.
    const channelId = socket.currentVoiceChannel;
    if (!channelId) return;
    socket.to(`voice:${channelId}`).emit('voice:peer-state', { socketId: socket.id, userId: user._id, muted, deafened, screensharing, video });
  }));

  socket.on('voice:activity', isolateSocketHandler(socket, 'voice:activity', (payload: { channelId: string; speaking: boolean }) => {
    if (!validateSocketPayload(payload, socketSchemas.voiceActivity).valid) return;
    const room = socket.currentVoiceChannel;
    if (!room) return;   // FAZ G6 — yalniz gercek odaya konusma sinyali
    socket.to(`voice:${room}`).emit('voice:activity', { socketId: socket.id, userId: user._id, speaking: payload.speaking });
  }));

  // ── Voice E2E key exchange ─────────────────────────────────
  socket.on('voice:e2e-key', isolateSocketHandler(socket, 'voice:e2e-key', (payload: { channelId: string; targetUserId: string; encryptedKey: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.voiceE2eKey).valid) return;
    const { channelId, targetUserId, encryptedKey } = payload;
    return (async () => {
      // FAZ G6 — GONDEREN de odada olmalidir; aksi halde disaridan anahtar
      // enjekte edilebilirdi.
      if (socket.currentVoiceChannel !== channelId) return;
      const room   = await _loadRoom(channelId);
      if (!room.some(p => p.socketId === socket.id)) return;
      const target = room.find(p => p.userId === targetUserId);
      if (target?.socketId) {
        io.to(target.socketId).emit('voice:e2e-key', { fromUserId: user._id, encryptedKey });
      }
    })();
  }));
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

// ── TEST ERISIMCILERI ───────────────────────────────────────────────────────
// Oda durumu Redis/bellek arkasindadir; testler onu dogrudan kuramaz.
// Bunlar YALNIZCA test icindir ve urun yolunda kullanilmaz.
export async function __setVoiceRoomForTest(channelId: string, peers: VoicePeer[]): Promise<void> {
  await _saveRoom(channelId, peers);
}
export async function __getVoiceRoomForTest(channelId: string): Promise<VoicePeer[]> {
  return _loadRoom(channelId);
}

/**
 * KANONİK AKTİF SESLİ ODA SAYISI (metrik için).
 *
 * ── KAPATILAN GERÇEK KUSUR (Final21, Faz 6 — F21-6-01) ───────────────────────
 * `bridge_voice_rooms` göstergesi `Object.keys(voiceRooms).length` okuyordu.
 * `voiceRooms` ise yalnızca `_fallback` haritasını saran bir Proxy'dir ve
 * `_saveRoom` içindeki şu satır yüzünden REDIS YAPILANDIRILDIĞINDA O HARİTAYA
 * HİÇ YAZILMAZ:
 *
 *     if (isRedisAvailable()) { ...redis'e yaz...; return; }   // <- erken donus
 *     if (process.env.REDIS_URL) throw ...
 *     _fallback.set(channelId, peers);                          // sadece redis YOKKEN
 *
 * Sonuç: tek düğümlü geliştirmede (REDIS_URL yok) gösterge DOĞRU çalışıyor,
 * ama çok düğümlü her ÜRETİM kurulumunda SONSUZA DEK 0 okuyordu. ÖLÇÜLDÜ:
 * bir akran odadayken Redis'te `bridge:cache:voice:room:<id>` anahtarı VARDI,
 * `bridge_voice_rooms` ise 0 diyordu.
 *
 * Bedeli: sesli kapasite üretim panolarında GÖRÜNMEZ; oda sayısına dayanan
 * hiçbir alarm ASLA ateşlenmez; SFU aşırı yüklenmesi fark edilmez. "Yerelde
 * çalışıyor, üretimde bozuk" sınıfının tam örneği.
 *
 * ── MALİYET ─────────────────────────────────────────────────────────────────
 * Kazıma başına sınırsız iş yapılmaz: sonuç KISA SÜRELİ önbelleklenir, yani
 * kazıma aralığı ne olursa olsun Redis'e en fazla ROOM_COUNT_TTL_MS'de bir
 * SCAN gider. `KEYS` kullanılmaz (Redis'i bloklardı).
 */
const ROOM_COUNT_TTL_MS = 10_000;
let _roomCount = { value: 0, at: 0 };

export async function getVoiceRoomCount(): Promise<number> {
  if (!isRedisAvailable()) {
    // Otorite yapılandırılmış ama şu an yoksa UYDURMA sayı verilmez:
    // son bilinen değer döner (metrik "0" diye yalan söylemez).
    if (process.env.REDIS_URL) return _roomCount.value;
    return _fallback.size;
  }
  const now = Date.now();
  if (now - _roomCount.at < ROOM_COUNT_TTL_MS) return _roomCount.value;
  try {
    const value = await cache.countKeys('voice:room:*');
    _roomCount = { value, at: now };
    return value;
  } catch {
    return _roomCount.value;
  }
}

/** Canonical read path for REST/other modules; consults Redis first, fallback second. */
export async function getVoiceRoomPeers(channelId: string): Promise<VoicePeer[]> {
  return _loadRoom(channelId);
}

export { registerVoiceHandlers, leaveVoice, voiceRooms, voiceActivity };
