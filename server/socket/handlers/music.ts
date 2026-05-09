// server/socket/handlers/music.js
const { v4: uuidv4 } = require('uuid');
const { getVideoInfo, getStreamUrl, getQueue, skipCurrent, clearQueue } = require('../../music');

function systemMsg(channelId, serverId, content) {
  return { _id: uuidv4(), channelId, serverId, userId: 'system', username: 'Bridge Bot', displayName: '🤖 Bridge Bot', avatarColor: '#5865f2', content, type: 'system', reactions: {}, createdAt: Date.now() };
}

function formatDuration(s) {
  if (!s) return '?:??';
  const m = Math.floor(s / 60); const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

async function handleMusicCommand({ content, channelId, serverId, user, io, socket }) {
  const parts = content.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === '!play') {
    const url = parts[1];
    if (!url) { io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, '🎵 Usage: !play <YouTube URL>')); return true; }
    io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, `🔍 Fetching: ${url}`));
    try {
      const info = await getVideoInfo(url);
      const streamUrl = await getStreamUrl(url);
      const q = getQueue(channelId);
      const track = { ...info, streamUrl, requestedBy: user.displayName };
      if (!q.current) {
        q.current = track;
        io.to(`channel:${channelId}`).emit('music:play', { channelId, track });
        io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, `🎵 Now playing: **${info.title}** (${formatDuration(info.duration)}) — ${user.displayName}`));
      } else {
        if (q.queue.length >= 25) { io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, '❌ Queue full (max 25).')); return true; }
        q.queue.push(track);
        io.to(`channel:${channelId}`).emit('music:queued', { channelId, track, position: q.queue.length });
        io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, `📋 Added to queue (#${q.queue.length}): **${info.title}** — ${user.displayName}`));
      }
    } catch (e) {
      const safeMsg = (e.message || '').startsWith('Only YouTube') || (e.message || '').startsWith('Could not') ? e.message : 'Could not process that URL.';
      io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, `❌ ${safeMsg}`));
    }
    return true;
  }
  if (cmd === '!skip') {
    const next = skipCurrent(channelId);
    const q = getQueue(channelId);
    if (next) { q.current = next; io.to(`channel:${channelId}`).emit('music:play', { channelId, track: next }); io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, `⏭️ Skipped. Now: **${next.title}**`)); }
    else { q.current = null; io.to(`channel:${channelId}`).emit('music:stop', { channelId }); io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, '⏹️ Queue ended.')); }
    return true;
  }
  if (cmd === '!stop')  { clearQueue(channelId); io.to(`channel:${channelId}`).emit('music:stop', { channelId }); io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, '⏹️ Stopped.')); return true; }
  if (cmd === '!queue') {
    const q = getQueue(channelId);
    if (!q.current) { io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, '🎵 Queue empty.')); }
    else {
      const lines = [`🎵 **Now:** ${q.current.title} (${formatDuration(q.current.duration)})`];
      q.queue.forEach((t, i) => lines.push(`${i + 1}. ${t.title} — ${t.requestedBy}`));
      io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, lines.join('\n')));
    }
    return true;
  }
  if (cmd === '!help') { io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, serverId, '🤖 **Commands:** !play <url> · !skip · !stop · !queue')); return true; }
  return false;
}

function registerMusicHandlers(socket, io, user) {
  socket.on('music:ended', ({ channelId }) => {
    const q = getQueue(channelId);
    const next = q.queue.shift() || null;
    q.current = next;
    if (next) {
      io.to(`channel:${channelId}`).emit('music:play', { channelId, track: next });
      io.to(`channel:${channelId}`).emit('message:new', systemMsg(channelId, null, `🎵 Now playing: **${next.title}**`));
    } else {
      io.to(`channel:${channelId}`).emit('music:stop', { channelId });
    }
  });
}

module.exports = { handleMusicCommand, registerMusicHandlers };
export {};
