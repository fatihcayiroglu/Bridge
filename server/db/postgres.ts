// @ts-nocheck
// server/db/postgres.js — PostgreSQL adapter
// SQLite db/index.js ile BİREBİR aynı API → drop-in replacement
//
// KULLANIM:
//   .env → DATABASE_URL=postgresql://user:pass@localhost:5432/bridge
//   server/index.js → const db = require('./db/postgres');  // SQLite yerine
//
// KURULUM:
//   npm install pg
//   createdb bridge
//   node db/postgres.js   (ilk çalıştırmada tabloları oluşturur)

'use strict';

const { Pool }  = require('pg');
const { v4: uuidv4 } = require('uuid');

// ── BAĞLANTI ─────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max:              process.env.PG_POOL_MAX   ? parseInt(process.env.PG_POOL_MAX)   : 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('[DB] PostgreSQL pool hatası:', err.message);
});

// ── SCHEMA ───────────────────────────────────────────────────
// Tüm tablolar IF NOT EXISTS → güvenle tekrar çalıştırılabilir
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  _id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  "displayName" TEXT NOT NULL,
  password TEXT NOT NULL,
  "avatarColor" TEXT NOT NULL DEFAULT '#5865f2',
  "avatarUrl" TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  bio TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  pronouns TEXT NOT NULL DEFAULT '',
  "bannerColor" TEXT NOT NULL DEFAULT '',
  "bannerUrl" TEXT,
  "statusText" TEXT NOT NULL DEFAULT '',
  "statusEmoji" TEXT NOT NULL DEFAULT '',
  "tokenVersion" INTEGER NOT NULL DEFAULT 0,
  email TEXT,
  "emailVerified" BOOLEAN NOT NULL DEFAULT FALSE,
  "emailToken" TEXT,
  "emailTokenExp" BIGINT,
  "twoFactorSecret" TEXT,
  "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "twoFactorBackup" JSONB NOT NULL DEFAULT '[]',
  "isAdmin" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "expiresAt" BIGINT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  "usedAt" BIGINT,
  family TEXT
);
CREATE INDEX IF NOT EXISTS idx_rt_userId  ON refresh_tokens("userId");
CREATE INDEX IF NOT EXISTS idx_rt_expires ON refresh_tokens("expiresAt");
CREATE INDEX IF NOT EXISTS idx_rt_family  ON refresh_tokens(family);  -- Sprint 10: revokeByFamily

CREATE TABLE IF NOT EXISTS servers (
  _id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '🌐',
  "iconUrl" TEXT,
  "bannerUrl" TEXT,
  "ownerId" TEXT NOT NULL,
  discoverable BOOLEAN NOT NULL DEFAULT FALSE,
  description TEXT NOT NULL DEFAULT '',
  tags JSONB NOT NULL DEFAULT '[]',
  "verificationEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "verificationChannelId" TEXT,
  "verificationRoleId" TEXT,
  "logChannelId" TEXT,
  "createdAt" BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL REFERENCES servers(_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  topic TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'GENERAL',
  "categoryId" TEXT,
  "order" INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels("serverId");

CREATE TABLE IF NOT EXISTS messages (
  _id TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  username TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "avatarColor" TEXT NOT NULL DEFAULT '#5865f2',
  content TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'normal',
  "fileUrl" TEXT,
  "fileName" TEXT,
  "fileType" TEXT,
  reactions JSONB NOT NULL DEFAULT '{}',
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  "editedAt" BIGINT,
  "editHistory" JSONB NOT NULL DEFAULT '[]',
  "replyTo" JSONB,
  "bridgedFrom" JSONB,
  "scheduledId" TEXT,
  "threadId" TEXT,
  "threadCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages("channelId");
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages("createdAt");
CREATE INDEX IF NOT EXISTS idx_messages_server  ON messages("serverId");

CREATE TABLE IF NOT EXISTS members (
  "userId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL REFERENCES servers(_id) ON DELETE CASCADE,
  roles JSONB NOT NULL DEFAULT '[]',
  "joinedAt" BIGINT NOT NULL,
  "timeoutUntil" BIGINT,
  verified BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY("userId", "serverId")
);
CREATE INDEX IF NOT EXISTS idx_members_user   ON members("userId");
CREATE INDEX IF NOT EXISTS idx_members_server ON members("serverId");

CREATE TABLE IF NOT EXISTS invites (
  _id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  "serverId" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "expiresAt" BIGINT NOT NULL,
  "maxUses" INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);

CREATE TABLE IF NOT EXISTS roles (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#99aab5',
  permissions INTEGER NOT NULL DEFAULT 16,
  position INTEGER NOT NULL DEFAULT 0,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roles_server ON roles("serverId");

CREATE TABLE IF NOT EXISTS dm_conversations (
  _id TEXT PRIMARY KEY,
  participants JSONB NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "lastMessageAt" BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS dm_messages (
  _id TEXT PRIMARY KEY,
  "dmId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "avatarColor" TEXT NOT NULL DEFAULT '#5865f2',
  content TEXT NOT NULL DEFAULT '',
  "fileUrl" TEXT,
  "fileName" TEXT,
  "fileType" TEXT,
  reactions JSONB NOT NULL DEFAULT '{}',
  e2e BOOLEAN NOT NULL DEFAULT FALSE,
  "isEncrypted" BOOLEAN NOT NULL DEFAULT FALSE,
  "e2eData" JSONB,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dm_messages_conv ON dm_messages("dmId");
CREATE INDEX IF NOT EXISTS idx_dm_messages_ts   ON dm_messages("dmId", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS server_gifs (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  name TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]',
  url TEXT NOT NULL,
  "fileType" TEXT NOT NULL DEFAULT 'image/gif',
  "uploadedBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gifs_server ON server_gifs("serverId");

CREATE TABLE IF NOT EXISTS scheduled_msgs (
  _id TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  username TEXT NOT NULL,
  "avatarColor" TEXT NOT NULL DEFAULT '#5865f2',
  content TEXT NOT NULL,
  "sendAt" BIGINT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  sent BOOLEAN NOT NULL DEFAULT FALSE,
  "sentAt" BIGINT
);
CREATE INDEX IF NOT EXISTS idx_sched_sendAt ON scheduled_msgs("sendAt");

CREATE TABLE IF NOT EXISTS channel_bridges (
  _id TEXT PRIMARY KEY,
  "sourceChannelId" TEXT NOT NULL,
  "targetChannelId" TEXT NOT NULL,
  "sourceServerId" TEXT NOT NULL,
  "targetServerId" TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  "createdBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_bridge_src ON channel_bridges("sourceChannelId");

CREATE TABLE IF NOT EXISTS server_emojis (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  "uploadedBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emojis_server ON server_emojis("serverId");

CREATE TABLE IF NOT EXISTS polls (
  _id TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  question TEXT NOT NULL,
  options JSONB NOT NULL DEFAULT '[]',
  "multiSelect" BOOLEAN NOT NULL DEFAULT FALSE,
  "expiresAt" BIGINT,
  closed BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_polls_channel ON polls("channelId");

CREATE TABLE IF NOT EXISTS soundboard (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🔊',
  url TEXT NOT NULL,
  "uploadedBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_soundboard_server ON soundboard("serverId");

CREATE TABLE IF NOT EXISTS friendships (
  _id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "friendId" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  "createdAt" BIGINT NOT NULL,
  UNIQUE("userId", "friendId")
);
CREATE INDEX IF NOT EXISTS idx_friends_user   ON friendships("userId");
CREATE INDEX IF NOT EXISTS idx_friends_friend ON friendships("friendId");

CREATE TABLE IF NOT EXISTS channel_categories (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  collapsed BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cats_server ON channel_categories("serverId");

CREATE TABLE IF NOT EXISTS notification_prefs (
  _id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'all',
  "updatedAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifprefs_user ON notification_prefs("userId");

CREATE TABLE IF NOT EXISTS audit_logs (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_server ON audit_logs("serverId");

CREATE TABLE IF NOT EXISTS voice_messages (
  _id TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  url TEXT NOT NULL,
  duration INTEGER NOT NULL DEFAULT 0,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vm_channel ON voice_messages("channelId");

CREATE TABLE IF NOT EXISTS threads (
  _id TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "parentMessageId" TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  "createdBy" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "lastMessageAt" BIGINT NOT NULL,
  "messageCount" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads("channelId");
CREATE INDEX IF NOT EXISTS idx_threads_parent  ON threads("parentMessageId");

CREATE TABLE IF NOT EXISTS thread_messages (
  _id TEXT PRIMARY KEY,
  "threadId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  username TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "avatarColor" TEXT NOT NULL DEFAULT '#5865f2',
  content TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'normal',
  reactions JSONB NOT NULL DEFAULT '{}',
  "editedAt" BIGINT,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tmsg_thread  ON thread_messages("threadId");
CREATE INDEX IF NOT EXISTS idx_tmsg_created ON thread_messages("createdAt");

CREATE TABLE IF NOT EXISTS bots (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  username TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  "tokenHash" TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  permissions INTEGER NOT NULL DEFAULT 256,
  "webhookUrl" TEXT,
  events JSONB NOT NULL DEFAULT '[]',
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bots_server ON bots("serverId");

CREATE TABLE IF NOT EXISTS webhooks (
  _id TEXT PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  name TEXT NOT NULL,
  secret TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_overrides (
  _id TEXT PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  allow INTEGER NOT NULL DEFAULT 0,
  deny INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ovr_channel ON channel_overrides("channelId");

CREATE TABLE IF NOT EXISTS unread_counts (
  "userId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT NOT NULL,
  PRIMARY KEY ("userId", "channelId")
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  _id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  endpoint TEXT UNIQUE NOT NULL,
  keys JSONB NOT NULL DEFAULT '{}',
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions("userId");

CREATE TABLE IF NOT EXISTS native_push_tokens (
  _id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'unknown',
  token TEXT UNIQUE NOT NULL,
  "createdAt" BIGINT NOT NULL,
  "updatedAt" BIGINT
);
CREATE INDEX IF NOT EXISTS idx_nativepush_user ON native_push_tokens("userId");

CREATE TABLE IF NOT EXISTS federation_peers (
  _id TEXT PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  "desc" TEXT NOT NULL DEFAULT '',
  "addedAt" BIGINT NOT NULL,
  "lastSeen" BIGINT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS admin_logs (
  _id TEXT PRIMARY KEY,
  "adminId" TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  "createdAt" BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adminlogs_admin ON admin_logs("adminId");

-- Full-Text Search (PostgreSQL native)
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_messages_fts ON messages USING GIN(
  to_tsvector('simple', unaccent(coalesce(content,'') || ' ' || coalesce("displayName",'')))
);
CREATE INDEX IF NOT EXISTS idx_messages_trgm ON messages USING GIN(content gin_trgm_ops);
`;

// ── JSONB KOLONLARI ───────────────────────────────────────────
// Bu kolonlar PostgreSQL'de zaten JSONB — otomatik parse edilir.
// Ekstra işlem gerekmez, ama fromRow'da tutarlılık için liste tutuyoruz.
const JSONB_COLS = new Set([
  'reactions','replyTo','bridgedFrom','tags','roles','participants',
  'editHistory','options','events','subscription','twoFactorBackup',
  'keys','e2eData',
]);

// ── QUERY BUILDER ────────────────────────────────────────────
// SQLite'daki ? yerine PostgreSQL $1, $2, ... kullanır
function buildWhere(query) {
  if (!query || Object.keys(query).length === 0) return { sql: 'TRUE', params: [] };

  const parts  = [];
  const params = [];
  let   idx    = 1;

  function ph() { return `$${idx++}`; }
  function safeCol(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Unsafe column identifier: ${name}`);
    }
    return `"${name}"`;
  }

  function processKey(k, v) {
    // camelCase → PostgreSQL için çift tırnak
    const col = safeCol(k);

    if (k === '$or') {
      const orParts = v.map(sub => {
        const r = buildWhere(sub);
        // offset param indices
        const shifted = r.sql.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + params.length}`);
        params.push(...r.params);
        idx = params.length + 1;
        return `(${shifted})`;
      });
      parts.push(`(${orParts.join(' OR ')})`);
      return;
    }

    if (v === null) { parts.push(`${col} IS NULL`); return; }

    if (typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp)) {
      for (const [op, val] of Object.entries(v)) {
        if (!['$in', '$nin', '$lt', '$lte', '$gt', '$gte', '$ne', '$exists', '$regex'].includes(op)) {
          throw new Error(`Unsupported query operator: ${op}`);
        }
        if (op === '$in') {
          if (!val?.length) { parts.push('FALSE'); return; }
          const phs = val.map(() => ph()).join(',');
          parts.push(`${col} IN (${phs})`);
          params.push(...val);
        } else if (op === '$nin') {
          if (!val?.length) return;
          const phs = val.map(() => ph()).join(',');
          parts.push(`${col} NOT IN (${phs})`);
          params.push(...val);
        } else if (op === '$lt')  { parts.push(`${col} < ${ph()}`);  params.push(val); }
        else if (op === '$lte')   { parts.push(`${col} <= ${ph()}`); params.push(val); }
        else if (op === '$gt')    { parts.push(`${col} > ${ph()}`);  params.push(val); }
        else if (op === '$gte')   { parts.push(`${col} >= ${ph()}`); params.push(val); }
        else if (op === '$ne')    { parts.push(`${col} != ${ph()}`); params.push(val); }
        else if (op === '$exists') { parts.push(val ? `${col} IS NOT NULL` : `${col} IS NULL`); }
        else if (op === '$regex') {
          const pattern = val instanceof RegExp ? val.source : val;
          parts.push(`${col} ILIKE ${ph()}`);
          params.push(`%${pattern}%`);
        }
      }
      return;
    }

    parts.push(`${col} = ${ph()}`);
    params.push(v);
  }

  for (const [k, v] of Object.entries(query)) processKey(k, v);
  return { sql: parts.length ? parts.join(' AND ') : 'TRUE', params };
}

// ── COLLECTION SINIFI ────────────────────────────────────────
class Collection {
  constructor(table) {
    this.table = table;
  }

  // ── Tek kayıt bul ────────────────────────────────────────
  async findOne(query = {}) {
    const { sql, params } = buildWhere(query);
    const q = `SELECT * FROM "${this.table}" WHERE ${sql} LIMIT 1`;
    const { rows } = await pool.query(q, params);
    return rows[0] ?? null;
  }

  // ── Çoklu kayıt — zincir API (SQLite uyumlu) ─────────────
  find(query = {}) {
    let _sort  = null;
    let _limit = null;
    const self = this;

    const exec = async () => {
      const { sql, params } = buildWhere(query);
      let q = `SELECT * FROM "${self.table}" WHERE ${sql}`;
      if (_sort) {
        const parts = Object.entries(_sort).map(
          ([k, d]) => `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? `"${k}"` : (() => { throw new Error(`Unsafe sort key: ${k}`); })()} ${d === -1 ? 'DESC' : 'ASC'}`
        );
        q += ` ORDER BY ${parts.join(', ')}`;
      }
      if (_limit) q += ` LIMIT ${parseInt(_limit)}`;
      const { rows } = await pool.query(q, params);
      return rows;
    };

    const chain = {
      sort(s)  { _sort  = s; return chain; },
      limit(n) { _limit = n; return chain; },
      then(res, rej) { return exec().then(res, rej); },
      [Symbol.asyncIterator]() {
        let done = false;
        return {
          async next() {
            if (done) return { done: true };
            done = true;
            return { value: await exec(), done: false };
          },
        };
      },
    };
    return chain;
  }

  // ── Ekle ────────────────────────────────────────────────
  async insert(doc) {
    if (!doc._id) doc._id = uuidv4();
    const keys   = Object.keys(doc);
    const cols   = keys.map(k => `"${k}"`).join(', ');
    const phs    = keys.map((_, i) => `$${i + 1}`).join(', ');
    const values = keys.map(k => {
      const v = doc[k];
      // JSONB kolonlar: nesne/dizi → pg driver otomatik serialize eder
      return v;
    });
    await pool.query(
      `INSERT INTO "${this.table}" (${cols}) VALUES (${phs})`,
      values
    );
    return doc;
  }

  // ── Güncelle ─────────────────────────────────────────────
  async update(query, update) {
    const { sql: wSql, params: wParams } = buildWhere(query);

    if (update.$set) {
      const keys   = Object.keys(update.$set);
      const setCls = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
      const vals   = keys.map(k => update.$set[k]);
      // WHERE parametreleri $set'in ardından gelir
      const wOffset = vals.length;
      const wShifted = wSql.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + wOffset}`);
      await pool.query(
        `UPDATE "${this.table}" SET ${setCls} WHERE ${wShifted}`,
        [...vals, ...wParams]
      );
    }

    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) {
        const wShifted = wSql.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + 1}`);
        await pool.query(
          `UPDATE "${this.table}" SET "${k}" = "${k}" + $1 WHERE ${wShifted}`,
          [v, ...wParams]
        );
      }
    }

    if (update.$push) {
      for (const [k, v] of Object.entries(update.$push)) {
        const wShifted = wSql.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + 1}`);
        await pool.query(
          `UPDATE "${this.table}" SET "${k}" = "${k}" || $1::jsonb WHERE ${wShifted}`,
          [JSON.stringify([v]), ...wParams]
        );
      }
    }

    return { updated: true };
  }

  // ── Sil ─────────────────────────────────────────────────
  async remove(query = {}) {
    const { sql, params } = buildWhere(query);
    const result = await pool.query(
      `DELETE FROM "${this.table}" WHERE ${sql}`,
      params
    );
    return { deleted: result.rowCount };
  }

  // ── Say ──────────────────────────────────────────────────
  async count(query = {}) {
    const { sql, params } = buildWhere(query);
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS n FROM "${this.table}" WHERE ${sql}`,
      params
    );
    return parseInt(rows[0].n);
  }

  ensureIndex() {} // No-op: indeksler schema'da tanımlı
}

// ── FTS (Full-Text Search) — Gelişmiş ────────────────────────
//
// Strateji (en iyiden fallback'e):
//   1. websearch_to_tsquery  → "merhaba dünya" -hariç +zorunlu gibi Discord-benzeri syntax
//   2. to_tsquery prefix     → kısmi kelime (merhab:* → merhaba eşleşir)
//   3. pg_trgm similarity    → typo toleransı (meraba → merhaba)
//   4. ILIKE                 → son çare fallback
//
// Skor hesabı:
//   ts_rank_cd: konum ağırlıklı rank (başta geçen → yüksek skor)
//   similarity bonus: trigram benzerliği skora eklenir
//   recency bonus: son 7 günlük mesajlara +0.1 bonus
//
async function ftsSearch(queryText, serverIds, limit = 50) {
  if (!queryText?.trim() || !serverIds?.length) return [];

  const q = queryText.trim();

  // ── 1. websearch_to_tsquery (tam özellikli arama) ─────────
  try {
    const { rows } = await pool.query(`
      SELECT m.*,
        ts_rank_cd(
          to_tsvector('simple', unaccent(coalesce(m.content,'') || ' ' || coalesce(m."displayName",''))),
          websearch_to_tsquery('simple', unaccent($2)),
          32  -- normalizasyon: belge uzunluğuna göre böl
        )
        + CASE WHEN m."createdAt" > (extract(epoch from now()-interval '7 days')*1000)::bigint
               THEN 0.1 ELSE 0 END
        AS _score
      FROM messages m
      WHERE m."serverId" = ANY($1)
        AND to_tsvector('simple', unaccent(coalesce(m.content,'') || ' ' || coalesce(m."displayName",'')))
            @@ websearch_to_tsquery('simple', unaccent($2))
      ORDER BY _score DESC, m."createdAt" DESC
      LIMIT $3
    `, [serverIds, q, limit]);

    if (rows.length > 0) return rows;
  } catch (_) { /* syntax hatası → fallback */ }

  // ── 2. Prefix arama (kısmi kelime desteği) ────────────────
  // "merha" → merhaba eşleşir
  try {
    const prefixQ = q
      .split(/\s+/)
      .filter(Boolean)
      .map(w => w.replace(/[^\w\u00C0-\u024F]/g, '') + ':*')
      .join(' & ');

    if (prefixQ) {
      const { rows } = await pool.query(`
        SELECT m.*,
          ts_rank_cd(
            to_tsvector('simple', unaccent(coalesce(m.content,'') || ' ' || coalesce(m."displayName",''))),
            to_tsquery('simple', unaccent($2)),
            32
          ) AS _score
        FROM messages m
        WHERE m."serverId" = ANY($1)
          AND to_tsvector('simple', unaccent(coalesce(m.content,'') || ' ' || coalesce(m."displayName",'')))
              @@ to_tsquery('simple', unaccent($2))
        ORDER BY _score DESC, m."createdAt" DESC
        LIMIT $3
      `, [serverIds, prefixQ, limit]);

      if (rows.length > 0) return rows;
    }
  } catch (_) { /* fallback */ }

  // ── 3. Trigram similarity (typo toleransı) ────────────────
  // "meraba" → "merhaba" bulur, pg_trgm kullanır
  try {
    const { rows } = await pool.query(`
      SELECT m.*, similarity(m.content, $2) AS _score
      FROM messages m
      WHERE m."serverId" = ANY($1)
        AND m.content % $2
      ORDER BY _score DESC, m."createdAt" DESC
      LIMIT $3
    `, [serverIds, q, limit]);

    if (rows.length > 0) return rows;
  } catch (_) { /* pg_trgm yüklü değilse fallback */ }

  // ── 4. ILIKE fallback (son çare) ──────────────────────────
  const escaped = q.replace(/[%_\\]/g, c => `\\${c}`);
  const { rows } = await pool.query(`
    SELECT m.*
    FROM messages m
    WHERE m."serverId" = ANY($1)
      AND m.content ILIKE $2
    ORDER BY m."createdAt" DESC
    LIMIT $3
  `, [serverIds, `%${escaped}%`, limit]);

  return rows;
}

// ── TRANSACTION HELPER ────────────────────────────────────────
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── SCHEMA BAŞLAT ─────────────────────────────────────────────
async function initSchema() {
  console.log('[DB] PostgreSQL schema başlatılıyor...');
  await pool.query(SCHEMA);

  // ── v78-fix: Mevcut production DB'lere eksik sütunları ekle ──
  const migrations = [
    // Extension'lar — IF NOT EXISTS ile güvenli
    `CREATE EXTENSION IF NOT EXISTS unaccent`,
    `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
    // FTS index'lerini yeniden oluştur (unaccent ile)
    `CREATE INDEX IF NOT EXISTS idx_messages_fts ON messages USING GIN(
      to_tsvector('simple', unaccent(coalesce(content,'') || ' ' || coalesce("displayName",'')))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_trgm ON messages USING GIN(content gin_trgm_ops)`,
    // dm_messages — reactions, e2e alanları
    `ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS reactions JSONB NOT NULL DEFAULT '{}'`,
    `ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS e2e BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS "isEncrypted" BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS "e2eData" JSONB`,
    // push_subscriptions — subscription JSONB → endpoint + keys ayrı sütunlar
    `ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS endpoint TEXT`,
    `ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS keys JSONB DEFAULT '{}'`,
    // Eski subscription JSONB sütununu taşı (endpoint henüz boşsa)
    `UPDATE push_subscriptions SET endpoint = subscription->>'endpoint', keys = subscription->'keys' WHERE endpoint IS NULL AND subscription IS NOT NULL`,
    // Index'ler
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_push_endpoint ON push_subscriptions(endpoint)`,
    `CREATE INDEX IF NOT EXISTS idx_nativepush_user ON native_push_tokens("userId")`,
    `CREATE INDEX IF NOT EXISTS idx_dm_messages_ts ON dm_messages("dmId", "createdAt" DESC)`,
  ];

  for (const sql of migrations) {
    try { await pool.query(sql); } catch (e) {
      if (!e.message.includes('already exists') && !e.message.includes('does not exist')) {
        console.warn('[DB] Migration uyarısı:', e.message.slice(0, 120));
      }
    }
  }

  // ── Eksik tablolar (v40-v78 arası eklenenler) ────────────────
  const extraTables = [
    `CREATE TABLE IF NOT EXISTS channel_permissions (
      _id TEXT PRIMARY KEY,
      "channelId" TEXT NOT NULL,
      "roleId" TEXT NOT NULL,
      "serverId" TEXT NOT NULL,
      allow INTEGER NOT NULL DEFAULT 0,
      deny INTEGER NOT NULL DEFAULT 0,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT,
      UNIQUE("channelId", "roleId")
    )`,
    `CREATE INDEX IF NOT EXISTS idx_chperms_channel ON channel_permissions("channelId")`,

    `CREATE TABLE IF NOT EXISTS group_dm_conversations (
      _id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      "ownerId" TEXT NOT NULL,
      icon TEXT,
      "createdAt" BIGINT NOT NULL,
      "lastMessageAt" BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS group_dm_members (
      _id TEXT PRIMARY KEY,
      "groupId" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "joinedAt" BIGINT NOT NULL,
      UNIQUE("groupId", "userId")
    )`,
    `CREATE TABLE IF NOT EXISTS group_dm_messages (
      _id TEXT PRIMARY KEY,
      "groupId" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "displayName" TEXT NOT NULL,
      "avatarColor" TEXT NOT NULL DEFAULT '#5865f2',
      content TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'normal',
      "fileUrl" TEXT,
      "fileName" TEXT,
      reactions JSONB NOT NULL DEFAULT '{}',
      "createdAt" BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_gdm_messages_group ON group_dm_messages("groupId", "createdAt" DESC)`,

    `CREATE TABLE IF NOT EXISTS reaction_roles (
      _id TEXT PRIMARY KEY,
      "serverId" TEXT NOT NULL,
      "channelId" TEXT NOT NULL,
      "messageId" TEXT NOT NULL,
      emoji TEXT NOT NULL,
      "roleId" TEXT NOT NULL,
      "createdBy" TEXT NOT NULL,
      "createdAt" BIGINT NOT NULL,
      UNIQUE("messageId", emoji, "roleId")
    )`,
    `CREATE INDEX IF NOT EXISTS idx_rr_message ON reaction_roles("messageId")`,

    `CREATE TABLE IF NOT EXISTS blocks (
      _id TEXT PRIMARY KEY,
      "blockerId" TEXT NOT NULL,
      "blockedId" TEXT NOT NULL,
      "createdAt" BIGINT NOT NULL,
      UNIQUE("blockerId", "blockedId")
    )`,
    `CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks("blockerId")`,

    `CREATE TABLE IF NOT EXISTS user_connections (
      _id TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      platform TEXT NOT NULL,
      username TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      "createdAt" BIGINT NOT NULL,
      UNIQUE("userId", platform)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_connections_user ON user_connections("userId")`,

    `CREATE TABLE IF NOT EXISTS fcm_tokens (
      _id TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      platform TEXT NOT NULL DEFAULT 'android',
      "createdAt" BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fcmtokens_user ON fcm_tokens("userId")`,

    `CREATE TABLE IF NOT EXISTS bot_ratings (
      _id TEXT PRIMARY KEY,
      "botId" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      rating INTEGER NOT NULL,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT,
      UNIQUE("botId", "userId")
    )`,
    `CREATE INDEX IF NOT EXISTS idx_botratings_bot ON bot_ratings("botId")`,

    `CREATE TABLE IF NOT EXISTS server_bots (
      _id TEXT PRIMARY KEY,
      "botId" TEXT NOT NULL,
      "serverId" TEXT NOT NULL,
      "addedBy" TEXT NOT NULL,
      "addedAt" BIGINT NOT NULL,
      UNIQUE("botId", "serverId")
    )`,
    `CREATE INDEX IF NOT EXISTS idx_serverbots_server ON server_bots("serverId")`,

    `CREATE TABLE IF NOT EXISTS outgoing_webhooks (
      _id TEXT PRIMARY KEY,
      "serverId" TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      events JSONB NOT NULL DEFAULT '["message:new"]',
      secret TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      "createdBy" TEXT NOT NULL,
      "createdAt" BIGINT NOT NULL,
      "lastFiredAt" BIGINT,
      "lastStatus" INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ogwh_server ON outgoing_webhooks("serverId")`,

    `CREATE TABLE IF NOT EXISTS server_onboarding (
      _id TEXT PRIMARY KEY,
      "serverId" TEXT NOT NULL UNIQUE,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      "rulesChannelId" TEXT,
      "welcomeChannelId" TEXT,
      "welcomeMessage" TEXT NOT NULL DEFAULT 'Sunucuya hoş geldin, {user}! 👋',
      "verificationLevel" INTEGER NOT NULL DEFAULT 0,
      "defaultRoles" JSONB NOT NULL DEFAULT '[]',
      questions JSONB NOT NULL DEFAULT '[]',
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT
    )`,

    `CREATE TABLE IF NOT EXISTS onboarding_completions (
      _id TEXT PRIMARY KEY,
      "serverId" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "completedAt" BIGINT NOT NULL,
      answers JSONB NOT NULL DEFAULT '{}',
      UNIQUE("serverId", "userId")
    )`,

    `CREATE TABLE IF NOT EXISTS automod_rules (
      _id TEXT PRIMARY KEY,
      "serverId" TEXT NOT NULL,
      type TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      config JSONB NOT NULL DEFAULT '{}',
      "createdBy" TEXT NOT NULL,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_automod_server ON automod_rules("serverId")`,

    `CREATE TABLE IF NOT EXISTS ap_follows (
      _id TEXT PRIMARY KEY,
      "actorUrl" TEXT NOT NULL,
      "targetUserId" TEXT NOT NULL,
      "activityId" TEXT,
      "createdAt" BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_apfollows_target ON ap_follows("targetUserId")`,

    `CREATE TABLE IF NOT EXISTS ap_activities (
      _id TEXT PRIMARY KEY,
      "targetUserId" TEXT NOT NULL,
      activity JSONB NOT NULL DEFAULT '{}',
      processed BOOLEAN NOT NULL DEFAULT FALSE,
      "createdAt" BIGINT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS ap_messages (
      _id TEXT PRIMARY KEY,
      "actorUrl" TEXT NOT NULL,
      "channelId" TEXT,
      content TEXT NOT NULL DEFAULT '',
      "apId" TEXT UNIQUE,
      "createdAt" BIGINT NOT NULL
    )`,

    // ActivityPub genişletilmiş tablolar
    `CREATE TABLE IF NOT EXISTS ap_outgoing_follows (
      _id TEXT PRIMARY KEY,
      "fromUserId" TEXT NOT NULL,
      "targetActorUrl" TEXT NOT NULL,
      "activityId" TEXT,
      accepted BOOLEAN NOT NULL DEFAULT FALSE,
      "acceptedAt" BIGINT,
      "createdAt" BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ap_outfollows_user ON ap_outgoing_follows("fromUserId")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_outfollows_unique ON ap_outgoing_follows("fromUserId", "targetActorUrl")`,

    `CREATE TABLE IF NOT EXISTS ap_likes (
      _id TEXT PRIMARY KEY,
      "actorUrl" TEXT,
      "fromUserId" TEXT,
      "objectUrl" TEXT NOT NULL,
      "targetUserId" TEXT,
      "createdAt" BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ap_likes_object ON ap_likes("objectUrl")`,

    `CREATE TABLE IF NOT EXISTS ap_announces (
      _id TEXT PRIMARY KEY,
      "actorUrl" TEXT,
      "fromUserId" TEXT,
      "objectUrl" TEXT NOT NULL,
      "targetUserId" TEXT,
      "createdAt" BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ap_announces_object ON ap_announces("objectUrl")`,

    // ap_follows — eksik kolonları ekle
    `ALTER TABLE ap_follows ADD COLUMN IF NOT EXISTS accepted BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE ap_follows ADD COLUMN IF NOT EXISTS "actorInbox" TEXT`,

    // ap_messages — zengin alan desteği
    `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS "targetUserId" TEXT`,
    `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS summary TEXT`,
    `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS sensitive BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS "inReplyTo" TEXT`,
    `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'`,
    `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'`,
    `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS published BIGINT`,
    `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS "updatedAt" BIGINT`,
    `CREATE INDEX IF NOT EXISTS idx_ap_messages_actor ON ap_messages("actorUrl")`,
    `CREATE INDEX IF NOT EXISTS idx_ap_messages_published ON ap_messages(published DESC NULLS LAST)`,

    // ap_activities — zengin alan desteği
    `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "actorUserId" TEXT`,
    `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS type TEXT`,
    `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "activityId" TEXT`,
    `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "noteId" TEXT`,
    `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "publishedAt" BIGINT`,
    `CREATE INDEX IF NOT EXISTS idx_ap_activities_actor ON ap_activities("actorUserId")`,
    `CREATE INDEX IF NOT EXISTS idx_ap_activities_type ON ap_activities(type)`,

    // notifications tablosu (AP + normal)
    `CREATE TABLE IF NOT EXISTS notifications (
      _id TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      type TEXT NOT NULL,
      "actorUrl" TEXT,
      "noteId" TEXT,
      "noteUrl" TEXT,
      read BOOLEAN NOT NULL DEFAULT FALSE,
      "createdAt" BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications("userId", "createdAt" DESC)`,

    // audit_logs ek kolonlar
    `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS "channelId" TEXT`,
    `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS "old" JSONB`,
    `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS "new" JSONB`,
    `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}'`,
    `CREATE INDEX IF NOT EXISTS idx_audit_server_channel ON audit_logs("serverId", "channelId")`,

    // messages ek kolonlar
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS embeds JSONB NOT NULL DEFAULT '[]'`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS components JSONB NOT NULL DEFAULT '[]'`,
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS "botId" TEXT`,

    // bots ek kolonlar
    `ALTER TABLE bots ADD COLUMN IF NOT EXISTS "isPublic" BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE bots ADD COLUMN IF NOT EXISTS description TEXT`,
    `ALTER TABLE bots ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'utility'`,
    `ALTER TABLE bots ADD COLUMN IF NOT EXISTS icon TEXT`,
    `ALTER TABLE bots ADD COLUMN IF NOT EXISTS "contextCommands" JSONB NOT NULL DEFAULT '[]'`,

    // WebAuthn passkey kimlik bilgileri
    `CREATE TABLE IF NOT EXISTS webauthn_credentials (
      _id TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "credentialId" TEXT NOT NULL UNIQUE,
      "publicKey" TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      "deviceType" TEXT NOT NULL DEFAULT 'unknown',
      transports JSONB NOT NULL DEFAULT '[]',
      name TEXT NOT NULL DEFAULT 'Passkey',
      "lastUsedAt" BIGINT,
      "createdAt" BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials("userId")`,
    `CREATE INDEX IF NOT EXISTS idx_webauthn_cred ON webauthn_credentials("credentialId")`,

    // Sprint 11 — link_preview_cache (TTL-bazlı embed önbellekleme)
    `CREATE TABLE IF NOT EXISTS link_preview_cache (
      url TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      "fetchedAt" BIGINT NOT NULL,
      "expiresAt" BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_lpcache_expires ON link_preview_cache("expiresAt")`,

    // Federasyon whitelist / blacklist
    `CREATE TABLE IF NOT EXISTS federation_whitelist (
      _id TEXT PRIMARY KEY,
      domain TEXT UNIQUE NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      "createdAt" BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS federation_blacklist (
      _id TEXT PRIMARY KEY,
      domain TEXT UNIQUE NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      "createdAt" BIGINT NOT NULL
    )`,

    // ActivityPub delivery queue (federation retry)
    `CREATE TABLE IF NOT EXISTS ap_delivery_queue (
      _id TEXT PRIMARY KEY,
      payload JSONB NOT NULL DEFAULT '{}',
      attempts INTEGER NOT NULL DEFAULT 0,
      "nextAt" BIGINT NOT NULL,
      "createdAt" BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_apqueue_nextat ON ap_delivery_queue("nextAt")`,

    // Podcast (Stage -> Podcast Yayınlama)
    `CREATE TABLE IF NOT EXISTS podcast_settings (
      _id TEXT PRIMARY KEY,
      "serverId" TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      "coverUrl" TEXT,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT
    )`,
    `CREATE TABLE IF NOT EXISTS podcast_episodes (
      _id TEXT PRIMARY KEY,
      "serverId" TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      "audioUrl" TEXT NOT NULL,
      duration INTEGER NOT NULL DEFAULT 0,
      "publishedAt" BIGINT,
      "createdAt" BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_podcast_episodes_server ON podcast_episodes("serverId", "createdAt" DESC)`,

    // Sunucu şablonları (v57+)
    `CREATE TABLE IF NOT EXISTS server_templates (
      _id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      "createdBy" TEXT NOT NULL,
      "isBuiltin" BOOLEAN NOT NULL DEFAULT FALSE,
      config JSONB NOT NULL DEFAULT '{}',
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT
    )`,
  ];

  for (const sql of extraTables) {
    try { await pool.query(sql); } catch (e) {
      if (!e.message.includes('already exists') && !e.message.includes('does not exist')) {
        console.warn('[DB] Extra table migration uyarısı:', e.message.slice(0, 120));
      }
    }
  }

  console.log('[DB] ✅ Schema hazır.');
}

// ── DB NESNESI (SQLite db/index.js ile aynı API) ─────────────
const TABLE_MAP = {
  users:              'users',
  servers:            'servers',
  channels:           'channels',
  messages:           'messages',
  members:            'members',
  invites:            'invites',
  roles:              'roles',
  dmConversations:    'dm_conversations',
  dmMessages:         'dm_messages',
  serverGifs:         'server_gifs',
  scheduledMsgs:      'scheduled_msgs',
  channelBridges:     'channel_bridges',
  refreshTokens:      'refresh_tokens',
  serverEmojis:       'server_emojis',
  polls:              'polls',
  soundboard:         'soundboard',
  friendships:        'friendships',
  channelCategories:  'channel_categories',
  notificationPrefs:  'notification_prefs',
  auditLogs:          'audit_logs',
  voiceMessages:      'voice_messages',
  threads:            'threads',
  threadMessages:     'thread_messages',
  bots:               'bots',
  webhooks:           'webhooks',
  channelOverrides:   'channel_overrides',
  unreadCounts:       'unread_counts',
  pushSubscriptions:  'push_subscriptions',
  federationPeers:    'federation_peers',
  adminLogs:          'admin_logs',
  // WebAuthn passkey credentials
  webauthnCredentials: 'webauthn_credentials',
  // Additional collections missing from earlier versions
  botRatings:         'bot_ratings',
  serverBots:         'server_bots',
  apFollows:          'ap_follows',
  apActivities:       'ap_activities',
  apMessages:         'ap_messages',
  apOutgoingFollows:  'ap_outgoing_follows',
  apLikes:            'ap_likes',
  apAnnounces:        'ap_announces',
  notifications:      'notifications',
  reactionRoles:      'reaction_roles',
  blocks:             'blocks',
  userConnections:    'user_connections',
  groupDmConversations: 'group_dm_conversations',
  groupDmMembers:     'group_dm_members',
  groupDmMessages:    'group_dm_messages',
  automodRules:       'automod_rules',
  outgoingWebhooks:   'outgoing_webhooks',
  serverOnboarding:   'server_onboarding',
  onboardingCompletions: 'onboarding_completions',
  podcastSettings:    'podcast_settings',
  podcastEpisodes:    'podcast_episodes',
  federationWhitelist: 'federation_whitelist',
  federationBlacklist: 'federation_blacklist',
  fcmTokens:          'fcm_tokens',
  nativePushTokens:   'native_push_tokens',
  channelPermissions: 'channel_permissions',
  apDeliveryQueue:    'ap_delivery_queue',
  serverTemplates:    'server_templates',
};

const db = {};
for (const [key, table] of Object.entries(TABLE_MAP)) {
  db[key] = new Collection(table);
}

// Özel metodlar
db._pool        = pool;
db._ftsSearch   = ftsSearch;
db._transaction = withTransaction;
db._initSchema  = initSchema;

// SQLite uyumluluk takma adları
db._sqlite = null; // PostgreSQL'de yok — kullanan yerlerde kontrol et

module.exports = db;

// ── İLK ÇALIŞMA: schema kur ───────────────────────────────────
// server/index.js'de `await db._initSchema()` çağır
// YA DA bu dosyayı doğrudan çalıştır: node db/postgres.js
if (require.main === module) {
  initSchema()
    .then(() => { console.log('Schema kuruldu.'); process.exit(0); })
    .catch(err => { console.error('Schema hatası:', err); process.exit(1); });
}
export {};
