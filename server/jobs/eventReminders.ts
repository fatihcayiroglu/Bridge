// server/jobs/eventReminders.ts
// Sprint 96 — Sunucu Etkinliği Öncesi Push Bildirimi
//
// Mantık:
//   Her dakika çalışır. Başlamak üzere olan etkinlikleri (5 dk ve 15 dk önce)
//   bulur; 'going' veya 'interested' RSVP'si olan kullanıcılara push gönderir.
//   Aynı etkinlik için aynı pencerede tekrar gönderimi önlemek için Redis'te
//   TTL'li bir flag saklanır.
//
// Push kanalları: Web Push (VAPID) + FCM + APNs — sendPushToUser'ı çağırır.
//
// Değişiklikler (Sprint 96 review):
//   - db.query() → ServerEventRepository (repository pattern)
//   - server_events full-scan → cursor-based sayfalı tarama (yüksek yük desteği)

import logger from '../lib/logger';
import { cache } from '../lib/redisAdapter';
import { sendPushToUser } from '../lib/pushSender';
import { ServerEvents } from '../db/repositories/ServerEventRepository';

// Kaç dakika önce bildirim gönderilsin
const REMIND_WINDOWS_MIN = [5, 15];

// Sayfa başına maksimum etkinlik (cursor loop)
const PAGE_SIZE = 100;

// Redis flag key: eventId + pencere dakikası
function remindKey(eventId: string, windowMin: number): string {
  return `evtremind:${eventId}:${windowMin}`;
}

export async function sendEventReminders(): Promise<void> {
  const now = new Date();

  for (const windowMin of REMIND_WINDOWS_MIN) {
    const windowStart = new Date(now.getTime() + windowMin * 60_000 - 30_000); // ±30s tolerans
    const windowEnd   = new Date(now.getTime() + windowMin * 60_000 + 30_000);

    // Cursor-based sayfalı tarama — yüksek yük senaryosunda full-scan önlenir
    let cursor: string | undefined;

    pageLoop: while (true) {
      let events;
      try {
        events = await ServerEvents.findScheduledInWindow(
          windowStart,
          windowEnd,
          cursor,
          PAGE_SIZE,
        );
      } catch (err) {
        logger.error({ err }, '[EventReminder] DB sorgu hatası');
        break pageLoop;
      }

      if (!events.length) break pageLoop;

      for (const event of events) {
        const rkey = remindKey(event.id, windowMin);

        // Zaten gönderildi mi?
        try {
          const alreadySent = await cache.get(rkey);
          if (alreadySent) continue;
          // Flag'i işaretle — 5 dakika TTL (çakışma önleme + multi-instance safe)
          await cache.set(rkey, '1', 300);
        } catch {
          // Redis yoksa devam et — olsa olsa duplicate gönderilir, crash olmaz
        }

        // RSVP'si olan kullanıcıları çek
        let rsvps;
        try {
          rsvps = await ServerEvents.findAttendees(event.id);
        } catch (err) {
          logger.error({ err, eventId: event.id }, '[EventReminder] RSVP sorgu hatası');
          continue;
        }

        if (!rsvps.length) continue;

        const minuteLabel = windowMin === 5 ? '5 dakika' : `${windowMin} dakika`;
        const payload = {
          title: `🗓️ ${event.title}`,
          body:  `Etkinlik ${minuteLabel} içinde başlıyor!`,
          icon:  '/icons/icon-192.png',
          data: {
            type:      'event:reminder',
            eventId:   event.id,
            serverId:  event.server_id,
            channelId: event.channel_id ?? undefined,
            startsAt:  event.starts_at.toISOString(),
            url:       `/app?server=${event.server_id}&event=${event.id}`,
          },
        };

        let sent = 0;
        for (const rsvp of rsvps) {
          try {
            await sendPushToUser(rsvp.user_id, payload);
            sent++;
          } catch (err) {
            logger.warn(
              { err, userId: rsvp.user_id, eventId: event.id },
              '[EventReminder] Push gönderilemedi',
            );
          }
        }

        logger.info(
          { eventId: event.id, title: event.title, windowMin, sent, total: rsvps.length },
          '[EventReminder] Etkinlik bildirimleri gönderildi',
        );
      }

      // Sonraki sayfa için cursor'ı ilerlet
      cursor = events[events.length - 1]?.id;
      if (events.length < PAGE_SIZE) break pageLoop; // son sayfa
    }
  }
}

// Aktif interval handle — stopEventReminderJob() için tutulur
let _reminderInterval: ReturnType<typeof setInterval> | null = null;
let _reminderInitTimer: ReturnType<typeof setTimeout> | null = null;

export function startEventReminderJob(): void {
  if (_reminderInitTimer !== null || _reminderInterval !== null) return;

  // İlk çalışmayı biraz geciktir — server tam ayağa kalksın (15s: app boot süresi marjı)
  _reminderInitTimer = setTimeout(() => {
    _reminderInitTimer = null;
    sendEventReminders().catch(err =>
      logger.error({ err }, '[EventReminder] İlk çalışma hatası'),
    );
    _reminderInterval = setInterval(() => {
      sendEventReminders().catch(err =>
        logger.error({ err }, '[EventReminder] Interval hatası'),
      );
    }, 60_000); // Her dakika kontrol et
    _reminderInterval.unref?.();
  }, 15_000);
  _reminderInitTimer.unref?.();

  logger.info('   ✅ Event Reminder Job (1m interval, windows: 5m + 15m)');
}

/**
 * Graceful shutdown — process SIGTERM/SIGINT handler'larından çağrılır.
 * Devam eden sendEventReminders() çağrısını kesmez; sadece bir sonraki
 * tick'i engeller.
 */
export function stopEventReminderJob(): void {
  if (_reminderInitTimer !== null) {
    clearTimeout(_reminderInitTimer);
    _reminderInitTimer = null;
  }
  if (_reminderInterval !== null) {
    clearInterval(_reminderInterval);
    _reminderInterval = null;
    logger.info('[EventReminder] Job durduruldu');
  }
}
