// server/socket/handlers/voice.js
const { getQueue } = require('../../music');

const voiceRooms   = {};
const voiceActivity = new Map();
const MAX_VOICE_PEERS = 10;

function leaveVoice(socket, channelId, serverId, io) {
  if (!voiceRooms[channelId]) return;
  voiceRooms[channelId] = voiceRooms[channelId].filter(p => p.socketId !== socket.id);
  socket.leave(`voice:${channelId}`);
  socket.to(`voice:${channelId}`).emit('voice:peer-left', { socketId: socket.id, userId: socket.userId });
  if (serverId && io) io.to(`server:${serverId}`).emit('voice:room-update', { channelId, peers: voiceRooms[channelId] });
  socket.currentVoiceChannel = null;
  socket.currentVoiceServer  = null;
}

function registerVoiceHandlers(socket, io, user) {
  socket.on('voice:join', ({ channelId, serverId }) => {
    if (!voiceRooms[channelId]) voiceRooms[channelId] = [];
    if (voiceRooms[channelId].length >= MAX_VOICE_PEERS) {
      socket.emit('voice:full', { channelId, max: MAX_VOICE_PEERS });
      return;
    }
    const existingPeers = voiceRooms[channelId];
    socket.emit('voice:existing-peers', existingPeers.map(p => ({
      socketId: p.socketId, userId: p.userId, displayName: p.displayName, avatarColor: p.avatarColor,
    })));
    const peerInfo = { socketId: socket.id, userId: user._id, displayName: user.displayName, avatarColor: user.avatarColor };
    voiceRooms[channelId].push(peerInfo);
    socket.currentVoiceChannel = channelId;
    socket.currentVoiceServer  = serverId;
    socket.join(`voice:${channelId}`);
    socket.to(`voice:${channelId}`).emit('voice:peer-joined', peerInfo);
    io.to(`server:${serverId}`).emit('voice:room-update', { channelId, peers: voiceRooms[channelId] });
    const q = getQueue(channelId);
    if (q.current) socket.emit('music:play', { channelId, track: q.current });
  });

  socket.on('voice:leave', ({ channelId, serverId }) => leaveVoice(socket, channelId, serverId, io));

  socket.on('webrtc:offer',         ({ targetSocketId, offer, channelId })    => io.to(targetSocketId).emit('webrtc:offer',         { fromSocketId: socket.id, offer, channelId }));
  socket.on('webrtc:answer',        ({ targetSocketId, answer })              => io.to(targetSocketId).emit('webrtc:answer',        { fromSocketId: socket.id, answer }));
  socket.on('webrtc:ice-candidate', ({ targetSocketId, candidate })           => io.to(targetSocketId).emit('webrtc:ice-candidate', { fromSocketId: socket.id, candidate }));

  socket.on('voice:state-update', ({ channelId, muted, deafened, screensharing, video }) => {
    socket.to(`voice:${channelId}`).emit('voice:peer-state', { socketId: socket.id, userId: user._id, muted, deafened, screensharing, video });
  });

  socket.on('voice:activity', ({ channelId, speaking }) => {
    socket.to(`voice:${channelId}`).emit('voice:activity', { socketId: socket.id, userId: user._id, speaking });
  });

  // ── Voice E2E key exchange ─────────────────────────────────
  // Bir peer, başka bir peer için şifreli session key gönderiyor
  socket.on('voice:e2e-key', ({ channelId, targetUserId, encryptedKey }) => {
    // targetUserId'nin socket'ini bul ve ona ilet
    const room = voiceRooms[channelId] || [];
    const target = room.find(p => p.userId === targetUserId);
    if (target && target.socketId) {
      io.to(target.socketId).emit('voice:e2e-key', {
        fromUserId:   user._id,
        encryptedKey,
      });
    }
  });
}

module.exports = { registerVoiceHandlers, leaveVoice, voiceRooms, voiceActivity };
export {};
