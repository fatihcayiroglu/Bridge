// server/db/repositories/ServerRepository.ts (loader + $in fix)

import db from '../loader';
import { postgresPoolOrTestFallback } from './postgresInvariant';
import { memberProfileAssetUrls, releaseUnreferencedUploads } from '../../lib/uploadRelease';
import logger from '../../lib/logger';

class ServerRepository {
  private createWithDefaultsTail: Promise<void> = Promise.resolve();
  async findById(id: string) {
    return db.servers.findOne({ _id: id });
  }

  async findByOwner(ownerId: string) {
    return db.servers.find({ ownerId });
  }

  async findJoinedByUser(userId: string) {
    const memberships = await db.members.find({ userId });
    if (!memberships.length) return [];
    const serverIds = memberships.map((m) => m.serverId);
    return db.servers.find({ _id: { $in: serverIds } });
  }

  async findByIds(ids: string[]) {
    if (!ids || ids.length === 0) return [];
    return db.servers.find({ _id: { $in: ids } });
  }

  async find(query: Record<string, unknown>) {
    return db.servers.find(query);
  }

  async findOne(query: Record<string, unknown>) {
    return db.servers.findOne(query);
  }

  async create(data: Record<string, unknown>) {
    return db.servers.insert(data);
  }

  /**
   * Create the server, default channels, and owner membership as one durable
   * aggregate. The per-owner advisory lock also makes MAX_SERVERS_PER_USER a
   * concurrency-safe policy rather than a racy route-level count.
   */
  async createWithDefaultsAtomic(input: {
    serverId: string;
    ownerId: string;
    name: string;
    icon: string;
    textChannelId: string;
    voiceChannelId: string;
    createdAt: number;
    maxOwnedServers: number;
  }): Promise<{ status: 'created'; server: Record<string, unknown> } | { status: 'limit' }> {
    const { serverId, ownerId, name, icon, textChannelId, voiceChannelId, createdAt, maxOwnedServers } = input;
    for (const [field, value] of Object.entries({ serverId, ownerId, name, icon, textChannelId, voiceChannelId })) {
      if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
    }
    if (!Number.isSafeInteger(createdAt) || createdAt <= 0) throw new RangeError('createdAt must be a positive safe integer');
    if (!Number.isSafeInteger(maxOwnedServers) || maxOwnedServers < 1) throw new RangeError('maxOwnedServers must be a positive safe integer');

    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.connect ? rawPool : null, 'ServerRepository atomic operation');
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Hash-lock is scoped to this transaction and serializes only creations
        // for the same owner, including the pre-insert resource-limit count.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`server-create:${ownerId}`]);
        const countResult = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM servers WHERE "ownerId"=$1',
          [ownerId],
        );
        const ownedCount = Number(countResult.rows[0]?.count ?? '0');
        if (!Number.isSafeInteger(ownedCount) || ownedCount < 0) {
          throw new Error('Invalid owned-server count returned by PostgreSQL');
        }
        if (ownedCount >= maxOwnedServers) {
          await client.query('ROLLBACK');
          return { status: 'limit' };
        }

        const serverResult = await client.query<Record<string, unknown>>(
          `INSERT INTO servers (_id, name, icon, "ownerId", "createdAt")
           VALUES ($1,$2,$3,$4,$5)
           RETURNING *`,
          [serverId, name, icon, ownerId, createdAt],
        );
        await client.query(
          `INSERT INTO channels (_id, "serverId", name, type, topic, category, "order", "createdAt")
           VALUES
             ($1,$3,'general','text','General chat','GENERAL',0,$4),
             ($2,$3,'General Voice','voice','','VOICE',1,$4)`,
          [textChannelId, voiceChannelId, serverId, createdAt],
        );
        await client.query(
          `INSERT INTO members ("userId", "serverId", roles, "joinedAt")
           VALUES ($1,$2,'[]'::jsonb,$3)`,
          [ownerId, serverId, createdAt],
        );
        const server = serverResult.rows[0];
        if (!server) throw new Error('Server insert returned no row');
        await client.query('COMMIT');
        return { status: 'created', server };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }

    // In-memory/unit-test compatibility: serialize the aggregate and compensate
    // partial writes on failure. Production durability is provided by the SQL
    // transaction above; this branch intentionally does not pretend to be a DB
    // transaction engine.
    const previous = this.createWithDefaultsTail;
    let release!: () => void;
    this.createWithDefaultsTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const owned = await db.servers.find({ ownerId });
      if (owned.length >= maxOwnedServers) return { status: 'limit' };

      const server = await db.servers.insert({ _id: serverId, name, icon, ownerId, createdAt });
      try {
        await db.channels.insert({ _id: textChannelId, serverId, name: 'general', type: 'text', topic: 'General chat', category: 'GENERAL', order: 0, createdAt });
        await db.channels.insert({ _id: voiceChannelId, serverId, name: 'General Voice', type: 'voice', topic: '', category: 'VOICE', order: 1, createdAt });
        await db.members.insert({ userId: ownerId, serverId, roles: [], joinedAt: createdAt });
      } catch (err) {
        await db.members.remove({ userId: ownerId, serverId }).catch(() => undefined);
        await db.channels.remove({ serverId }).catch(() => undefined);
        await db.servers.remove({ _id: serverId }).catch(() => undefined);
        throw err;
      }
      return { status: 'created', server: server as unknown as Record<string, unknown> };
    } finally {
      release();
    }
  }

  async update(id: string, fields: Record<string, unknown>) {
    return db.servers.update({ _id: id }, { $set: fields });
  }

  async delete(id: string) {
    return db.servers.remove({ _id: id });
  }

  /**
   * Delete the complete server-owned relational graph.
   *
   * Production PostgreSQL uses ONE transaction. This is intentionally broader
   * than the historical route-level Promise.all cascade: most Bridge tables do
   * not have an FK to servers/channels, so deleting only channels/members/roles
   * leaves durable orphan rows and a mid-delete failure can expose a half-deleted
   * tenant. Optional/numbered-migration tables are discovered from pg_catalog so
   * an older but otherwise supported database is not bricked by the cleanup.
   *
   * The in-memory test adapter has no transaction engine; its fallback mirrors
   * the same ownership graph closely enough for route/regression tests.
   */
  async deleteGraphAtomic(id: string, expectedOwnerId?: string): Promise<'deleted' | 'not_found' | 'owner_mismatch'> {
    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.connect ? rawPool : null, 'ServerRepository atomic operation');
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query<{ _id: string; ownerId: string }>('SELECT _id, "ownerId" FROM servers WHERE _id=$1 FOR UPDATE', [id]);
        const lockedRow = locked.rows[0];
        if (!lockedRow) {
          await client.query('ROLLBACK');
          return 'not_found';
        }
        if (expectedOwnerId && String(lockedRow.ownerId) !== expectedOwnerId) {
          await client.query('ROLLBACK');
          return 'owner_mismatch';
        }

        const tableRows = await client.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
        );
        const columnRows = await client.query<{ table_name: string; column_name: string }>(
          `SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = current_schema()`,
        );
        const present = new Set(tableRows.rows.map((r) => r.table_name));
        const cols = new Map<string, Set<string>>();
        for (const row of columnRows.rows) {
          if (!cols.has(row.table_name)) cols.set(row.table_name, new Set());
          cols.get(row.table_name)!.add(row.column_name);
        }
        const has = (table: string, col?: string) =>
          present.has(table) && (!col || cols.get(table)?.has(col) === true);
        const del = async (table: string, sql: string, params: unknown[] = [id]) => {
          if (present.has(table)) await client.query(sql, params);
        };

        const channelResult = has('channels', 'serverId')
          ? await client.query<{ _id: string }>('SELECT _id FROM channels WHERE "serverId"=$1 FOR UPDATE', [id])
          : { rows: [] as Array<{ _id: string }> };
        const channelIds = channelResult.rows.map((r) => String(r._id));
        const botResult = has('bots', 'serverId')
          ? await client.query<{ _id: string }>('SELECT _id FROM bots WHERE "serverId"=$1 FOR UPDATE', [id])
          : { rows: [] as Array<{ _id: string }> };
        const botIds = botResult.rows.map((r) => String(r._id));

        // ── Final21 Faz 19: sunucunun KENDİ dosyaları ─────────────────────────
        // Simge, afiş, emoji, GIF, ses, kayıt ve üyelerin sunucu profili görselleri alt
        // dizinlerde yaşar; günlük temizlik işi onlara BİLEREK dokunmaz. Sunucu silinince
        // hiçbir yol onları bırakmıyordu. Yollar satırlar silinmeden ÖNCE toplanır, işlem
        // tamamlandıktan SONRA başvurusu kalmayanlar bırakılır (lib/uploadRelease.ts).
        const assetUrls: string[] = [];
        // Hem URL sütunu hem WHERE sütunu var olmalı: eksik bir sütun işlemi DÜŞÜRÜRDÜ.
        const collect = async (table: string, col: string, whereCol: string, sql: string, params: unknown[] = [id]) => {
          if (!has(table, col) || !has(table, whereCol)) return;
          const r = await client.query<Record<string, unknown>>(sql, params);
          for (const row of r.rows) {
            const v = row[col];
            if (typeof v === 'string' && v) assetUrls.push(v);
          }
        };
        await collect('servers', 'iconUrl', '_id', 'SELECT "iconUrl" FROM servers WHERE _id=$1');
        await collect('servers', 'bannerUrl', '_id', 'SELECT "bannerUrl" FROM servers WHERE _id=$1');
        await collect('server_emojis', 'url', 'serverId', 'SELECT url FROM server_emojis WHERE "serverId"=$1');
        await collect('server_gifs', 'url', 'serverId', 'SELECT url FROM server_gifs WHERE "serverId"=$1');
        await collect('soundboard', 'url', 'serverId', 'SELECT url FROM soundboard WHERE "serverId"=$1');
        if (channelIds.length) {
          await collect('podcast_episodes', 'audioUrl', 'channelId', 'SELECT "audioUrl" FROM podcast_episodes WHERE "channelId" = ANY($1::text[])', [channelIds]);
        }
        await collect('podcast_episodes', 'audioUrl', 'serverId', 'SELECT "audioUrl" FROM podcast_episodes WHERE "serverId"=$1');
        if (has('members', 'serverProfile') && has('members', 'serverId')) {
          const r = await client.query<{ serverProfile: unknown }>(
            'SELECT "serverProfile" FROM members WHERE "serverId"=$1 AND "serverProfile" IS NOT NULL', [id]);
          assetUrls.push(...memberProfileAssetUrls(r.rows));
        }

        // Cross-tenant/channel edges must disappear from BOTH directions.
        if (has('channel_bridges', 'sourceServerId') && has('channel_bridges', 'targetServerId'))
          await del('channel_bridges', 'DELETE FROM channel_bridges WHERE "sourceServerId"=$1 OR "targetServerId"=$1');
        if (has('channel_follows', 'sourceServerId') && has('channel_follows', 'targetServerId'))
          await del('channel_follows', 'DELETE FROM channel_follows WHERE "sourceServerId"=$1 OR "targetServerId"=$1');
        if (has('crosspost_log', 'sourceServerId') && has('crosspost_log', 'targetServerId'))
          await del('crosspost_log', 'DELETE FROM crosspost_log WHERE "sourceServerId"=$1 OR "targetServerId"=$1');

        if (botIds.length) {
          if (has('bot_ratings', 'botId'))
            await del('bot_ratings', 'DELETE FROM bot_ratings WHERE "botId" = ANY($1::text[])', [botIds]);
          if (has('server_bots', 'botId'))
            await del('server_bots', 'DELETE FROM server_bots WHERE "serverId"=$1 OR "botId" = ANY($2::text[])', [id, botIds]);
        } else if (has('server_bots', 'serverId')) {
          await del('server_bots', 'DELETE FROM server_bots WHERE "serverId"=$1');
        }

        // Personal/derived rows that only point at channel ids have no server FK.
        if (channelIds.length) {
          const byChannel: Array<[string, string]> = [
            ['channel_overrides', 'channelId'],
            ['channel_permissions', 'channelId'],
            ['unread_counts', 'channelId'],
            ['channel_read_positions', 'channelId'],
            ['message_reports', 'channelId'],
            ['canvas_strokes', 'channelId'],
            ['ap_messages', 'channelId'],
          ];
          for (const [table, col] of byChannel) {
            if (has(table, col))
              await del(table, `DELETE FROM "${table}" WHERE "${col}" = ANY($1::text[])`, [channelIds]);
          }
          if (has('notification_prefs', 'channelId'))
            await del('notification_prefs', `DELETE FROM notification_prefs
              WHERE "channelId" = ANY($1::text[]) OR "channelId"=$2`, [channelIds, `server:${id}`]);
          if (has('saved_messages', 'destinationType') && has('saved_messages', 'destinationId'))
            await del('saved_messages', `DELETE FROM saved_messages
              WHERE "destinationType"='channel' AND "destinationId" = ANY($1::text[])`, [channelIds]);
          for (const table of ['podcast_settings', 'podcast_episodes']) {
            if (has(table, 'channelId'))
              await del(table, `DELETE FROM "${table}" WHERE "channelId" = ANY($1::text[])`, [channelIds]);
          }
        } else if (has('notification_prefs', 'channelId')) {
          await del('notification_prefs', 'DELETE FROM notification_prefs WHERE "channelId"=$1', [`server:${id}`]);
        }

        // Direct server-owned rows. Some legacy podcast rows still carry
        // serverId after migration 032, so both legacy and channel scopes are cleaned.
        const directServerTables = [
          'outgoing_webhook_deliveries', 'outgoing_webhooks', 'automod_rules',
          'onboarding_completions', 'server_onboarding', 'reaction_roles',
          'channel_permissions', 'notification_keywords', 'message_reports', 'notifications', 'messages', 'invites', 'roles',
          'server_gifs', 'scheduled_msgs', 'server_emojis', 'polls', 'soundboard_user_stats', 'soundboard',
          'channel_categories', 'audit_logs', 'voice_messages', 'threads',
          'thread_messages', 'webhooks', 'podcast_settings', 'podcast_episodes',
          'sticker_packs', 'bots',
        ];
        for (const table of directServerTables) {
          if (has(table, 'serverId'))
            await del(table, `DELETE FROM "${table}" WHERE "serverId"=$1`);
        }
        if (has('server_events', 'server_id'))
          await del('server_events', 'DELETE FROM server_events WHERE server_id=$1');
        // Numbered migration 011 owns this table and already has ON DELETE
        // CASCADE, but an explicit delete keeps the graph complete before the
        // final server row and is harmless if the migration is present.
        if (has('server_boosts', 'serverId'))
          await del('server_boosts', 'DELETE FROM server_boosts WHERE "serverId"=$1');

        if (has('members', 'serverId')) await del('members', 'DELETE FROM members WHERE "serverId"=$1');
        if (has('channels', 'serverId')) await del('channels', 'DELETE FROM channels WHERE "serverId"=$1');
        await client.query('DELETE FROM servers WHERE _id=$1', [id]);
        await client.query('COMMIT');
        // Veritabanı yetkilidir: dosya bırakılamazsa silme GERİ ALINMAZ, olay kaydedilir.
        await releaseUnreferencedUploads(rawPool, assetUrls, (url, err) => {
          logger.error({ err, serverId: id, url, event: 'server_delete.asset_release_failed' },
            'Sunucu silindi ama bir dosya bırakılamadı.');
        });
        return 'deleted';
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }

    // Test/in-memory fallback. Security-sensitive production durability proof
    // comes from the PostgreSQL transaction above; do not pretend this branch
    // is atomic.
    const dynamicDb = db as unknown as Record<string, {
      remove?: (filter: Record<string, unknown>) => Promise<unknown>;
    } | undefined>;
    const currentServer = await db.servers.findOne({ _id: id });
    if (!currentServer) return 'not_found';
    if (expectedOwnerId && String(currentServer.ownerId) !== expectedOwnerId) return 'owner_mismatch';
    const channelRows = await db.channels.find({ serverId: id });
    const channelIds = channelRows.map((c) => String(c._id));
    const botRows = await db.bots.find({ serverId: id });
    const botIds = botRows.map((b) => String(b._id));
    const remove = async (key: string, filter: Record<string, unknown>) => {
      const col = dynamicDb[key];
      if (col?.remove) await col.remove(filter);
    };

    await remove('channelBridges', { $or: [{ sourceServerId: id }, { targetServerId: id }] });
    await remove('channelFollows', { $or: [{ sourceServerId: id }, { targetServerId: id }] });
    await remove('crosspostLog', { $or: [{ sourceServerId: id }, { targetServerId: id }] });
    if (botIds.length) {
      await remove('botRatings', { botId: { $in: botIds } });
      await remove('serverBots', { $or: [{ serverId: id }, { botId: { $in: botIds } }] });
    } else await remove('serverBots', { serverId: id });
    if (channelIds.length) {
      for (const key of ['channelOverrides', 'channelPermissions', 'unreadCounts', 'channelReadPositions', 'messageReports', 'canvasStrokes', 'apMessages'])
        await remove(key, { channelId: { $in: channelIds } });
      await remove('notificationPrefs', { channelId: { $in: [...channelIds, `server:${id}`] } });
      await remove('savedMessages', { destinationType: 'channel', destinationId: { $in: channelIds } });
      await remove('podcastSettings', { channelId: { $in: channelIds } });
      await remove('podcastEpisodes', { channelId: { $in: channelIds } });
    } else await remove('notificationPrefs', { channelId: `server:${id}` });

    for (const key of [
      'outgoingWebhookDeliveries', 'outgoingWebhooks', 'automodRules',
      'onboardingCompletions', 'serverOnboarding', 'reactionRoles',
      'channelPermissions', 'notificationKeywords', 'messageReports', 'notifications', 'messages', 'invites', 'roles',
      'serverGifs', 'scheduledMsgs', 'serverEmojis', 'polls', 'soundboardUserStats', 'soundboard',
      'channelCategories', 'auditLogs', 'voiceMessages', 'threads',
      'threadMessages', 'webhooks', 'podcastSettings', 'podcastEpisodes',
      'stickerPacks', 'bots', 'members', 'channels',
    ]) await remove(key, { serverId: id });
    await remove('serverEvents', { server_id: id });
    await db.servers.remove({ _id: id });
    return 'deleted';
  }

  async getMember(userId: string, serverId: string) {
    return db.members.findOne({ userId, serverId });
  }

  async addMember(userId: string, serverId: string, roles: string[] = []) {
    return db.members.insert({ userId, serverId, roles: JSON.stringify(roles), joinedAt: Date.now() });
  }

  async removeMember(userId: string, serverId: string) {
    return db.members.remove({ userId, serverId });
  }

  async getMembers(serverId: string) {
    return db.members.find({ serverId });
  }

  async count(query = {}) {
    return db.servers.count(query);
  }

  async findRecentSorted(limit = 100) {
    return db.servers.find({}).sort({ createdAt: -1 }).limit(limit);
  }
}

export default new ServerRepository();
