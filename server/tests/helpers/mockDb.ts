// server/tests/helpers/mockDb.ts
// Tam in-memory mock DB — tüm collection'ları kapsar
// Sprint 57: .js → .ts migrate edildi (helpers son 3 dosya)

import { v4 as uuidv4 } from 'uuid';

// ── Tip tanımları ─────────────────────────────────────────────────────────────

type QueryOperators = {
  $in?:     unknown[];
  $nin?:    unknown[];
  $ne?:     unknown;
  $gt?:     unknown;
  $gte?:    unknown;
  $lt?:     unknown;
  $lte?:    unknown;
  $exists?: boolean;
  $regex?:  RegExp | string;
};

type QueryValue = unknown | QueryOperators;
type Query      = Record<string, QueryValue> & { $or?: Query[] };

type UpdateSpec = {
  $set?:  Record<string, unknown>;
  $inc?:  Record<string, number>;
  $push?: Record<string, unknown>;
};

interface MockDoc {
  _id: string;
  [key: string]: unknown;
}

interface SortSpec {
  [field: string]: 1 | -1;
}

interface FindChain {
  sort(s: SortSpec):  this;
  skip(n: number):    this;
  limit(n: number):   this;
  then<T>(res: (v: MockDoc[]) => T, rej?: (e: unknown) => T): Promise<T>;
}

interface MockCollection {
  findOne(q?: Query): Promise<MockDoc | null>;
  find(q?: Query): FindChain;
  insert(doc: Partial<MockDoc>): Promise<MockDoc>;
  update(q: Query, upd: UpdateSpec): Promise<{ updated: number }>;
  remove(q?: Query): Promise<{ deleted: number }>;
  delete(q?: Query): Promise<{ deleted: number }>;
  count(q?: Query): Promise<number>;
  ensureIndex(): void;
}

type Store = Record<string, Record<string, MockDoc>>;

// ── Collection listesi ────────────────────────────────────────────────────────

const ALL_COLLECTIONS: readonly string[] = [
  'users', 'servers', 'members', 'channels', 'messages',
  'refresh_tokens', 'invites', 'roles', 'dm_conversations', 'dm_messages',
  'server_gifs', 'scheduled_msgs', 'channel_bridges', 'server_emojis',
  'polls', 'soundboard', 'friendships', 'channel_categories',
  'notification_prefs', 'audit_logs', 'voice_messages',
  'threads', 'thread_messages', 'bots', 'webhooks',
  'channel_overrides', 'unread_counts', 'push_subscriptions',
  'federation_peers', 'admin_logs', 'server_federation_keys',
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
  // Güvenlik: ActivityPub özel anahtarları ayrı tabloda
  'user_ap_keys', 'userApKeys',
  // Rozet sistemi
  'user_badges', 'userBadges',
  // Upload sahipliği (Sprint 75)
  'uploads',
] as const;

// ── Sorgu motoru ──────────────────────────────────────────────────────────────

function matchesQuery(doc: MockDoc, q: Query): boolean {
  for (const [k, v] of Object.entries(q)) {
    if (k === '$or') {
      const clauses = v as Query[];
      if (!clauses.some(sub => matchesQuery(doc, sub))) return false;
      continue;
    }
    if (v === null) {
      if (doc[k] !== null && doc[k] !== undefined) return false;
      continue;
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp)) {
      const op = v as QueryOperators;
      if (op.$in     !== undefined && !op.$in.includes(doc[k]))   return false;
      if (op.$nin    !== undefined &&  op.$nin.includes(doc[k]))   return false;
      if (op.$ne     !== undefined &&  doc[k] === op.$ne)          return false;
      if (op.$gt     !== undefined && (doc[k] as number) <= (op.$gt as number))  return false;
      if (op.$gte    !== undefined && (doc[k] as number) <  (op.$gte as number)) return false;
      if (op.$lt     !== undefined && (doc[k] as number) >= (op.$lt as number))  return false;
      if (op.$lte    !== undefined && (doc[k] as number) >  (op.$lte as number)) return false;
      if (op.$exists !== undefined) {
        const exists = doc[k] !== undefined && doc[k] !== null;
        if (op.$exists !== exists) return false;
      }
      if (op.$regex !== undefined) {
        const pattern = op.$regex instanceof RegExp ? op.$regex : new RegExp(op.$regex, 'i');
        if (!pattern.test(String(doc[k] ?? ''))) return false;
      }
      continue;
    }
    if (doc[k] !== v) return false;
  }
  return true;
}

// ── Collection factory ────────────────────────────────────────────────────────

function makeCol(store: Store, name: string): MockCollection {
  if (!store[name]) store[name] = {};
  const rows = (): MockDoc[] => Object.values(store[name]);

  return {
    async findOne(q: Query = {}): Promise<MockDoc | null> {
      return rows().find(r => matchesQuery(r, q)) ?? null;
    },

    find(q: Query = {}): FindChain {
      let result = rows().filter(r => matchesQuery(r, q));
      const chain: FindChain = {
        sort(s: SortSpec) {
          const entries = Object.entries(s) as [string, 1 | -1][];
          result = [...result].sort((a, b) => {
            for (const [field, dir] of entries) {
              if (a[field] < b[field]) return dir === -1 ? 1 : -1;
              if (a[field] > b[field]) return dir === -1 ? -1 : 1;
            }
            return 0;
          });
          return chain;
        },
        skip(n: number) { result = result.slice(n); return chain; },
        limit(n: number) { result = result.slice(0, n); return chain; },
        then<T>(res: (v: MockDoc[]) => T, rej?: (e: unknown) => T): Promise<T> {
          return Promise.resolve([...result]).then(res, rej);
        },
      };
      return chain;
    },

    async insert(doc: Partial<MockDoc>): Promise<MockDoc> {
      const full = { ...doc, _id: doc._id ?? uuidv4() } as MockDoc;
      store[name][full._id] = full;
      return { ...full };
    },

    async update(q: Query, upd: UpdateSpec): Promise<{ updated: number }> {
      const targets = rows().filter(r => matchesQuery(r, q));
      for (const t of targets) {
        if (upd.$set)  Object.assign(store[name][t._id], upd.$set);
        if (upd.$inc) {
          for (const [k, v] of Object.entries(upd.$inc)) {
            store[name][t._id][k] = ((store[name][t._id][k] as number) || 0) + v;
          }
        }
        if (upd.$push) {
          for (const [k, v] of Object.entries(upd.$push)) {
            if (!Array.isArray(store[name][t._id][k])) store[name][t._id][k] = [];
            (store[name][t._id][k] as unknown[]).push(v);
          }
        }
      }
      return { updated: targets.length };
    },

    async remove(q: Query = {}): Promise<{ deleted: number }> {
      const targets = rows().filter(r => matchesQuery(r, q));
      for (const t of targets) delete store[name][t._id];
      return { deleted: targets.length };
    },

    async delete(q: Query = {}): Promise<{ deleted: number }> {
      const targets = rows().filter(r => matchesQuery(r, q));
      for (const t of targets) delete store[name][t._id];
      return { deleted: targets.length };
    },

    async count(q: Query = {}): Promise<number> {
      return rows().filter(r => matchesQuery(r, q)).length;
    },

    ensureIndex(): void {},
  };
}

// ── MockDb tipi ───────────────────────────────────────────────────────────────

export interface MockDb {
  users:              MockCollection;
  servers:            MockCollection;
  members:            MockCollection;
  channels:           MockCollection;
  messages:           MockCollection;
  refreshTokens:      MockCollection;
  invites:            MockCollection;
  roles:              MockCollection;
  dmConversations:    MockCollection;
  dmMessages:         MockCollection;
  serverGifs:         MockCollection;
  scheduledMsgs:      MockCollection;
  channelBridges:     MockCollection;
  serverEmojis:       MockCollection;
  polls:              MockCollection;
  soundboard:         MockCollection;
  friendships:        MockCollection;
  channelCategories:  MockCollection;
  notificationPrefs:  MockCollection;
  auditLogs:          MockCollection;
  voiceMessages:      MockCollection;
  threads:            MockCollection;
  threadMessages:     MockCollection;
  bots:               MockCollection;
  webhooks:           MockCollection;
  channelOverrides:   MockCollection;
  unreadCounts:       MockCollection;
  pushSubscriptions:  MockCollection;
  federationPeers:    MockCollection;
  serverFederationKeys: MockCollection;
  adminLogs:          MockCollection;
  reactionRoles:      MockCollection;
  nativePushTokens:   MockCollection;
  apActivities:       MockCollection;
  apFollows:          MockCollection;
  apMessages:         MockCollection;
  apOutgoingFollows:  MockCollection;
  apLikes:            MockCollection;
  apAnnounces:        MockCollection;
  notifications:      MockCollection;
  fcmTokens:          MockCollection;
  federationWhitelist:  MockCollection;
  federationBlacklist:  MockCollection;
  automodRules:         MockCollection;
  groupDmConversations: MockCollection;
  groupDmMembers:       MockCollection;
  groupDmMessages:      MockCollection;
  userConnections:      MockCollection;
  outgoingWebhooks:     MockCollection;
  serverOnboarding:     MockCollection;
  channelPermissions:   MockCollection;
  serverRoles:          MockCollection;
  emailTokens:          MockCollection;
  serverTemplates:      MockCollection;
  podcastSettings:      MockCollection;
  podcastEpisodes:      MockCollection;
  userApKeys:           MockCollection;
  userBadges:           MockCollection;
  uploads:              MockCollection;
  _ftsSearch:           () => Promise<never[]>;
  _sqlite: {
    transaction: (fn: () => void) => () => void;
    prepare: () => { run: () => void; get: () => { n: number }; all: () => never[] };
  };
  _pool: {
    query:   jest.Mock;
    connect: jest.Mock;
  };
  _transaction: (fn: (client: { query: jest.Mock; release: jest.Mock }) => unknown) => Promise<unknown>;
  _initSchema:  () => Promise<void>;
  _reset:       () => void;
}

// ── Builder ───────────────────────────────────────────────────────────────────

function buildMockDb(store: Store): MockDb {
  const db = {
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
    serverFederationKeys: makeCol(store, 'server_federation_keys'),
    adminLogs:         makeCol(store, 'admin_logs'),
    reactionRoles:     makeCol(store, 'reaction_roles'),
    nativePushTokens:  makeCol(store, 'native_push_tokens'),
    apActivities:      makeCol(store, 'ap_activities'),
    apFollows:         makeCol(store, 'ap_follows'),
    apMessages:        makeCol(store, 'ap_messages'),
    apOutgoingFollows:    makeCol(store, 'ap_outgoing_follows'),
    apLikes:              makeCol(store, 'ap_likes'),
    apAnnounces:          makeCol(store, 'ap_announces'),
    notifications:        makeCol(store, 'notifications'),
    fcmTokens:            makeCol(store, 'fcm_tokens'),
    federationWhitelist:  makeCol(store, 'federation_whitelist'),
    federationBlacklist:  makeCol(store, 'federation_blacklist'),
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
    serverTemplates:        makeCol(store, 'server_templates'),
    podcastSettings:        makeCol(store, 'podcast_settings'),
    podcastEpisodes:        makeCol(store, 'podcast_episodes'),
    userApKeys:             makeCol(store, 'user_ap_keys'),
    userBadges:             makeCol(store, 'user_badges'),
    uploads:                makeCol(store, 'uploads'),
    _ftsSearch: async (): Promise<never[]> => [],
    _sqlite: {
      transaction: (fn: () => void) => () => fn(),
      prepare: () => ({ run: () => {}, get: () => ({ n: 0 }), all: () => [] as never[] }),
    },
    _pool: {
      query:   jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: jest.fn().mockResolvedValue({
        query:   jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        release: jest.fn(),
      }),
    },
    _transaction: async (fn: (client: { query: jest.Mock; release: jest.Mock }) => unknown) => {
      const client = {
        query:   jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        release: jest.fn(),
      };
      return fn(client);
    },
    _initSchema: async (): Promise<void> => {},
    _reset: () => {
      for (const name of ALL_COLLECTIONS) store[name] = {};
    },
  } as unknown as MockDb;          // cast: dinamik koleksiyon map'i doğrudan atanıyor
  return db;
}

function createStore(): Store {
  const store: Store = {};
  for (const name of ALL_COLLECTIONS) store[name] = {};
  return store;
}

export function createMockDb(): MockDb {
  return buildMockDb(createStore());
}

// ── Test fixture helpers ──────────────────────────────────────────────────────

export interface UserFixture {
  _id: string; username: string; displayName: string;
  password: string; avatarColor: string; status: string;
  bio: string; tokenVersion: number; createdAt: number;
  [key: string]: unknown;
}

export interface ServerFixture {
  _id: string; name: string; icon: string;
  ownerId: string; createdAt: number;
  [key: string]: unknown;
}

export interface ChannelFixture {
  _id: string; serverId: string; name: string;
  type: string; topic: string; category: string;
  order: number; createdAt: number;
  [key: string]: unknown;
}

export interface MessageFixture {
  _id: string; channelId: string; serverId: string; userId: string;
  username: string; displayName: string; avatarColor: string;
  content: string; type: string; reactions: Record<string, unknown>;
  pinned: boolean; createdAt: number;
  [key: string]: unknown;
}

export interface ThreadMessageFixture {
  _id: string; threadId: string; userId: string;
  username: string; displayName: string; avatarColor: string;
  content: string; type: string; reactions: Record<string, unknown>;
  createdAt: number;
  [key: string]: unknown;
}

export function makeUser(overrides: Partial<UserFixture> = {}): UserFixture {
  return {
    _id:          uuidv4(),
    username:     'testuser_' + Math.random().toString(36).slice(2, 7),
    displayName:  'Test User',
    password:     '$2a$10$hashedpassword',
    avatarColor:  '#2d9cdb',
    status:       'offline',
    bio:          '',
    tokenVersion: 0,
    createdAt:    Date.now(),
    ...overrides,
  };
}

export function makeServer(ownerId: string, overrides: Partial<ServerFixture> = {}): ServerFixture {
  return {
    _id:       uuidv4(),
    name:      'Test Server',
    icon:      '🌐',
    ownerId,
    createdAt: Date.now(),
    ...overrides,
  };
}

export function makeChannel(serverId: string, overrides: Partial<ChannelFixture> = {}): ChannelFixture {
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

export function makeMessage(
  channelId: string,
  serverId: string,
  userId: string,
  overrides: Partial<MessageFixture> = {},
): MessageFixture {
  return {
    _id:         uuidv4(),
    channelId,
    serverId,
    userId,
    username:    'testuser',
    displayName: 'Test User',
    avatarColor: '#2d9cdb',
    content:     'Test message',
    type:        'normal',
    reactions:   {},
    pinned:      false,
    createdAt:   Date.now(),
    ...overrides,
  };
}

export function makeThreadMessage(
  threadId: string,
  userId: string,
  overrides: Partial<ThreadMessageFixture> = {},
): ThreadMessageFixture {
  return {
    _id:         uuidv4(),
    threadId,
    userId,
    username:    'testuser',
    displayName: 'Test User',
    avatarColor: '#2d9cdb',
    content:     'Thread reply',
    type:        'normal',
    reactions:   {},
    createdAt:   Date.now(),
    ...overrides,
  };
}
