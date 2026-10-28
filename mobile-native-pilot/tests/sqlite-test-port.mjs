// Real Node SQLite for persistence semantics ONLY; not an encryption oracle.
// SQLCipher presence is injected here. Native CI independently checks the actual
// SQLCipher implementation and Android process restart, without this adapter.
import { DatabaseSync } from 'node:sqlite';
export function sqliteTestPort(path, cipher = true) {
  const db = new DatabaseSync(path);
  return {
    async getFirstAsync(sql, ...params) { if (sql === 'PRAGMA cipher_version') return cipher ? { cipher_version: 'SEMANTICS_TEST_DOUBLE_NOT_ENCRYPTION' } : null; return db.prepare(sql).get(...params) ?? null; },
    async getAllAsync(sql, ...params) { return db.prepare(sql).all(...params); },
    async runAsync(sql, ...params) { return db.prepare(sql).run(...params); },
    async execAsync(sql) { db.exec(sql); },
    async closeAsync() { db.close(); },
  };
}
