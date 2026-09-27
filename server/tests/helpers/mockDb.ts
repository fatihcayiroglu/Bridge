// server/tests/helpers/mockDb.ts
// Tam in-memory mock DB — tüm collection'ları kapsar
// Sprint 57: .js → .ts migrate edildi (helpers son 3 dosya)

import { v4 as uuidv4 } from 'uuid';

// ── Tip tanımları ─────────────────────────────────────────────────────────────

type QueryOperators = {
  $in?:     unknown[];
  $nin?:    unknown[];
  $ne?:     unknown;
  $contains?: unknown;
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

export interface MockDoc {
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

export interface MockCollection {
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
  'polls', 'soundboard', 'soundboard_user_stats', 'friendships', 'blocks', 'channel_categories',
  'notification_prefs', 'notification_keywords', 'audit_logs', 'voice_messages',
  'threads', 'thread_messages', 'bots', 'server_bots', 'bot_ratings', 'webhooks',
  'channel_overrides', 'unread_counts', 'channel_read_positions', 'push_subscriptions',
  'federation_peers', 'admin_logs', 'server_federation_keys',
  'reaction_roles', 'native_push_tokens', 'ap_activities',
  'reactionRoles', 'nativePushTokens', 'apActivities',
  // v45 — eksik koleksiyonlar eklendi
  'automod_rules', 'outgoing_webhook_deliveries', 'group_dm_conversations', 'group_dm_members', 'group_dm_messages',
  'user_connections', 'outgoing_webhooks', 'server_onboarding', 'channel_permissions',
  'server_roles', 'email_tokens',
  // v57 — server şablonları DB'ye taşındı
  'server_templates', 'onboarding_completions',
  // v65 — Podcast (Stage -> Podcast Yayınlama)
  'podcast_settings',
  'podcast_episodes',
  // federation social — ActivityPub extended collections
  'ap_outgoing_follows', 'ap_likes', 'ap_announces',
  'notifications', 'fcm_tokens',
  'federation_whitelist', 'federation_blacklist',
  'ap_delivery_queue',
  'saved_messages', 'savedMessages', 'message_reports', 'messageReports',
  // Güvenlik: ActivityPub özel anahtarları ayrı tabloda
  'user_ap_keys', 'userApKeys',
  // Rozet sistemi
  'user_badges', 'userBadges',
  // Upload sahipliği (Sprint 75)
  'uploads',
  // Sticker paketleri (migrations_pg/021). camelCase takma adlar db/loader
  // anahtarlarıyla, snake_case adlar TABLE_MAP hedefleriyle eşleşir.
  'sticker_packs', 'sticker_pack_items', 'stickerPacks', 'stickerPackItems',
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
      // JSONB dizi üyeliği — pgCollection'daki `@>` ile aynı semantik.
      if (op.$contains !== undefined) {
        const field = doc[k];
        const wanted = Array.isArray(op.$contains) ? op.$contains : [op.$contains];
        if (!Array.isArray(field)) return false;
        if (!wanted.every(w => field.includes(w))) return false;
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

/**
 * ════════════════════════════════════════════════════════════════════════════
 * JSONB SADAKATİ — `pg` NE DÖNDÜRÜRSE MOCK DA ONU DÖNDÜRMELİ
 * ════════════════════════════════════════════════════════════════════════════
 * `members.roles` kolonu `JSONB NOT NULL DEFAULT '[]'`tir. PostgreSQL'e JSON
 * METNİ (`'[]'`) yazılabilir, ama `pg` sürücüsü okurken HER ZAMAN ayrıştırılmış
 * bir JS DİZİSİ döndürür. Üretim kodu bu yüzden diziyle çalışır:
 *
 *     const roleIds = membership.roles || [];
 *     if (roleIds.length) { ...rolleri çöz... }        // lib/permissions.ts
 *
 * ── ÖLÇÜLEN ARIZA ─────────────────────────────────────────────────────────
 * Mock hiçbir normalizasyon yapmıyordu; fixture'ların 34'ü `roles: '[]'`
 * (STRING) yazıyordu. O zaman `roleIds` iki karakterlik bir STRING olur,
 * `roleIds.length === 2` TRUE'dur, kod rol dalına girer, hiçbir rol bulamaz ve
 *
 *     basePermissions = [].reduce(..., 0) === 0
 *
 * yani rolü olmayan sıradan bir üye SESSİZCE SIFIR İZİNLİ olur —
 * `DEFAULT_PERMISSIONS` yerine. Üretimde ASLA oluşamayacak bir durum.
 *
 * Sonucu iki yönlüydü: (1) meşru üyeler 403 alıyor ve testler "ürün bozuk"
 * gibi düşüyordu, (2) düşmeyen testler ise yetkilendirmenin İZİN VEREN
 * dalını hiç yürütmüyordu — yani kapsam görünüyor ama koruma ölçülmüyordu.
 *
 * Bu normalizasyon PostgreSQL'in davranışını taklit eder: JSONB kolona yazılan
 * JSON metni, okunurken ayrıştırılmış değer olarak görünür.
 */
const JSONB_ARRAY_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  members: ['roles'],
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * BOOLEAN SUTUNLAR — PostgreSQL 0/1'i `true`/`false`a DONUSTURUR
 * ════════════════════════════════════════════════════════════════════════════
 * PostgreSQL'de bir BOOLEAN kolona `1` yazilabilir (`'1'::boolean` = true) ve
 * `pg` surucusu okurken HER ZAMAN gercek bir boolean dondurur. Yani uretimde
 * `isAdmin` degeri `1` OLARAK OKUNAMAZ.
 *
 * Mock ise ne yazildiysa onu sakliyordu. Fixture'lar `isAdmin: 1` yazinca:
 *
 *   · uretim kodu `Users.count({ isAdmin: true })` sorguluyor,
 *   · mock kati esitlikle `1 !== true` diyor,
 *   · sayim 0 cikiyor.
 *
 * Bu, `routes/admin/core.ts` icindeki YONETICI BOOTSTRAP kapisini besleyen
 * sorgudur: "zaten yonetici var mi?". Mock'ta 0 donmesi, testin yanlislikla
 * "ikinci yonetici olusturulabiliyor" gibi davranmasina yol acar.
 *
 * Kolon listesi CANLI semadan alinmistir (information_schema, data_type =
 * boolean). Normalize etmek mock'u PostgreSQL'e SADIK kilar; fixture'lari tek
 * tek duzeltmek yerine seam duzeltilir.
 */
const BOOLEAN_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ap_activities: ['processed'],
  ap_outgoing_follows: ['accepted'],
  automod_rules: ['enabled'],
  bot_marketplace: ['approved', 'authorVerified', 'featured', 'verified'],
  bots: ['active', 'isPublic'],
  channel_bridges: ['active'],
  channel_categories: ['collapsed'],
  channels: ['modOnly'],
  dm_messages: ['e2e', 'isEncrypted'],
  federation_peers: ['verified'],
  members: ['banned', 'verified'],
  messages: ['autoModAlert', 'isWebhook', 'pinned'],
  notifications: ['read'],
  outgoing_webhooks: ['enabled'],
  podcast_episodes: ['published'],
  podcast_settings: ['enabled', 'explicit'],
  polls: ['allowVoteChange', 'closed', 'multiSelect'],
  refresh_tokens: ['used'],
  roles: ['displayOnProfile'],
  scheduled_msgs: ['sent'],
  soundboard_user_stats: ['favorite'],
  server_boosts: ['active'],
  server_onboarding: ['enabled'],
  server_templates: ['isBuiltin'],
  servers: ['discoverable', 'featured', 'verificationEnabled'],
  threads: ['locked', 'pinned'],
  user_connections: ['verified'],
  users: ['emailVerified', 'isAdmin', 'twoFactorEnabled'],
});

function normalizeJsonbColumns(collection: string, doc: Record<string, unknown>): void {
  const columns = JSONB_ARRAY_COLUMNS[collection];
  if (!columns) return;
  for (const column of columns) {
    const value = doc[column];
    if (typeof value !== 'string') continue;
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) doc[column] = parsed;
    } catch {
      // Ayrıştırılamayan metin OLDUĞU GİBİ bırakılır: mock, PostgreSQL'in
      // geçersiz JSONB'yi reddetmesini taklit etmez; sessizce "düzeltip"
      // gerçek bir hatayı gizlemek daha kötü olurdu.
    }
  }
}

/** PostgreSQL BOOLEAN semantigi: 0/1 ve '0'/'1' gercek boolean'a donusur. */
function normalizeBooleanColumns(collection: string, doc: Record<string, unknown>): void {
  const columns = BOOLEAN_COLUMNS[collection];
  if (!columns) return;
  for (const column of columns) {
    if (!Object.prototype.hasOwnProperty.call(doc, column)) continue;
    const value = doc[column];
    if (typeof value === 'boolean' || value === null || value === undefined) continue;
    if (value === 1 || value === '1' || value === 'true' || value === 't') { doc[column] = true; continue; }
    if (value === 0 || value === '0' || value === 'false' || value === 'f') { doc[column] = false; continue; }
    // Diger degerler DOKUNULMADAN birakilir: PostgreSQL onlari reddederdi ve
    // sessizce "duzeltmek" gercek bir fixture hatasini gizlerdi.
  }
}

/** Bir satirin tum sema-turevli normalizasyonlarini uygular. */
function normalizeRow(collection: string, doc: Record<string, unknown>): void {
  normalizeJsonbColumns(collection, doc);
  normalizeBooleanColumns(collection, doc);
}

/**
 * SORGU degerlerini de normalize eder.
 *
 * PostgreSQL'de `WHERE "discoverable" = $1` sorgusuna JS `1` gecirmek
 * CALISIR: surucu degeri metin olarak gonderir ve `'1'::boolean` = true olur.
 * Yani uretim kodu bir boolean kolonu 1/0 ile sorgulayabilir ve dogru sonucu
 * alir.
 *
 * Mock kati esitlik kullandigi icin bunu taklit etmezse, satir `true` olarak
 * saklanmisken `{ discoverable: 1 }` sorgusu HICBIR SEY eslesmez ve testler
 * uretimde olmayan bir davranis olcer.
 *
 * Yalnizca DUZ skaler degerler donusturulur; `$in`, `$lt` gibi operator
 * nesnelerine dokunulmaz.
 */
function normalizeQuery(collection: string, query: Query): Query {
  const columns = BOOLEAN_COLUMNS[collection];
  if (!columns || !query || typeof query !== 'object') return query;
  let copy: Record<string, unknown> | null = null;
  for (const column of columns) {
    if (!Object.prototype.hasOwnProperty.call(query, column)) continue;
    const value = (query as Record<string, unknown>)[column];
    if (typeof value === 'boolean' || value === null || value === undefined) continue;
    if (value !== null && typeof value === 'object') continue;   // $in / $lt vb.
    let mapped: unknown = value;
    if (value === 1 || value === '1' || value === 'true' || value === 't') mapped = true;
    else if (value === 0 || value === '0' || value === 'false' || value === 'f') mapped = false;
    else continue;
    if (!copy) copy = { ...(query as Record<string, unknown>) };
    copy[column] = mapped;
  }
  return (copy ?? query) as Query;
}

function makeCol(store: Store, name: string): MockCollection {
  if (!store[name]) store[name] = {};
  const rows = (): MockDoc[] => Object.values(store[name]);

  return {
    async findOne(q: Query = {}): Promise<MockDoc | null> {
      const nq = normalizeQuery(name, q);
      return rows().find(r => matchesQuery(r, nq)) ?? null;
    },

    find(q: Query = {}): FindChain {
      const nq = normalizeQuery(name, q);
      let result = rows().filter(r => matchesQuery(r, nq));
      const chain: FindChain = {
        sort(s: SortSpec) {
          const entries = Object.entries(s) as [string, 1 | -1][];
          // `MockDoc` degerleri `unknown`tur (dogrusu budur: satirlar
          // rastgele alan tasir). Karsilastirma ICIN once SIRALANABILIR bir
          // bicime indirgenir; boylece `<`/`>` operatorleri `unknown` uzerinde
          // calistirilmaz ve siralama davranisi ACIKCA tanimli olur.
          const sortKey = (value: unknown): number | string => {
            if (typeof value === 'number' || typeof value === 'string') return value;
            if (typeof value === 'boolean') return value ? 1 : 0;
            if (value === null || value === undefined) return '';
            return String(value);
          };
          result = [...result].sort((a, b) => {
            for (const [field, dir] of entries) {
              const av = sortKey(a[field]);
              const bv = sortKey(b[field]);
              if (av < bv) return dir === -1 ? 1 : -1;
              if (av > bv) return dir === -1 ? -1 : 1;
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
      normalizeRow(name, full as Record<string, unknown>);
      store[name][full._id] = full;
      return { ...full };
    },

    async update(q: Query, upd: UpdateSpec): Promise<{ updated: number }> {
      const targets = rows().filter(r => matchesQuery(r, normalizeQuery(name, q)));
      for (const t of targets) {
        if (upd.$set) {
          Object.assign(store[name][t._id], upd.$set);
          normalizeRow(name, store[name][t._id] as Record<string, unknown>);
        }
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
      const targets = rows().filter(r => matchesQuery(r, normalizeQuery(name, q)));
      for (const t of targets) delete store[name][t._id];
      return { deleted: targets.length };
    },

    async delete(q: Query = {}): Promise<{ deleted: number }> {
      const targets = rows().filter(r => matchesQuery(r, normalizeQuery(name, q)));
      for (const t of targets) delete store[name][t._id];
      return { deleted: targets.length };
    },

    async count(q: Query = {}): Promise<number> {
      return rows().filter(r => matchesQuery(r, normalizeQuery(name, q))).length;
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
  soundboardUserStats: MockCollection;
  friendships:        MockCollection;
  /** Kullanici engelleme — `Social.insertBlock/removeBlock/findBlock`. */
  blocks:             MockCollection;
  channelCategories:  MockCollection;
  notificationPrefs:  MockCollection;
  notificationKeywords: MockCollection;
  auditLogs:          MockCollection;
  voiceMessages:      MockCollection;
  threads:            MockCollection;
  threadMessages:     MockCollection;
  bots:               MockCollection;
  serverBots:         MockCollection;
  botRatings:         MockCollection;
  webhooks:           MockCollection;
  channelOverrides:   MockCollection;
  unreadCounts:       MockCollection;
  channelReadPositions: MockCollection;
  pushSubscriptions:  MockCollection;
  federationPeers:    MockCollection;
  serverFederationKeys: MockCollection;
  adminLogs:          MockCollection;
  reactionRoles:      MockCollection;
  nativePushTokens:   MockCollection;
  apActivities:       MockCollection;
  apDeliveryQueue:    MockCollection;
  apFollows:          MockCollection;
  apMessages:         MockCollection;
  apOutgoingFollows:  MockCollection;
  apLikes:            MockCollection;
  apAnnounces:        MockCollection;
  notifications:      MockCollection;
  savedMessages:      MockCollection;
  messageReports:     MockCollection;
  fcmTokens:          MockCollection;
  federationWhitelist:  MockCollection;
  federationBlacklist:  MockCollection;
  automodRules:         MockCollection;
  groupDmConversations: MockCollection;
  groupDmMembers:       MockCollection;
  groupDmMessages:      MockCollection;
  userConnections:      MockCollection;
  outgoingWebhooks:     MockCollection;
  outgoingWebhookDeliveries: MockCollection;
  serverOnboarding:     MockCollection;
  /**
   * Bu uc koleksiyon `createMockDb` icinde HEP vardi ama arayuzde
   * BILDIRILMEMISTI: onlari kullanan testler `MockDb` tipi altinda
   * derlenmiyordu (TS2339) ve bu yuzden strict borc defterinde
   * kaliyorlardi. Bildirim eksikligiydi, davranis degil.
   */
  onboardingCompletions: MockCollection;
  stickerPacks:         MockCollection;
  stickerPackItems:     MockCollection;
  channelPermissions:   MockCollection;
  serverRoles:          MockCollection;
  emailTokens:          MockCollection;
  serverTemplates:      MockCollection;
  podcastSettings:      MockCollection;
  podcastEpisodes:      MockCollection;
  userApKeys:           MockCollection;
  userBadges:           MockCollection;
  uploads:              MockCollection;
  /**
   * `AuthRepository.webauthnCollection()` bu koleksiyon YOKSA
   * "WebAuthn credential store is unavailable" FIRLATIR. Mock'ta tanimli
   * olmadigi icin MFA gerektiren yollar testte 500 uretiyordu ve gercek
   * davranis (403 MFA_REQUIRED) hic olculemiyordu.
   */
  webauthnCredentials:  MockCollection;
  // ── ARAMA KANCALARI ─────────────────────────────────────────────────────
  //
  // Uretim `DbInstance` bunlari `(...args: unknown[]) => unknown` diye
  // bildiriyor; mock DB ise yalnizca `_ftsSearch`i, hem de `() => Promise<never[]>`
  // olarak bildiriyordu. Testler bu kancalari GERCEK imzalariyla degistirip
  // arama davranisini olcuyor; bildirim eksik/dar oldugu icin her degistirme
  // TS2322/TS2339 uretiyordu.
  //
  // Imzalar URUNUN cagri bicimine gore yazildi
  // (`routes/search*.ts`, `db/postgres/search.ts`).
  // Parametreler `never[]`tir — BILEREK. Bunlar TEST DIKISLERIdir: her suit
  // kancayi KENDI senaryosunun imzasiyla degistirir (biri `(query, serverIds,
  // limit, allowedChannelIds)`, digeri `(query, scope)`). `unknown[]` yazmak
  // bu atamalari cakiskanlik (contravariance) yuzunden REDDEDER; `never[]` ise
  // "herhangi bir fonksiyon" icin dogru ve `any`siz olan tiptir.
  _ftsSearch: (...args: never[]) => unknown;
  /** Birlesik arama — yalnizca bazi suitler kurar. */
  _unifiedSearch?: (...args: never[]) => unknown;
  /** Mesaj baglami (oncesi/sonrasi) — yalnizca bazi suitler kurar. */
  _searchContext?: (...args: never[]) => unknown;
  _sqlite: {
    transaction: (fn: () => void) => () => void;
    prepare: () => { run: () => void; get: () => { n: number }; all: () => never[] };
  };
  /**
   * PostgreSQL havuzu STUB'U — VARSAYILAN OLARAK YOKTUR.
   * Bkz. `createMockDb` üzerindeki uzun not; `createMockDb({ withPgPool: true })`
   * ile açıkça istenir.
   */
  _pool?: {
    query:   jest.Mock;
    connect: jest.Mock;
  };
  _transaction: (fn: (client: { query: jest.Mock; release: jest.Mock }) => unknown) => Promise<unknown>;
  _initSchema:  () => Promise<void>;
  _reset:       () => void;
}

// ── Builder ───────────────────────────────────────────────────────────────────

function buildMockDb(store: Store, withPgPool: boolean): MockDb {
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
    soundboardUserStats: makeCol(store, 'soundboard_user_stats'),
    friendships:       makeCol(store, 'friendships'),
    blocks:            makeCol(store, 'blocks'),
    channelCategories: makeCol(store, 'channel_categories'),
    notificationPrefs: makeCol(store, 'notification_prefs'),
    notificationKeywords: makeCol(store, 'notification_keywords'),
    auditLogs:         makeCol(store, 'audit_logs'),
    voiceMessages:     makeCol(store, 'voice_messages'),
    threads:           makeCol(store, 'threads'),
    threadMessages:    makeCol(store, 'thread_messages'),
    bots:              makeCol(store, 'bots'),
    serverBots:        makeCol(store, 'server_bots'),
    botRatings:        makeCol(store, 'bot_ratings'),
    webhooks:          makeCol(store, 'webhooks'),
    channelOverrides:  makeCol(store, 'channel_overrides'),
    unreadCounts:      makeCol(store, 'unread_counts'),
    channelReadPositions: makeCol(store, 'channel_read_positions'),
    pushSubscriptions: makeCol(store, 'push_subscriptions'),
    federationPeers:   makeCol(store, 'federation_peers'),
    serverFederationKeys: makeCol(store, 'server_federation_keys'),
    adminLogs:         makeCol(store, 'admin_logs'),
    reactionRoles:     makeCol(store, 'reaction_roles'),
    nativePushTokens:  makeCol(store, 'native_push_tokens'),
    apActivities:      makeCol(store, 'ap_activities'),
    apDeliveryQueue:   makeCol(store, 'ap_delivery_queue'),
    apFollows:         makeCol(store, 'ap_follows'),
    apMessages:        makeCol(store, 'ap_messages'),
    apOutgoingFollows:    makeCol(store, 'ap_outgoing_follows'),
    apLikes:              makeCol(store, 'ap_likes'),
    apAnnounces:          makeCol(store, 'ap_announces'),
    notifications:        makeCol(store, 'notifications'),
    savedMessages:        makeCol(store, 'saved_messages'),
    messageReports:       makeCol(store, 'message_reports'),
    fcmTokens:            makeCol(store, 'fcm_tokens'),
    federationWhitelist:  makeCol(store, 'federation_whitelist'),
    federationBlacklist:  makeCol(store, 'federation_blacklist'),
    automodRules:           makeCol(store, 'automod_rules'),
    groupDmConversations:   makeCol(store, 'group_dm_conversations'),
    groupDmMembers:         makeCol(store, 'group_dm_members'),
    groupDmMessages:        makeCol(store, 'group_dm_messages'),
    userConnections:        makeCol(store, 'user_connections'),
    outgoingWebhooks:       makeCol(store, 'outgoing_webhooks'),
    outgoingWebhookDeliveries: makeCol(store, 'outgoing_webhook_deliveries'),
    serverOnboarding:       makeCol(store, 'server_onboarding'),
    onboardingCompletions:  makeCol(store, 'onboarding_completions'),
    channelPermissions:     makeCol(store, 'channel_permissions'),
    serverRoles:            makeCol(store, 'server_roles'),
    emailTokens:            makeCol(store, 'email_tokens'),
    serverTemplates:        makeCol(store, 'server_templates'),
    podcastSettings:        makeCol(store, 'podcast_settings'),
    podcastEpisodes:        makeCol(store, 'podcast_episodes'),
    userApKeys:             makeCol(store, 'user_ap_keys'),
    userBadges:             makeCol(store, 'user_badges'),
    uploads:                makeCol(store, 'uploads'),
    webauthnCredentials:    makeCol(store, 'webauthn_credentials'),
    stickerPacks:           makeCol(store, 'sticker_packs'),
    stickerPackItems:       makeCol(store, 'sticker_pack_items'),
    _ftsSearch: async (): Promise<Array<Record<string, unknown>>> => [],
    _sqlite: {
      transaction: (fn: () => void) => () => fn(),
      prepare: () => ({ run: () => {}, get: () => ({ n: 0 }), all: () => [] as never[] }),
    },
    ...(withPgPool ? {
      _pool: {
        query:   jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        connect: jest.fn().mockResolvedValue({
          query:   jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
          release: jest.fn(),
        }),
      },
    } : {}),
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

/**
 * ════════════════════════════════════════════════════════════════════════════
 * `_pool` VARSAYILAN OLARAK VERİLMEZ — VE BU KASITLIDIR
 * ════════════════════════════════════════════════════════════════════════════
 * Üretim kodu, ATOMİK PostgreSQL yollarını `db._pool` VARLIĞINA bakarak seçer:
 *
 *     const pool = (db as { _pool?: Pool })._pool;
 *     if (!pool) return null;          // → çağıran belgelenmiş yedek yola düşer
 *
 * En az 10 repository bunu yapar: `Messages.toggleReactionAtomic`,
 * `Auth.rotateRefreshTokenAtomic`, `InviteRepository` slot tüketimi,
 * `DmRepository.markReadWithReceipt`, `OutgoingWebhookRepository`,
 * `FederationRepository`, `NotificationRepository` …
 *
 * ── ÖLÇÜLEN ARIZA ─────────────────────────────────────────────────────────
 * Mock, SQL çalıştıramadığı hâlde bir `_pool` İLAN EDİYORDU ve `query`
 * her zaman `{ rows: [], rowCount: 0 }` döndürüyordu. Üretim kodu bu yüzden
 * "gerçek PostgreSQL" dalına giriyor, sonra "hiçbir satır etkilenmedi"
 * cevabını alıyor ve bunu bir ALAN HATASI olarak yorumluyordu:
 *
 *     POST /api/messages/:id/react
 *       → toggleReactionAtomic() === false
 *       → 400 "Max 20 unique reactions per message"     (mesajda 0 reaksiyon var!)
 *
 * Yani mock, testleri yalnızca kırmıyordu; ÜRETİM KODUNU YANLIŞ DALA
 * SOKUYORDU. Yedek (mock/SQLite) yolu — kodun bu adaptör için tasarladığı yol —
 * yüzlerce testte HİÇ çalışmıyordu.
 *
 * Havuz stub'una gerçekten ihtiyaç duyan testler (SQL/kontrol akışı iddiaları)
 * `withPgPool: true` ile AÇIKÇA ister. Böylece "SQL sözleşmesini ölçüyorum"
 * niyeti dosyada görünür olur.
 *
 * DİKKAT: `withPgPool: true` bile PostgreSQL SEMANTİĞİNİ KANITLAMAZ — yalnızca
 * hangi SQL'in gönderildiğini gösterir. Gerçek kilitleme/yarış davranışı için
 * `tests/pg-integration/` altındaki gerçek veritabanı süiti kullanılır.
 */
/**
 * `findOne` NULL donebilir. Testlerde satirin VAR OLMASI beklentinin bir
 * parcasidir; onu dogrudan dereference etmek strict altinda derlenmez ve
 * strict olmadan da hatayi `TypeError: reading 'x' of null` gibi okunmasi
 * zor bir kaza hâline getirir. Bu yardimci beklentiyi ACIK yazar: satir
 * yoksa hangi sorgunun karsiligi bulunamadigini soyleyen bir hata firlatir,
 * varsa tipi daraltir.
 */
export interface DocSource<T> {
  findOne(query: Record<string, unknown>): Promise<T | null>;
}

export async function requireDoc<T = MockDoc>(
  collection: DocSource<T>,
  query: Record<string, unknown>,
): Promise<T> {
  const doc = await collection.findOne(query);
  if (!doc) throw new Error(`beklenen kayit bulunamadi: ${JSON.stringify(query)}`);
  return doc;
}

export function createMockDb(options: { withPgPool?: boolean } = {}): MockDb {
  return buildMockDb(createStore(), options.withPgPool === true);
}

/**
 * Var olan bir mock DB örneğine PostgreSQL havuz STUB'U ekler.
 *
 * `db/loader` NODE_ENV=test altında kendi `createMockDb()` çağrısını yapar ve
 * singleton döndürür; dolayısıyla loader üzerinden gelen bir örneğe seçenek
 * geçirilemez. SQL/kontrol-akışı sözleşmesi ölçen süitler bunu AÇIKÇA çağırır.
 *
 * Bu bir SQL SÖZLEŞMESİ aracıdır — PostgreSQL semantiği KANITLAMAZ.
 */
export function attachPgPoolStub(target: MockDb): MockDb {
  if (!target._pool) {
    target._pool = {
      query:   jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: jest.fn().mockResolvedValue({
        query:   jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        release: jest.fn(),
      }),
    };
  }
  return target;
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

export interface PollOptionFixture {
  id: string; text: string; votes: string[];
}

export interface PollFixture {
  _id: string; channelId: string; serverId: string; createdBy: string;
  question: string; options: PollOptionFixture[];
  multiSelect: boolean; expiresAt: number | null; closed: boolean; createdAt: number;
  [key: string]: unknown;
}

export function makePoll(
  scope: { channelId: string; serverId: string; createdBy: string },
  overrides: Partial<PollFixture> = {},
): PollFixture {
  return {
    _id:         uuidv4(),
    channelId:   scope.channelId,
    serverId:    scope.serverId,
    createdBy:   scope.createdBy,
    question:    'Test?',
    options:     [{ id: '0', text: 'A', votes: [] }, { id: '1', text: 'B', votes: [] }],
    multiSelect: false,
    expiresAt:   null,
    closed:      false,
    createdAt:   Date.now(),
    ...overrides,
  };
}

export interface ThreadFixture {
  _id: string; channelId: string; serverId: string;
  /** Forum konularinda ust mesaj yoktur (kanal koklu) — bu yuzden nullable. */
  parentMessageId: string | null;
  name: string; createdBy: string;
  createdAt: number; lastMessageAt: number; messageCount: number;
  pinned?: boolean; locked?: boolean;
  [key: string]: unknown;
}

export function makeThread(
  scope: { channelId: string; serverId: string; createdBy: string; parentMessageId?: string | null },
  overrides: Partial<ThreadFixture> = {},
): ThreadFixture {
  const now = Date.now();
  return {
    _id:             uuidv4(),
    channelId:       scope.channelId,
    serverId:        scope.serverId,
    parentMessageId: scope.parentMessageId ?? null,
    name:            'Test Thread',
    createdBy:       scope.createdBy,
    createdAt:       now,
    lastMessageAt:   now,
    messageCount:    0,
    ...overrides,
  };
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
    // PostgreSQL `users` gercekte bu iki NOT NULL alani varsayilanla doner.
    // Fixture'in bunlari atlamasi, fail-closed privacy normalizasyonunu testlerde
    // gercek veritabanindan farkli bir "bozuk row" durumuna sokuyordu.
    presenceVisibility: 'visible',
    dmPrivacy:     'everyone',
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
