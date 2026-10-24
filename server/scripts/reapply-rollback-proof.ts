// server/scripts/reapply-rollback-proof.ts
//
// Test-only ordered migration replay for verify-migration-rollback.js.
// A real production CLI migration always executes verifyUpgradeSource first.
// A rollback proof deliberately creates a partially rolled-back schema; the
// production safety guard must reject that schema. The proof still needs to
// measure the complete down/up SQL chain without relaxing the production guard.
//
// Reuse the SAME canonical versioned migration applicator, only on a throwaway
// proof database with a positively verified, reserved name.
import { Client } from 'pg';
import path from 'path';
import { applyPendingMigrations } from '../db/postgres/versionedMigrations';

export function assertRollbackProofTarget(raw: string | undefined, nodeEnv: string | undefined): string {
  if (nodeEnv !== 'test' || !raw) {
    throw new Error('ROLLBACK_PROOF_ONLY: test environment and DATABASE_URL required');
  }
  const url = new URL(raw);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!/^bridge_rollback_proof_[a-z0-9_]+$/.test(databaseName) || databaseName.length > 63) {
    throw new Error('ROLLBACK_PROOF_ONLY: refusing to replay migrations outside a reserved throwaway proof database');
  }

  return raw;
}

async function main(): Promise<void> {
  const raw = assertRollbackProofTarget(process.env.DATABASE_URL, process.env.NODE_ENV);
  const client = new Client({ connectionString: raw });
  await client.connect();
  try {
    const applied = await applyPendingMigrations(client, {
      dir: path.join(__dirname, '..', 'db', 'migrations_pg'),
    });
    process.stdout.write(`Rollback proof re-applied ${applied.length} ordered migrations.\n`);
  } finally {
    await client.end();
  }
}

if (require.main === module) main().catch((err: Error) => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
