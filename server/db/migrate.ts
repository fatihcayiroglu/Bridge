const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

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
  const tx = db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(file, Date.now());
  });
  tx();
  process.stdout.write(`Applied migration: ${file}\n`);
}

process.stdout.write('Migration run completed.\n');
export {};
