// server/db/repositories/NotificationRepository.js
// Bildirim tercihleri ve push token sorgularını tek noktada toplar.

'use strict';
const { v4: uuidv4 } = require('uuid');
const db = require('../loader');

class NotificationRepository {
  // ── Notification Preferences ───────────────────────────────

  async findPref(userId, channelId) {
    return db.notificationPrefs.findOne({ userId, channelId });
  }

  async upsertPref(userId, channelId, fields) {
    const existing = await this.findPref(userId, channelId);
    if (existing) {
      return db.notificationPrefs.update({ userId, channelId }, { $set: fields });
    }
    return db.notificationPrefs.insert({ userId, channelId, ...fields });
  }

  // ── Web Push Subscriptions ─────────────────────────────────

  async findPushSubscriptions(userId) {
    return db.pushSubscriptions?.find({ userId }) ?? [];
  }

  async insertPushSubscription(data) {
    return db.pushSubscriptions?.insert(data);
  }

  async removePushSubscription(endpoint) {
    return db.pushSubscriptions?.remove({ endpoint });
  }

  async findPushSubscriptionByEndpoint(endpoint) {
    try {
      return await db.pushSubscriptions?.findOne({ endpoint });
    } catch {
      return null;
    }
  }

  async findPushSubscriptionForUserEndpoint(userId, endpoint) {
    try {
      return await db.pushSubscriptions?.findOne({ userId, endpoint });
    } catch {
      return null;
    }
  }

  async updatePushSubscription(filter, modifier) {
    return db.pushSubscriptions?.update(filter, modifier);
  }

  async removePushSubscriptionWhere(filter, options) {
    return db.pushSubscriptions?.remove(filter, options ?? {}).catch(() => {});
  }

  async findPushSubscriptionsForUser(userId) {
    return db.pushSubscriptions?.find({ userId }).catch(() => []) ?? [];
  }

  prefsFindForUserChannels(userId, channelIds) {
    if (!channelIds?.length) return Promise.resolve([]);
    return db.notificationPrefs?.find({ userId, channelId: { $in: channelIds } }).catch(() => []) ?? [];
  }

  async findNativeTokensForUser(userId) {
    return db.nativePushTokens?.find({ userId }).catch(() => []) ?? [];
  }

  async removeNativeTokenWhere(query) {
    return db.nativePushTokens?.remove(query).catch(() => {});
  }

  async findFcmTokensForUser(userId) {
    return db.fcmTokens?.find({ userId }).catch(() => []) ?? [];
  }

  async removeFcmTokenWhere(query) {
    return db.fcmTokens?.remove(query).catch(() => {});
  }

  unreadFind(query) {
    return db.unreadCounts?.find(query);
  }

  async unreadFindOne(query) {
    return db.unreadCounts?.findOne(query);
  }

  async unreadUpdate(filter, modifier) {
    return db.unreadCounts?.update(filter, modifier);
  }

  async unreadInsert(doc) {
    return db.unreadCounts?.insert(doc);
  }

  prefsFind(query) {
    return db.notificationPrefs?.find(query);
  }

  // ── Native Push Tokens ─────────────────────────────────────

  async findNativeToken(userId, platform) {
    return db.nativePushTokens?.findOne({ userId, platform });
  }

  async upsertNativeToken(userId, platform, token) {
    const id       = `npt_${userId}_${platform}`;
    const existing = await this.findNativeToken(userId, platform);
    if (existing) {
      return db.nativePushTokens.update({ _id: existing._id }, { $set: { token, updatedAt: Date.now() } });
    }
    return db.nativePushTokens?.insert({ _id: id, userId, platform, token, createdAt: Date.now(), updatedAt: Date.now() });
  }

  async removeNativeToken(userId, platform) {
    return db.nativePushTokens?.remove({ userId, platform });
  }

  // ── Federation / ActivityPub gelen kutusu ──────────────────

  async insertInbox(data) {
    return db.notifications?.insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  async findInbox(query) {
    return db.notifications?.find(query) ?? [];
  }

  async updateInbox(filter, modifier) {
    return db.notifications?.update(filter, modifier);
  }

  inboxFind(query) {
    return db.notifications?.find(query);
  }

  async updateInboxMany(filter, modifier, options) {
    try {
      return await db.notifications?.update(filter, modifier, options);
    } catch {
      return null;
    }
  }
}

module.exports = new NotificationRepository();
export {};
