// @ts-nocheck
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const dataDir = path.join(__dirname, '../data');
const dbPath = path.join(dataDir, 'bridge.db');
const migrationsDir = path.join(__dirname, 'migrations');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(migrationsDir)) fs.mkdirSync(migrationsDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`);

const appliedRows = db.prepare('SELECT id FROM schema_migrations').all();
const applied = new Set(appliedRows.map((row) => row.id));
const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();

const command = process.argv[2] || 'up';
if (!['up', 'status'].includes(command)) {
  process.stderr.write('Usage: node db/migrate.js [up|status]\n');
  process.exit(1);
}

if (command === 'status') {
  for (const file of files) {
    process.stdout.write(`${applied.has(file) ? 'applied' : 'pending'} ${file}\n`);
  }
  process.stdout.write('Status completed.\n');
  process.exit(0);
}

for (const file of files) {
  if (applied.has(file)) continue;
  const fullPath = path.join(migrationsDir, file);
  const sql = fs.readFileSync(fullPath, 'utf8');

  // Her SQL ifadesini ayrı ayrı çalıştır.
  // ALTER TABLE gibi "duplicate column name" hatası verebilecek ifadeler
  // tüm transaction'ı bloklamamalı — idempotency için yok sayılır.
  // Boş ifadeler ve yorum satırları atlanır.
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));

  const tx = db.transaction(() => {
    for (const stmt of statements) {
      try {
        db.exec(stmt + ';');
      } catch (err) {
        const msg = (err && err.message) ? err.message : String(err);
        if (
          msg.includes('duplicate column name') ||
          msg.includes('already exists')
        ) {
          // Idempotent — kolon/tablo zaten mevcut, devam et
          process.stdout.write(`  [skip idempotent] ${msg}\n`);
        } else {
          throw err;
        }
      }
    }
    db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(file, Date.now());
  });
  tx();
  process.stdout.write(`Applied migration: ${file}\n`);
}

process.stdout.write('Migration run completed.\n');
