// server/db/repositories/NotificationRepository.ts
// Bildirim tercihleri ve push token sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';

class NotificationRepository {
  // ── Notification Preferences ───────────────────────────────

  async findPref(userId: string, channelId: string) {
    return db.notificationPrefs.findOne({ userId, channelId });
  }

  async upsertPref(userId: string, channelId: string, fields: Record<string, unknown>) {
    const existing = await this.findPref(userId, channelId);
    if (existing) {
      return db.notificationPrefs.update({ userId, channelId }, { $set: fields });
    }
    return db.notificationPrefs.insert({ userId, channelId, ...fields });
  }

  // ── Web Push Subscriptions ─────────────────────────────────

  async findPushSubscriptions(userId: string) {
    try {
      const rows = await db.pushSubscriptions?.find({ userId });
      return rows ?? [];
    } catch {
      return [];
    }
  }

  async insertPushSubscription(data: Record<string, unknown>) {
    return db.pushSubscriptions?.insert(data);
  }

  async removePushSubscription(endpoint: string) {
    return db.pushSubscriptions?.remove({ endpoint });
  }

  async findPushSubscriptionByEndpoint(endpoint: string) {
    try {
      return await db.pushSubscriptions?.findOne({ endpoint });
    } catch {
      return null;
    }
  }

  async findPushSubscriptionForUserEndpoint(userId: string, endpoint: string) {
    try {
      return await db.pushSubscriptions?.findOne({ userId, endpoint });
    } catch {
      return null;
    }
  }

  async updatePushSubscription(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return db.pushSubscriptions?.update(filter, modifier);
  }

  async removePushSubscriptionWhere(filter: Record<string, unknown>, options?: Record<string, unknown>) {
    return db.pushSubscriptions?.remove(filter, options ?? {}).catch(() => {});
  }

  async findPushSubscriptionsForUser(userId: string) {
    try {
      const rows = await db.pushSubscriptions?.find({ userId });
      return rows ?? [];
    } catch {
      return [];
    }
  }

  prefsFindForUserChannels(userId: string, channelIds: string[]) {
    if (!channelIds?.length) return Promise.resolve([]);
    return db.notificationPrefs?.find({ userId, channelId: { $in: channelIds } }).catch(() => []) ?? [];
  }

  async findNativeTokensForUser(userId: string) {
    return db.nativePushTokens?.find({ userId }).catch(() => []) ?? [];
  }

  async removeNativeTokenWhere(query: Record<string, unknown>) {
    return db.nativePushTokens?.remove(query).catch(() => {});
  }

  async findFcmTokensForUser(userId: string) {
    return db.fcmTokens?.find({ userId }).catch(() => []) ?? [];
  }

  async removeFcmTokenWhere(query: Record<string, unknown>) {
    return db.fcmTokens?.remove(query).catch(() => {});
  }

  unreadFind(query: Record<string, unknown>) {
    return db.unreadCounts?.find(query);
  }

  async unreadFindOne(query: Record<string, unknown>) {
    return db.unreadCounts?.findOne(query);
  }

  async unreadUpdate(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return db.unreadCounts?.update(filter, modifier);
  }

  async unreadInsert(doc: Record<string, unknown>) {
    return db.unreadCounts?.insert(doc);
  }

  prefsFind(query: Record<string, unknown>) {
    return db.notificationPrefs?.find(query);
  }

  async findPrefsForUserInServer(userId: string, serverId: string) {
    return db.notificationPrefs?.find({ userId, serverId }).catch(() => []) ?? [];
  }

  async findPrefsForUser(userId: string) {
    return db.notificationPrefs?.find({ userId }).catch(() => []) ?? [];
  }

  async findServerPref(userId: string, serverId: string) {
    return db.notificationPrefs?.findOne({ userId, serverId }).catch(() => null);
  }

  async deletePref(userId: string, channelId?: string, serverId?: string) {
    const query: Record<string, unknown> = { userId };
    if (channelId) query.channelId = channelId;
    if (serverId) query.serverId = serverId;
    return db.notificationPrefs?.remove(query);
  }

  // ── Native Push Tokens ─────────────────────────────────────

  async findNativeToken(userId: string, platform: string) {
    return db.nativePushTokens?.findOne({ userId, platform });
  }

  async upsertNativeToken(userId: string, platform: string, token: string) {
    const id       = `npt_${userId}_${platform}`;
    const existing = await this.findNativeToken(userId, platform);
    if (existing) {
      return db.nativePushTokens.update({ _id: existing._id }, { $set: { token, updatedAt: Date.now() } });
    }
    return db.nativePushTokens?.insert({ _id: id, userId, platform, token, createdAt: Date.now(), updatedAt: Date.now() });
  }

  async removeNativeToken(userId: string, platform: string) {
    return db.nativePushTokens?.remove({ userId, platform });
  }

  // ── Federation / ActivityPub gelen kutusu ──────────────────

  async insertInbox(data: Record<string, unknown>) {
    return db.notifications?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async findInbox(query: Record<string, unknown>) {
    return db.notifications?.find(query) ?? [];
  }

  async updateInbox(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return db.notifications?.update(filter, modifier);
  }

  inboxFind(query: Record<string, unknown>) {
    return db.notifications?.find(query);
  }

  async updateInboxMany(filter: Record<string, unknown>, modifier: Record<string, unknown>, options?: Record<string, unknown>) {
    try {
      return await db.notifications?.update(filter, modifier, options);
    } catch {
      return null;
    }
  }
}

export default new NotificationRepository();
