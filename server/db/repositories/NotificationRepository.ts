// server/db/repositories/NotificationRepository.ts
// Bildirim tercihleri ve push token sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';
import { postgresPoolOrTestFallback } from './postgresInvariant';
import { queryActivityUnreadChannels } from '../queries/activityUnread';

class NotificationRepository {
  private prefStore() {
    if (!db.notificationPrefs) throw new Error('notificationPrefs store unavailable');
    return db.notificationPrefs;
  }

  private keywordStore() {
    if (!db.notificationKeywords) throw new Error('notificationKeywords store unavailable');
    return db.notificationKeywords;
  }

  private inboxStore() {
    if (!db.notifications) throw new Error('notifications store unavailable');
    return db.notifications;
  }

  // ── Notification Preferences ───────────────────────────────

  async findPref(userId: string, channelId: string) {
    return this.prefStore().findOne({ userId, channelId });
  }

  async upsertPref(userId: string, channelId: string, fields: Record<string, unknown>) {
    // Repository boundary owns row identity and the table-specific write shape.
    // Never let dynamic caller fields override user/channel identity or invent
    // globally-valid-but-table-invalid PostgreSQL columns.
    const safeFields: Record<string, unknown> = {};
    for (const key of ['level', 'muteUntil', 'updatedAt']) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) safeFields[key] = fields[key];
    }

    const existing = await this.findPref(userId, channelId);
    if (existing) {
      return this.prefStore().update({ userId, channelId }, { $set: safeFields });
    }

    try {
      return await this.prefStore().insert({ userId, channelId, ...safeFields });
    } catch (error) {
      // Two nodes can both observe "missing" before either INSERT commits.
      // Migration 045 owns the canonical unique key; the loser converges on
      // UPDATE instead of surfacing a user-visible 500. Non-uniqueness errors
      // remain real defects and must not be swallowed.
      const code = String((error as { code?: unknown })?.code ?? '');
      const message = String((error as Error)?.message ?? '');
      if (code !== '23505' && !/duplicate|unique/i.test(message)) throw error;
      return this.prefStore().update({ userId, channelId }, { $set: safeFields });
    }
  }

  // ── Notification Watch Words ────────────────────────────────

  async listWatchWords(userId: string, serverId: string): Promise<string[]> {
    const rows = await this.keywordStore().find({ userId, serverId });
    return (rows ?? [])
      .map((row: Record<string, unknown>) => String(row.keyword ?? ''))
      .filter(Boolean)
      .sort((a: string, b: string) => a.localeCompare(b));
  }

  async findMatchingWatchWords(serverId: string, words: string[]) {
    if (!words.length) return [];
    return await this.keywordStore().find({ serverId, keyword: { $in: words } }) ?? [];
  }

  /**
   * Replace the complete per-server watch-word set. PostgreSQL uses one data-
   * modifying CTE so a crash cannot leave a partially replaced preference.
   */
  async replaceWatchWords(userId: string, serverId: string, words: string[], now = Date.now()): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      const pool = postgresPoolOrTestFallback(
        (db as unknown as { _pool?: import('pg').Pool })._pool,
        'notification watch-word replace',
      );
      if (!pool?.query) throw new Error('PostgreSQL pool cannot query for notification watch-word replace');
      await pool.query(
        `WITH removed AS (
           DELETE FROM notification_keywords WHERE "userId"=$1 AND "serverId"=$2
         )
         INSERT INTO notification_keywords ("userId", "serverId", keyword, "createdAt")
         SELECT $1, $2, word, $4 FROM unnest($3::text[]) AS word
         ON CONFLICT ("userId", "serverId", keyword) DO NOTHING`,
        [userId, serverId, words, now],
      );
      return;
    }

    await this.keywordStore().remove({ userId, serverId });
    for (const keyword of words) {
      await this.keywordStore().insert({ userId, serverId, keyword, createdAt: now });
    }
  }

  // ── Web Push Subscriptions ─────────────────────────────────

  private pushStore() {
    if (!db.pushSubscriptions) throw new Error('pushSubscriptions store unavailable');
    return db.pushSubscriptions;
  }

  private nativePushStore() {
    if (!db.nativePushTokens) throw new Error('nativePushTokens store unavailable');
    return db.nativePushTokens;
  }

  private fcmStore() {
    if (!db.fcmTokens) throw new Error('fcmTokens store unavailable');
    return db.fcmTokens;
  }

  async findPushSubscriptions(userId: string) {
    const rows = await this.pushStore().find({ userId });
    return rows ?? [];
  }

  async insertPushSubscription(data: Record<string, unknown>) {
    return this.pushStore().insert(data);
  }

  async removePushSubscription(endpoint: string) {
    return this.pushStore().remove({ endpoint });
  }

  async findPushSubscriptionByEndpoint(endpoint: string) {
    return this.pushStore().findOne({ endpoint });
  }

  async findPushSubscriptionForUserEndpoint(userId: string, endpoint: string) {
    return this.pushStore().findOne({ userId, endpoint });
  }

  async updatePushSubscription(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return this.pushStore().update(filter, modifier);
  }

  async removePushSubscriptionWhere(filter: Record<string, unknown>, options?: Record<string, unknown>) {
    return this.pushStore().remove(filter, options ?? {});
  }

  async findPushSubscriptionsForUser(userId: string) {
    const rows = await this.pushStore().find({ userId });
    return rows ?? [];
  }

  prefsFindForUserChannels(userId: string, channelIds: string[]) {
    if (!channelIds?.length) return Promise.resolve([]);
    return this.prefStore().find({ userId, channelId: { $in: channelIds } });
  }

  async findNativeTokensForUser(userId: string) {
    const rows = await this.nativePushStore().find({ userId });
    return rows ?? [];
  }

  async removeNativeTokenWhere(query: Record<string, unknown>) {
    return this.nativePushStore().remove(query);
  }

  async findFcmTokensForUser(userId: string) {
    const rows = await this.fcmStore().find({ userId });
    return rows ?? [];
  }

  async removeFcmTokenWhere(query: Record<string, unknown>) {
    return this.fcmStore().remove(query);
  }

  unreadFind(query: Record<string, unknown>) {
    return db.unreadCounts.find(query);
  }

  async unreadFindOne(query: Record<string, unknown>) {
    return db.unreadCounts.findOne(query);
  }

  async unreadUpdate(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return db.unreadCounts.update(filter, modifier);
  }

  async unreadInsert(doc: Record<string, unknown>) {
    return db.unreadCounts.insert(doc);
  }

  // ── Chronological Channel Read Position ───────────────────────────────

  async findChannelReadPosition(userId: string, channelId: string) {
    return db.channelReadPositions.findOne({ userId, channelId });
  }

  /**
   * Monotonic read cursor. Two tabs may mark the same channel concurrently; a
   * slower response must never move the user's position backwards. PostgreSQL
   * compares the same `(createdAt, messageId)` tuple used by message pagination.
   */
  async advanceChannelReadPosition(
    userId: string, channelId: string, lastReadAt: number, lastReadMessageId: string, updatedAt = Date.now(),
  ): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      const pool = postgresPoolOrTestFallback(
        (db as unknown as { _pool?: import('pg').Pool })._pool,
        'channel read-position upsert',
      );
      if (!pool?.query) throw new Error('PostgreSQL pool cannot query for channel read-position upsert');
      await pool.query(
        `INSERT INTO channel_read_positions
           ("userId", "channelId", "lastReadAt", "lastReadMessageId", "updatedAt")
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ("userId", "channelId") DO UPDATE
           SET "lastReadAt" = EXCLUDED."lastReadAt",
               "lastReadMessageId" = EXCLUDED."lastReadMessageId",
               "updatedAt" = EXCLUDED."updatedAt"
         WHERE (EXCLUDED."lastReadAt", EXCLUDED."lastReadMessageId") >=
               (channel_read_positions."lastReadAt", channel_read_positions."lastReadMessageId")`,
        [userId, channelId, lastReadAt, lastReadMessageId, updatedAt],
      );
      return;
    }

    // Test adapter compatibility with the same monotonic semantics.
    const existing = await db.channelReadPositions.findOne({ userId, channelId }) as
      | { lastReadAt?: unknown; lastReadMessageId?: unknown } | null;
    const oldAt = Number(existing?.lastReadAt ?? -1);
    const oldId = String(existing?.lastReadMessageId ?? '');
    if (existing && (lastReadAt < oldAt || (lastReadAt === oldAt && lastReadMessageId < oldId))) return;
    if (existing) {
      await db.channelReadPositions.update({ userId, channelId }, {
        $set: { lastReadAt, lastReadMessageId, updatedAt },
      });
    } else {
      await db.channelReadPositions.insert({ userId, channelId, lastReadAt, lastReadMessageId, updatedAt });
    }
  }

  /** PostgreSQL owner for the shared unread counter mutation. */
  async unreadIncrementAtomic(userId: string, channelId: string, now: number): Promise<boolean> {
    if (process.env.NODE_ENV === 'test') return false;
    const pool = postgresPoolOrTestFallback(
      (db as unknown as { _pool?: import('pg').Pool })._pool,
      'atomic unread increment',
    );
    if (!pool?.query) throw new Error('PostgreSQL pool cannot query for atomic unread increment');

    await pool.query(
      `INSERT INTO unread_counts ("userId", "channelId", count, "createdAt", "updatedAt")
       VALUES ($1, $2, 1, $3, $3)
       ON CONFLICT ("userId", "channelId")
       DO UPDATE SET count = unread_counts.count + 1, "updatedAt" = EXCLUDED."updatedAt"`,
      [userId, channelId, now],
    );
    return true;
  }

  prefsFind(query: Record<string, unknown>) {
    return this.prefStore().find(query);
  }

  async findPrefsForUserInServer(userId: string, serverId: string) {
    const channels = await db.channels.find({ serverId }) ?? [];
    const channelIds = channels.map((c: { _id?: unknown }) => String(c._id ?? '')).filter(Boolean);
    if (!channelIds.length) return [];
    return this.prefStore().find({ userId, channelId: { $in: channelIds } });
  }

  /** Channels with messages from others newer than the user's read cursor (lib/channelActivity.ts). */
  async findActivityUnreadChannels(userId: string): Promise<Array<{ channelId: string; serverId: string }>> {
    const pool = postgresPoolOrTestFallback(
      (db as unknown as { _pool?: import('pg').Pool })._pool,
      'unread channel activity',
    );
    if (!pool?.query) return [];
    return queryActivityUnreadChannels(pool, userId);
  }

  async findPrefsForUser(userId: string) {
    return await this.prefStore().find({ userId }) ?? [];
  }

  async findServerPref(userId: string, serverId: string) {
    return this.prefStore().findOne({ userId, channelId: `server:${serverId}` });
  }

  async deletePref(userId: string, channelId?: string, serverId?: string) {
    const query: Record<string, unknown> = { userId };
    if (channelId) query.channelId = channelId;
    if (serverId) query.channelId = `server:${serverId}`;
    return this.prefStore().remove(query);
  }

  // ── Native Push Tokens ─────────────────────────────────────

  async findNativeToken(userId: string, platform: string) {
    return this.nativePushStore().findOne({ userId, platform });
  }

  async upsertNativeToken(userId: string, platform: string, token: string) {
    const id       = `npt_${userId}_${platform}`;
    const existing = await this.findNativeToken(userId, platform);
    if (existing) {
      return this.nativePushStore().update({ _id: existing._id }, { $set: { token, updatedAt: Date.now() } });
    }
    return this.nativePushStore().insert({ _id: id, userId, platform, token, createdAt: Date.now(), updatedAt: Date.now() });
  }

  async removeNativeToken(userId: string, platform: string) {
    return this.nativePushStore().remove({ userId, platform });
  }

  // ── Federation / ActivityPub gelen kutusu ──────────────────

  async insertInbox(data: Record<string, unknown>) {
    return this.inboxStore().insert({ _id: uuidv4(), createdAt: Date.now(), ...data });
  }

  /**
   * Deterministic personal Saved reminder notification. Including `remindAt`
   * in the id allows the same Saved item to be rescheduled after delivery,
   * while worker retries for one schedule remain duplicate-safe.
   */
  async insertSavedReminder(userId: string, savedId: string, remindAt: number): Promise<boolean> {
    const _id = `inbox:saved-reminder:${userId}:${savedId}:${remindAt}`;
    if (await this.inboxStore().findOne({ _id })) return false;
    try {
      await this.inboxStore().insert({
        _id, userId, type: 'saved_reminder', activityId: `saved:${savedId}:${remindAt}`, noteId: savedId,
        read: false, createdAt: Date.now(),
      });
      return true;
    } catch (error) {
      const code = String((error as { code?: unknown })?.code ?? '');
      if (code === '23505' || /duplicate|unique/i.test(String((error as Error)?.message ?? ''))) return false;
      throw error;
    }
  }

  async findUnreadSavedReminders(userId: string, limit = 100) {
    return this.inboxStore().find({ userId, type: 'saved_reminder', read: false })
      .sort({ createdAt: -1, _id: -1 }).limit(Math.min(Math.max(limit, 1), 200));
  }

  async markSavedReminderRead(userId: string, id: string) {
    return this.inboxStore().update({ _id: id, userId, type: 'saved_reminder' }, { $set: { read: true } });
  }

  async markAllSavedRemindersRead(userId: string) {
    return this.inboxStore().update({ userId, type: 'saved_reminder', read: false }, { $set: { read: true } }, { multi: true });
  }

  async findInbox(query: Record<string, unknown>) {
    return await this.inboxStore().find(query) ?? [];
  }

  async updateInbox(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return this.inboxStore().update(filter, modifier);
  }

  inboxFind(query: Record<string, unknown>) {
    return this.inboxStore().find(query);
  }

  async updateInboxMany(filter: Record<string, unknown>, modifier: Record<string, unknown>, options?: Record<string, unknown>) {
    return this.inboxStore().update(filter, modifier, options);
  }

  // ── Unified Inbox ──────────────────────────────────────────

  /**
   * Persist one canonical attention row per (recipient, message).
   *
   * The deterministic id and database unique index make socket retries,
   * worker retries and backend restarts idempotent. Only identifiers are
   * stored; display metadata is resolved again after an authorization check.
   */
  async insertChannelAttention(data: {
    userId: string;
    type: 'mention' | 'reply' | 'watch';
    serverId: string;
    channelId: string;
    messageId: string;
    actorId: string;
    createdAt?: number;
  }): Promise<boolean> {
    const _id = `inbox:${data.userId}:${data.messageId}`;
    try {
      if (await this.inboxStore().findOne({ _id })) return false;
      await this.inboxStore().insert({
        _id,
        userId: data.userId,
        type: data.type,
        serverId: data.serverId,
        channelId: data.channelId,
        messageId: data.messageId,
        actorId: data.actorId,
        read: false,
        createdAt: data.createdAt ?? Date.now(),
      });
      return true;
    } catch (error) {
      // Duplicate delivery is expected and means the canonical row already
      // exists. Fail closed for other write errors without breaking messages.
      const code = String((error as { code?: unknown })?.code ?? '');
      if (code === '23505' || /duplicate|unique/i.test(String((error as Error)?.message ?? ''))) return false;
      throw error;
    }
  }

  async findUnreadChannelAttention(userId: string, limit = 100) {
    return this.inboxStore()
      .find({ userId, read: false, type: { $in: ['mention', 'reply', 'watch'] } })
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(limit, 1), 200));
  }

  async markChannelAttentionRead(userId: string, channelId: string) {
    return this.inboxStore().update(
      { userId, channelId, read: false, type: { $in: ['mention', 'reply', 'watch'] } },
      { $set: { read: true } },
      { multi: true },
    );
  }

  async markAllChannelAttentionRead(userId: string) {
    return this.inboxStore().update(
      { userId, read: false, type: { $in: ['mention', 'reply', 'watch'] } },
      { $set: { read: true } },
      { multi: true },
    );
  }

  async clearAllUnreadCounts(userId: string) {
    return db.unreadCounts.update(
      { userId, count: { $gt: 0 } },
      { $set: { count: 0, updatedAt: Date.now() } },
      { multi: true },
    );
  }
}

export default new NotificationRepository();
