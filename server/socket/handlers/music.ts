// server/socket/handlers/music.ts
import type { HandlerSocket, HandlerServer } from '../handler-contracts';
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
import type { Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { getVideoInfo, getStreamUrl, readMusicQueue, mutateMusicQueue, skipSharedMusicQueue, clearSharedMusicQueue, isValidMusicUrl, type MusicTrack } from '../../music';
import { isolateSocketHandler } from '../handlerIsolation';


type UserRecord = { _id: string; username?: string; displayName?: string; avatarColor?: string; avatarUrl?: string | null };

function systemMsg(channelId: string, serverId: string | null, content: string) {
  return {
    _id:         uuidv4(),
    channelId,
    serverId,
    userId:      'system',
    username:    'Bridge Bot',
    displayName: '🤖 Bridge Bot',
    avatarColor: '#2d9cdb',
    content,
    type:        'system',
    reactions:   {},
    createdAt:   Date.now(),
  };
}

function formatDuration(s: number | undefined): string {
  if (!s) return '?:??';
  const m   = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

async function handleMusicCommand({
  content,
  channelId,
  serverId,
  user,
  io,
}: {
  content:   string;
  channelId: string;
  serverId:  string;
  user:      UserRecord;
  io:        HandlerServer;
  socket:    HandlerSocket;
}): Promise<boolean> {
  const parts = content.trim().split(/\s+/);
  const cmd   = (parts[0] ?? '').toLowerCase();

  if (cmd === '!play') {
    const url = parts[1];
    if (!url) {
      io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, '🎵 Usage: !play <YouTube/SoundCloud URL>'));
      return true;
    }
    if (!isValidMusicUrl(url)) {
      io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId,
        '❌ Only YouTube or SoundCloud HTTP(S) URLs are supported.'));
      return true;
    }
    io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, `🔍 Fetching: ${url}`));
    try {
      const info      = await getVideoInfo(url);
      const streamUrl = await getStreamUrl(url);
      const track: MusicTrack = { ...info, streamUrl, requestedBy: user.displayName };
      const outcome = await mutateMusicQueue(channelId, queue => {
        if (queue.queue.length >= 25) return { kind: 'full' as const };
        if (!queue.current) {
          queue.current = track;
          return { kind: 'play' as const };
        }
        queue.queue.push(track);
        return { kind: 'queued' as const, position: queue.queue.length };
      });

      if (outcome.kind === 'full') {
        io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, '❌ Queue full (max 25).'));
        return true;
      }
      if (outcome.kind === 'play') {
        io.to(`channel:${channelId}`).emit('music:play', { channelId, track });
        io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId,
          `🎵 Now playing: **${info.title}** (${formatDuration(info.duration)}) — ${user.displayName}`));
      } else {
        io.to(`channel:${channelId}`).emit('music:queued', { channelId, track, position: outcome.position });
        io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId,
          `📋 Added to queue (#${outcome.position}): **${info.title}** — ${user.displayName}`));
      }
    } catch (e: unknown) {
      const msg    = e instanceof Error ? e.message : '';
      const safeMsg = (msg.startsWith('Only YouTube') || msg.startsWith('Could not'))
        ? msg
        : 'Could not process that URL.';
      io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, `❌ ${safeMsg}`));
    }
    return true;
  }

  if (cmd === '!skip') {
    const next = await skipSharedMusicQueue(channelId);
    if (next) {
      io.to(`channel:${channelId}`).emit('music:play', { channelId, track: next });
      io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, `⏭️ Skipped. Now: **${next.title}**`));
    } else {
      io.to(`channel:${channelId}`).emit('music:stop', { channelId });
      io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, '⏹️ Queue ended.'));
    }
    return true;
  }

  if (cmd === '!stop') {
    await clearSharedMusicQueue(channelId);
    io.to(`channel:${channelId}`).emit('music:stop', { channelId });
    io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, '⏹️ Stopped.'));
    return true;
  }

  if (cmd === '!queue') {
    const q = await readMusicQueue(channelId);
    if (!q.current) {
      io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, '🎵 Queue empty.'));
    } else {
      const lines = [`🎵 **Now:** ${q.current.title} (${formatDuration(q.current.duration)})`];
      q.queue.forEach((t, i) => lines.push(`${i + 1}. ${t.title} — ${t.requestedBy ?? 'Unknown'}`));
      io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, lines.join('\n')));
    }
    return true;
  }

  if (cmd === '!help') {
    io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId,
      '🤖 **Commands:** !play <url> · !skip · !stop · !queue'));
    return true;
  }

  return false;
}

function registerMusicHandlers(socket: HandlerSocket, io: HandlerServer, _user: UserRecord): void {
  socket.on('music:ended', isolateSocketHandler(socket, 'music:ended', (payload: { channelId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.musicEnded).valid) return;
    const { channelId } = payload;
    const activeVoice = (socket as Socket & { currentVoiceChannel?: string | null }).currentVoiceChannel;
    if (activeVoice !== channelId || !socket.rooms.has(`voice:${channelId}`)) return;
    return (async () => {
      const next = await skipSharedMusicQueue(channelId);
      if (next) {
        io.to(`channel:${channelId}`).emit('music:play', { channelId, track: next });
        io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, null,
          `🎵 Now playing: **${next.title}**`));
      } else {
        io.to(`channel:${channelId}`).emit('music:stop', { channelId });
      }
    })();
  }));
}

export { handleMusicCommand, registerMusicHandlers };
