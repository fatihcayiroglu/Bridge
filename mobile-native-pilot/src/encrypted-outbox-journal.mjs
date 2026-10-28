// One SQLCipher connection and one serialized owner per account database.
// No plaintext fallback. Sending state is committed BEFORE external emission.
export async function createEncryptedOutboxJournal({ db, keyHex }) {
  if (typeof keyHex !== 'string' || !/^[a-f0-9]{64}$/.test(keyHex)) throw new Error('INVALID_DATABASE_KEY');
  const cipher = await db.getFirstAsync('PRAGMA cipher_version');
  if (!cipher || typeof cipher.cipher_version !== 'string' || !cipher.cipher_version) throw new Error('SQLCIPHER_REQUIRED');
  await db.execAsync(`PRAGMA key = "x'${keyHex}'"`);
  // A wrong key fails this read before any schema/data mutation.
  const version = await db.getFirstAsync('PRAGMA user_version');
  if (version.user_version > 1) throw new Error('UNSUPPORTED_DATABASE_VERSION');
  await db.execAsync('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, message_id TEXT); PRAGMA user_version = 1;');
  let chain = Promise.resolve(), closed = false;
  function serialize(work) {
    if (closed) return Promise.reject(new Error('JOURNAL_CLOSED'));
    const result = chain.then(work); chain = result.catch(() => {}); return result;
  }
  const unpack = row => ({ ...JSON.parse(row.payload), id: row.id, status: row.status, ...(row.message_id ? { messageId: row.message_id } : {}) });
  // A killed process cannot know whether the server persisted a sending row.
  // Preserve id/payload and require explicit same-ID replay after restoration.
  await db.runAsync("UPDATE outbox SET status = 'unconfirmed' WHERE status = 'sending'");
  return Object.freeze({
    list: () => serialize(async () => (await db.getAllAsync('SELECT * FROM outbox ORDER BY seq')).map(unpack)),
    append(input) {
      return serialize(async () => {
        const { id, serverId, channelId, content } = input;
        if (![id, serverId, channelId].every(v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(v)) || id.length > 64 || typeof content !== 'string' || !content.trim() || content.length > 4000) throw new Error('INVALID_MESSAGE');
        const payload = JSON.stringify({ serverId, channelId, content });
        const prior = await db.getFirstAsync('SELECT * FROM outbox WHERE id = ?', id);
        if (prior) { if (prior.payload !== payload) throw new Error('IDEMPOTENCY_CONFLICT'); return unpack(prior); }
        const count = await db.getFirstAsync('SELECT count(*) AS count FROM outbox');
        if (count.count >= 100) throw new Error('OUTBOX_FULL');
        await db.runAsync("INSERT INTO outbox (id, payload, status) VALUES (?, ?, 'queued')", id, payload);
        return { id, serverId, channelId, content, status: 'queued' };
      });
    },
    mark(id, status, messageId = null) {
      return serialize(async () => {
        if (!['queued', 'sending', 'unconfirmed', 'failed', 'confirmed'].includes(status) ||
            (status === 'confirmed' && (typeof messageId !== 'string' || !messageId))) throw new Error('INVALID_STATUS');
        const prior = await db.getFirstAsync('SELECT * FROM outbox WHERE id = ?', id);
        if (!prior) throw new Error('UNKNOWN_MESSAGE');
        const transitions = { queued: ['sending'], sending: ['confirmed', 'unconfirmed', 'failed'], unconfirmed: ['queued'], failed: ['queued'], confirmed: [] };
        if (!transitions[prior.status]?.includes(status)) throw new Error('INVALID_TRANSITION');
        const result = await db.runAsync('UPDATE outbox SET status = ?, message_id = ? WHERE id = ?', status, messageId, id);
        if (result.changes !== 1) throw new Error('UNKNOWN_MESSAGE');
      });
    },
    remove: id => serialize(async () => {
      const row = await db.getFirstAsync('SELECT * FROM outbox WHERE id = ?', id);
      if (row && !['queued', 'confirmed'].includes(row.status)) throw new Error('OUTCOME_UNRESOLVED');
      await db.runAsync('DELETE FROM outbox WHERE id = ?', id);
    }),
    // Release only receipts that have already been acknowledged and durably
    // marked confirmed. Neither unsent drafts nor unknown-outcome sends may
    // be evicted to make space. The owner serializes this with all other writes.
    pruneConfirmed(max = 25) {
      return serialize(async () => {
        if (!Number.isInteger(max) || max < 0 || max > 100) throw new Error('INVALID_PRUNE_LIMIT');
        if (max === 0) return [];
        const oldest = await db.getAllAsync("SELECT id FROM outbox WHERE status = 'confirmed' ORDER BY seq LIMIT ?", max);
        if (oldest.length === 0) return [];
        const ids = oldest.map(row => row.id);
        const params = ids.map(() => '?').join(', ');
        const result = await db.runAsync(`DELETE FROM outbox WHERE status = 'confirmed' AND id IN (${params})`, ...ids);
        if (result.changes !== ids.length) throw new Error('RECEIPT_PRUNE_INCONSISTENT');
        return ids;
      });
    },
    async close() { if (closed) return; closed = true; await chain; await db.closeAsync(); },
  });
}
