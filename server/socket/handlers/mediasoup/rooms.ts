// server/socket/handlers/mediasoup/rooms.ts
// SFU room yaşam döngüsü — oluşturma, temizleme, peer listesi

import logger from '../../../lib/logger';
import * as sfuRegistry from '../../../lib/sfuRegistry';
import { config } from './config';
import { getNextWorkerWithIndex, incrementWorkerLoad, decrementWorkerLoad } from './workers';
import type { SfuRoom, SfuPeer, MediasoupTransport, MediasoupRouter } from './types';

export const sfuRooms  = new Map<string, SfuRoom>();
export const sfuPeers  = new Map<string, SfuPeer>();
const _roomCreating    = new Map<string, Promise<SfuRoom>>();
const _pendingRoomCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

function _clearScheduledRoomCleanup(channelId: string): void {
  const timer = _pendingRoomCleanupTimers.get(channelId);
  if (timer !== undefined) {
    clearTimeout(timer);
    _pendingRoomCleanupTimers.delete(channelId);
  }
}

function _scheduleRoomCleanup(channelId: string): void {
  _clearScheduledRoomCleanup(channelId);
  const timer = setTimeout(() => {
    _pendingRoomCleanupTimers.delete(channelId);
    cleanupRoom(channelId);
  }, 5000);
  timer.unref?.();
  _pendingRoomCleanupTimers.set(channelId, timer);
}

// ── Room CRUD ────────────────────────────────────────────────────────────────

const MAX_ROOMS = 500; // mediasoup router başına ~50MB RAM; 500 oda = ~25GB üst sınır

export async function getOrCreateRoom(channelId: string): Promise<SfuRoom> {
  const existingRoom = sfuRooms.get(channelId);
  if (existingRoom) {
    _clearScheduledRoomCleanup(channelId);
    return existingRoom;
  }
  if (_roomCreating.has(channelId)) return _roomCreating.get(channelId)!;

  if (sfuRooms.size >= MAX_ROOMS) {
    throw new Error(`[mediasoup] getOrCreateRoom: maksimum room sayısına ulaşıldı (${MAX_ROOMS}). Yeni oda oluşturulamaz.`);
  }

  const creationPromise = (async (): Promise<SfuRoom> => {
    try {
      const { worker, index: workerIdx } = getNextWorkerWithIndex();
      const router = await worker.createRouter({ mediaCodecs: config.mediaCodecs });
      incrementWorkerLoad(workerIdx);

      const room: SfuRoom = { router, peers: new Map(), createdAt: Date.now(), channelId, _workerIndex: workerIdx };
      sfuRooms.set(channelId, room);

      sfuRegistry.claimRoom(channelId).catch((err: Error) =>
        logger.warn({ detail: err.message }, '[SFU] Registry claimRoom hatası:')
      );

      room._refreshInterval = setInterval(
        () => sfuRegistry.refreshRoom(channelId).catch(() => {}),
        10 * 60 * 1000
      );
      room._refreshInterval.unref?.();

      const workerCloseCapableRouter = router as MediasoupRouter & { on?: (event: string, listener: () => void) => void };
      if (typeof workerCloseCapableRouter.on === 'function') {
        workerCloseCapableRouter.on('workerclose', () => {
          logger.warn(`[SFU] Worker kapandı, room temizleniyor — channel: ${channelId}`);
          clearInterval(room._refreshInterval);
          _clearScheduledRoomCleanup(channelId);
          if (room._workerIndex !== undefined) decrementWorkerLoad(room._workerIndex);
          sfuRooms.delete(channelId);
          sfuRegistry.releaseRoom(channelId).catch(() => {});
        });
      }

      logger.info(`[SFU] Room oluşturuldu — channel: ${channelId}, node: ${sfuRegistry.INSTANCE_ID}`);
      return room;
    } finally {
      _roomCreating.delete(channelId);
    }
  })();

  _roomCreating.set(channelId, creationPromise);
  return creationPromise;
}

export function cleanupRoom(channelId: string): void {
  _clearScheduledRoomCleanup(channelId);
  const room = sfuRooms.get(channelId);
  if (!room) return;
  if (room.peers.size === 0) {
    clearInterval(room._refreshInterval);
    if (room._workerIndex !== undefined) decrementWorkerLoad(room._workerIndex);
    room.router.close();
    sfuRooms.delete(channelId);
    sfuRegistry.releaseRoom(channelId).catch(() => {});
    logger.info(`[SFU] Boş room temizlendi — channel: ${channelId}`);
  }
}

// ── Transport factory ────────────────────────────────────────────────────────

export async function createWebRtcTransport(router: MediasoupRouter): Promise<MediasoupTransport> {
  const opts: import('./types').WebRtcTransportConfig = {
    ...config.webRtcTransport,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  };
  const transport = await router.createWebRtcTransport(opts);

  if (config.webRtcTransport.maxIncomingBitrate && transport.setMaxIncomingBitrate) {
    try {
      await transport.setMaxIncomingBitrate(config.webRtcTransport.maxIncomingBitrate);
    } catch { /* eski mediasoup versiyonlarında mevcut değil */ }
  }

  return transport;
}

// ── Peer helpers ─────────────────────────────────────────────────────────────

export function getRoomPeerList(channelId: string): Array<{
  socketId:    string;
  userId:      string;
  displayName: string;
  avatarColor: string;
}> {
  const room = sfuRooms.get(channelId);
  if (!room) return [];
  return [...room.peers.entries()].map(([sid, p]) => ({
    socketId:    sid,
    userId:      p.userId,
    displayName: p.displayName,
    avatarColor: p.avatarColor,
  }));
}

export async function cleanupPeer(
  socketId:  string,
  io:        { to(r: string): { emit(ev: string, d: unknown): void } },
  channelId: string | undefined,
  serverId:  string | undefined
): Promise<void> {
  const peer = sfuPeers.get(socketId);
  if (!peer) return;

  const ch = channelId ?? peer.channelId;
  const sv = serverId  ?? peer.serverId ?? undefined;

  for (const consumer of peer.consumers.values()) consumer.close();
  for (const producer of peer.producers.values()) producer.close();
  peer.sendTransport?.close();
  peer.recvTransport?.close();

  sfuPeers.delete(socketId);

  const room = sfuRooms.get(ch);
  if (room) {
    room.peers.delete(socketId);
    io.to(`voice:${ch}`).emit('sfu:peer-left', { socketId, userId: peer.userId });
    if (sv) {
      io.to(`server:${sv}`).emit('voice:room-update', {
        channelId: ch,
        peers: getRoomPeerList(ch),
      });
    }
    _scheduleRoomCleanup(ch);
  }
}

/** @internal Test ortamında room/peer map'lerini sıfırlar. Production'da çağrılmaz. */
export function _resetRoomsForTest(): void {
  for (const room of sfuRooms.values()) clearInterval(room._refreshInterval);
  for (const timer of _pendingRoomCleanupTimers.values()) clearTimeout(timer);
  _pendingRoomCleanupTimers.clear();
  sfuRooms.clear();
  sfuPeers.clear();
}
