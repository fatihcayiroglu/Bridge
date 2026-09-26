// server/socket/handlers/infra.ts
// Altyapı socket event'leri:
//   typing, status, notif:pref, friend, server/channel yönetimi,
//   polls, soundboard, bot modals, member nicknames, disconnect

import type { HandlerSocket, HandlerServer } from '../handler-contracts';
import logger from '../../lib/logger';
import { Users, Members, Notifications, Channels, ServerAssets, Social } from '../../db/repositories';
import { pushMemberCount } from './discover';
import {
  getMembershipsCached,
  invalidateMemberships,
  markOnline,
  markOffline,
  isPresenceVisible,
  releaseSocket,
  throttleStatusWrite,
} from '../../lib/presenceCache';

import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
import type { SafeUser } from '../../lib/userUtils';
import { resolvePermissions, hasPermission, PERMS } from '../../lib/permissions';
import { isolateSocketHandler } from '../handlerIsolation';
import { findBuiltinSoundboardSound } from '../../lib/soundboardCatalog';
import { isMemberTimedOut } from '../../lib/memberTimeout';


interface InfraHandlerOptions {
  socketUsers:       Map<string, SafeUser>;
  typingTimers:      Map<string, ReturnType<typeof setTimeout>>;
  TYPING_TIMEOUT_MS: number;
  _socketRateStore:  Map<string, number[]>;
  leaveVoice:        (socket: HandlerSocket, channelId: string, serverId: string | undefined, io: HandlerServer) => Promise<void>;
  voiceActivity:     Map<string, number>;
  refreshMemberships:(userId: string) => Promise<void>;
  safeUser:          SafeUser;
}

// Testler bu secenek nesnesini KURMAK zorunda oldugu icin disa acilir:
// `export` olmadan test ikizi `Map<any, any>` cikarimina dusuyor ve denetim
// tamamen kayboluyordu. Tip disa acilinca ikiz URUN sozlesmesine uymak
// zorunda kalir.
export interface DisconnectOptions {
  socketUsers:     Map<string, SafeUser>;
  typingTimers:    Map<string, ReturnType<typeof setTimeout>>;
  _socketRateStore:Map<string, number[]>;
  leaveVoice:      (socket: HandlerSocket, channelId: string, serverId: string | undefined, io: HandlerServer) => Promise<void>;
  voiceActivity:   Map<string, number>;
  tokenCheckTimer: ReturnType<typeof setInterval>;
  tokenExpiryTimer: ReturnType<typeof setTimeout> | null;
  io:              HandlerServer;
}


/**
 * Tüm altyapı olaylarını kaydeder.
 * @param {object} socket         — rate-limited socket proxy
 * @param {object} rawSocket      — ham Socket.IO socket (room join/leave için)
 * @param {object} io             — Socket.IO server instance
 * @param {object} user           — kimliği doğrulanmış kullanıcı
 * @param {Map}    socketUsers    — socketId → sanitizedUser
 * @param {Map}    typingTimers   — channelId:userId → timeout handle
 * @param {number} TYPING_TIMEOUT_MS
 * @param {Map}    _socketRateStore
 * @param {Function} leaveVoice
 * @param {object} voiceActivity
 * @param {Function} refreshMemberships
 * @param {object} safeUser       — sanitize edilmiş user
 */
function registerInfraHandlers(
  socket: HandlerSocket,
  rawSocket: HandlerSocket,
  io: HandlerServer,
  user: SafeUser & { _id: string },
  { socketUsers: _socketUsers, typingTimers, TYPING_TIMEOUT_MS, _socketRateStore, leaveVoice: _leaveVoice, voiceActivity: _voiceActivity, refreshMemberships, safeUser }: InfraHandlerOptions,
): void {

  // ── TYPING INDICATORS ─────────────────────────────────────────
  // FIX: channelId artık socket room üyeliğiyle doğrulanıyor.
  // Kullanıcı o kanala join olmamışsa (channel:join event'i gelmediyse) typing
  // event'i yayılmaz. Bu, herhangi bir authenticated kullanıcının rastgele
  // bir channelId ile typing broadcast yapmasını engelliyor.
  //
  // ════════════════════════════════════════════════════════════════════════
  // TEK SAHİP (Final21 Faz 16)
  // ════════════════════════════════════════════════════════════════════════
  // `typing:start` için İKİ ayrı handler kayıtlıydı: burası `typing:start`/
  // `typing:stop` yayıyordu, `messages-send.ts` ise `typing:update`. İstemci
  // (MessageLoader.svelte) YALNIZCA `typing:update` dinler — yani buradaki
  // yayın hiçbir alıcıya ulaşmıyordu; her tuş olayında kanal odasına İKİ kat
  // trafik gidiyordu ve otomatik süre aşımı ("stop kaybolursa") kimseye
  // ulaşmadığı için ölü bir emniyetti.
  //
  // Bakım tuzağı teoride değil PRATİKTE ısırdı: Faz 15'te görünen ad
  // düzeltmesi yalnızca `messages-send.ts`ye girdi; buradaki yayın hâlâ
  // `displayName` alanını yedeksiz gönderiyordu.
  //
  // Sahiplik burada toplandı — şema doğrulaması, oda denetimi, zamanlayıcılar
  // ve `activeTyping` istatistiği zaten burada. Yayılan olay artık istemcinin
  // GERÇEKTEN dinlediği `typing:update`; süre aşımı da onun `typing:false`
  // biçimi, yani emniyet artık çalışıyor.
  const emitTyping = (channelId: string, typing: boolean): void => {
    rawSocket.to(`channel:${channelId}`).emit('typing:update', {
      channelId,
      userId: user._id,
      username: user.username,
      displayName: user.displayName || user.username,
      avatarColor: user.avatarColor,
      typing,
    });
  };

  socket.on('typing:start', isolateSocketHandler(socket, 'typing:start', (payload: { channelId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.typingChannel).valid) return;
    const { channelId } = payload;
    // Kanal üyelik kontrolü: rawSocket ancak channel:join sonrası ilgili room'a girer.
    if (!rawSocket.rooms.has(`channel:${channelId}`)) return;
    const key = `${channelId}:${user._id}`;
    const existing = typingTimers.get(key);
    if (existing) clearTimeout(existing);
    emitTyping(channelId, true);
    const timer = setTimeout(() => {
      typingTimers.delete(key);
      emitTyping(channelId, false);
    }, TYPING_TIMEOUT_MS);
    typingTimers.set(key, timer);
  }));

  socket.on('typing:stop', isolateSocketHandler(socket, 'typing:stop', (payload: { channelId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.typingChannel).valid) return;
    const { channelId } = payload;
    // Üye olunmayan kanallar için stop event'i de görmezden gel.
    if (!rawSocket.rooms.has(`channel:${channelId}`)) return;
    const key = `${channelId}:${user._id}`;
    const timer = typingTimers.get(key);
    if (timer) { clearTimeout(timer); typingTimers.delete(key); }
    emitTyping(channelId, false);
  }));

  // ── STATUS ────────────────────────────────────────────────────
  type StatusAck = (result: { ok: boolean; status?: 'online' | 'idle' | 'dnd' | 'offline'; code?: string }) => void;
  socket.on('status:update', isolateSocketHandler(socket, 'status:update', async (
    payload: { status: string; statusText?: string; statusEmoji?: string }, ack?: StatusAck,
  ) => {
    if (!validateSocketPayload(payload, socketSchemas.statusUpdate).valid) { ack?.({ ok: false, code: 'INVALID_STATUS' }); return; }
    const { status, statusText, statusEmoji } = payload;
    const allowed = ['online', 'idle', 'dnd', 'offline'] as const;
    if (!allowed.includes(status as typeof allowed[number])) { ack?.({ ok: false, code: 'INVALID_STATUS' }); return; }
    try {
      // Kullanıcının kalıcı görünürlük tercihi, istemcinin göndereceği bir
      // `online` değeriyle aşılamaz. Sunucu her broadcast'te yeniden uygular.
      const presenceVisible = await isPresenceVisible(user._id);
      const preferredStatus = status as typeof allowed[number];
      const effectiveStatus = presenceVisible ? preferredStatus : 'offline';
      // Preference and effective live state are distinct. Persist both in the
      // same authoritative write so reconnect cannot erase idle/DND/manual-offline.
      //
      // The redundant-write throttle is applied over the WHOLE persisted tuple,
      // not just `status`. Clients emit status:update on every focus/blur/idle
      // transition, so an unthrottled handler wrote the same row to PostgreSQL
      // on every one of them; keying only on `status` (the old behaviour) would
      // instead have swallowed a custom status text/emoji change made while the
      // status itself stayed `online`. Presence broadcast and online/offline
      // bookkeeping below stay unconditional — only the redundant row write is
      // skipped. `throttleStatusWrite` fails open (writes) on cache errors.
      const writeToken = [preferredStatus, effectiveStatus, statusText || '', statusEmoji || ''].join('|');
      if (await throttleStatusWrite(user._id, writeToken)) {
        await Users.update(user._id, {
          presenceStatus: preferredStatus,
          status: effectiveStatus,
          statusText: statusText || '',
          statusEmoji: statusEmoji || '',
        });
      }

      const current = await getMembershipsCached(user._id, () => Members.findByUser(user._id));
      const statusPayload = { userId: user._id, status: effectiveStatus, statusText: statusText || '', statusEmoji: statusEmoji || '' };
      // NOT (Final21 Faz 16): burada oda BAŞINA ayrı yayın yapılıyor; ortak
      // sunucusu olan alıcı aynı olayın birden çok kopyasını alır. Tek yayına
      // çevirmek için `HandlerServer.to()` imzasının oda listesi kabul etmesi
      // gerekir; denendi ve ikiz/okuyucu sözleşmelerine 170+ katı tip hatası
      // olarak yayıldığı için BİLEREK geri alındı. Ölçülen asıl yol — bağlantı
      // anında 8 kopya — gerçek Socket.IO tipleriyle çalışan socket/index.ts'te
      // düzeltildi. Burada kalan kopya, durum DEĞİŞİKLİĞİNDE oluşur.
      for (const m of current) io.to(`server:${m.serverId}`).emit('user:status', statusPayload);

      if (effectiveStatus !== 'offline') await markOnline(user._id);
      else await markOffline(user._id);
      ack?.({ ok: true, status: effectiveStatus });
    } catch (e) {
      logger.warn({ userId: user._id, event: 'socket.status_update.error', err: (e as Error).message },
        'status:update işlemi başarısız.');
      ack?.({ ok: false, code: 'STATUS_UPDATE_FAILED' });
    }
  }));
  socket.on('notif:pref', isolateSocketHandler(socket, 'notif:pref', async (payload: { channelId: string; level: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.notifPref).valid) return;
    const { channelId, level } = payload;
    const allowed = ['all', 'mentions', 'mute'];
    if (!allowed.includes(level)) return;
    try {
      const channel = await Channels.findById(channelId);
      if (!channel) return;
      const perms = await resolvePermissions(user._id, String(channel.serverId), channelId).catch(() => 0);
      if (!hasPermission(perms, PERMS.VIEW_CHANNELS)) return;
      await Notifications.upsertPref(user._id, channelId, { level, muteUntil: null, updatedAt: Date.now() });
      rawSocket.emit('notif:pref:updated', { channelId, level });
    } catch (e) {
      logger.warn({ userId: user._id, channelId, event: 'socket.notif_pref.error', err: (e as Error).message },
        'notif:pref kaydedilemedi.');
    }
  }));
  socket.on('friend:request:notify', isolateSocketHandler(socket, 'friend:request:notify', async (payload: { toUserId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.friendRequestNotify).valid) return;
    const { toUserId } = payload;
    // Client notification is only a delivery hint. Authoritative state must
    // already contain THIS user's pending request to the target.
    const friendship = await Social.findFriendship(user._id, toUserId).catch(() => null);
    if (!friendship || friendship.status !== 'pending' ||
        String(friendship.userId) !== user._id || String(friendship.friendId) !== toUserId) return;
    io.to(`user:${toUserId}`).emit('friend:request:received', { from: safeUser });
  }));

  // ── SERVER MEMBERSHIP ─────────────────────────────────────────
  socket.on('server:joined', isolateSocketHandler(socket, 'server:joined', async (payload: { serverId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.serverIdPayload).valid) return;
    const { serverId } = payload;
    // Client cannot subscribe itself to an arbitrary tenant room. The REST
    // membership write must already be visible before the socket joins it.
    const membership = await Members.findOne(user._id, serverId).catch(() => null);
    if (!membership) return;
    rawSocket.join(`server:${serverId}`);
    // Üyelik değişti — cache'i geçersiz kıl
    await invalidateMemberships(user._id);
    await refreshMemberships(user._id);
    // Keşif sayfasındaki üye sayısını güncelle
    pushMemberCount(io, serverId).catch(() => {});
  }));
  socket.on('server:left', isolateSocketHandler(socket, 'server:left', async (payload: { serverId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.serverIdPayload).valid) return;
    const { serverId } = payload;
    rawSocket.leave(`server:${serverId}`);
    await invalidateMemberships(user._id);
    // Keşif sayfasındaki üye sayısını güncelle
    pushMemberCount(io, serverId).catch(() => {});
  }));

  // ── KANAL/KATEGORI/ANKET YAYIN ROLELERI — KALDIRILDI ──────────────────────
  //
  // ════════════════════════════════════════════════════════════════════════
  // KAPATILAN GERCEK ACIK (CANLI SUNUCUDA DOGRULANDI)
  // ════════════════════════════════════════════════════════════════════════
  // Burada su bicimde alti olay dinleniyordu:
  //
  //     socket.on('channel:deleted', ({ serverId, channelId }) =>
  //       io.to(`server:${serverId}`).emit('channel:deleted', { channelId }));
  //
  // Yetki denetimi YOK, uyelik denetimi YOK, sema dogrulamasi YOK. Hem hedef
  // `serverId` hem de icerik TAMAMEN istemci kontrolundeydi. Yani kimligi
  // dogrulanmis HERHANGI bir kullanici, UYESI OLMADIGI bir sunucunun
  // odasina istedigi olayi yayinlayabiliyordu.
  //
  // CANLI SOMURU (e2e/_relay-spoof.cjs) — uye OLMAYAN bir kullanici:
  //   • `channel:deleted` ile gercek kanali TUM uyelerin arayuzunden sildi
  //   • `channel:updated` ile gercek kanalin adini degistirdi
  //   • `channel:created` / `category:created` ile sahte ogeler enjekte etti
  // Kurban sunucusundaki her uye bu sahte olaylari aldi.
  //
  // ── NEDEN SILINDI, YETKILENDIRILMEDI ────────────────────────────────────
  // Olculdu (e2e/_relay-legit.cjs): GERCEK kanal olusturma/silme islemleri
  // bu olaylardan HICBIRINI uretmiyordu (0 olay). Istemci de bunlari
  // yaymiyor — `ChannelListManager.svelte` bunlari acikca "legacy" olarak
  // isaretliyor. Yani role, mesru bir ureticisi olmayan SAF SALDIRI
  // YUZEYIYDI.
  //
  // Kanonik yayin artik YETKILI REST rotalarindan sunucu tarafinda yapilir
  // (routes/servers/channels.ts). Boylece kaynak, islemi gerceklestirme
  // yetkisi zaten dogrulanmis olan koddur.
  //
  // `validate.ts` icindeki `channelBroadcast` semasi da bu rolelere hic
  // baglanmamisti; artik gereksizdir.

  // ── SOUNDBOARD ────────────────────────────────────────────────
  socket.on('soundboard:play', isolateSocketHandler(socket, 'soundboard:play', async (payload: { channelId: string; soundId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.soundboardPlay).valid) return;
    const { channelId, soundId } = payload;
    // Voice room membership is authoritative. A client may not broadcast into
    // another channel merely by naming its id.
    if (rawSocket.currentVoiceChannel !== channelId || !rawSocket.rooms.has(`voice:${channelId}`)) return;
    const channel = await Channels.findById(channelId).catch(() => null);
    if (!channel || !['voice', 'stage'].includes(String(channel.type ?? ''))) return;
    // ── SES YAYMAK KONUŞMAKTIR ────────────────────────────────────────────
    // Soundboard, kanaldaki HERKESE duyulabilir ses üretir. Bu yüzden mikrofon
    // üreticisiyle (mediasoup `requireSpeak`) AYNI yetki sınırına tabidir:
    // SPEAK açıkça reddedilmiş bir üye, soundboard üzerinden o reddi
    // aşamamalıdır. Aksi hâlde "seste konuşma yetkisi yok" ayarı, tek tıkla
    // atlanabilen kozmetik bir kısıt olurdu.
    //
    // Zaman aşımına (timeout) alınmış üye de aynı nedenle susturulur: moderasyon
    // yaptırımı yalnızca metin mesajlarını değil, üyenin ürettiği HER kanal
    // sesini kapsamalıdır.
    const membership = await Members.findOne(user._id, String(channel.serverId)).catch(() => null);
    if (!membership || isMemberTimedOut((membership as { timeoutUntil?: unknown }).timeoutUntil)) return;
    const perms = await resolvePermissions(user._id, String(channel.serverId), channelId).catch(() => 0);
    if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.CONNECT)) return;
    if (!hasPermission(perms, PERMS.SPEAK)) return;
    const builtin = findBuiltinSoundboardSound(soundId);
    const sound = builtin ?? await ServerAssets.findSoundByIdAndServer(soundId, String(channel.serverId)).catch(() => null);
    if (!sound) return;
    if (!builtin && !/^\/uploads\/soundboard\/[A-Za-z0-9._-]{1,200}$/.test(String(sound.url ?? ''))) return;
    try {
      await ServerAssets.recordSoundPlay(soundId, user._id, builtin ? null : String(channel.serverId));
    } catch (error) {
      // Playback stays available during an analytics-state incident, but the
      // persistence failure is never hidden from operators.
      logger.warn({ err: error, soundId, userId: user._id }, '[Soundboard] play tracking failed');
    }
    rawSocket.to(`voice:${channelId}`).emit('soundboard:play', {
      channelId,
      soundId: sound._id,
      soundUrl: sound.url,
      soundName: sound.name,
      emoji: sound.emoji,
      scope: builtin ? 'global' : 'server',
      playedBy: {
        id: user._id,
        username: user.username,
        displayName: user.displayName ?? user.username,
        avatarColor: user.avatarColor ?? null,
        avatarUrl: user.avatarUrl ?? null,
      },
    });
  }));

  // Bot modals are emitted only by the authoritative interaction route.
  // A client-controlled userId/modal relay would allow authenticated users to
  // inject UI into another user's session, so no inbound socket handler exists.

  // Member nickname broadcasts are server-authoritative from the REST route.
  // No client relay is registered here.
}

/**
 * Disconnect temizlik işlemleri — token timer dahil.
 * socket/index.js'deki disconnect handler'ında çağrılır.
 */
async function handleDisconnect(
  rawSocket: HandlerSocket,
  user: SafeUser & { _id: string },
  { socketUsers, typingTimers, _socketRateStore, leaveVoice, voiceActivity, tokenCheckTimer, tokenExpiryTimer, io }: DisconnectOptions,
): Promise<void> {
  // 0. Token check timer'ı temizle
  clearInterval(tokenCheckTimer);
  if (tokenExpiryTimer) clearTimeout(tokenExpiryTimer);
  socketUsers.delete(rawSocket.id);

  // 1. Tüm room'lardan çık
  for (const room of [...rawSocket.rooms]) {
    if (room !== rawSocket.id) rawSocket.leave(room);
  }

  // 2. Typing timer'ları temizle
  for (const [key, timer] of typingTimers) {
    if (key.endsWith(`:${user._id}`)) { clearTimeout(timer); typingTimers.delete(key); }
  }

  // 3. Rate limit kayıtlarını serbest bırak
  const userPrefix = `${user._id}:`;
  for (const key of _socketRateStore.keys()) {
    if (key.startsWith(userPrefix)) _socketRateStore.delete(key);
  }

  // 4. Ses kanalından çık
  if (rawSocket.currentVoiceChannel) await leaveVoice(rawSocket, rawSocket.currentVoiceChannel, rawSocket.currentVoiceServer ?? undefined, io);
  voiceActivity.delete(rawSocket.id);

  // 5. Multi-tab: başka bağlantı yoksa offline yap
  // releaseSocket, presenceCache'deki socket map'ini günceller ve son socket
  // kapanınca Redis'e markOffline + cluster pub/sub bildirimi gönderir.
  const remainingSockets = await releaseSocket(user._id, rawSocket.id);
  const stillConnected   = remainingSockets > 0
    // Fallback: presenceCache'de socket yoksa socketUsers Map'ten kontrol et
    || [...socketUsers.values()].some(u => (u._id || u.id) === user._id);

  if (!stillConnected) {
    try { await Users.update(user._id, { status: 'offline' }); } catch (e) {
      logger.warn({ userId: user._id, event: 'socket.disconnect.offline_update_error', err: (e as Error).message },
        'Offline durum güncellenemedi.');
    }
    // markOffline artık releaseSocket() içinde çağrılıyor; burada tekrar çağrılmaz
    const current = await getMembershipsCached(user._id, () => Members.findByUser(user._id).catch(() => []));
    for (const m of current) io.to(`server:${m.serverId}`).emit('user:status', { userId: user._id, status: 'offline' });
  }
}

export { registerInfraHandlers, handleDisconnect };
