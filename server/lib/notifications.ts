// server/lib/notifications.ts — Oturum 16: targetUserIds, deliverPushBatched imzaları
// Mention detection, notification queue, push support

import logger from './logger';
import { effectiveNotificationPref, isMuted, normalizeNotificationLevel } from './notificationMute';
import { randomUUID } from 'crypto';
import { cache } from './redisAdapter';
import { Users, Channels, Members, Notifications } from '../db/repositories';
import { sendPushToUser, PushPayload } from './pushSender';
import express from 'express';
import { authMiddleware } from '../middleware/auth';
import { canViewChannel } from './permissions';
import { validateWebPushSubscription } from './webPushSubscriptionPolicy';
import { extractNotificationWatchTokens } from './notificationWatchWords';
import { storedMessageText } from './storedText';
import { serverText, userLocale } from './serverLocale';

// ── Tipler ────────────────────────────────────────────────────
interface MsgLike {
  _id:         unknown;
  content?:    unknown;
  channelId:   unknown;
  serverId?:   unknown;
  userId?:     unknown;
  displayName?: unknown;
  username?:   unknown;
  createdAt?:  unknown;
}

interface UserRow {
  _id:      string;
  username: string;
}

interface PrefRow {
  userId:    string;
  channelId: string;
  level:     string;
  muteUntil?: number | null;
}

interface UnreadRow {
  channelId: string;
  count:     number;
  userId:    string;
}

// ── Regex ─────────────────────────────────────────────────────
const MENTION_REGEX  = /@([a-zA-Z0-9_]+)/g;
const DIRECT_MENTION_REGEX = /<@([a-zA-Z0-9_-]+)>/g;
const EVERYONE_REGEX = /@(everyone|here)/;

// ── ANA FONKSİYON ────────────────────────────────────────────
export async function processNotifications(
  msg: MsgLike,
  io: unknown,
  socketUsers: Map<string, { id: string }>,
  excludedUserIds: Set<string> = new Set(),
): Promise<void> {
  try {
    const content = String(msg.content || '');
    const mentions = extractMentions(content);
    const directMentionIds = extractDirectMentionIds(content);
    const isEveryoneMention = EVERYONE_REGEX.test(content);

    // Watch words are SERVER-scoped policy, so channel ownership must be
    // canonical before matching them. Do not short-circuit only because the
    // message has no @mention: a watch-word match is also an attention event.
    const channel = await Channels.findById(String(msg.channelId));
    if (!channel) return;
    const canonicalServerId = String((channel as { serverId?: unknown }).serverId || '');
    if (!canonicalServerId) return;

    const members = await Members.findByServer(canonicalServerId) as Array<{ userId: string }>;
    const memberUserIds = new Set(members.map(m => m.userId));

    const watchWordByUser = new Map<string, string>();
    const watchTokens = extractNotificationWatchTokens(content);
    if (watchTokens.length) {
      try {
        const rows = await Notifications.findMatchingWatchWords(canonicalServerId, watchTokens) as Array<{
          userId?: unknown; keyword?: unknown;
        }>;
        for (const row of rows) {
          const userId = String(row.userId ?? '');
          const keyword = String(row.keyword ?? '');
          // FK/cascade should keep this clean, but membership is re-checked at
          // delivery time so stale preference metadata cannot target ex-members.
          if (!userId || !keyword || userId === String(msg.userId) || !memberUserIds.has(userId)) continue;
          if (!watchWordByUser.has(userId)) watchWordByUser.set(userId, keyword);
        }
      } catch (err) {
        // Watch words are additive. If their preference store is temporarily
        // unavailable, ordinary explicit mentions must keep working.
        logger.warn({
          event: 'notification_watch_word_read_failed',
          channelId: String(msg.channelId),
          messageId: String(msg._id),
          err: err instanceof Error ? err.message : String(err),
        }, '[Notifications] Watch-word state unavailable; continuing with explicit mentions');
      }
    }

    if (!mentions.length && !directMentionIds.length && !isEveryoneMention && !watchWordByUser.size) return;

    let targetUserIds: string[] = [];

    if (isEveryoneMention) {
      targetUserIds = members.map(m => m.userId).filter(id => id !== String(msg.userId));
    } else {
      const [users, directUsers] = await Promise.all([
        Users.findByUsernames(mentions) as Promise<UserRow[]>,
        Users.findByIds(directMentionIds) as Promise<UserRow[]>,
      ]);
      targetUserIds = [...users, ...directUsers]
        .filter(u => memberUserIds.has(u._id) && u._id !== String(msg.userId))
        .map(u => u._id);
    }

    // Union explicit attention and watch-word attention. Muting/permissions are
    // still evaluated below and therefore remain authoritative.
    targetUserIds.push(...watchWordByUser.keys());
    targetUserIds = [...new Set(targetUserIds)].filter(id => !excludedUserIds.has(id));

    // Membership is not channel visibility. Resolve the recipient's CURRENT
    // VIEW_CHANNELS permission before persisting or emitting any preview.
    const visibility = await Promise.all(
      targetUserIds.map(async (userId) => ({
        userId,
        allowed: await canViewChannel(userId, canonicalServerId, String(msg.channelId)),
      }))
    );
    targetUserIds = visibility.filter(item => item.allowed).map(item => item.userId);

    if (!targetUserIds.length) return;

    let notifPrefsRows: unknown;
    let usernameRows: UserRow[];
    try {
      [notifPrefsRows, usernameRows] = await Promise.all([
        Promise.resolve(Notifications.prefsFind({
          userId: { $in: targetUserIds },
          channelId: { $in: [String(msg.channelId), `server:${canonicalServerId}`] },
        })),
        Users.findByIds(targetUserIds) as Promise<UserRow[]>,
      ]);
    } catch (err) {
      // Preference state is policy, not decoration. Fail closed rather than
      // silently turning a mute/mentions setting into implicit `all`.
      logger.warn({
        event: 'notification_preference_read_failed',
        channelId: String(msg.channelId),
        messageId: String(msg._id),
        err: err instanceof Error ? err.message : String(err),
      }, '[Notifications] Preference state unavailable; suppressing notification delivery');
      return;
    }

    const channelPrefMap = new Map<string, PrefRow>();
    const serverPrefMap = new Map<string, PrefRow>();
    for (const p of (notifPrefsRows as PrefRow[] || [])) {
      if (p.channelId === String(msg.channelId)) channelPrefMap.set(p.userId, p);
      else if (p.channelId === `server:${canonicalServerId}`) serverPrefMap.set(p.userId, p);
    }

    const usernameMap = new Map<string, string>();
    for (const u of (usernameRows as UserRow[])) usernameMap.set(u._id, (u.username || '').toLowerCase());

    const notifPromises = targetUserIds.map(async (userId) => {
      const pref = effectiveNotificationPref(channelPrefMap.get(userId), serverPrefMap.get(userId));
      if (isMuted(pref)) return;
      const directlyMentioned = directMentionIds.includes(userId);
      const usernameMentioned = mentions.includes(usernameMap.get(userId) || '');
      const matchedKeyword = watchWordByUser.get(userId) ?? null;
      const explicitlyMentioned = isEveryoneMention || directlyMentioned || usernameMentioned;
      // A watch word is an explicit opt-in to this server's attention stream,
      // so it remains eligible under "mentions only". Mute is checked above
      // and always wins.
      if (pref.level === 'mentions' && !explicitlyMentioned && !matchedKeyword) return;

      const inserted = await Notifications.insertChannelAttention({
        userId,
        type: explicitlyMentioned ? 'mention' : 'watch',
        serverId: canonicalServerId,
        channelId: String(msg.channelId),
        messageId: String(msg._id),
        actorId: String(msg.userId),
        createdAt: Number(msg.createdAt ?? Date.now()),
      });
      if (!inserted) return;

      const reason = explicitlyMentioned ? 'mention' : 'watch-word';
      deliverRealtimeNotif(userId, msg, socketUsers, io, reason, matchedKeyword);
      const ioServer = io as { to(id: string): { emit(ev: string, data: unknown): void } };
      ioServer.to(`user:${userId}`).emit('inbox:changed', { reason });
      await deliverPushBatched(userId, msg, reason);
      await incrementUnread(userId, String(msg.channelId));
    });

    const results = await Promise.allSettled(notifPromises);
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      // `results[i]` indekslemesi kesin değildir ve `reason` YALNIZCA
      // reddedilen dalda vardır; daraltmadan okumak tip olarak yanlış,
      // çalışma anında da `undefined` riskliydi.
      if (result?.status !== 'rejected') continue;
      logger.error({
        event: 'notification_delivery_failed',
        userId: targetUserIds[i] ?? '',
        channelId: String(msg.channelId),
        messageId: String(msg._id),
        err: result.reason instanceof Error ? result.reason.message : String(result.reason),
      }, '[Notifications] Attention delivery failed');
    }
  } catch (err) {
    logger.error('[Notifications] Error:', (err as Error).message);
  }
}

// ── MENTION EXTRACTION ───────────────────────────────────────
export function extractMentions(content: string): string[] {
  const mentions: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(MENTION_REGEX.source, 'g');
  while ((match = re.exec(content)) !== null) {
    const name = match[1];
    if (name === undefined || ['everyone', 'here'].includes(name)) continue;
    mentions.push(name.toLowerCase());
  }
  return [...new Set(mentions)];
}

export function extractDirectMentionIds(content: string): string[] {
  const ids: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(DIRECT_MENTION_REGEX.source, 'g');
  while ((match = re.exec(content)) !== null) {
    const id = match[1];
    if (id !== undefined) ids.push(id);
  }
  return [...new Set(ids)];
}

// ── REALTIME SOCKET BİLDİRİMİ ────────────────────────────────
function deliverRealtimeNotif(
  userId: string,
  msg: MsgLike,
  _socketUsers: Map<string, { id: string }>,
  io: unknown,
  reason: 'mention' | 'watch-word' = 'mention',
  matchedKeyword: string | null = null,
): void {
  const ioServer = io as { to(id: string): { emit(ev: string, data: unknown): void } };
  // Every authenticated socket joins user:<id>. With the Socket.IO Redis
  // adapter this is the cluster-wide delivery owner; a process-local socket
  // index would silently miss recipients connected to another node.
  ioServer.to(`user:${userId}`).emit('notification:mention', {
    type:       'mention',
    messageId:  msg._id,
    channelId:  msg.channelId,
    serverId:   msg.serverId,
    fromUser:   msg.displayName,
    fromUserId: msg.userId,
    preview:    storedMessageText(msg).slice(0, 100),
    createdAt:  msg.createdAt,
    reason,
    ...(matchedKeyword ? { matchedKeyword } : {}),
  });
}

// ── OKUNMAMIŞ SAYACI ─────────────────────────────────────────
const _unreadLocks = new Map<string, Promise<void>>();

async function withUnreadLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = _unreadLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  _unreadLocks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (_unreadLocks.get(key) === tail) _unreadLocks.delete(key);
  }
}

export async function incrementUnread(userId: string, channelId: string): Promise<void> {
  const now = Date.now();
  if (await Notifications.unreadIncrementAtomic(userId, channelId, now)) return;

  // In-memory test adapter: serialize the read/insert-or-$inc fallback so the
  // test contract cannot hide a lost-update bug that PostgreSQL would expose.
  await withUnreadLock(`${userId}:${channelId}`, async () => {
    const existing = await Notifications.unreadFindOne({ userId, channelId }) as UnreadRow | null;
    if (existing) {
      await Notifications.unreadUpdate(
        { userId, channelId },
        { $inc: { count: 1 }, $set: { updatedAt: Date.now() } }
      );
    } else {
      await Notifications.unreadInsert({ userId, channelId, count: 1, createdAt: Date.now(), updatedAt: Date.now() });
    }
  });
}

export async function clearUnread(userId: string, channelId: string): Promise<void> {
  try {
    await Notifications.unreadUpdate({ userId, channelId }, { $set: { count: 0, updatedAt: Date.now() } });
  } catch (err) {
    logger.warn({
      event: 'unread_clear_failed', userId, channelId,
      err: err instanceof Error ? err.message : String(err),
    }, '[Notifications] Failed to clear unread state');
  }
}

export async function getUnreadCounts(userId: string): Promise<Record<string, number>> {
  try {
    const rows = (await Notifications.unreadFind({ userId, count: { $gt: 0 } }).catch(() => [])) ?? [];
    return (rows as UnreadRow[]).reduce<Record<string, number>>((acc, r) => {
      acc[r.channelId] = r.count;
      return acc;
    }, {});
  } catch { return {}; }
}

// ── YARDIMCI ─────────────────────────────────────────────────
export async function getNotifPref(userId: string, channelId: string): Promise<string> {
  const cacheKey = `notifpref:${userId}:${channelId}`;
  const cached = await cache.get(cacheKey);
  if (cached) return String(cached);
  const pref = await Notifications.findPref(userId, channelId) as { level?: string } | null;
  const level = normalizeNotificationLevel(pref?.level, Boolean(pref));
  await cache.set(cacheKey, level, 120);
  return level;
}

// ── PUSH BATCHING ─────────────────────────────────────────────
interface PendingPush {
  /** YALNIZCA gonderimde kullanilan son mesajlar tutulur (bkz. PUSH_KEEP_MSGS). */
  msgs:    MsgLike[];
  /** Gercek toplam — govde yalnizca son 3'u gosterse de baslik sayiyi kullanir. */
  count:   number;
  /** Ilk mesajin zamani — AZAMI BEKLEME suresini hesaplamak icin. */
  firstAt: number;
  timer:   ReturnType<typeof setTimeout> | null;
  reasons: Set<'mention' | 'watch-word'>;
}

const _pendingPush = new Map<string, PendingPush>();
const PUSH_DEBOUNCE_MS = 3000;

// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN IKI GERCEK KUSUR (P2) — GERI BASINC VE ACLIK
// ════════════════════════════════════════════════════════════════════════════
// Eski kod her yeni mesajda `clearTimeout` yapip 3 saniyelik zamanlayiciyi
// SIFIRDAN kuruyordu ve AZAMI BEKLEME yoktu. Iki sonucu vardi:
//
// A) BILDIRIM ACLIGI (islevsel kusur)
//    Mesajlar 3 saniyeden sik geldigi surece zamanlayici HIC ATESLENMEZ.
//    Yani hareketli bir sohbette kullaniciya push bildirimi HIC GITMEZ —
//    tam da en cok ihtiyac duyuldugu anda sessizce kaybolur.
//
// B) SINIRSIZ BIRIKIM (kaynak kusuru)
//    `msgs` her mesajda buyurdu ve zamanlayici atesleemedigi icin girdi
//    Map'ten hic silinmedi. Oysa gonderim yalnizca SON 3 mesaji ve TOPLAM
//    SAYIYI kullanir — digerlerini tutmanin hicbir faydasi yoktu.
//
// DUZELTME: sabit pencereli azami bekleme + sabit boyutlu tampon.
const PUSH_MAX_WAIT_MS = 15_000;   // en gec bu sure sonunda MUTLAKA gonderilir
const PUSH_KEEP_MSGS   = 3;        // govdede zaten yalnizca son 3 gosteriliyor

export async function deliverPushBatched(
  userId: string,
  msg: MsgLike,
  reason: 'mention' | 'watch-word' = 'mention',
): Promise<void> {
  const key = `${userId}:${String(msg.channelId)}`;

  const now = Date.now();
  let pending = _pendingPush.get(key);

  if (pending) {
    if (pending.timer) clearTimeout(pending.timer);
    pending.msgs.push(msg);
    // SABIT BOYUT: yalnizca gonderimde kullanilan son mesajlar tutulur.
    if (pending.msgs.length > PUSH_KEEP_MSGS) {
      pending.msgs.splice(0, pending.msgs.length - PUSH_KEEP_MSGS);
    }
    pending.count++;
    pending.reasons.add(reason);
  } else {
    pending = { msgs: [msg], count: 1, firstAt: now, timer: null, reasons: new Set([reason]) };
    _pendingPush.set(key, pending);
  }

  // AZAMI BEKLEME: ilk mesajin uzerinden PUSH_MAX_WAIT_MS gectiyse debounce
  // artik erteleyemez. Boylece surekli akan bir sohbet bildirimi ACLIGA
  // dusuremez.
  const elapsed = now - pending.firstAt;
  const delay   = Math.max(0, Math.min(PUSH_DEBOUNCE_MS, PUSH_MAX_WAIT_MS - elapsed));

  pending.timer = setTimeout(async () => {
    _pendingPush.delete(key);
    const msgs  = pending!.msgs;
    // `msgs.length` artik SABIT BOYUTLU tampondur; gercek toplam ayri tutulur.
    const count = pending!.count;
    const last  = msgs[msgs.length - 1];
    // Tampon boşsa gönderilecek anlamlı bir bildirim YOKTUR. Eskiden
    // `last.displayName` okunuyordu; boş tamponda bu, kullanıcıya
    // "undefined seni mention etti" başlıklı bir push GÖNDERİRDİ.
    if (!last) return;

    // Final21 Phase 16: written in the language the RECIPIENT reads. Before this, every push
    // was Turkish regardless of the reader's locale.
    const locale = await userLocale(userId);
    let title: string;
    let body: string;
    if (count === 1) {
      const name = String(last.displayName || last.username);
      title = pending!.reasons.has('watch-word') && !pending!.reasons.has('mention')
        ? serverText(locale, 'push_watch_word_title', { name })
        : serverText(locale, 'push_mention_title', { name });
      body  = storedMessageText(last).slice(0, 120);
    } else {
      let channelName = String(msg.channelId);
      try {
        const ch = await Channels.findById(String(msg.channelId)) as { name?: string } | null;
        if (ch) channelName = `#${ch.name}`;
      } catch {}
      title = pending!.reasons.size > 1 || pending!.reasons.has('watch-word')
        ? serverText(locale, 'push_many_notifications', { count, channel: channelName })
        : serverText(locale, 'push_many_mentions', { count, channel: channelName });
      body  = msgs.slice(-3)
        .map(m => `${String(m.displayName || m.username)}: ${storedMessageText(m).slice(0, 60)}`)
        .join('\n');
    }

    try {
      const payload: PushPayload = {
        title, body,
        icon:  '/icon-192.png',
        badge: '/badge-72.png',
        data:  { type: 'mention', reason: [...pending!.reasons][0] ?? 'mention', channelId: String(msg.channelId), serverId: String(msg.serverId) },
      };
      await sendPushToUser(userId, payload);
    } catch {}
  }, delay);
}

// ── TEST KANCALARI ───────────────────────────────────────────
export const __pendingPushForTest   = _pendingPush;
export const __PUSH_MAX_WAIT_MS     = PUSH_MAX_WAIT_MS;
export const __PUSH_DEBOUNCE_MS     = PUSH_DEBOUNCE_MS;
export const __PUSH_KEEP_MSGS       = PUSH_KEEP_MSGS;

// ── PUSH SUBSCRIPTION ROUTES ─────────────────────────────────
export const pushRouter = express.Router();

pushRouter.post('/subscribe', authMiddleware, async (req, res) => {
  const validated = validateWebPushSubscription(req.body?.subscription);
  if (!validated.ok) return res.status(400).json({ error: validated.error });

  const user = (req as typeof req & { user: { id: string } }).user;
  const { endpoint, keys } = validated.subscription;
  try {
    const existing = await Notifications.findPushSubscriptionForUserEndpoint(user.id, endpoint);
    if (existing) {
      await Notifications.updatePushSubscription(
        { userId: user.id, endpoint },
        { $set: { keys, updatedAt: Date.now() } },
      );
    } else {
      await Notifications.insertPushSubscription({
        _id: randomUUID(),
        userId: user.id,
        endpoint,
        keys,
        createdAt: Date.now(),
      });
    }
  } catch (err) {
    logger.error({ err, userId: user.id, endpoint, event: 'push.subscribe.storage_failed' }, 'Failed to persist push subscription');
    return res.status(503).json({ error: 'Push subscription storage unavailable' });
  }
  res.json({ subscribed: true });
});

pushRouter.delete('/unsubscribe', authMiddleware, async (req, res) => {
  const { endpoint } = req.body as { endpoint?: string };
  const user = (req as typeof req & { user: { id: string } }).user;
  try {
    await Notifications.removePushSubscriptionWhere({ userId: user.id, endpoint });
  } catch (err) {
    logger.error({ err, userId: user.id, endpoint, event: 'push.unsubscribe.storage_failed' }, 'Failed to remove push subscription');
    return res.status(503).json({ error: 'Push subscription storage unavailable' });
  }
  res.json({ unsubscribed: true });
});

pushRouter.get('/vapid-key', (_req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

pushRouter.post('/register-native', authMiddleware, async (req, res) => {
  const { token, platform } = req.body as { token?: string; platform?: string };
  const user = (req as typeof req & { user: { id: string } }).user;

  if (!token || typeof token !== 'string')
    return res.status(400).json({ error: 'token gerekli' });

  const plat = ['ios', 'android'].includes(platform || '') ? platform! : 'unknown';
  try {
    await Notifications.upsertNativeToken(user.id, plat, token);
  } catch (err) {
    logger.error({ err, userId: user.id, platform: plat, event: 'push.native.storage_failed' }, 'Failed to persist native push token');
    return res.status(503).json({ error: 'Push token storage unavailable' });
  }
  res.json({ ok: true });
});
