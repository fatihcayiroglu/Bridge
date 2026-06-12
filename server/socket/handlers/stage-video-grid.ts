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

import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
import type { Socket, Server as IOServer } from 'socket.io';
import { sfuPeers } from './mediasoup/rooms';
import logger from '../../lib/logger';

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
  socket: Socket,
  io:     IOServer,
  user:   { _id: string; displayName: string; avatarColor: string },
): void {

  socket.on('stage:video-join', (payload: { channelId: string }) => {
    try {
      if (!validateSocketPayload(payload, socketSchemas.stageVideoChannelId).valid) return;
      const { channelId } = payload;
      if (!channelId) return;
      const sfuState = readSfuVideoState(socket.id);
      const room = getOrCreateGridRoom(channelId);
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
  });

  socket.on('stage:video-leave', (payload: { channelId: string }) => {
    try {
      if (!validateSocketPayload(payload, socketSchemas.stageVideoChannelId).valid) return;
      const { channelId } = payload;
      if (!channelId) return;
      _removePeerFromGrid(socket.id, channelId, io);
    } catch (err) {
      logger.error({ event: 'video_grid.leave.error', err }, 'stage:video-leave hatası');
    }
  });

  socket.on('stage:video-layout', ({
    channelId, layout, spotlightId,
  }: { channelId: string; layout: 'grid' | 'spotlight'; spotlightId?: string }) => {
    try {
      if (!channelId) return;
      const room = videoGridRooms.get(channelId);
      if (!room) return;
      const peers = [...room.peers.values()];
      const isHost = peers.length === 0 || peers[0].userId === user._id;
      if (!isHost) {
        socket.emit('stage:video-error', { message: 'Layout değiştirme izniniz yok.' });
        return;
      }
      room.layout      = layout;
      room.spotlightId = spotlightId ?? null;
      io.to(`video-grid:${channelId}`).emit('stage:video-layout-changed', { layout, spotlightId: room.spotlightId });
    } catch (err) {
      logger.error({ event: 'video_grid.layout.error', err }, 'stage:video-layout hatası');
    }
  });

  socket.on('sfu:produced', (payload: { kind: string }) => {
    try {
      if (!validateSocketPayload(payload, socketSchemas.sfuProduced).valid) return;
      const { kind } = payload;
      _syncSfuStateToGrid(socket.id);
      if (kind === 'video' || kind === 'screen') _broadcastPeerUpdate(socket.id, io);
    } catch (err) {
      logger.error({ event: 'video_grid.sfu_produced.error', err }, 'sfu:produced grid sync hatası');
    }
  });

  socket.on('voice:activity', (payload: { channelId: string; speaking: boolean }) => {
    try {
      if (!validateSocketPayload(payload, socketSchemas.voiceActivity).valid) return;
      const { channelId, speaking } = payload;
      const room = videoGridRooms.get(channelId);
      if (!room) return;
      const peer = room.peers.get(socket.id);
      if (!peer) return;
      peer.speaking = speaking;
      io.to(`video-grid:${channelId}`).emit('stage:video-update', { type: 'speaking', socketId: socket.id, speaking });
    } catch (err) {
      logger.error({ event: 'video_grid.voice_activity.error', err }, 'voice:activity grid hatası');
    }
  });

  socket.on('voice:state-update', ({
    channelId, muted, deafened, screensharing, video,
  }: { channelId: string; muted: boolean; deafened: boolean; screensharing: boolean; video: boolean }) => {
    try {
      const room = videoGridRooms.get(channelId);
      if (!room) return;
      const peer = room.peers.get(socket.id);
      if (!peer) return;
      peer.muted    = muted;
      peer.deafened = deafened;
      peer.hasCamera = video;
      peer.hasScreen = screensharing;
      io.to(`video-grid:${channelId}`).emit('stage:video-update', {
        type: 'state', socketId: socket.id, muted, deafened, hasCamera: video, hasScreen: screensharing,
      });
    } catch (err) {
      logger.error({ event: 'video_grid.state_update.error', err }, 'voice:state-update grid hatası');
    }
  });

  socket.on('disconnect', () => {
    try {
      for (const [channelId, room] of videoGridRooms) {
        if (room.peers.has(socket.id)) _removePeerFromGrid(socket.id, channelId, io);
      }
    } catch (err) {
      logger.error({ event: 'video_grid.disconnect.error', err }, 'video-grid disconnect temizliği hatası');
    }
  });
}

// ── İç yardımcılar ────────────────────────────────────────────────────────────

function _removePeerFromGrid(socketId: string, channelId: string, io: IOServer): void {
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

function _broadcastPeerUpdate(socketId: string, io: IOServer): void {
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
