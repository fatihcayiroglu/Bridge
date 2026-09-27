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
const _roomLeaseWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

function _clearRoomLeaseWatchdog(channelId: string): void {
  const timer = _roomLeaseWatchdogs.get(channelId);
  if (timer !== undefined) clearTimeout(timer);
  _roomLeaseWatchdogs.delete(channelId);
}

function _invalidateRoomOwnership(channelId: string, expectedRoom: SfuRoom, reason: string): void {
  if (sfuRooms.get(channelId) !== expectedRoom) return;
  clearInterval(expectedRoom._refreshInterval);
  _clearScheduledRoomCleanup(channelId);
  _clearRoomLeaseWatchdog(channelId);

  for (const [socketId, peer] of expectedRoom.peers) {
    for (const consumer of peer.consumers.values()) { try { consumer.close(); } catch { /* best effort */ } }
    for (const producer of peer.producers.values()) { try { producer.close(); } catch { /* best effort */ } }
    try { peer.sendTransport?.close(); } catch { /* best effort */ }
    try { peer.recvTransport?.close(); } catch { /* best effort */ }
    sfuPeers.delete(socketId);
  }
  expectedRoom.peers.clear();
  sfuRooms.delete(channelId);
  if (expectedRoom._workerIndex !== undefined) decrementWorkerLoad(expectedRoom._workerIndex);
  try { expectedRoom.router.close(); } catch { /* already closed */ }
  logger.error({ channelId, reason, event: 'sfu.room.ownership_invalidated' },
    '[SFU] Room ownership can no longer be proven; local media state closed fail-closed.');
}

function _armRoomLeaseWatchdog(channelId: string, room: SfuRoom): void {
  _clearRoomLeaseWatchdog(channelId);
  // Stop shortly before this node's liveness lease can expire. Other nodes take
  // over a room whose owner's lease is gone (lib/sfuRegistry.ts); a node that
  // cannot renew while another node can reach Redis must not keep serving past
  // that boundary, or two independent routers could exist for one channel.
  const delayMs = Math.max(1_000, sfuRegistry.NODE_LEASE_MS - 5_000);
  const timer = setTimeout(() => _invalidateRoomOwnership(channelId, room, 'lease_refresh_unconfirmed'), delayMs);
  timer.unref?.();
  _roomLeaseWatchdogs.set(channelId, timer);
}

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

/**
 * Oda, kayıt defterine göre BAŞKA bir node'a ait. Çağıran istemciyi o node'a
 * yönlendirmelidir; yerel bir oda AÇILMAMALIDIR (bkz. lib/sfuRegistry.ts).
 */
export class RoomOwnedElsewhereError extends Error {
  constructor(public readonly channelId: string, public readonly ownerNodeId: string | null) {
    super(`[mediasoup] Room ${channelId} is owned by node ${ownerNodeId ?? 'unknown'}`);
    this.name = 'RoomOwnedElsewhereError';
  }
}

export async function getOrCreateRoom(channelId: string): Promise<SfuRoom> {
  const existingRoom = sfuRooms.get(channelId);
  if (existingRoom) {
    _clearScheduledRoomCleanup(channelId);
    return existingRoom;
  }
  if (_roomCreating.has(channelId)) return _roomCreating.get(channelId)!;

  // Include in-flight creations. Without this, a burst of distinct channels
  // can all pass the size check before any router reaches sfuRooms.
  if (sfuRooms.size + _roomCreating.size >= MAX_ROOMS) {
    throw new Error(`[mediasoup] getOrCreateRoom: maksimum room sayısına ulaşıldı (${MAX_ROOMS}). Yeni oda oluşturulamaz.`);
  }

  const creationPromise = (async (): Promise<SfuRoom> => {
    let ownershipClaimed = false;
    try {
      // ── ÖNCE SAHİPLİK, SONRA ROUTER ────────────────────────────────────
      // Kayıt talebi eskiden router OLUŞTURULDUKTAN SONRA ve ATEŞLE-UNUT
      // olarak yapılıyordu. Kayıt ise koşulsuz `SETEX` kullandığı için iki
      // node aynı kanal için AYNI ANDA oda açıp ikisi de "sahibim" diyebiliyordu
      // (bkz. lib/sfuRegistry.ts:claimRoom). Sonuç: aynı kanal için İKİ SFU
      // odası ve birbirini duyamayan katılımcılar.
      //
      // Artık talep ATOMİKTİR (`SET NX EX`) ve ÖNCE yapılır: kaybedersek
      // pahalı router hiç oluşturulmaz ve çağıran doğru node'a yönlendirir.
      // A configured registry is the ownership authority. If it is unavailable,
      // do not guess that this node owns the room: in a multi-node deployment
      // that guess can create two independent routers for the same channel.
      const claim = await sfuRegistry.claimRoom(channelId);

      if (!claim.owned) {
        logger.info({ channelId, owner: claim.owner, event: 'sfu.room.claim_lost' },
          '[SFU] Oda başka bir node tarafından sahiplenildi; yerel oda açılmıyor.');
        throw new RoomOwnedElsewhereError(channelId, claim.owner);
      }
      ownershipClaimed = true;

      const { worker, index: workerIdx } = getNextWorkerWithIndex();
      const router = await worker.createRouter({ mediaCodecs: config.mediaCodecs });
      incrementWorkerLoad(workerIdx);

      const room: SfuRoom = { router, peers: new Map(), createdAt: Date.now(), channelId, _workerIndex: workerIdx };
      sfuRooms.set(channelId, room);
      _armRoomLeaseWatchdog(channelId, room);
      // RTP-capability discovery creates the router before a peer joins. If the
      // client disappears between those steps, reclaim the otherwise-empty
      // router/Redis lease instead of leaking toward MAX_ROOMS forever. A real
      // join cancels this timer through the existing-room path above.
      _scheduleRoomCleanup(channelId);

      room._refreshInterval = setInterval(
        () => {
          void sfuRegistry.refreshRoom(channelId).then((stillOwned) => {
            if (sfuRooms.get(channelId) !== room) return;
            if (stillOwned === false) {
              _invalidateRoomOwnership(channelId, room, 'lease_owned_by_another_node');
              return;
            }
            _armRoomLeaseWatchdog(channelId, room);
          }).catch((err: Error) => {
            // Keep the existing lease only until its watchdog deadline. A
            // transient outage need not drop calls immediately, while a long
            // partition can never outlive the last confirmed Redis lease.
            logger.warn({ err: err.message, channelId, event: 'sfu.registry.refresh_failed' }, '[SFU] Registry room lease refresh failed.');
          });
        },
        sfuRegistry.NODE_HEARTBEAT_MS,
      );
      room._refreshInterval.unref?.();

      const workerCloseCapableRouter = router as MediasoupRouter & { on?: (event: string, listener: () => void) => void };
      if (typeof workerCloseCapableRouter.on === 'function') {
        workerCloseCapableRouter.on('workerclose', () => {
          logger.warn(`[SFU] Worker kapandı, room temizleniyor — channel: ${channelId}`);
          clearInterval(room._refreshInterval);
          _clearScheduledRoomCleanup(channelId);
          _clearRoomLeaseWatchdog(channelId);

          // `sfuPeers` is a global socket -> peer index used by every later SFU
          // command (and the stage video grid). A mediasoup worker closes all
          // native transports, but it does not remove our JavaScript indexes.
          // Leaving these entries behind made a dead worker look like an active
          // media session until each client happened to reconnect/leave.
          for (const socketId of room.peers.keys()) sfuPeers.delete(socketId);
          room.peers.clear();

          if (room._workerIndex !== undefined) decrementWorkerLoad(room._workerIndex);
          if (sfuRooms.get(channelId) === room) sfuRooms.delete(channelId);
          sfuRegistry.releaseRoom(channelId).catch((err: Error) => {
            logger.warn({ err: err.message, channelId, event: 'sfu.registry.release_failed' }, '[SFU] Registry room release failed after worker close.');
          });
        });
      }

      logger.info(`[SFU] Room oluşturuldu — channel: ${channelId}, node: ${sfuRegistry.INSTANCE_ID}`);
      return room;
    } catch (err) {
      // A failed worker/router creation must not strand ownership for an hour
      // and redirect healthy nodes back to a room that does not exist.
      if (ownershipClaimed && !sfuRooms.has(channelId)) {
        await sfuRegistry.releaseRoom(channelId).catch((releaseErr: Error) => {
          logger.warn({ err: releaseErr.message, channelId, event: 'sfu.registry.release_failed' },
            '[SFU] Failed creation ownership lease could not be released.');
        });
      }
      throw err;
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
    _clearRoomLeaseWatchdog(channelId);
    if (room._workerIndex !== undefined) decrementWorkerLoad(room._workerIndex);
    room.router.close();
    sfuRooms.delete(channelId);
    sfuRegistry.releaseRoom(channelId).catch((err: Error) => {
      logger.warn({ err: err.message, channelId, event: 'sfu.registry.release_failed' }, '[SFU] Registry room release failed during cleanup.');
    });
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

/** Close every local media producer owned by one Stage account.
 *
 * This is intentionally account-scoped rather than socket-scoped: SFU
 * signaling can be redirected to a dedicated owner-node socket while Stage
 * control stays on the primary app socket. Closing the mediasoup Producer is
 * authoritative; connected consumers receive their normal `producerclose`
 * event and cannot keep rendering a demoted speaker's old stream. */
export function revokeStagePublishers(channelId: string, userId: string): number {
  const room = sfuRooms.get(channelId);
  if (!room) return 0;
  let closed = 0;
  for (const peer of room.peers.values()) {
    if (peer.userId !== userId) continue;
    for (const [kind, producer] of [...peer.producers.entries()]) {
      try { producer.close(); } catch { /* already closed */ }
      peer.producers.delete(kind);
      closed++;
    }
    peer.video = false;
    peer.screensharing = false;
    peer.muted = true;
  }
  return closed;
}

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
  io:        { to(r: string | string[]): { emit(ev: string, d: unknown): void } },
  // `null` DA KABUL EDILIR: `peer.channelId` / `peer.serverId` urunde
  // `string | null`dur ve her cagri yeri `?? undefined` yazmak zorunda
  // kaliyordu. Govde zaten `serverId ?? peer.serverId ?? undefined` diyor;
  // imza artik gercegi soyluyor.
  channelId: string | null | undefined,
  serverId:  string | null | undefined
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
      io.to([`voice:${ch}`, `channel:${ch}`]).emit('voice:room-update', {
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
  for (const timer of _roomLeaseWatchdogs.values()) clearTimeout(timer);
  _pendingRoomCleanupTimers.clear();
  _roomLeaseWatchdogs.clear();
  sfuRooms.clear();
  sfuPeers.clear();
}
