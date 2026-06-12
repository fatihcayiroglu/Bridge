// @ts-nocheck
// server/lib/notifications.ts — Oturum 16: targetUserIds, deliverPushBatched imzaları
// Mention detection, notification queue, push support

import logger from './logger';
import { randomUUID } from 'crypto';
import { cache } from './redisAdapter';
import { Users, Channels, Members, Notifications } from '../db/repositories';
import { sendPushToUser, PushPayload } from './pushSender';
import express from 'express';
import { authMiddleware } from '../middleware/auth';

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
}

interface UnreadRow {
  channelId: string;
  count:     number;
  userId:    string;
}

// ── Regex ─────────────────────────────────────────────────────
const MENTION_REGEX  = /@([a-zA-Z0-9_]+)/g;
const EVERYONE_REGEX = /@(everyone|here)/;

// ── ANA FONKSİYON ────────────────────────────────────────────
export async function processNotifications(
  msg: MsgLike,
  io: unknown,
  socketUsers: Map<string, { id: string }>,
): Promise<void> {
  try {
    const content = String(msg.content || '');
    const mentions = extractMentions(content);
    const isEveryoneMention = EVERYONE_REGEX.test(content);

    if (!mentions.length && !isEveryoneMention) return;

    const channel = await Channels.findById(String(msg.channelId));
    if (!channel) return;

    let targetUserIds: string[] = [];

    if (isEveryoneMention) {
      const members = await Members.findByServer(String(msg.serverId)) as Array<{ userId: string }>;
      targetUserIds = members.map(m => m.userId).filter(id => id !== String(msg.userId));
    } else {
      const users = await Users.findByUsernames(mentions) as UserRow[];
      const memberUserIds = new Set(
        (await Members.findByServer(String(msg.serverId)) as Array<{ userId: string }>).map(m => m.userId)
      );
      targetUserIds = users
        .filter(u => memberUserIds.has(u._id) && u._id !== String(msg.userId))
        .map(u => u._id);
    }

    if (!targetUserIds.length) return;

    const [notifPrefsRows, usernameRows] = await Promise.all([
      Notifications.prefsFind({ userId: { $in: targetUserIds }, channelId: msg.channelId }).catch(() => []) ?? [],
      Users.findByIds(targetUserIds) as Promise<UserRow[]>,
    ]);

    const prefMap = new Map<string, string>();
    for (const p of (notifPrefsRows as PrefRow[] || [])) prefMap.set(p.userId, p.level);

    const usernameMap = new Map<string, string>();
    for (const u of (usernameRows as UserRow[])) usernameMap.set(u._id, (u.username || '').toLowerCase());

    const notifPromises = targetUserIds.map(async (userId) => {
      const pref = prefMap.get(userId) || 'all';
      if (pref === 'mute') return;
      if (pref === 'mentions' && !isEveryoneMention && !mentions.includes(usernameMap.get(userId) || '')) return;

      deliverRealtimeNotif(userId, msg, socketUsers, io);
      await deliverPushBatched(userId, msg);
      await incrementUnread(userId, String(msg.channelId));
    });

    await Promise.allSettled(notifPromises);
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
    if (!['everyone', 'here'].includes(match[1])) {
      mentions.push(match[1].toLowerCase());
    }
  }
  return [...new Set(mentions)];
}

// ── REALTIME SOCKET BİLDİRİMİ ────────────────────────────────
function deliverRealtimeNotif(
  userId: string,
  msg: MsgLike,
  socketUsers: Map<string, { id: string }>,
  io: unknown,
): void {
  const ioServer = io as { to(id: string): { emit(ev: string, data: unknown): void } };
  for (const [socketId, su] of socketUsers) {
    if (su.id === userId) {
      ioServer.to(socketId).emit('notification:mention', {
        type:       'mention',
        messageId:  msg._id,
        channelId:  msg.channelId,
        serverId:   msg.serverId,
        fromUser:   msg.displayName,
        fromUserId: msg.userId,
        preview:    (String(msg.content || '')).slice(0, 100),
        createdAt:  msg.createdAt,
      });
    }
  }
}

// ── OKUNMAMIŞ SAYACI ─────────────────────────────────────────
export async function incrementUnread(userId: string, channelId: string): Promise<void> {
  const existing = await Notifications.unreadFindOne({ userId, channelId }) as UnreadRow | null;
  if (existing) {
    await Notifications.unreadUpdate(
      { userId, channelId },
      { $set: { count: (existing.count || 0) + 1, updatedAt: Date.now() } }
    );
  } else {
    await Notifications.unreadInsert({ userId, channelId, count: 1, createdAt: Date.now(), updatedAt: Date.now() });
  }
}

export async function clearUnread(userId: string, channelId: string): Promise<void> {
  try {
    await Notifications.unreadUpdate({ userId, channelId }, { $set: { count: 0, updatedAt: Date.now() } });
  } catch {}
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
  const level = pref?.level || 'all';
  await cache.set(cacheKey, level, 120);
  return level;
}

// ── PUSH BATCHING ─────────────────────────────────────────────
interface PendingPush {
  msgs:  MsgLike[];
  timer: ReturnType<typeof setTimeout> | null;
}

const _pendingPush = new Map<string, PendingPush>();
const PUSH_DEBOUNCE_MS = 3000;

export async function deliverPushBatched(
  userId: string,
  msg: MsgLike,
): Promise<void> {
  const key = `${userId}:${String(msg.channelId)}`;

  if (_pendingPush.has(key)) {
    const pending = _pendingPush.get(key)!;
    if (pending.timer) clearTimeout(pending.timer);
    pending.msgs.push(msg);
  } else {
    _pendingPush.set(key, { msgs: [msg], timer: null });
  }

  const pending = _pendingPush.get(key)!;
  pending.timer = setTimeout(async () => {
    _pendingPush.delete(key);
    const msgs  = pending.msgs;
    const count = msgs.length;
    const last  = msgs[msgs.length - 1];

    let title: string;
    let body: string;
    if (count === 1) {
      title = `${String(last.displayName || last.username)} seni mention etti`;
      body  = String(last.content || '').slice(0, 120);
    } else {
      let channelName = String(msg.channelId);
      try {
        const ch = await Channels.findById(String(msg.channelId)) as { name?: string } | null;
        if (ch) channelName = `#${ch.name}`;
      } catch {}
      title = `${count} yeni mention — ${channelName}`;
      body  = msgs.slice(-3)
        .map(m => `${String(m.displayName || m.username)}: ${String(m.content || '').slice(0, 60)}`)
        .join('\n');
    }

    try {
      const payload: PushPayload = {
        title, body,
        icon:  '/icon-192.png',
        badge: '/badge-72.png',
        data:  { type: 'mention', channelId: String(msg.channelId), serverId: String(msg.serverId) },
      };
      await sendPushToUser(userId, payload);
    } catch {}
  }, PUSH_DEBOUNCE_MS);
}

// ── PUSH SUBSCRIPTION ROUTES ─────────────────────────────────
export const pushRouter = express.Router();

pushRouter.post('/subscribe', authMiddleware, async (req, res) => {
  const { subscription } = req.body as { subscription?: { endpoint?: string; keys?: Record<string, string> } };
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });

  const user = (req as typeof req & { user: { id: string } }).user;
  const existing = await Notifications.findPushSubscriptionForUserEndpoint(user.id, subscription.endpoint);
  if (!existing) {
    await Notifications.insertPushSubscription({
      _id:       randomUUID(),
      userId:    user.id,
      endpoint:  subscription.endpoint,
      keys:      subscription.keys || {},
      createdAt: Date.now(),
    });
  }
  res.json({ subscribed: true });
});

pushRouter.delete('/unsubscribe', authMiddleware, async (req, res) => {
  const { endpoint } = req.body as { endpoint?: string };
  const user = (req as typeof req & { user: { id: string } }).user;
  await Notifications.removePushSubscriptionWhere({ userId: user.id, endpoint });
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
  await Notifications.upsertNativeToken(user.id, plat, token);
  res.json({ ok: true });
});
