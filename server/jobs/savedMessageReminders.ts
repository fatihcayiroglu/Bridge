import { Notifications, SavedMessages } from '../db/repositories';
import { sendPushToUser } from '../lib/pushSender';
import logger from '../lib/logger';

const POLL_MS = 30_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function runSavedMessageReminderTick(now = Date.now()): Promise<void> {
  if (running) return;
  running = true;
  try {
    const due = await SavedMessages.findDueReminders(now, 100);
    for (const row of due) {
      const id = String(row._id ?? '');
      const userId = String(row.userId ?? '');
      const remindAt = Number(row.remindAt ?? 0);
      if (!id || !userId || !Number.isSafeInteger(remindAt) || remindAt <= 0) continue;

      // Durable in-app attention is canonical. Push is best effort after the
      // inbox row exists, so users without push permission still receive the
      // reminder when they return to Bridge.
      try {
        await Notifications.insertSavedReminder(userId, id, remindAt);
      } catch (error) {
        logger.warn({ error, userId, savedId: id }, 'Saved reminder inbox row could not be created');
        continue;
      }

      const marked = await SavedMessages.markReminded(id, remindAt, now);
      if (marked?.updated !== 1) continue; // schedule changed/cancelled during delivery

      void sendPushToUser(userId, {
        title: '⏰ Bridge hatırlatıcısı',
        body: 'Sonra bakmak için kaydettiğin bir mesaja dönme zamanı.',
        icon: '/icons/icon-192.png',
        data: { type: 'saved:reminder', savedId: id, url: '/app?saved=1' },
      }).catch(error => logger.warn({ error, userId, savedId: id }, 'Saved reminder push failed'));
    }
  } catch (error) {
    logger.error({ error }, 'Saved reminder job failed');
  } finally {
    running = false;
  }
}

export function startSavedMessageReminderJob(): void {
  if (timer) return;
  void runSavedMessageReminderTick();
  timer = setInterval(() => { void runSavedMessageReminderTick(); }, POLL_MS);
  timer.unref?.();
}

export function stopSavedMessageReminderJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
