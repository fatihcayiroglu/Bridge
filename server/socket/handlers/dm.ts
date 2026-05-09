// server/socket/handlers/dm.js
const { v4: uuidv4 } = require('uuid');
const { Dms, GroupDms, Users } = require('../../db/repositories');
const { getDmId } = require('../../routes/dm');
const { sanitizeUser } = require('../../lib/userUtils');

// Active DM calls: callId → { callerId, calleeId, type, startedAt, status }
const activeDmCalls = new Map();

// Helper: find all socket IDs for a userId
function findSocketsForUser(userId, socketUsers) {
  const sids: string[] = [];
  for (const [sid, su] of socketUsers) {
    if ((su._id || su.id) === userId) sids.push(sid);
  }
  return sids;
}

function registerDmHandlers(socket, io, user, socketUsers) {
  // ── DM CALL: Initiate ──────────────────────────────────────
  // type: 'voice' | 'video'
  socket.on('dm:call:start', ({ toUserId, type = 'voice' }) => {
    if (!toUserId || !['voice', 'video'].includes(type)) return;

    const callId = uuidv4();
    activeDmCalls.set(callId, {
      callId,
      callerId:  user._id,
      calleeId:  toUserId,
      type,
      startedAt: Date.now(),
      status:    'ringing',
    });

    const callerInfo = {
      callId,
      type,
      callerId:          user._id,
      callerDisplayName: user.displayName,
      callerAvatarColor: user.avatarColor,
    };

    // Send ring to callee
    const calleeSockets = findSocketsForUser(toUserId, socketUsers);
    for (const sid of calleeSockets) io.to(sid).emit('dm:call:incoming', callerInfo);

    // Confirm to caller
    socket.emit('dm:call:outgoing', { callId, type, toUserId });

    // Auto-cancel if not answered in 30s
    setTimeout(() => {
      const call = activeDmCalls.get(callId);
      if (call && call.status === 'ringing') {
        activeDmCalls.delete(callId);
        socket.emit('dm:call:missed', { callId });
        for (const sid of findSocketsForUser(toUserId, socketUsers)) {
          io.to(sid).emit('dm:call:missed', { callId });
        }
      }
    }, 30_000);
  });

  // ── DM CALL: Accept ───────────────────────────────────────
  socket.on('dm:call:accept', ({ callId }) => {
    const call = activeDmCalls.get(callId);
    if (!call || call.calleeId !== user._id) return;
    call.status = 'active';

    // Notify caller
    const callerSockets = findSocketsForUser(call.callerId, socketUsers);
    for (const sid of callerSockets) {
      io.to(sid).emit('dm:call:accepted', {
        callId,
        type:              call.type,
        calleeDisplayName: user.displayName,
        calleeAvatarColor: user.avatarColor,
      });
    }
    // Tell both sides to start WebRTC — use a shared channelId = callId
    socket.emit('dm:call:ready', { callId, channelId: callId, role: 'callee', type: call.type });
    for (const sid of callerSockets) {
      io.to(sid).emit('dm:call:ready', { callId, channelId: callId, role: 'caller', type: call.type });
    }
  });

  // ── DM CALL: Decline ──────────────────────────────────────
  socket.on('dm:call:decline', ({ callId }) => {
    const call = activeDmCalls.get(callId);
    if (!call) return;
    activeDmCalls.delete(callId);
    const callerSockets = findSocketsForUser(call.callerId, socketUsers);
    for (const sid of callerSockets) io.to(sid).emit('dm:call:declined', { callId });
  });

  // ── DM CALL: End (hang up) ────────────────────────────────
  socket.on('dm:call:end', ({ callId }) => {
    const call = activeDmCalls.get(callId);
    if (!call) return;
    const otherUserId = call.callerId === user._id ? call.calleeId : call.callerId;
    activeDmCalls.delete(callId);
    const otherSockets = findSocketsForUser(otherUserId, socketUsers);
    for (const sid of otherSockets) io.to(sid).emit('dm:call:ended', { callId });
    socket.emit('dm:call:ended', { callId });
  });

  // ── DM CALL: WebRTC signaling (routed through server) ─────
  socket.on('dm:call:offer',         ({ callId, targetUserId, offer })      => {
    for (const sid of findSocketsForUser(targetUserId, socketUsers))
      io.to(sid).emit('dm:call:offer', { callId, fromSocketId: socket.id, offer });
  });
  socket.on('dm:call:answer',        ({ callId, targetUserId, answer })     => {
    for (const sid of findSocketsForUser(targetUserId, socketUsers))
      io.to(sid).emit('dm:call:answer', { callId, fromSocketId: socket.id, answer });
  });
  socket.on('dm:call:ice',           ({ callId, targetUserId, candidate }) => {
    for (const sid of findSocketsForUser(targetUserId, socketUsers))
      io.to(sid).emit('dm:call:ice', { callId, fromSocketId: socket.id, candidate });
  });

  // ─────────────────────────────────────────────────────────
  socket.on('dm:send', async ({ toUserId, content }) => {
    if (!content?.trim()) return;
    const isE2E = content.startsWith('🔒e2e:');
    const maxLen = isE2E ? 20_000 : 2000;
    if (content.length > maxLen) return;
    const other = await Users.findById(toUserId);
    if (!other) return;
    const dmId = getDmId(user._id, toUserId);
    const { dmId: _id } = await Dms.findOrCreateConversation(user._id, toUserId);
    const msg = await Dms.insertMessage({
      dmId,
      userId: user._id, displayName: user.displayName, avatarColor: user.avatarColor,
      content: content.trim(),
      reactions: {},
      e2e: isE2E,
    });
    socket.emit('dm:message', msg);
    for (const [sid, su] of socketUsers) {
      if ((su._id || su.id) === toUserId) io.to(sid).emit('dm:message', msg);
    }
  });

  socket.on('dm:join', (dmId) => {
    for (const room of socket.rooms) if (room.startsWith('dm:')) socket.leave(room);
    socket.join(`dm:${dmId}`);
  });

  // ── DM REACTIONS ─────────────────────────────────────────────
  socket.on('dm:react', async ({ messageId, dmId, emoji }) => {
    if (!messageId || !dmId || !emoji) return;
    if (typeof emoji !== 'string' || emoji.length > 16) return;

    const msg  = await Dms.findMessage(messageId, dmId);
    if (!msg) return;

    const conv = await Dms.findConversation(dmId);
    if (!conv || !conv.participants.includes(user._id)) return;

    let reactions;
    try { reactions = typeof msg.reactions === 'string' ? JSON.parse(msg.reactions) : (msg.reactions || {}); }
    catch { reactions = {}; }

    const users = reactions[emoji] || [];
    const idx   = users.indexOf(user._id);
    if (idx === -1) users.push(user._id); else users.splice(idx, 1);
    if (users.length === 0) delete reactions[emoji]; else reactions[emoji] = users;

    await Dms.updateMessage(messageId, { reactions });
    io.to(`dm:${dmId}`).emit('dm:reaction', { messageId, dmId, reactions });
  });
}


// ── GROUP DM SOCKET HANDLERS ──────────────────────────────────────────────────
function registerGroupDmHandlers(socket, io, user, socketUsers) {
  async function joinGroupRooms() {
    const memberships = await GroupDms.findGroupsByUser(user._id);
    for (const m of memberships) socket.join(`gdm:${m.groupId}`);
  }
  joinGroupRooms().catch(() => {});

  socket.on('gdm:send', async ({ groupId, content }) => {
    if (!content?.trim() || content.length > 2000) return;
    const member = await GroupDms.findMember(groupId, user._id);
    if (!member) return;

    const now = Date.now();
    const msg = await GroupDms.insertMessage({
      groupId,
      userId:      user._id,
      displayName: user.displayName,
      avatarColor: user.avatarColor || '#5865f2',
      content:     content.trim(),
      type:        'normal',
    });
    await GroupDms.update(groupId, { lastMessageAt: now });
    io.to(`gdm:${groupId}`).emit('gdm:message', msg);
  });

  socket.on('gdm:join', (groupId) => {
    socket.join(`gdm:${groupId}`);
  });

  socket.on('gdm:typing', ({ groupId }) => {
    socket.to(`gdm:${groupId}`).emit('gdm:typing', {
      groupId,
      userId:      user._id,
      displayName: user.displayName,
    });
  });

  // ── GROUP DM VOICE CALL ───────────────────────────────────
  // Active group calls: groupId → Set of participant userIds
  // Uses a shared socket room: gdm:voice:<groupId>

  socket.on('gdm:call:start', async ({ groupId, type = 'voice' }) => {
    if (!['voice', 'video'].includes(type)) return;
    const member = await GroupDms.findMember(groupId, user._id);
    if (!member) return;

    // Join the voice room
    socket.join(`gdm:voice:${groupId}`);

    // Notify everyone else in the group
    socket.to(`gdm:${groupId}`).emit('gdm:call:incoming', {
      groupId,
      type,
      callerId:          user._id,
      callerDisplayName: user.displayName,
      callerAvatarColor: user.avatarColor,
    });

    // Confirm to caller they started the call
    socket.emit('gdm:call:started', { groupId, type });
  });

  socket.on('gdm:call:join', async ({ groupId, type = 'voice' }) => {
    const member = await GroupDms.findMember(groupId, user._id);
    if (!member) return;

    socket.join(`gdm:voice:${groupId}`);

    // Tell everyone already in the voice room that a new peer joined
    socket.to(`gdm:voice:${groupId}`).emit('gdm:call:peer:joined', {
      groupId,
      userId:      user._id,
      displayName: user.displayName,
      avatarColor: user.avatarColor,
      socketId:    socket.id,
    });

    // Send the joining peer a list of existing participants in the room
    const roomSockets = await io.in(`gdm:voice:${groupId}`).fetchSockets();
    const existingPeers = roomSockets
      .filter(s => s.id !== socket.id)
      .map(s => ({ socketId: s.id, userId: s.data?.userId, displayName: s.data?.displayName }));
    socket.emit('gdm:call:existing:peers', { groupId, peers: existingPeers });

    socket.emit('gdm:call:joined', { groupId, type });
  });

  socket.on('gdm:call:leave', ({ groupId }) => {
    socket.leave(`gdm:voice:${groupId}`);
    socket.to(`gdm:voice:${groupId}`).emit('gdm:call:peer:left', {
      groupId,
      userId:   user._id,
      socketId: socket.id,
    });
    socket.emit('gdm:call:left', { groupId });
  });

  socket.on('gdm:call:end', async ({ groupId }) => {
    // Only the call initiator or an admin should be able to end for everyone
    // For simplicity, anyone can end — notify all, kick them from voice room
    io.to(`gdm:voice:${groupId}`).emit('gdm:call:ended', { groupId, byUserId: user._id });
    // Force all sockets in the voice room to leave it
    const roomSockets = await io.in(`gdm:voice:${groupId}`).fetchSockets();
    for (const s of roomSockets) s.leave(`gdm:voice:${groupId}`);
  });

  // WebRTC signaling — peer-to-peer via server relay
  socket.on('gdm:call:offer', ({ groupId, targetSocketId, offer }) => {
    io.to(targetSocketId).emit('gdm:call:offer', { groupId, fromSocketId: socket.id, offer });
  });
  socket.on('gdm:call:answer', ({ groupId, targetSocketId, answer }) => {
    io.to(targetSocketId).emit('gdm:call:answer', { groupId, fromSocketId: socket.id, answer });
  });
  socket.on('gdm:call:ice', ({ groupId, targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('gdm:call:ice', { groupId, fromSocketId: socket.id, candidate });
  });

  // Mute/video state broadcast within group call
  socket.on('gdm:call:state', ({ groupId, muted, video }) => {
    socket.to(`gdm:voice:${groupId}`).emit('gdm:call:peer:state', {
      groupId, socketId: socket.id, userId: user._id, muted, video,
    });
  });
}

module.exports = { registerDmHandlers, registerGroupDmHandlers };
export {};
