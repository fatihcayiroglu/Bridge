// server/db/fts.js: FTS5 full-text search setup & helpers
// Called once at startup by db/index.js

function setupFTS(sqlite) {
  // Create FTS5 virtual table for messages
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      _id UNINDEXED,
      content,
      channelId UNINDEXED,
      serverId UNINDEXED,
      userId UNINDEXED,
      displayName,
      createdAt UNINDEXED,
      content='messages',
      content_rowid='rowid'
    );

    -- Triggers to keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, _id, content, channelId, serverId, userId, displayName, createdAt)
      VALUES (new.rowid, new._id, new.content, new.channelId, new.serverId, new.userId, new.displayName, new.createdAt);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, _id, content, channelId, serverId, userId, displayName, createdAt)
      VALUES ('delete', old.rowid, old._id, old.content, old.channelId, old.serverId, old.userId, old.displayName, old.createdAt);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, _id, content, channelId, serverId, userId, displayName, createdAt)
      VALUES ('delete', old.rowid, old._id, old.content, old.channelId, old.serverId, old.userId, old.displayName, old.createdAt);
      INSERT INTO messages_fts(rowid, _id, content, channelId, serverId, userId, displayName, createdAt)
      VALUES (new.rowid, new._id, new.content, new.channelId, new.serverId, new.userId, new.displayName, new.createdAt);
    END;
  `);

  // Backfill existing messages into FTS (safe to run multiple times — INSERT OR IGNORE)
  sqlite.exec(`
    INSERT OR IGNORE INTO messages_fts(rowid, _id, content, channelId, serverId, userId, displayName, createdAt)
    SELECT rowid, _id, content, channelId, serverId, userId, displayName, createdAt FROM messages
    WHERE content != '';
  `);
}

/**
 * Full-text search across messages the user has access to.
 * @param {object} sqlite   - raw better-sqlite3 instance
 * @param {string} query    - search term
 * @param {string[]} serverIds - servers the user is a member of
 * @param {number} limit
 * @returns {object[]} matching message rows
 */
function ftsSearch(sqlite, query, serverIds, limit = 20) {
  if (!serverIds.length) return [];
  // Sanitize query for FTS5 — escape double quotes
  const safeQ = query.replace(/"/g, '""');
  const placeholders = serverIds.map(() => '?').join(',');
  try {
    return sqlite.prepare(`
      SELECT m.*
      FROM messages m
      JOIN messages_fts fts ON m._id = fts._id
      WHERE messages_fts MATCH ?
        AND m.serverId IN (${placeholders})
      ORDER BY rank
      LIMIT ?
    `).all(`"${safeQ}"`, ...serverIds, limit);
  } catch {
    // Fallback to LIKE if FTS query is malformed (e.g. special chars)
    return sqlite.prepare(`
      SELECT * FROM messages
      WHERE content LIKE ? AND serverId IN (${placeholders})
      ORDER BY createdAt DESC
      LIMIT ?
    `).all(`%${query.replace(/[%_]/g, c => `\\${c}`)}%`, ...serverIds, limit);
  }
}

module.exports = { setupFTS, ftsSearch };
export {};
