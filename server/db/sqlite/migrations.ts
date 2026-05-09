function run(sqlite, sql) {
  try { sqlite.exec(sql); } catch {}
}

function addCollection(db, Collection, sqlite, key, table) {
  db[key] = new Collection(sqlite, table);
}

function applyBootstrapSchema(sqlite) {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS users (
  _id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, displayName TEXT NOT NULL, password TEXT NOT NULL,
  avatarColor TEXT NOT NULL DEFAULT '#5865f2', avatarUrl TEXT, status TEXT NOT NULL DEFAULT 'offline',
  bio TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
  pronouns TEXT NOT NULL DEFAULT '', bannerColor TEXT NOT NULL DEFAULT '', tokenVersion INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token TEXT PRIMARY KEY, userId TEXT NOT NULL, expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0, usedAt INTEGER, family TEXT
);
CREATE INDEX IF NOT EXISTS idx_rt_userId  ON refresh_tokens(userId);
CREATE INDEX IF NOT EXISTS idx_rt_expires ON refresh_tokens(expiresAt);
CREATE INDEX IF NOT EXISTS idx_rt_family  ON refresh_tokens(family);  -- Sprint 10: revokeByFamily hızı için
CREATE TABLE IF NOT EXISTS servers (_id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '🌐', bannerUrl TEXT, ownerId TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS channels (_id TEXT PRIMARY KEY, serverId TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'text', topic TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'GENERAL', "order" INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(serverId);
CREATE TABLE IF NOT EXISTS messages (
  _id TEXT PRIMARY KEY, channelId TEXT NOT NULL, serverId TEXT NOT NULL, userId TEXT NOT NULL, username TEXT NOT NULL, displayName TEXT NOT NULL,
  avatarColor TEXT NOT NULL DEFAULT '#5865f2', content TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'normal', fileUrl TEXT, fileName TEXT, fileType TEXT,
  reactions TEXT NOT NULL DEFAULT '{}', pinned INTEGER NOT NULL DEFAULT 0, editedAt INTEGER, replyTo TEXT, bridgedFrom TEXT, scheduledId TEXT, createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channelId);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(createdAt);
CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channelId, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_messages_channel_pinned ON messages(channelId, pinned) WHERE pinned = 1;
CREATE TABLE IF NOT EXISTS members (userId TEXT NOT NULL, serverId TEXT NOT NULL, roles TEXT NOT NULL DEFAULT '[]', joinedAt INTEGER NOT NULL, PRIMARY KEY(userId, serverId));
CREATE INDEX IF NOT EXISTS idx_members_user ON members(userId);
CREATE INDEX IF NOT EXISTS idx_members_server ON members(serverId);
CREATE INDEX IF NOT EXISTS idx_members_user_server ON members(userId, serverId);
CREATE TABLE IF NOT EXISTS invites (_id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, serverId TEXT NOT NULL, createdBy TEXT NOT NULL, expiresAt INTEGER NOT NULL, maxUses INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);
CREATE TABLE IF NOT EXISTS roles (_id TEXT PRIMARY KEY, serverId TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#99aab5', permissions INTEGER NOT NULL DEFAULT 16, position INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_roles_server ON roles(serverId);
CREATE TABLE IF NOT EXISTS dm_conversations (_id TEXT PRIMARY KEY, participants TEXT NOT NULL, createdAt INTEGER NOT NULL, lastMessageAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS dm_messages (_id TEXT PRIMARY KEY, dmId TEXT NOT NULL, userId TEXT NOT NULL, displayName TEXT NOT NULL, avatarColor TEXT NOT NULL DEFAULT '#5865f2', content TEXT NOT NULL DEFAULT '', fileUrl TEXT, fileName TEXT, fileType TEXT, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_dm_messages_conv ON dm_messages(dmId);
CREATE TABLE IF NOT EXISTS server_gifs (_id TEXT PRIMARY KEY, serverId TEXT NOT NULL, name TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', url TEXT NOT NULL, fileType TEXT NOT NULL DEFAULT 'image/gif', uploadedBy TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_gifs_server ON server_gifs(serverId);
CREATE TABLE IF NOT EXISTS scheduled_msgs (_id TEXT PRIMARY KEY, channelId TEXT NOT NULL, serverId TEXT NOT NULL, userId TEXT NOT NULL, displayName TEXT NOT NULL, username TEXT NOT NULL, avatarColor TEXT NOT NULL DEFAULT '#5865f2', content TEXT NOT NULL, sendAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0, sentAt INTEGER);
CREATE INDEX IF NOT EXISTS idx_sched_sendAt ON scheduled_msgs(sendAt);
CREATE TABLE IF NOT EXISTS channel_bridges (_id TEXT PRIMARY KEY, sourceChannelId TEXT NOT NULL, targetChannelId TEXT NOT NULL, sourceServerId TEXT NOT NULL, targetServerId TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS idx_bridge_src ON channel_bridges(sourceChannelId);
CREATE TABLE IF NOT EXISTS server_emojis (_id TEXT PRIMARY KEY, serverId TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, uploadedBy TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_emojis_server ON server_emojis(serverId);
CREATE TABLE IF NOT EXISTS polls (_id TEXT PRIMARY KEY, channelId TEXT NOT NULL, serverId TEXT NOT NULL, createdBy TEXT NOT NULL, question TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]', multiSelect INTEGER NOT NULL DEFAULT 0, expiresAt INTEGER, closed INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_polls_channel ON polls(channelId);
CREATE TABLE IF NOT EXISTS soundboard (_id TEXT PRIMARY KEY, serverId TEXT NOT NULL, name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '🔊', url TEXT NOT NULL, uploadedBy TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_soundboard_server ON soundboard(serverId);
`);

  [
    "ALTER TABLE users ADD COLUMN website TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN location TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN pronouns TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN bannerColor TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE servers ADD COLUMN bannerUrl TEXT",
    "ALTER TABLE servers ADD COLUMN iconUrl TEXT",
    "ALTER TABLE messages ADD COLUMN editHistory TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE users ADD COLUMN bannerUrl TEXT",
    "ALTER TABLE servers ADD COLUMN discoverable INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE servers ADD COLUMN description TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE servers ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'",
  ].forEach((sql) => run(sqlite, sql));
}

function applyFeatureMigrations(sqlite, db, Collection) {
  run(sqlite, `
CREATE TABLE IF NOT EXISTS friendships (_id TEXT PRIMARY KEY, userId TEXT NOT NULL, friendId TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', createdAt INTEGER NOT NULL, UNIQUE(userId, friendId));
CREATE INDEX IF NOT EXISTS idx_friends_user ON friendships(userId);
CREATE INDEX IF NOT EXISTS idx_friends_friend ON friendships(friendId);
CREATE TABLE IF NOT EXISTS channel_categories (_id TEXT PRIMARY KEY, serverId TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, collapsed INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cat_server ON channel_categories(serverId);
CREATE TABLE IF NOT EXISTS notification_prefs (userId TEXT NOT NULL, channelId TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'all', PRIMARY KEY(userId, channelId));
CREATE TABLE IF NOT EXISTS audit_logs (_id TEXT PRIMARY KEY, serverId TEXT NOT NULL, actorId TEXT NOT NULL, actorName TEXT NOT NULL, action TEXT NOT NULL, targetId TEXT, targetName TEXT, detail TEXT NOT NULL DEFAULT '', createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_audit_server ON audit_logs(serverId, createdAt);
CREATE TABLE IF NOT EXISTS voice_messages (_id TEXT PRIMARY KEY, channelId TEXT NOT NULL, serverId TEXT NOT NULL, userId TEXT NOT NULL, displayName TEXT NOT NULL, avatarColor TEXT NOT NULL DEFAULT '#5865f2', fileUrl TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_vm_channel ON voice_messages(channelId);
`);
  [
    "ALTER TABLE channels ADD COLUMN categoryId TEXT",
    "ALTER TABLE channels ADD COLUMN position INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE members ADD COLUMN timeoutUntil INTEGER",
    "ALTER TABLE members ADD COLUMN verified INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE users ADD COLUMN statusText TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN statusEmoji TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE servers ADD COLUMN verificationEnabled INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE servers ADD COLUMN verificationChannelId TEXT",
    "ALTER TABLE servers ADD COLUMN verificationRoleId TEXT",
    "ALTER TABLE servers ADD COLUMN logChannelId TEXT",
    "ALTER TABLE messages ADD COLUMN threadId TEXT",
    "ALTER TABLE messages ADD COLUMN threadCount INTEGER NOT NULL DEFAULT 0",
  ].forEach((sql) => run(sqlite, sql));

  run(sqlite, `
CREATE TABLE IF NOT EXISTS threads (_id TEXT PRIMARY KEY, channelId TEXT NOT NULL, serverId TEXT NOT NULL, parentMessageId TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL, lastMessageAt INTEGER NOT NULL, messageCount INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads(channelId);
CREATE INDEX IF NOT EXISTS idx_threads_parent ON threads(parentMessageId);
CREATE TABLE IF NOT EXISTS thread_messages (_id TEXT PRIMARY KEY, threadId TEXT NOT NULL, channelId TEXT NOT NULL, serverId TEXT NOT NULL, userId TEXT NOT NULL, username TEXT NOT NULL, displayName TEXT NOT NULL, avatarColor TEXT NOT NULL DEFAULT '#5865f2', content TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'normal', reactions TEXT NOT NULL DEFAULT '{}', editedAt INTEGER, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tmsg_thread ON thread_messages(threadId);
CREATE INDEX IF NOT EXISTS idx_tmsg_created ON thread_messages(createdAt);
`);

  run(sqlite, `CREATE TABLE IF NOT EXISTS federation_peers (_id TEXT PRIMARY KEY, url TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '', desc TEXT NOT NULL DEFAULT '', addedAt INTEGER NOT NULL, lastSeen INTEGER NOT NULL, verified INTEGER NOT NULL DEFAULT 0)`);
  [
    "ALTER TABLE users ADD COLUMN isAdmin INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN email TEXT",
    "ALTER TABLE users ADD COLUMN emailVerified INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN emailToken TEXT",
    "ALTER TABLE users ADD COLUMN emailTokenExp INTEGER",
    "ALTER TABLE users ADD COLUMN twoFactorSecret TEXT",
    "ALTER TABLE users ADD COLUMN twoFactorEnabled INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN twoFactorBackup TEXT NOT NULL DEFAULT '[]'",
  ].forEach((sql) => run(sqlite, sql));
  run(sqlite, `CREATE TABLE IF NOT EXISTS admin_logs (_id TEXT PRIMARY KEY, adminId TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, createdAt INTEGER NOT NULL)`);
  run(sqlite, `CREATE INDEX IF NOT EXISTS idx_adminlogs_admin ON admin_logs(adminId)`);
  run(sqlite, `CREATE TABLE IF NOT EXISTS federation_whitelist (_id TEXT PRIMARY KEY, domain TEXT UNIQUE NOT NULL, reason TEXT NOT NULL DEFAULT '', createdAt INTEGER NOT NULL)`);
  run(sqlite, `CREATE TABLE IF NOT EXISTS federation_blacklist (_id TEXT PRIMARY KEY, domain TEXT UNIQUE NOT NULL, reason TEXT NOT NULL DEFAULT '', createdAt INTEGER NOT NULL)`);

  [
    `CREATE TABLE IF NOT EXISTS channel_permissions (_id TEXT PRIMARY KEY, channelId TEXT NOT NULL, roleId TEXT NOT NULL, serverId TEXT NOT NULL, allow INTEGER NOT NULL DEFAULT 0, deny INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, updatedAt INTEGER, UNIQUE(channelId, roleId))`,
    `CREATE INDEX IF NOT EXISTS idx_chperms_channel ON channel_permissions(channelId)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_chperms_channel_role ON channel_permissions(channelId, roleId)`,
    `CREATE TABLE IF NOT EXISTS fcm_tokens (_id TEXT PRIMARY KEY, userId TEXT NOT NULL, token TEXT UNIQUE NOT NULL, platform TEXT NOT NULL DEFAULT 'android', createdAt INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_fcmtokens_user ON fcm_tokens(userId)`,
    `CREATE TABLE IF NOT EXISTS push_subscriptions_v30 (_id TEXT PRIMARY KEY, userId TEXT NOT NULL, endpoint TEXT UNIQUE NOT NULL, keys TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER)`,
    `CREATE INDEX IF NOT EXISTS idx_pushsubs_user ON push_subscriptions_v30(userId)`,
    `CREATE TABLE IF NOT EXISTS native_push_tokens (_id TEXT PRIMARY KEY, userId TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'unknown', token TEXT UNIQUE NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER)`,
    `CREATE INDEX IF NOT EXISTS idx_nativepush_user ON native_push_tokens(userId)`,
    `CREATE TABLE IF NOT EXISTS bot_ratings (_id TEXT PRIMARY KEY, botId TEXT NOT NULL, userId TEXT NOT NULL, rating INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER, UNIQUE(botId, userId))`,
    `CREATE INDEX IF NOT EXISTS idx_botratings_bot ON bot_ratings(botId)`,
    `CREATE TABLE IF NOT EXISTS server_bots (_id TEXT PRIMARY KEY, botId TEXT NOT NULL, serverId TEXT NOT NULL, addedBy TEXT NOT NULL, addedAt INTEGER NOT NULL, UNIQUE(botId, serverId))`,
    `CREATE INDEX IF NOT EXISTS idx_serverbots_server ON server_bots(serverId)`,
    `CREATE TABLE IF NOT EXISTS ap_follows (_id TEXT PRIMARY KEY, actorUrl TEXT NOT NULL, targetUserId TEXT NOT NULL, activityId TEXT, createdAt INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_apfollows_target ON ap_follows(targetUserId)`,
    `CREATE TABLE IF NOT EXISTS ap_activities (_id TEXT PRIMARY KEY, targetUserId TEXT NOT NULL, activity TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL)`,
    `ALTER TABLE voice_messages ADD COLUMN transcript TEXT`,
    `ALTER TABLE messages ADD COLUMN embeds TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE messages ADD COLUMN components TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE messages ADD COLUMN botId TEXT`,
    `ALTER TABLE bots ADD COLUMN public INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE bots ADD COLUMN description TEXT`,
    `ALTER TABLE bots ADD COLUMN category TEXT NOT NULL DEFAULT 'utility'`,
    `ALTER TABLE bots ADD COLUMN icon TEXT`,
    `ALTER TABLE bots ADD COLUMN verified INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE bots ADD COLUMN rating REAL NOT NULL DEFAULT 0`,
    `ALTER TABLE bots ADD COLUMN ratingCount INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE bots ADD COLUMN webhookUrl TEXT`,
    `ALTER TABLE users ADD COLUMN apPublicKey TEXT`,
    `ALTER TABLE users ADD COLUMN apPrivateKey TEXT`,
    `ALTER TABLE users ADD COLUMN bio TEXT`,
  ].forEach((sql) => run(sqlite, sql));

  run(sqlite, `
CREATE TABLE IF NOT EXISTS reaction_roles (_id TEXT PRIMARY KEY, serverId TEXT NOT NULL, channelId TEXT NOT NULL, messageId TEXT NOT NULL, emoji TEXT NOT NULL, roleId TEXT NOT NULL, createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_rr_server ON reaction_roles(serverId);
CREATE INDEX IF NOT EXISTS idx_rr_message ON reaction_roles(messageId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rr_unique ON reaction_roles(messageId, emoji, roleId);
`);

  [
    `ALTER TABLE servers ADD COLUMN slug TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_slug ON servers(slug) WHERE slug IS NOT NULL`,
    `ALTER TABLE channels ADD COLUMN nsfw INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE channels ADD COLUMN bitrate INTEGER NOT NULL DEFAULT 64000`,
    `ALTER TABLE users ADD COLUMN badge TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE members ADD COLUMN nickname TEXT`,
    `ALTER TABLE bots ADD COLUMN contextCommands TEXT NOT NULL DEFAULT '[]'`,
  ].forEach((sql) => run(sqlite, sql));

  run(sqlite, `
CREATE TABLE IF NOT EXISTS blocks (_id TEXT PRIMARY KEY, blockerId TEXT NOT NULL, blockedId TEXT NOT NULL, createdAt INTEGER NOT NULL, UNIQUE(blockerId, blockedId));
CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks(blockerId);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blockedId);
CREATE TABLE IF NOT EXISTS user_connections (_id TEXT PRIMARY KEY, userId TEXT NOT NULL, platform TEXT NOT NULL, username TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', verified INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, UNIQUE(userId, platform));
CREATE INDEX IF NOT EXISTS idx_connections_user ON user_connections(userId);
CREATE TABLE IF NOT EXISTS group_dm_conversations (_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', ownerId TEXT NOT NULL, icon TEXT, createdAt INTEGER NOT NULL, lastMessageAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS group_dm_members (_id TEXT PRIMARY KEY, groupId TEXT NOT NULL, userId TEXT NOT NULL, joinedAt INTEGER NOT NULL, UNIQUE(groupId, userId));
CREATE TABLE IF NOT EXISTS group_dm_messages (_id TEXT PRIMARY KEY, groupId TEXT NOT NULL, userId TEXT NOT NULL, displayName TEXT NOT NULL, avatarColor TEXT NOT NULL DEFAULT '#5865f2', content TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'normal', fileUrl TEXT, fileName TEXT, reactions TEXT NOT NULL DEFAULT '{}', createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_gdm_members_group ON group_dm_members(groupId);
CREATE INDEX IF NOT EXISTS idx_gdm_members_user ON group_dm_members(userId);
CREATE INDEX IF NOT EXISTS idx_gdm_messages_group ON group_dm_messages(groupId);
CREATE INDEX IF NOT EXISTS idx_gdm_messages_created ON group_dm_messages(groupId, createdAt DESC);
CREATE TABLE IF NOT EXISTS automod_rules (_id TEXT PRIMARY KEY, serverId TEXT NOT NULL, type TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL DEFAULT '{}', createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER);
CREATE INDEX IF NOT EXISTS idx_automod_server ON automod_rules(serverId);
`);

  [
    `ALTER TABLE threads ADD COLUMN firstMessage TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE threads ADD COLUMN participantCount INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE threads ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE threads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE threads ADD COLUMN locked INTEGER NOT NULL DEFAULT 0`,
  ].forEach((sql) => run(sqlite, sql));

  run(sqlite, `
CREATE TABLE IF NOT EXISTS outgoing_webhooks (_id TEXT PRIMARY KEY, serverId TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, events TEXT NOT NULL DEFAULT '["message:new"]', secret TEXT, enabled INTEGER NOT NULL DEFAULT 1, createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL, lastFiredAt INTEGER, lastStatus INTEGER);
CREATE INDEX IF NOT EXISTS idx_ogwh_server ON outgoing_webhooks(serverId);
CREATE TABLE IF NOT EXISTS server_onboarding (_id TEXT PRIMARY KEY, serverId TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, rulesChannelId TEXT, welcomeChannelId TEXT, welcomeMessage TEXT NOT NULL DEFAULT 'Sunucuya hoş geldin, {user}! 👋', verificationLevel INTEGER NOT NULL DEFAULT 0, defaultRoles TEXT NOT NULL DEFAULT '[]', questions TEXT NOT NULL DEFAULT '[]', createdAt INTEGER NOT NULL, updatedAt INTEGER);
CREATE INDEX IF NOT EXISTS idx_onboarding_server ON server_onboarding(serverId);
CREATE TABLE IF NOT EXISTS onboarding_completions (_id TEXT PRIMARY KEY, serverId TEXT NOT NULL, userId TEXT NOT NULL, completedAt INTEGER NOT NULL, answers TEXT NOT NULL DEFAULT '{}');
CREATE UNIQUE INDEX IF NOT EXISTS idx_onboard_uniq ON onboarding_completions(serverId, userId);
CREATE TABLE IF NOT EXISTS podcast_settings (_id TEXT PRIMARY KEY, channelId TEXT UNIQUE NOT NULL, title TEXT, description TEXT, language TEXT, explicit INTEGER NOT NULL DEFAULT 0, category TEXT, imageUrl TEXT, author TEXT, ownerEmail TEXT, feedPath TEXT, enabled INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL, updatedAt INTEGER);
CREATE TABLE IF NOT EXISTS podcast_episodes (_id TEXT PRIMARY KEY, channelId TEXT NOT NULL, messageId TEXT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', audioUrl TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 0, episodeNo INTEGER NOT NULL DEFAULT 0, seasonNo INTEGER NOT NULL DEFAULT 0, guid TEXT, published INTEGER NOT NULL DEFAULT 1, publishedAt INTEGER NOT NULL, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_podcast_channel ON podcast_episodes(channelId, publishedAt DESC);
`);

  [
    `ALTER TABLE audit_logs ADD COLUMN channelId TEXT`,
    `ALTER TABLE audit_logs ADD COLUMN "old" TEXT`,
    `ALTER TABLE audit_logs ADD COLUMN "new" TEXT`,
    `ALTER TABLE audit_logs ADD COLUMN extra TEXT NOT NULL DEFAULT '{}'`,
    `CREATE INDEX IF NOT EXISTS idx_audit_server_channel ON audit_logs(serverId, channelId)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_server_channel_time ON audit_logs(serverId, channelId, createdAt)`,
    `DROP INDEX IF EXISTS idx_audit_channel`,
    `CREATE INDEX IF NOT EXISTS idx_audit_channel ON audit_logs(serverId, channelId, createdAt)`,
    `CREATE TABLE IF NOT EXISTS server_templates (_id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '🌐', description TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', categories TEXT NOT NULL DEFAULT '[]', createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER)`,
    `CREATE INDEX IF NOT EXISTS idx_templates_createdAt ON server_templates(createdAt DESC)`,
    `CREATE TABLE IF NOT EXISTS webauthn_credentials (_id TEXT PRIMARY KEY, userId TEXT NOT NULL, credentialId TEXT NOT NULL UNIQUE, publicKey TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0, deviceType TEXT NOT NULL DEFAULT 'unknown', transports TEXT NOT NULL DEFAULT '[]', name TEXT NOT NULL DEFAULT 'Passkey', lastUsedAt INTEGER, createdAt INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(userId)`,
    `CREATE INDEX IF NOT EXISTS idx_webauthn_cred ON webauthn_credentials(credentialId)`,
    `ALTER TABLE users ADD COLUMN e2ePublicKey TEXT`,
    `ALTER TABLE users ADD COLUMN e2eKeyVersion INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE users ADD COLUMN e2eAlgorithm TEXT NOT NULL DEFAULT 'P-256'`,
    `ALTER TABLE users ADD COLUMN e2eKeyUpdatedAt INTEGER`,
    `ALTER TABLE dm_messages ADD COLUMN isEncrypted INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE dm_messages ADD COLUMN e2eData TEXT`,
    `ALTER TABLE users ADD COLUMN ssoProvider TEXT`,
    `ALTER TABLE users ADD COLUMN ssoId TEXT`,
    `ALTER TABLE servers ADD COLUMN ssoConfig TEXT`,
    `ALTER TABLE dm_messages ADD COLUMN reactions TEXT NOT NULL DEFAULT '{}'`,
  ].forEach((sql) => run(sqlite, sql));

  addCollection(db, Collection, sqlite, 'friendships', 'friendships');
  addCollection(db, Collection, sqlite, 'channelCategories', 'channel_categories');
  addCollection(db, Collection, sqlite, 'notificationPrefs', 'notification_prefs');
  addCollection(db, Collection, sqlite, 'auditLogs', 'audit_logs');
  addCollection(db, Collection, sqlite, 'voiceMessages', 'voice_messages');
  addCollection(db, Collection, sqlite, 'threads', 'threads');
  addCollection(db, Collection, sqlite, 'threadMessages', 'thread_messages');
  db.federation_peers = new Collection(sqlite, 'federation_peers');
  addCollection(db, Collection, sqlite, 'admin_logs', 'admin_logs');
  addCollection(db, Collection, sqlite, 'adminLogs', 'admin_logs');
  addCollection(db, Collection, sqlite, 'channelPermissions', 'channel_permissions');
  addCollection(db, Collection, sqlite, 'fcmTokens', 'fcm_tokens');
  addCollection(db, Collection, sqlite, 'pushSubscriptions', 'push_subscriptions_v30');
  addCollection(db, Collection, sqlite, 'unreadCounts', 'unread_counts');
  addCollection(db, Collection, sqlite, 'nativePushTokens', 'native_push_tokens');
  addCollection(db, Collection, sqlite, 'botRatings', 'bot_ratings');
  addCollection(db, Collection, sqlite, 'serverBots', 'server_bots');
  addCollection(db, Collection, sqlite, 'apFollows', 'ap_follows');
  addCollection(db, Collection, sqlite, 'apActivities', 'ap_activities');
  addCollection(db, Collection, sqlite, 'apMessages', 'ap_messages');
  addCollection(db, Collection, sqlite, 'reactionRoles', 'reaction_roles');
  addCollection(db, Collection, sqlite, 'blocks', 'blocks');
  addCollection(db, Collection, sqlite, 'userConnections', 'user_connections');
  addCollection(db, Collection, sqlite, 'groupDmConversations', 'group_dm_conversations');
  addCollection(db, Collection, sqlite, 'groupDmMembers', 'group_dm_members');
  addCollection(db, Collection, sqlite, 'groupDmMessages', 'group_dm_messages');
  addCollection(db, Collection, sqlite, 'automodRules', 'automod_rules');
  addCollection(db, Collection, sqlite, 'outgoingWebhooks', 'outgoing_webhooks');
  addCollection(db, Collection, sqlite, 'serverOnboarding', 'server_onboarding');
  addCollection(db, Collection, sqlite, 'onboardingCompletions', 'onboarding_completions');
  addCollection(db, Collection, sqlite, 'serverTemplates', 'server_templates');
  addCollection(db, Collection, sqlite, 'webauthnCredentials', 'webauthn_credentials');
  addCollection(db, Collection, sqlite, 'podcastSettings', 'podcast_settings');
  addCollection(db, Collection, sqlite, 'podcastEpisodes', 'podcast_episodes');
  addCollection(db, Collection, sqlite, 'federationWhitelist', 'federation_whitelist');
  addCollection(db, Collection, sqlite, 'federationBlacklist', 'federation_blacklist');
  db.federationPeers = db.federation_peers;

  try {
    const oldSubs = sqlite.prepare(
      `SELECT _id, userId, subscription, createdAt FROM push_subscriptions WHERE _id NOT IN (SELECT _id FROM push_subscriptions_v30)`
    ).all();
    const insertStmt = sqlite.prepare(
      `INSERT OR IGNORE INTO push_subscriptions_v30 (_id, userId, endpoint, keys, createdAt)
       VALUES (@_id, @userId, @endpoint, @keys, @createdAt)`
    );
    for (const row of oldSubs) {
      try {
        const sub = JSON.parse(row.subscription);
        if (sub?.endpoint) {
          insertStmt.run({
            _id: row._id,
            userId: row.userId,
            endpoint: sub.endpoint,
            keys: JSON.stringify(sub.keys || {}),
            createdAt: row.createdAt,
          });
        }
      } catch {}
    }
  } catch {}
}

module.exports = { applyBootstrapSchema, applyFeatureMigrations };
export {};
