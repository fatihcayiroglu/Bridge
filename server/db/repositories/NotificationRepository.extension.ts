// server/db/repositories/NotificationRepository.extension.ts  (Sprint 91)
// Mevcut NotificationRepository'ye eksik metotları ekle.
// Bu dosya NotificationRepository.ts'in import'u yerine geçer veya
// mevcut sınıfa mixin olarak uygulanır.

import { getDb } from '../connection';

// ── Types ────────────────────────────────────────────────────────────────────

export interface NotifPref {
  userId:        string;
  channelId:     string;
  level:         'all' | 'mentions' | 'mute' | 'default';
  muteUntil?:    number | null;
  updatedAt:     number;
  isServerLevel?: boolean;
  serverId?:     string;
}

// ── Repository methods ────────────────────────────────────────────────────────

export async function upsertNotifPref(
  userId: string,
  channelId: string,
  fields: Partial<NotifPref>
): Promise<NotifPref> {
  const db  = getDb();
  const col = db.collection<NotifPref>('notification_prefs');

  const update: Partial<NotifPref> & { updatedAt: number } = {
    ...fields,
    userId,
    channelId,
    updatedAt: Date.now(),
  };

  await col.updateOne(
    { userId, channelId },
    { $set: update },
    { upsert: true }
  );

  return { userId, channelId, level: fields.level ?? 'default', ...update };
}

export async function findPrefsForUserInServer(
  userId: string,
  serverId: string
): Promise<NotifPref[]> {
  const db  = getDb();

  // Get all channel IDs in this server first
  const channels = await db.collection('channels')
    .find({ serverId }, { projection: { _id: 1 } })
    .toArray();

  const channelIds = channels.map((c: { _id?: unknown }) => String(c._id));
  if (!channelIds.length) return [];

  return db.collection<NotifPref>('notification_prefs')
    .find({ userId, channelId: { $in: channelIds } })
    .toArray();
}

export async function findServerPref(
  userId: string,
  serverId: string
): Promise<NotifPref | null> {
  const db = getDb();
  return db.collection<NotifPref>('notification_prefs')
    .findOne({ userId, channelId: `server:${serverId}` });
}

export async function findPrefsForUser(userId: string): Promise<NotifPref[]> {
  const db = getDb();
  return db.collection<NotifPref>('notification_prefs')
    .find({ userId })
    .toArray();
}

export async function deleteNotifPref(userId: string, channelId: string): Promise<void> {
  const db = getDb();
  await db.collection('notification_prefs').deleteOne({ userId, channelId });
}

// ── Index creation (call once on server start) ────────────────────────────────

export async function ensureNotifPrefIndexes(): Promise<void> {
  const db  = getDb();
  const col = db.collection('notification_prefs');

  await col.createIndex({ userId: 1, channelId: 1 }, { unique: true });
  await col.createIndex({ userId: 1 });
  await col.createIndex({ channelId: 1 });
}
