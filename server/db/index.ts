// @ts-nocheck
// server/db/index.js — SQLite entrypoint (modularized)

const { sqlite } = require('./sqlite/connection');
const { Collection } = require('./sqlite/collection');
const { applyBootstrapSchema, applyFeatureMigrations } = require('./sqlite/migrations');

applyBootstrapSchema(sqlite);

const TABLE_MAP = {
  users: 'users',
  servers: 'servers',
  channels: 'channels',
  messages: 'messages',
  members: 'members',
  invites: 'invites',
  roles: 'roles',
  dmConversations: 'dm_conversations',
  dmMessages: 'dm_messages',
  serverGifs: 'server_gifs',
  scheduledMsgs: 'scheduled_msgs',
  channelBridges: 'channel_bridges',
  refreshTokens: 'refresh_tokens',
  serverEmojis: 'server_emojis',
  polls: 'polls',
  soundboard: 'soundboard',
};

const db = {};
for (const [key, table] of Object.entries(TABLE_MAP)) {
  db[key] = new Collection(sqlite, table);
}

db._sqlite = sqlite;

// SQLite FTS5 support
const { setupFTS, ftsSearch } = require('./fts');
setupFTS(sqlite);
db._ftsSearch = (searchTerm, serverIds, limit) => ftsSearch(sqlite, searchTerm, serverIds, limit);

// ── TRANSACTION HELPER ────────────────────────────────────────
// PostgreSQL adapter'daki db._transaction ile aynı API.
// better-sqlite3 transaction'ları senkron — fn senkron olmalıdır.
// Async fn geçilirse hata fırlatılır.
//
// Kullanım:
//   db._transaction((tx) => {
//     tx.messages.insert({ ... });
//     tx.channels.updateOne({ ... }, { ... });
//   });
//
// fn hata fırlatırsa otomatik ROLLBACK yapılır.
db._transaction = function withTransaction(fn) {
  // better-sqlite3 native transaction wrapper
  const txFn = sqlite.transaction(() => {
    // tx: db ile aynı API'yi sunar ama _sqlite referansını da taşır
    return fn(db);
  });
  return txFn();
};

applyFeatureMigrations(sqlite, db, Collection);

module.exports = db;
export {};
