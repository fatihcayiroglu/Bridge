// server/socket/handlers/stage.js
// Stage kanalı socket handler'ları
// demote düzeltmesi (module.exports sonrası orphan kod giderildi)
//      + speaking indicator + topic/live toggle

'use strict';

const stageRooms = new Map();

function getOrCreateRoom(channelId) {
  if (!stageRooms.has(channelId)) {
    stageRooms.set(channelId, { speakers: [], listeners: [], topic: '', live: false });
  }
  return stageRooms.get(channelId);
}

function removeUserFromRoom(channelId, userId) {
  if (!stageRooms.has(channelId)) return;
  const room = stageRooms.get(channelId);
  room.speakers  = room.speakers.filter(u => u.userId !== userId);
  room.listeners = room.listeners.filter(u => u.userId !== userId);
  if (!room.speakers.length && !room.listeners.length) stageRooms.delete(channelId);
}

function registerStageHandlers(socket, io, user) {
  socket.on('stage:join', ({ channelId }) => {
    if (!channelId) return;
    socket.join(`stage:${channelId}`);
    const room = getOrCreateRoom(channelId);
    socket.emit('stage:state', { channelId, ...room });
  });

  socket.on('stage:setRole', ({ channelId, role, displayName, avatarColor }) => {
    if (!channelId || !['speaker', 'listener'].includes(role)) return;
    removeUserFromRoom(channelId, user._id);
    const room = getOrCreateRoom(channelId);
    const userObj = {
      userId: user._id,
      displayName: user.displayName || displayName,
      avatarColor: user.avatarColor || avatarColor,
      muted: role === 'speaker',
      handRaised: false,
      speaking: false,
      socketId: socket.id,
    };
    if (role === 'speaker') room.speakers.push(userObj);
    else room.listeners.push(userObj);
    socket.to(`stage:${channelId}`).emit('stage:userJoined', { channelId, role, user: userObj });
    io.to(`stage:${channelId}`).emit('stage:state', { channelId, ...room });
  });

  socket.on('stage:updateMute', ({ channelId, muted }) => {
    if (!channelId) return;
    const room = stageRooms.get(channelId);
    if (!room) return;
    const sp = room.speakers.find(u => u.userId === user._id);
    if (sp) {
      sp.muted = muted;
      if (muted) sp.speaking = false;
      io.to(`stage:${channelId}`).emit('stage:muteUpdate', { channelId, userId: user._id, muted });
    }
  });

//   VAD tabanlı speaking indicator
  socket.on('stage:speaking', ({ channelId, speaking }) => {
    if (!channelId) return;
    const room = stageRooms.get(channelId);
    if (!room) return;
    const sp = room.speakers.find(u => u.userId === user._id);
    if (sp && !sp.muted) {
      sp.speaking = !!speaking;
      io.to(`stage:${channelId}`).emit('stage:speaking', { channelId, userId: user._id, speaking: sp.speaking });
    }
  });

  socket.on('stage:handRaise', ({ channelId, raised }) => {
    if (!channelId) return;
    const room = stageRooms.get(channelId);
    if (!room) return;
    const all = [...room.speakers, ...room.listeners];
    const u = all.find(x => x.userId === user._id);
    if (u) {
      u.handRaised = raised;
      io.to(`stage:${channelId}`).emit('stage:handRaise', { channelId, userId: user._id, raised });
    }
  });

  socket.on('stage:promote', async ({ channelId, targetUserId }) => {
    if (!channelId || !targetUserId) return;
    const room = stageRooms.get(channelId);
    if (!room) return;
    const isHost = room.speakers[0]?.userId === user._id;
    if (!isHost) return;
    const li = room.listeners.findIndex(u => u.userId === targetUserId);
    if (li === -1) return;
    const [promoted] = room.listeners.splice(li, 1);
    promoted.muted = true;
    promoted.handRaised = false;
    promoted.speaking = false;
    room.speakers.push(promoted);
    io.to(`stage:${channelId}`).emit('stage:promoted', { channelId, userId: targetUserId });
    io.to(`stage:${channelId}`).emit('stage:state', { channelId, ...room });
  });

//   demote artık registerStageHandlers içinde (eski kodda module.exports sonrasındaydı = hiç çalışmıyordu)
  socket.on('stage:demote', async ({ channelId, targetUserId }) => {
    if (!channelId || !targetUserId) return;
    const room = stageRooms.get(channelId);
    if (!room) return;
    const isHost = room.speakers[0]?.userId === user._id;
    if (!isHost) {
      try {
        const { Channels, Servers } = require('../../db/repositories');
        const channel = await Channels.findById(channelId);
        if (channel) {
          const server = await Servers.findById(channel.serverId);
          if (server && server.ownerId !== user._id) return;
        }
      } catch { return; }
    }
    const idx = room.speakers.findIndex(u => u.userId === targetUserId);
    if (idx === -1) return;
    const [demoted] = room.speakers.splice(idx, 1);
    demoted.muted = false;
    demoted.handRaised = false;
    demoted.speaking = false;
    room.listeners.push(demoted);
    io.to(`stage:${channelId}`).emit('stage:demoted', { channelId, userId: targetUserId });
    io.to(`stage:${channelId}`).emit('stage:state', { channelId, ...room });
  });

//   host konu güncelleyebilir
  socket.on('stage:setTopic', ({ channelId, topic }) => {
    if (!channelId) return;
    const room = stageRooms.get(channelId);
    if (!room) return;
    if (room.speakers[0]?.userId !== user._id) return;
    room.topic = (topic || '').slice(0, 200);
    io.to(`stage:${channelId}`).emit('stage:topicUpdate', { channelId, topic: room.topic });
  });

//   host CANLI badgeini açıp kapatabilir
  socket.on('stage:setLive', ({ channelId, live }) => {
    if (!channelId) return;
    const room = stageRooms.get(channelId);
    if (!room) return;
    if (room.speakers[0]?.userId !== user._id) return;
    room.live = !!live;
    io.to(`stage:${channelId}`).emit('stage:liveUpdate', { channelId, live: room.live });
  });

  socket.on('stage:leave', ({ channelId }) => {
    if (!channelId) return;
    removeUserFromRoom(channelId, user._id);
    socket.leave(`stage:${channelId}`);
    io.to(`stage:${channelId}`).emit('stage:userLeft', { channelId, userId: user._id });
    const room = stageRooms.get(channelId);
    if (room) io.to(`stage:${channelId}`).emit('stage:state', { channelId, ...room });
  });

  socket.on('disconnect', () => {
    for (const [channelId, room] of stageRooms) {
      const was = room.speakers.some(u => u.userId === user._id) ||
                  room.listeners.some(u => u.userId === user._id);
      if (was) {
        removeUserFromRoom(channelId, user._id);
        io.to(`stage:${channelId}`).emit('stage:userLeft', { channelId, userId: user._id });
        const current = stageRooms.get(channelId);
        if (current) io.to(`stage:${channelId}`).emit('stage:state', { channelId, ...current });
      }
    }
  });
}

module.exports = { registerStageHandlers, stageRooms };
export {};
