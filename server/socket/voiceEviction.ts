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
import { cleanupPeer, sfuPeers } from './handlers/mediasoup/rooms';

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
    logger.info({ userId, channelId, sfu: Boolean(sfuChannel), event: 'socket.voice_evicted' },
      'Voice session evicted after access revocation.');
  }
}
