// server/tests/helpers/mockDb.js
// Tam in-memory mock DB — tüm collection'ları kapsar

'use strict';

const { v4: uuidv4 } = require('uuid');

const ALL_COLLECTIONS = [
  'users', 'servers', 'members', 'channels', 'messages',
  'refresh_tokens', 'invites', 'roles', 'dm_conversations', 'dm_messages',
  'server_gifs', 'scheduled_msgs', 'channel_bridges', 'server_emojis',
  'polls', 'soundboard', 'friendships', 'channel_categories',
  'notification_prefs', 'audit_logs', 'voice_messages',
  'threads', 'thread_messages', 'bots', 'webhooks',
  'channel_overrides', 'unread_counts', 'push_subscriptions',
  'federation_peers', 'admin_logs',
  'reaction_roles', 'native_push_tokens', 'ap_activities',
  'reactionRoles', 'nativePushTokens', 'apActivities',
  // v45 — eksik koleksiyonlar eklendi
  'automod_rules', 'group_dm_conversations', 'group_dm_members', 'group_dm_messages',
  'user_connections', 'outgoing_webhooks', 'server_onboarding', 'channel_permissions',
  'server_roles', 'email_tokens',
  // v57 — server şablonları DB'ye taşındı
  'server_templates',
  // v65 — Podcast (Stage -> Podcast Yayınlama)
  'podcast_settings',
  'podcast_episodes',
  // federation social — ActivityPub extended collections
  'ap_outgoing_follows', 'ap_likes', 'ap_announces',
  'notifications', 'fcm_tokens',
  'federation_whitelist', 'federation_blacklist',
  'ap_delivery_queue',
];

function createStore() {
  const store = {};
  for (const name of ALL_COLLECTIONS) store[name] = {};
  return store;
}

function matchesQuery(doc, q) {
  for (const [k, v] of Object.entries(q)) {
    if (k === '$or') {
      if (!v.some(sub => matchesQuery(doc, sub))) return false;
      continue;
    }
    if (v === null) { if (doc[k] !== null && doc[k] !== undefined) return false; continue; }
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp)) {
      if (v.$in  !== undefined && !v.$in.includes(doc[k]))   return false;
      if (v.$nin !== undefined &&  v.$nin.includes(doc[k]))  return false;
      if (v.$ne  !== undefined &&  doc[k] === v.$ne)         return false;
      if (v.$gt  !== undefined &&  doc[k] <= v.$gt)          return false;
      if (v.$gte !== undefined &&  doc[k] < v.$gte)          return false;
      if (v.$lt  !== undefined &&  doc[k] >= v.$lt)          return false;
      if (v.$lte !== undefined &&  doc[k] > v.$lte)          return false;
      if (v.$exists !== undefined) {
        const exists = doc[k] !== undefined && doc[k] !== null;
        if (v.$exists !== exists) return false;
      }
      if (v.$regex !== undefined) {
        const pattern = v.$regex instanceof RegExp ? v.$regex : new RegExp(v.$regex, 'i');
        if (!pattern.test(String(doc[k] ?? ''))) return false;
      }
      continue;
    }
    if (doc[k] !== v) return false;
  }
  return true;
}

function makeCol(store, name) {
  if (!store[name]) store[name] = {};
  const rows = () => Object.values(store[name]);

  return {
    async findOne(q = {}) {
      return rows().find(r => matchesQuery(r, q)) ?? null;
    },
    find(q = {}) {
      let result = rows().filter(r => matchesQuery(r, q));
      const chain = {
        sort(s) {
          const entries = Object.entries(s);
          result = [...result].sort((a, b) => {
            for (const [field, dir] of entries) {
              if (a[field] < b[field]) return dir === -1 ? 1 : -1;
              if (a[field] > b[field]) return dir === -1 ? -1 : 1;
            }
            return 0;
          });
          return chain;
        },
        skip(n) { result = result.slice(n); return chain; },
        limit(n) { result = result.slice(0, n); return chain; },
        then(res, rej) { return Promise.resolve([...result]).then(res, rej); },
      };
      return chain;
    },
    async insert(doc) {
      if (!doc._id) doc._id = uuidv4();
      store[name][doc._id] = { ...doc };
      return { ...doc };
    },
    async update(q, upd) {
      const targets = rows().filter(r => matchesQuery(r, q));
      for (const t of targets) {
        if (upd.$set)  Object.assign(store[name][t._id], upd.$set);
        if (upd.$inc) {
          for (const [k, v] of Object.entries(upd.$inc)) {
            store[name][t._id][k] = (store[name][t._id][k] || 0) + v;
          }
        }
        if (upd.$push) {
          for (const [k, v] of Object.entries(upd.$push)) {
            if (!Array.isArray(store[name][t._id][k])) store[name][t._id][k] = [];
            store[name][t._id][k].push(v);
          }
        }
      }
      return { updated: targets.length };
    },
    async remove(q = {}) {
      const targets = rows().filter(r => matchesQuery(r, q));
      for (const t of targets) delete store[name][t._id];
      return { deleted: targets.length };
    },
    async delete(q = {}) {
      const targets = rows().filter(r => matchesQuery(r, q));
      for (const t of targets) delete store[name][t._id];
      return { deleted: targets.length };
    },
    async count(q = {}) {
      return rows().filter(r => matchesQuery(r, q)).length;
    },
    ensureIndex() {},
  };
}

function buildMockDb(store) {
  const db = {
    // Kolaylık: her collection'a camelCase isimle eriş
    users:             makeCol(store, 'users'),
    servers:           makeCol(store, 'servers'),
    members:           makeCol(store, 'members'),
    channels:          makeCol(store, 'channels'),
    messages:          makeCol(store, 'messages'),
    refreshTokens:     makeCol(store, 'refresh_tokens'),
    invites:           makeCol(store, 'invites'),
    roles:             makeCol(store, 'roles'),
    dmConversations:   makeCol(store, 'dm_conversations'),
    dmMessages:        makeCol(store, 'dm_messages'),
    serverGifs:        makeCol(store, 'server_gifs'),
    scheduledMsgs:     makeCol(store, 'scheduled_msgs'),
    channelBridges:    makeCol(store, 'channel_bridges'),
    serverEmojis:      makeCol(store, 'server_emojis'),
    polls:             makeCol(store, 'polls'),
    soundboard:        makeCol(store, 'soundboard'),
    friendships:       makeCol(store, 'friendships'),
    channelCategories: makeCol(store, 'channel_categories'),
    notificationPrefs: makeCol(store, 'notification_prefs'),
    auditLogs:         makeCol(store, 'audit_logs'),
    voiceMessages:     makeCol(store, 'voice_messages'),
    threads:           makeCol(store, 'threads'),
    threadMessages:    makeCol(store, 'thread_messages'),
    bots:              makeCol(store, 'bots'),
    webhooks:          makeCol(store, 'webhooks'),
    channelOverrides:  makeCol(store, 'channel_overrides'),
    unreadCounts:      makeCol(store, 'unread_counts'),
    pushSubscriptions: makeCol(store, 'push_subscriptions'),
    federationPeers:   makeCol(store, 'federation_peers'),
    adminLogs:         makeCol(store, 'admin_logs'),
  reactionRoles:     makeCol(store, 'reaction_roles'),
  nativePushTokens:  makeCol(store, 'native_push_tokens'),
  apActivities:      makeCol(store, 'ap_activities'),
  apFollows:         makeCol(store, 'ap_follows'),
  apMessages:        makeCol(store, 'ap_messages'),
  // federation social — ActivityPub extended
  apOutgoingFollows:    makeCol(store, 'ap_outgoing_follows'),
  apLikes:              makeCol(store, 'ap_likes'),
  apAnnounces:          makeCol(store, 'ap_announces'),
  notifications:        makeCol(store, 'notifications'),
  fcmTokens:            makeCol(store, 'fcm_tokens'),
  federationWhitelist:  makeCol(store, 'federation_whitelist'),
  federationBlacklist:  makeCol(store, 'federation_blacklist'),
  // v45 — eksik koleksiyonlar
  automodRules:           makeCol(store, 'automod_rules'),
  groupDmConversations:   makeCol(store, 'group_dm_conversations'),
  groupDmMembers:         makeCol(store, 'group_dm_members'),
  groupDmMessages:        makeCol(store, 'group_dm_messages'),
  userConnections:        makeCol(store, 'user_connections'),
  outgoingWebhooks:       makeCol(store, 'outgoing_webhooks'),
  serverOnboarding:       makeCol(store, 'server_onboarding'),
  channelPermissions:     makeCol(store, 'channel_permissions'),
  serverRoles:            makeCol(store, 'server_roles'),
  emailTokens:            makeCol(store, 'email_tokens'),
  // v57 — server şablonları DB'ye taşındı
  serverTemplates:        makeCol(store, 'server_templates'),
    // v65 — Podcast
    podcastSettings:        makeCol(store, 'podcast_settings'),
    podcastEpisodes:        makeCol(store, 'podcast_episodes'),
    // FTS stub
    _ftsSearch: async () => [],
    // SQLite transaction stub (geriye dönük uyumluluk)
    _sqlite: {
      transaction: (fn) => () => fn(),
      prepare: () => ({ run: () => {}, get: () => ({ n: 0 }), all: () => [] }),
    },
    // PostgreSQL compat stubs — health.js ve diğerleri _pool kontrol eder
    _pool: {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: jest.fn().mockResolvedValue({
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        release: jest.fn(),
      }),
    },
    _transaction: async (fn) => {
      const client = {
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        release: jest.fn(),
      };
      return fn(client);
    },
    _initSchema: async () => {},
  };
  db._reset = () => {
    for (const name of ALL_COLLECTIONS) store[name] = {};
  };
  return db;
}

function createMockDb() {
  return buildMockDb(createStore());
}

// Test fixture helpers
function makeUser(overrides = {}) {
  return {
    _id:         uuidv4(),
    username:    'testuser_' + Math.random().toString(36).slice(2, 7),
    displayName: 'Test User',
    password:    '$2a$10$hashedpassword',
    avatarColor: '#5865f2',
    status:      'offline',
    bio:         '',
    tokenVersion: 0,
    createdAt:   Date.now(),
    ...overrides,
  };
}

function makeServer(ownerId, overrides = {}) {
  return {
    _id:       uuidv4(),
    name:      'Test Server',
    icon:      '🌐',
    ownerId,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeChannel(serverId, overrides = {}) {
  return {
    _id:       uuidv4(),
    serverId,
    name:      'general',
    type:      'text',
    topic:     '',
    category:  'GENERAL',
    order:     0,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeMessage(channelId, serverId, userId, overrides = {}) {
  return {
    _id:         uuidv4(),
    channelId,
    serverId,
    userId,
    username:    'testuser',
    displayName: 'Test User',
    avatarColor: '#5865f2',
    content:     'Test message',
    type:        'normal',
    reactions:   {},
    pinned:      false,
    createdAt:   Date.now(),
    ...overrides,
  };
}

function makeThreadMessage(threadId, userId, overrides = {}) {
  return {
    _id:         uuidv4(),
    threadId,
    userId,
    username:    'testuser',
    displayName: 'Test User',
    avatarColor: '#5865f2',
    content:     'Thread reply',
    type:        'normal',
    reactions:   {},
    createdAt:   Date.now(),
    ...overrides,
  };
}

module.exports = { createMockDb, makeUser, makeServer, makeChannel, makeMessage, makeThreadMessage };
