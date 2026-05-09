const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
  const command = process.argv[2] || 'up';
  if (!['up', 'status'].includes(command)) {
    process.stderr.write('Usage: node db/migrate-postgres.js [up|status]\n');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    process.stderr.write('DATABASE_URL is required for PostgreSQL migrations.\n');
    process.exit(1);
  }

  const migrationsDir = path.join(__dirname, 'migrations_pg');
  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at BIGINT NOT NULL
    );
  `);

  const appliedRes = await client.query('SELECT id FROM schema_migrations');
  const applied = new Set(appliedRes.rows.map((row) => row.id));

  if (command === 'status') {
    for (const file of files) process.stdout.write(`${applied.has(file) ? 'applied' : 'pending'} ${file}\n`);
    await client.end();
    process.stdout.write('Status completed.\n');
    return;
  }

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)', [file, Date.now()]);
      await client.query('COMMIT');
      process.stdout.write(`Applied migration: ${file}\n`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  await client.end();
  process.stdout.write('PostgreSQL migration run completed.\n');
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
export {};
