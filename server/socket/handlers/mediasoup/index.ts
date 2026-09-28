// server/socket/handlers/mediasoup/index.ts
// Socket handler kaydı — tüm SFU event'lerini bağlar
//
// Bölünme (Sprint 44):
//   types.ts   — tip tanımları
//   config.ts  — env-driven yapılandırma
//   workers.ts — worker havuzu başlatma & yönetim
//   rooms.ts   — room/peer CRUD, transport factory, cleanup
//   index.ts   — socket handler kaydı (bu dosya)

import * as sfuRegistry from '../../../lib/sfuRegistry';
import { getRtcIceConfig } from '../../../lib/turnConfig';
import { sfuRooms, sfuPeers, getOrCreateRoom, createWebRtcTransport, getRoomPeerList, cleanupPeer, RoomOwnedElsewhereError } from './rooms';
import type { BridgeSocket, BridgeIO, BridgeUser, SfuPeer, RtpCapabilities, DtlsParameters, RtpParameters } from './types';
// Sprint 120: A3 — Merkezi simulcast encoding config'den import
import { SIMULCAST_ENCODINGS, SCREENSHARE_ENCODINGS } from './config';
// Sprint 122 FIX 3: Kanal üyelik kontrolü için Members repository
import { Channels, GroupDms, Members } from '../../../db/repositories';
import { PERMS, hasPermission, resolvePermissions } from '../../../lib/permissions';

import logger from '../../../lib/logger';
import { isolateSocketHandler } from '../../handlerIsolation';
import { isMemberTimedOut } from '../../../lib/memberTimeout';
import { isStageParticipant, isStageSpeaker } from '../stage';

export { initMediasoup, isSFUReady } from './workers';
export { sfuRooms, sfuPeers, cleanupRoom } from './rooms';

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128;
}

function isBoundedRtpObject(value: unknown, requireCodecs = false): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rtp = value as { codecs?: unknown; encodings?: unknown; headerExtensions?: unknown };
  if (requireCodecs && !Array.isArray(rtp.codecs)) return false;
  if (rtp.codecs !== undefined && (!Array.isArray(rtp.codecs) || rtp.codecs.length > 32)) return false;
  if (rtp.encodings !== undefined && (!Array.isArray(rtp.encodings) || rtp.encodings.length > 8)) return false;
  if (rtp.headerExtensions !== undefined && (!Array.isArray(rtp.headerExtensions) || rtp.headerExtensions.length > 64)) return false;
  return true;
}

type SfuOperation = 'capabilities' | 'join' | 'create-transport' | 'connect-transport' | 'produce' | 'consume' | 'resume-consumer';

function boundedRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,96}$/.test(value) ? value : undefined;
}

function emitSfuError(
  socket: BridgeSocket,
  operation: SfuOperation,
  requestId: unknown,
  code: string,
  message: string,
): void {
  socket.emit('sfu:error', {
    operation,
    ...(boundedRequestId(requestId) ? { requestId: boundedRequestId(requestId) } : {}),
    code,
    message,
  });
}

function logSfuFailure(operation: SfuOperation, error: unknown): void {
  logger.error({ operation, detail: error }, '[SFU] signaling operation failed');
}

// ── registerSFUHandlers ───────────────────────────────────────────────────────

export function registerSFUHandlers(
  socket: BridgeSocket,
  io:     BridgeIO,
  user:   BridgeUser
): void {
  // A socket may have one canonical SFU join attempt at a time. Newer joins or
  // an explicit leave invalidate older asynchronous authorization/registry work.
  let sfuJoinGeneration = 0;

  /**
   * Resolve media-room authority from server-side state. A client may name a
   * room, but it never gets to assert which server owns it or whether it may
   * connect/speak there. Group-DM rooms use the group membership table; normal
   * voice/stage rooms use the canonical channel permission resolver.
   */
  async function authorizeMediaRoom(
    channelId: string,
    claimedServerId: string | null | undefined,
    requireSpeak = false,
  ): Promise<{ serverId: string | null; isGroup: boolean; channelType: 'voice' | 'stage' | 'group' } | null> {
    if (!channelId) return null;

    const channel = await Channels.findById(channelId).catch(() => null);
    if (channel) {
      const actualServerId = String(channel.serverId ?? '');
      if (!actualServerId) return null;
      if (claimedServerId && claimedServerId !== actualServerId) return null;
      if (channel.type !== 'voice' && channel.type !== 'stage') return null;

      const membership = await Members.findOne(user._id, actualServerId).catch(() => null);
      if (!membership || isMemberTimedOut(membership.timeoutUntil)) return null;

      const perms = await resolvePermissions(user._id, actualServerId, channelId).catch(() => 0);
      if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.CONNECT)) return null;
      if (requireSpeak && !hasPermission(perms, PERMS.SPEAK)) return null;
      return { serverId: actualServerId, isGroup: false, channelType: channel.type as 'voice' | 'stage' };
    }

    // Group-DM SFU rooms do not have a channels row. They are authorized by
    // explicit group membership and never accept a claimed server id.
    if (claimedServerId) return null;
    const groupMember = await GroupDms.findMember(channelId, user._id).catch(() => null);
    return groupMember ? { serverId: null, isGroup: true, channelType: 'group' } : null;
  }

  function requireOwnPeerChannel(clientChannelId?: string): SfuPeer | null {
    const peer = sfuPeers.get(socket.id) ?? null;
    if (!peer) return null;
    if (clientChannelId && clientChannelId !== peer.channelId) return null;
    return peer;
  }

  // ── sfu:get-rtp-capabilities ─────────────────────────────────────────────
  socket.on('sfu:get-rtp-capabilities', isolateSocketHandler(socket, 'sfu:get-rtp-capabilities', async ({ channelId, requestId }: { channelId: string; requestId?: string }) => {
    try {
      if (!isBoundedId(channelId)) {
        return emitSfuError(socket, 'capabilities', requestId, 'INVALID_ROOM', 'Medya odası isteği geçersiz.');
      }
      const authority = await authorizeMediaRoom(channelId, null);
      if (!authority || (authority.channelType === 'stage' && !await isStageParticipant(channelId, user._id))) {
        return emitSfuError(socket, 'capabilities', requestId, 'FORBIDDEN', 'Bu medya odasına erişilemiyor.');
      }
      const room = await getOrCreateRoom(channelId);
      socket.emit('sfu:rtp-capabilities', { requestId: boundedRequestId(requestId), rtpCapabilities: room.router.rtpCapabilities });
    } catch (e: unknown) {
      // RTP capabilities are the FIRST SFU request a client makes. If another
      // node already owns the room, treating ownership as a generic error makes
      // the later `sfu:join` redirect unreachable. Emit the same canonical
      // redirect contract here so the client can establish a signaling socket
      // directly to the owner before any mediasoup transport is created.
      if (e instanceof RoomOwnedElsewhereError) {
        socket.emit('sfu:redirect', {
          channelId,
          requestId: boundedRequestId(requestId),
          ownerNodeId: e.ownerNodeId,
          message: "Bu ses odası başka bir sunucu node'unda çalışıyor. Sahip node'a bağlanılıyor…",
        });
        return;
      }
      logSfuFailure('capabilities', e);
      emitSfuError(socket, 'capabilities', requestId, 'UNAVAILABLE', 'Ses altyapısı şu anda kullanılamıyor.');
    }
  }));

  // ── sfu:join / sfu:group-join ────────────────────────────────────────────
  async function sfuJoinHandler({
    channelId, serverId, rtpCapabilities, requestId, replaces,
  }: { channelId: string; serverId: string | null; rtpCapabilities: RtpCapabilities; requestId?: string; replaces?: unknown }): Promise<void> {
    const generation = ++sfuJoinGeneration;
    try {
      if (!isBoundedId(channelId) || (serverId !== null && serverId !== undefined && !isBoundedId(serverId)) ||
          !isBoundedRtpObject(rtpCapabilities)) {
        emitSfuError(socket, 'join', requestId, 'INVALID_JOIN', 'Ses kanalına katılma isteği geçersiz.');
        return;
      }
      const authority = await authorizeMediaRoom(channelId, serverId);
      if (!authority || (authority.channelType === 'stage' && !await isStageParticipant(channelId, user._id))) {
        if (generation === sfuJoinGeneration) emitSfuError(socket, 'join', requestId, 'FORBIDDEN', 'Bu medya odasına katılma yetkiniz yok.');
        return;
      }
      if (generation !== sfuJoinGeneration) return;
      const actualServerId = authority.serverId;

      const isLocal = await sfuRegistry.isLocalRoom(channelId);
      if (generation !== sfuJoinGeneration) return;
      if (!isLocal) {
        const owner: string | null = await sfuRegistry.getRoomOwner(channelId);
        if (generation !== sfuJoinGeneration) return;
        socket.emit('sfu:redirect', {
          channelId,
          requestId: boundedRequestId(requestId),
          ownerNodeId: owner,
          message: "Bu ses odası başka bir sunucu node'unda çalışıyor. Yeniden bağlanılıyor…",
        });
        return;
      }

      // ── SAHİPLİK YARIŞI: KAYBEDERSEK YÖNLENDİR ──────────────────────────
      // Yukarıdaki `isLocalRoom()` kontrolü ile oda oluşturma arasında BAŞKA
      // bir node aynı odayı sahiplenmiş olabilir (kontrol-et-sonra-davran).
      // `getOrCreateRoom` artık atomik talebi kaybederse yerel oda AÇMAZ ve
      // `RoomOwnedElsewhereError` fırlatır; istemci kanonik node'a yönlendirilir.
      let room: Awaited<ReturnType<typeof getOrCreateRoom>>;
      try {
        room = await getOrCreateRoom(channelId);
      } catch (err) {
        if (err instanceof RoomOwnedElsewhereError) {
          if (generation === sfuJoinGeneration) {
            socket.emit('sfu:redirect', {
              channelId,
              requestId: boundedRequestId(requestId),
              ownerNodeId: err.ownerNodeId,
              message: "Bu ses odası başka bir sunucu node'unda çalışıyor. Yeniden bağlanılıyor…",
            });
          }
          return;
        }
        throw err;
      }
      if (generation !== sfuJoinGeneration) return;

      // A client re-establishing a lost session (new socket after a network
      // change) names the session it replaces. Until the server notices the
      // old socket is dead (ping timeout, up to ~45 s) that peer would stay in
      // the room as a ghost the other participants still render (P2 media
      // lab). Only the SAME user's peer in the SAME room is ever removed.
      if (isBoundedId(replaces) && replaces !== socket.id) {
        const stale = sfuPeers.get(replaces);
        if (stale && stale.userId === user._id && stale.channelId === channelId) {
          await cleanupPeer(replaces, io, stale.channelId, stale.serverId ?? undefined);
          if (generation !== sfuJoinGeneration) return;
        }
      }

      const previousPeer = sfuPeers.get(socket.id);
      if (previousPeer) {
        // cleanupPeer owns mediasoup state, but Socket.IO room membership is
        // owned by the socket. Leave the previous canonical voice room before
        // publishing the new peer so a room switch cannot retain ghost access
        // to broadcasts from the old channel.
        await socket.leave(`voice:${previousPeer.channelId}`);
        await cleanupPeer(socket.id, io, previousPeer.channelId, previousPeer.serverId ?? undefined);
        socket.currentVoiceChannel = null;
        socket.currentVoiceServer = null;
        if (generation !== sfuJoinGeneration) return;
      }

      const peer: SfuPeer = {
        channelId,
        serverId:        actualServerId,
        userId:          user._id,
        displayName:     user.displayName,
        avatarColor:     user.avatarColor,
        rtpCapabilities,
        sendTransport:   null,
        recvTransport:   null,
        producers:       new Map(),
        consumers:       new Map(),
        muted:           false,
        deafened:        false,
        screensharing:   false,
        video:           false,
      };

      sfuPeers.set(socket.id, peer);
      room.peers.set(socket.id, peer);

      socket.join(`voice:${channelId}`);
      socket.currentVoiceChannel = channelId;
      socket.currentVoiceServer  = actualServerId;

      const existingPeers = [];
      for (const [sid, p] of room.peers) {
        if (sid === socket.id) continue;
        existingPeers.push({
          socketId:    sid,
          userId:      p.userId,
          displayName: p.displayName,
          avatarColor: p.avatarColor,
          producers: [...p.producers.entries()].map(([kind, prod]) => ({ kind, producerId: prod.id })),
        });
      }

      const iceConfig = getRtcIceConfig(String(user._id));
      socket.emit('sfu:joined', {
        requestId: boundedRequestId(requestId),
        existingPeers,
        iceServers:         iceConfig.iceServers,
        iceTransportPolicy: iceConfig.iceTransportPolicy,
        ...(iceConfig.warning ? { warning: iceConfig.warning } : {}),
      });
      socket.to(`voice:${channelId}`).emit('sfu:peer-joined', {
        socketId:    socket.id,
        userId:      user._id,
        displayName: user.displayName,
        avatarColor: user.avatarColor,
      });

      const peerList = getRoomPeerList(channelId);
      const updateRooms = actualServerId
        ? [`voice:${channelId}`, `channel:${channelId}`]
        : [`voice:${channelId}`];
      io.to(updateRooms).emit('voice:room-update', { channelId, peers: peerList });

    } catch (e: unknown) {
      logSfuFailure('join', e);
      emitSfuError(socket, 'join', requestId, 'JOIN_FAILED', 'Ses kanalına katılım tamamlanamadı.');
    }
  }

  socket.on('sfu:join', isolateSocketHandler(socket, 'sfu:join', (p: { channelId: string; serverId: string | null; rtpCapabilities: RtpCapabilities; requestId?: string; replaces?: unknown }) => {
    return sfuJoinHandler(p);
  }));
  socket.on('sfu:group-join', isolateSocketHandler(socket, 'sfu:group-join', (p: { channelId: string; serverId?: string; rtpCapabilities: RtpCapabilities; requestId?: string; replaces?: unknown }) => {
    socket.emit('_sfu:join-routed');
    return sfuJoinHandler({ ...p, serverId: p.serverId ?? null });
  }));

  // ── sfu:create-transport ─────────────────────────────────────────────────
  socket.on('sfu:create-transport', isolateSocketHandler(socket, 'sfu:create-transport', async (payload: {
    channelId: string; direction: 'send' | 'recv'; requestId?: string;
  }) => {
    try {
      if (!payload || typeof payload !== 'object') return;
      const { channelId, direction, requestId } = payload;
      if (typeof channelId !== 'string' || channelId.length < 1 || channelId.length > 64 ||
          (direction !== 'send' && direction !== 'recv')) {
        return emitSfuError(socket, 'create-transport', requestId, 'INVALID_TRANSPORT', 'Medya bağlantısı oluşturulamadı.');
      }
      const peer = requireOwnPeerChannel(channelId);
      if (!peer) return emitSfuError(socket, 'create-transport', requestId, 'SESSION_MISMATCH', 'Ses oturumu artık geçerli değil.');
      if (!await authorizeMediaRoom(peer.channelId, peer.serverId)) {
        return emitSfuError(socket, 'create-transport', requestId, 'FORBIDDEN', 'Ses kanalı erişimi artık geçerli değil.');
      }
      const room = sfuRooms.get(peer.channelId);
      if (!room) return emitSfuError(socket, 'create-transport', requestId, 'ROOM_GONE', 'Ses odası artık kullanılamıyor.');

      if (direction === 'send' ? peer.sendTransport : peer.recvTransport) {
        return emitSfuError(socket, 'create-transport', requestId, 'ALREADY_EXISTS', 'Medya bağlantısı zaten hazır.');
      }

      const transport = await createWebRtcTransport(room.router);
      if (direction === 'send') peer.sendTransport = transport;
      else                      peer.recvTransport = transport;

      transport.on('dtlsstatechange', (state) => {
        if (state === 'closed' || state === 'failed') {
          transport.close();
          if (direction === 'send' && peer.sendTransport === transport) peer.sendTransport = null;
          if (direction === 'recv' && peer.recvTransport === transport) peer.recvTransport = null;
        }
      });

      socket.emit('sfu:transport-created', {
        requestId: boundedRequestId(requestId),
        direction,
        id:             transport.id,
        iceParameters:  transport.iceParameters,
        iceCandidates:  transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    } catch (e: unknown) {
      logSfuFailure('create-transport', e);
      emitSfuError(socket, 'create-transport', payload?.requestId, 'TRANSPORT_FAILED', 'Medya bağlantısı oluşturulamadı.');
    }
  }));

  // ── sfu:connect-transport ────────────────────────────────────────────────
  socket.on('sfu:connect-transport', isolateSocketHandler(socket, 'sfu:connect-transport', async (payload: {
    channelId: string; direction: 'send' | 'recv'; dtlsParameters: DtlsParameters; requestId?: string;
  }) => {
    try {
      if (!payload || typeof payload !== 'object') return;
      const { channelId, direction, dtlsParameters, requestId } = payload;
      if (typeof channelId !== 'string' || channelId.length < 1 || channelId.length > 64 ||
          (direction !== 'send' && direction !== 'recv') || !dtlsParameters || typeof dtlsParameters !== 'object') return;
      const peer = requireOwnPeerChannel(channelId);
      if (!peer) return;
      if (!await authorizeMediaRoom(peer.channelId, peer.serverId) || sfuPeers.get(socket.id) !== peer) {
        return emitSfuError(socket, 'connect-transport', requestId, 'FORBIDDEN', 'Ses kanalı erişimi artık geçerli değil.');
      }
      const transport = direction === 'send' ? peer.sendTransport : peer.recvTransport;
      if (!transport) return;
      await transport.connect({ dtlsParameters });
      socket.emit('sfu:transport-connected', { requestId: boundedRequestId(requestId), direction });
    } catch (e: unknown) {
      logSfuFailure('connect-transport', e);
      emitSfuError(socket, 'connect-transport', payload?.requestId, 'CONNECT_FAILED', 'Medya bağlantısı kurulamadı.');
    }
  }));

  // ── sfu:produce ──────────────────────────────────────────────────────────
  socket.on('sfu:produce', isolateSocketHandler(socket, 'sfu:produce', async (payload: {
    channelId:     string;
    kind:          'audio' | 'video';
    rtpParameters: RtpParameters;
    appData?:      Record<string, unknown>;
    requestId?:    string;
  }) => {
    try {
      if (!payload || typeof payload !== 'object') return;
      const { channelId, kind, rtpParameters, appData, requestId } = payload;
      if (!isBoundedId(channelId) || (kind !== 'audio' && kind !== 'video') ||
          !isBoundedRtpObject(rtpParameters, true) ||
          (appData !== undefined && (!appData || typeof appData !== 'object' || Array.isArray(appData) || Object.keys(appData).length > 32))) {
        return emitSfuError(socket, 'produce', requestId, 'INVALID_PRODUCER', 'Medya yayını başlatılamadı.');
      }
      const peer = requireOwnPeerChannel(channelId);
      if (!peer || !peer.sendTransport) return;
      const publishAuthority = await authorizeMediaRoom(peer.channelId, peer.serverId, true);
      if (!publishAuthority || (publishAuthority.channelType === 'stage' && !await isStageSpeaker(peer.channelId, user._id))) {
        return emitSfuError(socket, 'produce', requestId, 'FORBIDDEN', 'Bu medya odasında yayın yapma yetkiniz yok.');
      }
      const canonicalChannelId = peer.channelId;

      const isScreen = appData?.screen === true;
      const isScreenAudio = appData?.screenAudio === true;
      // Screen video and system audio are distinct producer identities even
      // though mediasoup transports the latter as an ordinary audio track.
      // Keeping separate keys prevents a screen-audio producer from replacing
      // the microphone producer or colliding with the screen video producer.
      if ((isScreen && kind !== 'video') || (isScreenAudio && kind !== 'audio') || (isScreen && isScreenAudio)) {
        return emitSfuError(socket, 'produce', requestId, 'INVALID_PRODUCER', 'Medya yayını başlatılamadı.');
      }
      const trackKind = isScreenAudio ? 'screen-audio' : (isScreen ? 'screen' : kind);
      if (peer.producers.has(trackKind)) {
        return emitSfuError(socket, 'produce', requestId, 'ALREADY_EXISTS', 'Bu medya yayını zaten açık.');
      }

      let normalizedRtp = rtpParameters;
      if (kind === 'video' && (rtpParameters.encodings?.length ?? 0) > 0) {
        // Sprint 120: A3 — config'deki merkezi encoding tanımları kullanılıyor
        const defaultEncodings = isScreen ? SCREENSHARE_ENCODINGS : SIMULCAST_ENCODINGS;
        const hasRid = rtpParameters.encodings!.some(e => e.rid);
        normalizedRtp = hasRid
          ? {
              ...rtpParameters,
              encodings: rtpParameters.encodings!.map((enc, i) => ({
                ...enc,
                maxBitrate:      enc.maxBitrate      ?? (defaultEncodings[i]?.maxBitrate ?? 500_000),
                scalabilityMode: enc.scalabilityMode ?? 'S1T3',
              })),
            }
          : { ...rtpParameters, encodings: defaultEncodings };
      }

      const producer = await peer.sendTransport.produce({ kind, rtpParameters: normalizedRtp, appData: appData ?? {} });
      peer.producers.set(trackKind, producer);

      producer.on('score', (scores) => socket.emit('sfu:producer-score', { producerId: producer.id, kind: trackKind, scores }));
      producer.on('videoorientationchange', (o) => socket.to(`voice:${canonicalChannelId}`).emit('sfu:video-orientation', { producerId: producer.id, orientation: o }));
      producer.on('transportclose', () => peer.producers.delete(trackKind));

      socket.emit('sfu:produced', { requestId: boundedRequestId(requestId), producerId: producer.id, kind: trackKind });
      socket.to(`voice:${canonicalChannelId}`).emit('sfu:new-producer', {
        socketId: socket.id, userId: user._id, producerId: producer.id, kind: trackKind,
        hasSimulcast: kind === 'video' && (normalizedRtp.encodings?.length ?? 0) > 1,
      });
    } catch (e: unknown) {
      logSfuFailure('produce', e);
      emitSfuError(socket, 'produce', payload?.requestId, 'PRODUCE_FAILED', 'Medya yayını başlatılamadı.');
    }
  }));

  // ── sfu:set-preferred-layer ──────────────────────────────────────────────
  socket.on('sfu:set-preferred-layer', isolateSocketHandler(socket, 'sfu:set-preferred-layer', async ({
    producerId, spatialLayer, temporalLayer,
  }: { producerId: string; spatialLayer: number; temporalLayer: number }) => {
    try {
      const peer = sfuPeers.get(socket.id);
      if (!peer) return;
      if (!await authorizeMediaRoom(peer.channelId, peer.serverId) || sfuPeers.get(socket.id) !== peer) return;
      const consumer = peer.consumers.get(producerId);
      if (!consumer || consumer.type !== 'simulcast') return;
      await consumer.setPreferredLayers({ spatialLayer, temporalLayer });
    } catch (e: unknown) {
      logger.warn('[SFU] set-preferred-layer error:', (e as Error).message);
    }
  }));

  // ── sfu:consume ──────────────────────────────────────────────────────────
  socket.on('sfu:consume', isolateSocketHandler(socket, 'sfu:consume', async (payload: {
    channelId: string; producerId: string; rtpCapabilities: RtpCapabilities; requestId?: string;
  }) => {
    try {
      if (!payload || typeof payload !== 'object') return;
      const { channelId, producerId, rtpCapabilities, requestId } = payload;
      if (!isBoundedId(channelId) || !isBoundedId(producerId) || !isBoundedRtpObject(rtpCapabilities)) {
        return emitSfuError(socket, 'consume', requestId, 'INVALID_CONSUMER', 'Medya akışı alınamadı.');
      }
      const peer = requireOwnPeerChannel(channelId);
      if (!peer || !peer.recvTransport) return;
      if (peer.consumers.has(producerId)) {
        return emitSfuError(socket, 'consume', requestId, 'ALREADY_EXISTS', 'Medya akışı zaten bağlı.');
      }
      if (!await authorizeMediaRoom(peer.channelId, peer.serverId)) {
        return emitSfuError(socket, 'consume', requestId, 'FORBIDDEN', 'Ses kanalı erişimi artık geçerli değil.');
      }
      const room = sfuRooms.get(peer.channelId);
      if (!room) return;
      const producerBelongsToRoom = [...room.peers.values()].some(p =>
        [...p.producers.values()].some(prod => prod.id === producerId)
      );
      if (!producerBelongsToRoom) {
        return emitSfuError(socket, 'consume', requestId, 'NOT_FOUND', 'Medya akışı artık kullanılamıyor.');
      }

      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        return emitSfuError(socket, 'consume', requestId, 'INCOMPATIBLE', 'Bu medya akışı cihazınızda açılamıyor.');
      }

      const consumer = await peer.recvTransport.consume({ producerId, rtpCapabilities, paused: true });
      peer.consumers.set(producerId, consumer);

      consumer.on('transportclose', () => peer.consumers.delete(producerId));
      consumer.on('producerclose', () => {
        peer.consumers.delete(producerId);
        socket.emit('sfu:producer-closed', { producerId });
      });

      socket.emit('sfu:consumed', {
        requestId: boundedRequestId(requestId),
        consumerId:    consumer.id,
        producerId,
        kind:          consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    } catch (e: unknown) {
      logSfuFailure('consume', e);
      emitSfuError(socket, 'consume', payload?.requestId, 'CONSUME_FAILED', 'Medya akışı alınamadı.');
    }
  }));

  // ── sfu:resume-consumer ──────────────────────────────────────────────────
  socket.on('sfu:resume-consumer', isolateSocketHandler(socket, 'sfu:resume-consumer', async ({ producerId, requestId }: { producerId: string; requestId?: string }) => {
    try {
      const peer = sfuPeers.get(socket.id);
      if (!peer) return;
      if (!isBoundedId(producerId)) return;
      if (!await authorizeMediaRoom(peer.channelId, peer.serverId) || sfuPeers.get(socket.id) !== peer) {
        return emitSfuError(socket, 'resume-consumer', requestId, 'FORBIDDEN', 'Ses kanalı erişimi artık geçerli değil.');
      }
      const consumer = peer.consumers.get(producerId);
      if (consumer) await consumer.resume();
    } catch (e: unknown) {
      logger.error({ detail: e }, '[SFU] resume-consumer error:');
    }
  }));

  // ── sfu:close-producer ───────────────────────────────────────────────────
  socket.on('sfu:close-producer', isolateSocketHandler(socket, 'sfu:close-producer', ({ kind }: { kind: string }) => {
    const peer = sfuPeers.get(socket.id);
    if (!peer) return;
    const producer = peer.producers.get(kind);
    if (producer) { producer.close(); peer.producers.delete(kind); }
  }));

  // ── sfu:leave ────────────────────────────────────────────────────────────
  socket.on('sfu:leave', isolateSocketHandler(socket, 'sfu:leave', async (_payload: { channelId?: string; serverId?: string }) => {
    ++sfuJoinGeneration;
    const peer = sfuPeers.get(socket.id);
    if (!peer) return;
    await socket.leave(`voice:${peer.channelId}`);
    await cleanupPeer(socket.id, io, peer.channelId, peer.serverId ?? undefined);
    socket.currentVoiceChannel = null;
    socket.currentVoiceServer = null;
  }));

  // ── voice:state-update ───────────────────────────────────────────────────
  socket.on('voice:state-update', isolateSocketHandler(socket, 'voice:state-update', async ({
    channelId, muted, deafened, screensharing, video,
  }: { channelId: string; muted: boolean; deafened: boolean; screensharing: boolean; video: boolean }) => {
    if ([muted, deafened, screensharing, video].some(value => typeof value !== 'boolean')) return;
    const peer = requireOwnPeerChannel(channelId);
    if (!peer) return;
    const allowed = await authorizeMediaRoom(peer.channelId, peer.serverId);
    if (!allowed || sfuPeers.get(socket.id) !== peer) return;
    Object.assign(peer, { muted, deafened, screensharing, video });
    socket.to(`voice:${peer.channelId}`).emit('voice:peer-state', {
      socketId: socket.id, userId: user._id, muted, deafened, screensharing, video,
    });
  }));

  // ── voice:activity ───────────────────────────────────────────────────────
  socket.on('voice:activity', isolateSocketHandler(socket, 'voice:activity', async ({ channelId, speaking }: { channelId: string; speaking: boolean }) => {
    if (typeof speaking !== 'boolean') return;
    const peer = requireOwnPeerChannel(channelId);
    if (!peer) return;
    const allowed = await authorizeMediaRoom(peer.channelId, peer.serverId);
    if (!allowed || sfuPeers.get(socket.id) !== peer) return;
    socket.to(`voice:${peer.channelId}`).emit('voice:activity', { socketId: socket.id, userId: user._id, speaking });
  }));

  // ── disconnect ───────────────────────────────────────────────────────────
  socket.on('disconnect', isolateSocketHandler(socket, 'disconnect', async () => {
    const peer = sfuPeers.get(socket.id);
    if (peer) await cleanupPeer(socket.id, io, peer.channelId, peer.serverId ?? undefined);
  }));
}
