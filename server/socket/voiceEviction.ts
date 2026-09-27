// server/socket/voiceEviction.ts
//
// The node-local half of a voice revocation (see lib/liveMembership.ts). Runs on
// the node that HOLDS the socket — the only place where `currentVoiceChannel`
// and the mediasoup peer are real objects — and takes the same leave path as a
// disconnect: SFU peer teardown (producers, consumers, transports) and removal
// from the shared voice roster, which broadcasts `voice:peer-left` and a fresh
// `voice:room-update` so every remaining peer drops the evicted participant.

import type { Server as SocketIOServer } from 'socket.io';
import logger from '../lib/logger';
import { leaveVoice } from './handlers/voice';
import { cleanupPeer, revokeStagePublishers, sfuPeers } from './handlers/mediasoup/rooms';

type VoiceSocket = Parameters<typeof leaveVoice>[0] & {
  rooms: Set<string>;
  currentVoiceChannel?: string | null;
  currentVoiceServer?: string | null;
};

export async function evictLocalVoiceSessions(
  io: SocketIOServer,
  userId: string,
  channelIds: readonly string[],
): Promise<void> {
  const wanted = new Set(channelIds);
  // `.local`: only sockets held by THIS node, as real Socket instances.
  const sockets = await io.in(`user:${userId}`).local.fetchSockets();
  for (const remote of sockets) {
    const socket = remote as unknown as VoiceSocket;
    const peer = sfuPeers.get(socket.id);
    const sfuChannel = peer && wanted.has(peer.channelId) ? peer.channelId : null;
    const p2pChannel = socket.currentVoiceChannel && wanted.has(socket.currentVoiceChannel) ? socket.currentVoiceChannel : null;
    if (!sfuChannel && !p2pChannel) continue;

    if (sfuChannel) {
      socket.leave(`voice:${sfuChannel}`);
      await cleanupPeer(socket.id, io, sfuChannel, peer?.serverId ?? undefined);
    }
    const channelId = p2pChannel ?? sfuChannel!;
    await leaveVoice(socket, channelId, socket.currentVoiceServer ?? undefined, io);
    // Tell the evicted client: without this it only noticed through an ICE
    // failure (if ever) and kept showing a live call (P2 media lab, AZ-03).
    (socket as unknown as { emit?: (event: string, data: unknown) => void }).emit?.('voice:evicted', { channelId });
    logger.info({ userId, channelId, sfu: Boolean(sfuChannel), event: 'socket.voice_evicted' },
      'Voice session evicted after access revocation.');
  }
}

/**
 * The node-local half of a SPEAK revocation (lib/liveMembership.ts). The user
 * may keep listening, but every producer they publish in that room is closed
 * on this node (a no-op unless this node owns the room); other participants'
 * consumers receive `producerclose`. P2P voice has no server-side media to
 * close, so a P2P session in that channel is ended instead (fail closed).
 */
export async function revokeLocalVoicePublishing(
  io: SocketIOServer,
  userId: string,
  channelId: string,
): Promise<void> {
  // `revokeStagePublishers` is room-generic: every producer of that user in the room.
  const closed = revokeStagePublishers(channelId, userId);
  const sockets = await io.in(`user:${userId}`).local.fetchSockets();
  for (const remote of sockets) {
    const socket = remote as unknown as VoiceSocket;
    if (sfuPeers.has(socket.id) || socket.currentVoiceChannel !== channelId) continue;
    await leaveVoice(socket, channelId, socket.currentVoiceServer ?? undefined, io);
    logger.info({ userId, channelId, event: 'socket.voice_evicted' }, 'P2P voice session ended after speak revocation.');
  }
  if (closed) {
    logger.info({ userId, channelId, producers: closed, event: 'socket.voice_publish_revoked' },
      'Voice producers closed after speak revocation.');
  }
}
