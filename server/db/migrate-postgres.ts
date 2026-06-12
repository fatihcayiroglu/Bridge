// server/db/migrate-postgres.ts
// Sprint 38: `down` + `rollback` komutları eklendi.
//
// Kullanım:
//   node db/migrate-postgres.js up          — bekleyen tüm migration'ları uygula
//   node db/migrate-postgres.js status      — uygulanan/bekleyen listesi
//   node db/migrate-postgres.js down        — en son uygulanan migration'ı geri al (1 adım)
//   node db/migrate-postgres.js rollback 3  — son N migration'ı geri al
//
// DOWN script'leri: server/db/migrations_pg/rollback/<name>.down.sql

import fs   from 'fs';
import path from 'path';
import { Client } from 'pg';

const COMMANDS = ['up', 'status', 'down', 'rollback'] as const;
type Command = (typeof COMMANDS)[number];

async function main(): Promise<void> {
  const command = (process.argv[2] ?? 'up') as Command;
  if (!(COMMANDS as readonly string[]).includes(command)) {
    process.stderr.write(`Usage: node db/migrate-postgres.js [${COMMANDS.join('|')}] [steps]\n`);
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    process.stderr.write('DATABASE_URL is required for PostgreSQL migrations.\n');
    process.exit(1);
  }

  const migrationsDir = path.join(__dirname, 'migrations_pg');
  const rollbackDir   = path.join(migrationsDir, 'rollback');

  const upFiles = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT    PRIMARY KEY,
      applied_at  BIGINT  NOT NULL,
      rolled_back BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);

  // Eski tablo uyumu: rolled_back kolonu yoksa ekle
  await client.query(`
    ALTER TABLE schema_migrations
      ADD COLUMN IF NOT EXISTS rolled_back BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  const appliedRes = await client.query<{ id: string }>(
    'SELECT id FROM schema_migrations WHERE rolled_back = FALSE ORDER BY applied_at ASC',
  );
  const applied     = new Set(appliedRes.rows.map((r) => r.id));
  const appliedList = appliedRes.rows.map((r) => r.id);

  // ── STATUS ──────────────────────────────────────────────────────────────────
  if (command === 'status') {
    process.stdout.write('Migration durumu:\n');
    for (const file of upFiles) {
      const tag = applied.has(file) ? '✅ applied' : '⏳ pending';
      process.stdout.write(`  ${tag}  ${file}\n`);
    }
    const pending = upFiles.filter((f) => !applied.has(f));
    process.stdout.write(`\nToplam: ${upFiles.length} | Uygulanmış: ${applied.size} | Bekleyen: ${pending.length}\n`);
    await client.end();
    return;
  }

  // ── UP ──────────────────────────────────────────────────────────────────────
  if (command === 'up') {
    let count = 0;
    for (const file of upFiles) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (id, applied_at, rolled_back) VALUES ($1, $2, FALSE) ' +
          'ON CONFLICT (id) DO UPDATE SET rolled_back = FALSE, applied_at = $2',
          [file, Date.now()],
        );
        await client.query('COMMIT');
        process.stdout.write(`✅ Applied: ${file}\n`);
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        process.stderr.write(`❌ Failed: ${file}\n`);
        throw err;
      }
    }
    if (count === 0) process.stdout.write('Uygulanacak migration yok.\n');
    await client.end();
    process.stdout.write(`Migration tamamlandı. (${count} yeni)\n`);
    return;
  }

  // ── DOWN / ROLLBACK ──────────────────────────────────────────────────────────
  const steps = command === 'rollback' ? parseInt(process.argv[3] ?? '1', 10) : 1;
  if (isNaN(steps) || steps < 1) {
    process.stderr.write('rollback için geçerli adım sayısı girin (örn: rollback 2)\n');
    process.exit(1);
  }

  if (appliedList.length === 0) {
    process.stdout.write('Geri alınacak migration yok.\n');
    await client.end();
    return;
  }

  if (!fs.existsSync(rollbackDir)) {
    process.stderr.write(
      `❌ Rollback klasörü bulunamadı: ${rollbackDir}\n` +
      '   server/db/migrations_pg/rollback/ klasörü oluşturulup .down.sql dosyaları eklenmeli.\n',
    );
    process.exit(1);
  }

  const toRollback = [...appliedList].reverse().slice(0, steps);

  let count = 0;
  for (const migration of toRollback) {
    const baseName = migration.replace(/\.sql$/, '');
    const downFile = path.join(rollbackDir, `${baseName}.down.sql`);

    if (!fs.existsSync(downFile)) {
      process.stderr.write(
        `⚠️  DOWN script yok: ${downFile}\n` +
        `   ${migration} için rollback desteği yok — atlanıyor.\n`,
      );
      continue;
    }

    const sql = fs.readFileSync(downFile, 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'UPDATE schema_migrations SET rolled_back = TRUE WHERE id = $1',
        [migration],
      );
      await client.query('COMMIT');
      process.stdout.write(`🔄 Rolled back: ${migration}\n`);
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      process.stderr.write(`❌ Rollback başarısız: ${migration}\n`);
      throw err;
    }
  }

  await client.end();
  process.stdout.write(`Rollback tamamlandı. (${count} migration geri alındı)\n`);
}

main().catch((err: Error) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
