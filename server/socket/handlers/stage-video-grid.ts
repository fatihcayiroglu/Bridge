// server/socket/handlers/stage-video-grid.ts — Sprint 83
// Stage channel'larda gerçek SFU video stream'lerini grid layout'a bağlar.
// Sprint 118: Tüm socket.on handler'larına try/catch eklendi.
//
// Yeni olaylar (client ↔ server):
//   stage:video-join      → kullanıcı video grid'e katılır (cam/screen açar)
//   stage:video-leave     → grid'den ayrılır
//   stage:video-state     → sunucunun mevcut grid durumunu gönderdiği olay
//   stage:video-update    → bir peer'ın video state'i değiştiğinde broadcast
//   stage:video-layout    → istemcinin preferred layout'u (spotlight / grid)

import type { HandlerSocket, HandlerServer } from '../handler-contracts';
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
import { sfuPeers } from './mediasoup/rooms';
import logger from '../../lib/logger';
import { canManageStage, isStageParticipant, isStageSpeaker } from './stage';
import { isolateSocketHandler } from '../handlerIsolation';


// ── Tipler ────────────────────────────────────────────────────────────────────

export interface VideoGridPeer {
  socketId:     string;
  userId:       string;
  displayName:  string;
  avatarColor:  string;
  hasCamera:    boolean;
  hasScreen:    boolean;
  muted:        boolean;
  deafened:     boolean;
  speaking:     boolean;
  joinedAt:     number;
}

export interface VideoGridRoom {
  channelId:   string;
  peers:       Map<string, VideoGridPeer>;
  layout:      'grid' | 'spotlight';
  spotlightId: string | null;
  createdAt:   number;
}

export const videoGridRooms = new Map<string, VideoGridRoom>();

// ── Yardımcılar ───────────────────────────────────────────────────────────────

function getOrCreateGridRoom(channelId: string): VideoGridRoom {
  if (videoGridRooms.has(channelId)) return videoGridRooms.get(channelId)!;
  const room: VideoGridRoom = {
    channelId,
    peers:       new Map(),
    layout:      'grid',
    spotlightId: null,
    createdAt:   Date.now(),
  };
  videoGridRooms.set(channelId, room);
  return room;
}

function serializeGridRoom(room: VideoGridRoom) {
  return {
    channelId:   room.channelId,
    layout:      room.layout,
    spotlightId: room.spotlightId,
    peers:       [...room.peers.values()].map(p => ({ ...p })),
  };
}

function readSfuVideoState(socketId: string): { hasCamera: boolean; hasScreen: boolean; muted: boolean; deafened: boolean } {
  try {
    const sfu = sfuPeers.get(socketId);
    if (!sfu) return { hasCamera: false, hasScreen: false, muted: false, deafened: false };
    return {
      hasCamera: sfu.video ?? sfu.producers.has('video') ?? false,
      hasScreen: sfu.screensharing ?? sfu.producers.has('screen') ?? false,
      muted:     sfu.muted ?? false,
      deafened:  sfu.deafened ?? false,
    };
  } catch {
    return { hasCamera: false, hasScreen: false, muted: false, deafened: false };
  }
}

// ── Handler kaydı ─────────────────────────────────────────────────────────────

export function registerVideoGridHandlers(
  socket: HandlerSocket,
  io:     HandlerServer,
  user:   { _id: string; displayName: string; avatarColor: string },
): void {

  socket.on('stage:video-join', isolateSocketHandler(socket, 'stage:video-join', async (payload: { channelId: string }) => {
    try {
      if (!validateSocketPayload(payload, socketSchemas.stageVideoChannelId).valid) return;
      const { channelId } = payload;
      if (!channelId) return;
      const sfuPeer = sfuPeers.get(socket.id);
      if (!sfuPeer || sfuPeer.channelId !== channelId || !await isStageParticipant(channelId, user._id, socket.id)) {
        socket.emit('stage:video-error', { message: 'Aktif stage/medya odasıyla video grid eşleşmiyor.' });
        return;
      }
      const sfuState = readSfuVideoState(socket.id);
      const room = getOrCreateGridRoom(sfuPeer.channelId);
      const peer: VideoGridPeer = {
        socketId:    socket.id,
        userId:      user._id,
        displayName: user.displayName,
        avatarColor: user.avatarColor,
        hasCamera:   sfuState.hasCamera,
        hasScreen:   sfuState.hasScreen,
        muted:       sfuState.muted,
        deafened:    sfuState.deafened,
        speaking:    false,
        joinedAt:    Date.now(),
      };
      room.peers.set(socket.id, peer);
      socket.join(`video-grid:${channelId}`);
      socket.emit('stage:video-state', serializeGridRoom(room));
      socket.to(`video-grid:${channelId}`).emit('stage:video-update', { type: 'peer-joined', peer: { ...peer } });
      logger.debug({ event: 'video_grid.join', channelId, userId: user._id }, 'peer joined video grid');
    } catch (err) {
      logger.error({ event: 'video_grid.join.error', err }, 'stage:video-join hatası');
    }
  }));

  socket.on('stage:video-leave', isolateSocketHandler(socket, 'stage:video-leave', async (payload: { channelId: string }) => {
    try {
      if (!validateSocketPayload(payload, socketSchemas.stageVideoChannelId).valid) return;
      const { channelId } = payload;
      if (!channelId) return;

      // Leaving the presentation grid is owned by the Socket.IO room + grid
      // membership itself, not by the mediasoup peer index. `sfu:leave` may
      // already have removed that index by the time this handler runs. The old
      // guard therefore stranded sockets in `video-grid:<channelId>`, letting a
      // user that had left continue receiving later grid/layout metadata.
      _removePeerFromGrid(socket.id, channelId, io);
      await socket.leave(`video-grid:${channelId}`);
    } catch (err) {
      logger.error({ event: 'video_grid.leave.error', err }, 'stage:video-leave hatası');
    }
  }));

  // The canonical WebRTC client leaves via `sfu:leave`; it does not need to
  // remember to send a second feature-specific teardown event. Register an
  // independent cleanup listener so event-handler ordering cannot leave stale
  // grid membership after mediasoup has deleted `sfuPeers`.
  socket.on('sfu:leave', isolateSocketHandler(socket, 'stage-video-grid:sfu-leave', async (payload: { channelId?: string }) => {
    try {
      const channelId = typeof payload?.channelId === 'string' ? payload.channelId : '';
      if (!channelId || channelId.length > 64) return;
      _removePeerFromGrid(socket.id, channelId, io);
      await socket.leave(`video-grid:${channelId}`);
    } catch (err) {
      logger.error({ event: 'video_grid.sfu_leave.error', err }, 'sfu:leave grid temizliği hatası');
    }
  }));

  socket.on('stage:video-layout', isolateSocketHandler(socket, 'stage:video-layout', async (payload: { channelId: string; layout: 'grid' | 'spotlight'; spotlightId?: string }) => {
    try {
      if (!validateSocketPayload(payload, socketSchemas.stageVideoLayout).valid) return;
      const { channelId, layout, spotlightId } = payload;
      const sfuPeer = sfuPeers.get(socket.id);
      if (!sfuPeer || sfuPeer.channelId !== channelId) return;
      const room = videoGridRooms.get(sfuPeer.channelId);
      if (!room || !room.peers.has(socket.id)) return;
      if (!await canManageStage(sfuPeer.channelId, user._id)) {
        socket.emit('stage:video-error', { message: 'Layout değiştirme izniniz yok.' });
        return;
      }
      if (layout === 'spotlight' && spotlightId && !room.peers.has(spotlightId)) {
        socket.emit('stage:video-error', { message: 'Spotlight hedefi bu video odasında değil.' });
        return;
      }
      room.layout      = layout;
      room.spotlightId = layout === 'spotlight' ? (spotlightId ?? socket.id) : null;
      io.to(`video-grid:${sfuPeer.channelId}`).emit('stage:video-layout-changed', { layout, spotlightId: room.spotlightId });
    } catch (err) {
      logger.error({ event: 'video_grid.layout.error', err }, 'stage:video-layout hatası');
    }
  }));

  socket.on('sfu:produced', isolateSocketHandler(socket, 'sfu:produced', (payload: { kind: string }) => {
    try {
      if (!validateSocketPayload(payload, socketSchemas.sfuProduced).valid) return;
      const { kind } = payload;
      _syncSfuStateToGrid(socket.id);
      if (kind === 'video' || kind === 'screen') _broadcastPeerUpdate(socket.id, io);
    } catch (err) {
      logger.error({ event: 'video_grid.sfu_produced.error', err }, 'sfu:produced grid sync hatası');
    }
  }));

  socket.on('voice:activity', isolateSocketHandler(socket, 'voice:activity', async (payload: { channelId: string; speaking: boolean }) => {
    try {
      if (!validateSocketPayload(payload, socketSchemas.voiceActivity).valid) return;
      const { channelId, speaking } = payload;
      const sfuPeer = sfuPeers.get(socket.id);
      if (!sfuPeer || sfuPeer.channelId !== channelId) return;
      if (!await isStageSpeaker(channelId, user._id, socket.id)) return;
      const room = videoGridRooms.get(sfuPeer.channelId);
      if (!room) return;
      const peer = room.peers.get(socket.id);
      if (!peer) return;
      peer.speaking = speaking;
      io.to(`video-grid:${sfuPeer.channelId}`).emit('stage:video-update', { type: 'speaking', socketId: socket.id, speaking });
    } catch (err) {
      logger.error({ event: 'video_grid.voice_activity.error', err }, 'voice:activity grid hatası');
    }
  }));

  socket.on('voice:state-update', isolateSocketHandler(socket, 'voice:state-update', async (payload: { channelId: string; muted: boolean; deafened: boolean; screensharing: boolean; video: boolean }) => {
    try {
      if (!validateSocketPayload(payload, socketSchemas.voiceStateUpdate).valid) return;
      const { channelId } = payload;
      const sfuPeer = sfuPeers.get(socket.id);
      if (!sfuPeer || sfuPeer.channelId !== channelId) return;
      const room = videoGridRooms.get(sfuPeer.channelId);
      if (!room) return;
      const peer = room.peers.get(socket.id);
      if (!peer) return;

      // Camera/screen presence is authoritative only when a mediasoup producer
      // actually exists. Never let client booleans paint fake Stage media.
      const sfuState = readSfuVideoState(socket.id);
      const speaker = await isStageSpeaker(channelId, user._id, socket.id);
      peer.muted = speaker ? sfuState.muted : true;
      peer.deafened = sfuState.deafened;
      peer.hasCamera = speaker && sfuState.hasCamera;
      peer.hasScreen = speaker && sfuState.hasScreen;
      if (!speaker) peer.speaking = false;
      io.to(`video-grid:${sfuPeer.channelId}`).emit('stage:video-update', {
        type: 'state', socketId: socket.id, muted: peer.muted, deafened: peer.deafened,
        hasCamera: peer.hasCamera, hasScreen: peer.hasScreen,
      });
    } catch (err) {
      logger.error({ event: 'video_grid.state_update.error', err }, 'voice:state-update grid hatası');
    }
  }));

  socket.on('disconnect', isolateSocketHandler(socket, 'disconnect', () => {
    try {
      for (const [channelId, room] of videoGridRooms) {
        if (room.peers.has(socket.id)) _removePeerFromGrid(socket.id, channelId, io);
      }
    } catch (err) {
      logger.error({ event: 'video_grid.disconnect.error', err }, 'video-grid disconnect temizliği hatası');
    }
  }));
}

// ── İç yardımcılar ────────────────────────────────────────────────────────────

export const registerStageVideoGridHandlers = registerVideoGridHandlers;

function _removePeerFromGrid(socketId: string, channelId: string, io: HandlerServer): void {
  const room = videoGridRooms.get(channelId);
  if (!room) return;
  room.peers.delete(socketId);
  if (room.spotlightId === socketId) { room.spotlightId = null; room.layout = 'grid'; }
  if (room.peers.size === 0) {
    videoGridRooms.delete(channelId);
    logger.debug({ event: 'video_grid.room_removed', channelId }, 'video grid odası kaldırıldı');
  } else {
    io.to(`video-grid:${channelId}`).emit('stage:video-update', { type: 'peer-left', socketId });
  }
}

function _syncSfuStateToGrid(socketId: string): void {
  const sfuState = readSfuVideoState(socketId);
  for (const room of videoGridRooms.values()) {
    const peer = room.peers.get(socketId);
    if (peer) {
      peer.hasCamera = sfuState.hasCamera;
      peer.hasScreen = sfuState.hasScreen;
      peer.muted     = sfuState.muted;
      peer.deafened  = sfuState.deafened;
    }
  }
}

function _broadcastPeerUpdate(socketId: string, io: HandlerServer): void {
  for (const [channelId, room] of videoGridRooms) {
    const peer = room.peers.get(socketId);
    if (peer) {
      io.to(`video-grid:${channelId}`).emit('stage:video-update', {
        type: 'state', socketId, hasCamera: peer.hasCamera, hasScreen: peer.hasScreen,
        muted: peer.muted, deafened: peer.deafened,
      });
    }
  }
}
