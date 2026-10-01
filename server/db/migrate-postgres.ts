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
import {
  appliedMigrations,
  applyPendingMigrations,
  ensureMigrationsTable,
  listMigrationFiles,
  MigrationFailedError,
  type MigrationQueryable,
} from './postgres/versionedMigrations';

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

  // P5: one implementation of "which files, which are applied, apply them" —
  // shared with the boot path (db/postgres/versionedMigrations.ts).
  const upFiles = listMigrationFiles(migrationsDir);

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  await ensureMigrationsTable(client as unknown as MigrationQueryable);

  const appliedList = await appliedMigrations(client as unknown as MigrationQueryable);
  const applied     = new Set(appliedList);

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
    let count: number;
    try {
      count = (await applyPendingMigrations(client as unknown as MigrationQueryable, {
        dir: migrationsDir,
        onApplied: (file) => process.stdout.write(`✅ Applied: ${file}\n`),
      })).length;
    } catch (err) {
      if (err instanceof MigrationFailedError) process.stderr.write(`❌ Failed: ${err.migration}\n`);
      await client.end().catch(() => undefined);
      throw err;
    }
    if (count === 0) process.stdout.write('Uygulanacak migration yok.\n');
    await client.end();
    process.stdout.write(`Migration tamamlandı. (${count} yeni)\n`);
    return;
  }

  // ── DOWN / ROLLBACK ──────────────────────────────────────────────────────────
  const stepsRaw = process.argv[3] ?? '1';
  const steps = command === 'rollback' && /^(?:[1-9]\d*)$/.test(stepsRaw)
    ? Number(stepsRaw)
    : command === 'down' ? 1 : NaN;
  if (!Number.isSafeInteger(steps) || steps < 1) {
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
      // Fail closed: never skip a newer applied migration and then roll back an
      // older one. That would create a schema state no forward chain reproduces.
      process.stderr.write(
        `❌ DOWN script yok: ${downFile}\n` +
        `   Rollback durduruldu; ${migration} ve daha eski migration'lara dokunulmadı.\n`,
      );
      await client.end();
      process.exitCode = 1;
      return;
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
