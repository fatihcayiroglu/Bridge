// server/jobs/scheduledMessages.ts — Scheduled message dispatcher
import logger from '../lib/logger';
import { v4 as uuidv4 } from 'uuid';
import type { Server as SocketServer } from 'socket.io';

import { ScheduledMessages, Users, Messages } from '../db/repositories';
import { sanitizeMessageContent } from '../lib/contentSanitizer';

interface ScheduledMessage {
  _id: string;
  channelId: string;
  serverId: string;
  userId: string;
  username: string;
  displayName?: string;
  avatarColor?: string;
  content: string;
}

interface UserRow {
  _id: string;
  username: string;
  displayName?: string;
  avatarColor?: string;
}

let _io: SocketServer | null = null;
let _scheduledInterval: ReturnType<typeof setInterval> | null = null;  // Sprint 98

export function startScheduledJob(io: SocketServer): void {
  _io = io;
  _scheduledInterval = setInterval(dispatchDue, 30_000);
  logger.info('   ✅ Scheduled Message Job (30s interval)');
}

// Sprint 98: Graceful shutdown desteği
export function stopScheduledJob(): void {
  if (_scheduledInterval) {
    clearInterval(_scheduledInterval);
    _scheduledInterval = null;
    logger.info('[ScheduledMessages] Job durduruldu');
  }
}

async function dispatchDue(): Promise<void> {
  try {
    const now = Date.now();
    const due = await ScheduledMessages.findDueBefore(now);
    for (const scheduled of due) {
      try {
        await ScheduledMessages.markSent(scheduled._id, now);

        const user = await Users.findById(scheduled.userId);

        const msg = await Messages.create({
          _id:         uuidv4(),
          channelId:   scheduled.channelId,
          serverId:    scheduled.serverId,
          userId:      scheduled.userId,
          username:    user?.username || scheduled.username,
          displayName: user?.displayName || scheduled.displayName,
          avatarColor: user?.avatarColor || scheduled.avatarColor,
          // Sprint 120: T5 — Scheduled mesajlar da sanitize edilmeli
          content:     sanitizeMessageContent(scheduled.content),
          type:        'normal',
          reactions:   {},
          createdAt:   now,
          scheduledId: scheduled._id,
        });

        if (_io) {
          _io.to(`channel:${scheduled.channelId}`).emit('message:new', msg);
        }
      } catch (msgErr) {
        // Tek bir mesaj başarısız olsa bile diğerleri gönderilmeye devam eder
        logger.error({ event: 'scheduled_msg_dispatch_fail', id: scheduled._id }, (msgErr as Error).message);
      }
    }
  } catch (e) {
    const err = e as Error;
    logger.error({ event: '[scheduled]' }, 'dispatch error: ' + err.message);
  }
}
