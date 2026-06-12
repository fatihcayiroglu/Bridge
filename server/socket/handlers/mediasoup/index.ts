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
import { getIceServers, getIceTransportPolicy } from '../../../lib/turnConfig';
import { sfuRooms, sfuPeers, getOrCreateRoom, createWebRtcTransport, getRoomPeerList, cleanupPeer } from './rooms';
import type { BridgeSocket, BridgeIO, BridgeUser, SfuPeer, RtpCapabilities, DtlsParameters, RtpParameters } from './types';
// Sprint 120: A3 — Merkezi simulcast encoding config'den import
import { SIMULCAST_ENCODINGS, SCREENSHARE_ENCODINGS } from './config';
// Sprint 122 FIX 3: Kanal üyelik kontrolü için Members repository
import { Members } from '../../../db/repositories';

import logger from '../../../lib/logger';
export { initMediasoup, isSFUReady } from './workers';
export { sfuRooms, sfuPeers, cleanupRoom } from './rooms';

// ── registerSFUHandlers ───────────────────────────────────────────────────────

export function registerSFUHandlers(
  socket: BridgeSocket,
  io:     BridgeIO,
  user:   BridgeUser
): void {

  // ── sfu:get-rtp-capabilities ─────────────────────────────────────────────
  socket.on('sfu:get-rtp-capabilities', async ({ channelId }: { channelId: string }) => {
    try {
      const room = await getOrCreateRoom(channelId);
      socket.emit('sfu:rtp-capabilities', { rtpCapabilities: room.router.rtpCapabilities });
    } catch (e: unknown) {
      socket.emit('sfu:error', { message: (e as Error).message });
    }
  });

  // ── sfu:join / sfu:group-join ────────────────────────────────────────────
  async function sfuJoinHandler({
    channelId, serverId, rtpCapabilities,
  }: { channelId: string; serverId: string | null; rtpCapabilities: RtpCapabilities }): Promise<void> {
    try {
      // Sprint 122 FIX 3: Ses kanalına katılmadan önce sunucu üyeliği doğrula.
      // Bu kontrol olmadan kimliği doğrulanmış herhangi bir kullanıcı,
      // üye olmadığı bir sunucunun ses kanalına katılabilirdi.
      if (serverId) {
        const membership = await Members.findOne(user._id, serverId).catch(() => null);
        if (!membership) {
          socket.emit('sfu:error', { message: 'Bu ses kanalına katılma yetkiniz yok.' });
          return;
        }
        // Timeout kontrolü
        if (membership.timeoutUntil && membership.timeoutUntil > Date.now()) {
          socket.emit('sfu:error', { message: 'Timeout süresince ses kanalına katılamazsınız.' });
          return;
        }
      }

      const isLocal = await sfuRegistry.isLocalRoom(channelId);
      if (!isLocal) {
        const owner: string | null = await sfuRegistry.getRoomOwner(channelId);
        socket.emit('sfu:redirect', {
          channelId,
          ownerNodeId: owner,
          message: "Bu ses odası başka bir sunucu node'unda çalışıyor. Yeniden bağlanılıyor…",
        });
        return;
      }

      const room = await getOrCreateRoom(channelId);

      if (sfuPeers.has(socket.id)) {
        await cleanupPeer(socket.id, io, undefined, undefined);
      }

      const peer: SfuPeer = {
        channelId,
        serverId:        serverId ?? null,
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
      socket.currentVoiceServer  = serverId ?? null;

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

      socket.emit('sfu:joined', {
        existingPeers,
        iceServers:         getIceServers(String(user._id)),
        iceTransportPolicy: getIceTransportPolicy(),
      });
      socket.to(`voice:${channelId}`).emit('sfu:peer-joined', {
        socketId:    socket.id,
        userId:      user._id,
        displayName: user.displayName,
        avatarColor: user.avatarColor,
      });

      const peerList = getRoomPeerList(channelId);
      if (serverId) io.to(`server:${serverId}`).emit('voice:room-update', { channelId, peers: peerList });
      io.to(`channel:${channelId}`).emit('voice:room-update', { channelId, peers: peerList });

    } catch (e: unknown) {
      logger.error({ detail: e }, '[SFU] join error:');
      socket.emit('sfu:error', { message: (e as Error).message });
    }
  }

  socket.on('sfu:join', (p: { channelId: string; serverId: string | null; rtpCapabilities: RtpCapabilities }) => {
    return sfuJoinHandler(p);
  });
  socket.on('sfu:group-join', (p: { channelId: string; serverId?: string; rtpCapabilities: RtpCapabilities }) => {
    socket.emit('_sfu:join-routed');
    return sfuJoinHandler({ ...p, serverId: p.serverId ?? null });
  });

  // ── sfu:create-transport ─────────────────────────────────────────────────
  socket.on('sfu:create-transport', async ({
    channelId, direction,
  }: { channelId: string; direction: 'send' | 'recv' }) => {
    try {
      const room = sfuRooms.get(channelId);
      if (!room) return socket.emit('sfu:error', { message: 'Room bulunamadı' });
      const peer = sfuPeers.get(socket.id);
      if (!peer) return socket.emit('sfu:error', { message: 'Peer bulunamadı' });

      const transport = await createWebRtcTransport(room.router);
      if (direction === 'send') peer.sendTransport = transport;
      else                      peer.recvTransport = transport;

      transport.on('dtlsstatechange', (state) => {
        if (state === 'closed' || state === 'failed') transport.close();
      });

      socket.emit('sfu:transport-created', {
        direction,
        id:             transport.id,
        iceParameters:  transport.iceParameters,
        iceCandidates:  transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
    } catch (e: unknown) {
      socket.emit('sfu:error', { message: (e as Error).message });
    }
  });

  // ── sfu:connect-transport ────────────────────────────────────────────────
  socket.on('sfu:connect-transport', async ({
    direction, dtlsParameters,
  }: { channelId: string; direction: 'send' | 'recv'; dtlsParameters: DtlsParameters }) => {
    try {
      const peer = sfuPeers.get(socket.id);
      if (!peer) return;
      const transport = direction === 'send' ? peer.sendTransport : peer.recvTransport;
      if (!transport) return;
      await transport.connect({ dtlsParameters });
      socket.emit('sfu:transport-connected', { direction });
    } catch (e: unknown) {
      socket.emit('sfu:error', { message: (e as Error).message });
    }
  });

  // ── sfu:produce ──────────────────────────────────────────────────────────
  socket.on('sfu:produce', async ({
    channelId, kind, rtpParameters, appData,
  }: {
    channelId:     string;
    kind:          'audio' | 'video';
    rtpParameters: RtpParameters;
    appData?:      Record<string, unknown>;
  }) => {
    try {
      const peer = sfuPeers.get(socket.id);
      if (!peer || !peer.sendTransport) return;

      let normalizedRtp = rtpParameters;
      if (kind === 'video' && (rtpParameters.encodings?.length ?? 0) > 0) {
        const isScreen = !!appData?.screen;
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
      const trackKind = appData?.screen ? 'screen' : kind;
      peer.producers.set(trackKind, producer);

      producer.on('score', (scores) => socket.emit('sfu:producer-score', { producerId: producer.id, kind: trackKind, scores }));
      producer.on('videoorientationchange', (o) => socket.to(`voice:${channelId}`).emit('sfu:video-orientation', { producerId: producer.id, orientation: o }));
      producer.on('transportclose', () => peer.producers.delete(trackKind));

      socket.emit('sfu:produced', { producerId: producer.id, kind: trackKind });
      socket.to(`voice:${channelId}`).emit('sfu:new-producer', {
        socketId: socket.id, userId: user._id, producerId: producer.id, kind: trackKind,
        hasSimulcast: kind === 'video' && (normalizedRtp.encodings?.length ?? 0) > 1,
      });
    } catch (e: unknown) {
      socket.emit('sfu:error', { message: (e as Error).message });
    }
  });

  // ── sfu:set-preferred-layer ──────────────────────────────────────────────
  socket.on('sfu:set-preferred-layer', async ({
    producerId, spatialLayer, temporalLayer,
  }: { producerId: string; spatialLayer: number; temporalLayer: number }) => {
    try {
      const peer = sfuPeers.get(socket.id);
      if (!peer) return;
      const consumer = peer.consumers.get(producerId);
      if (!consumer || consumer.type !== 'simulcast') return;
      await consumer.setPreferredLayers({ spatialLayer, temporalLayer });
    } catch (e: unknown) {
      logger.warn('[SFU] set-preferred-layer error:', (e as Error).message);
    }
  });

  // ── sfu:consume ──────────────────────────────────────────────────────────
  socket.on('sfu:consume', async ({
    channelId, producerId, rtpCapabilities,
  }: { channelId: string; producerId: string; rtpCapabilities: RtpCapabilities }) => {
    try {
      const room = sfuRooms.get(channelId);
      const peer = sfuPeers.get(socket.id);
      if (!room || !peer || !peer.recvTransport) return;

      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        return socket.emit('sfu:error', { message: 'Bu producer consume edilemiyor' });
      }

      const consumer = await peer.recvTransport.consume({ producerId, rtpCapabilities, paused: true });
      peer.consumers.set(producerId, consumer);

      consumer.on('transportclose', () => peer.consumers.delete(producerId));
      consumer.on('producerclose', () => {
        peer.consumers.delete(producerId);
        socket.emit('sfu:producer-closed', { producerId });
      });

      socket.emit('sfu:consumed', {
        consumerId:    consumer.id,
        producerId,
        kind:          consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    } catch (e: unknown) {
      socket.emit('sfu:error', { message: (e as Error).message });
    }
  });

  // ── sfu:resume-consumer ──────────────────────────────────────────────────
  socket.on('sfu:resume-consumer', async ({ producerId }: { producerId: string }) => {
    try {
      const peer = sfuPeers.get(socket.id);
      if (!peer) return;
      const consumer = peer.consumers.get(producerId);
      if (consumer) await consumer.resume();
    } catch (e: unknown) {
      logger.error({ detail: e }, '[SFU] resume-consumer error:');
    }
  });

  // ── sfu:close-producer ───────────────────────────────────────────────────
  socket.on('sfu:close-producer', ({ kind }: { kind: string }) => {
    const peer = sfuPeers.get(socket.id);
    if (!peer) return;
    const producer = peer.producers.get(kind);
    if (producer) { producer.close(); peer.producers.delete(kind); }
  });

  // ── sfu:leave ────────────────────────────────────────────────────────────
  socket.on('sfu:leave', async ({ channelId, serverId }: { channelId: string; serverId?: string }) => {
    await cleanupPeer(socket.id, io, channelId, serverId);
  });

  // ── voice:state-update ───────────────────────────────────────────────────
  socket.on('voice:state-update', ({
    channelId, muted, deafened, screensharing, video,
  }: { channelId: string; muted: boolean; deafened: boolean; screensharing: boolean; video: boolean }) => {
    const peer = sfuPeers.get(socket.id);
    if (peer) Object.assign(peer, { muted, deafened, screensharing, video });
    socket.to(`voice:${channelId}`).emit('voice:peer-state', {
      socketId: socket.id, userId: user._id, muted, deafened, screensharing, video,
    });
  });

  // ── voice:activity ───────────────────────────────────────────────────────
  socket.on('voice:activity', ({ channelId, speaking }: { channelId: string; speaking: boolean }) => {
    socket.to(`voice:${channelId}`).emit('voice:activity', { socketId: socket.id, userId: user._id, speaking });
  });

  // ── disconnect ───────────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    const peer = sfuPeers.get(socket.id);
    if (peer) await cleanupPeer(socket.id, io, peer.channelId, peer.serverId ?? undefined);
  });
}
