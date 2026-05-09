// @ts-nocheck
// server/jobs/scheduledMessages.js — Scheduled message dispatcher
const { v4: uuidv4 } = require('uuid');
const { ScheduledMessages, Users, Messages } = require('../db/repositories');

let _io = null;

function startScheduledJob(io) {
  _io = io;
  // Check every 30 seconds
  setInterval(dispatchDue, 30_000);
  console.log('   ✅ Scheduled Message Job (30s interval)');
}

async function dispatchDue() {
  try {
    const now = Date.now();
    const due = await ScheduledMessages.findDueBefore(now);
    for (const scheduled of due) {
      await ScheduledMessages.markSent(scheduled._id, now);

      const user = await Users.findById(scheduled.userId);

      const msg = await Messages.create({
        _id: uuidv4(),
        channelId: scheduled.channelId,
        serverId: scheduled.serverId,
        userId: scheduled.userId,
        username: user?.username || scheduled.username,
        displayName: user?.displayName || scheduled.displayName,
        avatarColor: user?.avatarColor || scheduled.avatarColor,
        content: scheduled.content,
        type: 'normal',
        reactions: {},
        createdAt: now,
        scheduledId: scheduled._id, // mark as scheduled
      });

      if (_io) {
        _io.to(`channel:${scheduled.channelId}`).emit('message:new', msg);
      }
    }
  } catch (e) {
    console.error('[scheduled] dispatch error:', e.message);
  }
}

module.exports = { startScheduledJob };
export {};
