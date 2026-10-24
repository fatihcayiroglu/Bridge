// Refuse unverified in-place upgrades before the boot schema pass or migration CLI
// mutates an existing installation. See docs/P7_D3_RELEASE_UPGRADE_PATH.md.
//
// v1.122.0 booted without the numbered chain. The current schema pass fails
// against it before its column-adding migrations can run; running the chain
// first fails at 046 and can leave a partially upgraded database. A staged,
// backed-up, reconciled and rollback-tested upgrader must replace this guard
// before that source can be admitted.
import type { MigrationQueryable } from './versionedMigrations';

interface UpgradeSourceMarkers extends Record<string, unknown> {
  hasUsers: boolean;
  hasMessages: boolean;
  hasMigrationsTable: boolean;
  hasSsoProvider: boolean;
  hasAckId: boolean;
  hasNullableEmbeds: boolean;
}

// Exactly one read-only statement. Use the same current_schema() as unqualified
// boot DDL; never infer installation compatibility from a version string alone.
export const UPGRADE_SOURCE_MARKERS_SQL = `
  SELECT
    to_regclass(format('%I.%I', current_schema(), 'users')) IS NOT NULL AS "hasUsers",
    to_regclass(format('%I.%I', current_schema(), 'messages')) IS NOT NULL AS "hasMessages",
    to_regclass(format('%I.%I', current_schema(), 'schema_migrations')) IS NOT NULL AS "hasMigrationsTable",
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'users' AND column_name = 'ssoProvider'
    ) AS "hasSsoProvider",
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'messages' AND column_name = 'ackId'
    ) AS "hasAckId",
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'messages' AND column_name = 'embeds'
        AND is_nullable = 'YES'
    ) AS "hasNullableEmbeds"
`;

export class UnverifiedUpgradeSourceError extends Error {
  readonly code = 'BRIDGE_UPGRADE_SOURCE_UNVERIFIED';

  constructor(missing: readonly string[]) {
    super(
      'BRIDGE_UPGRADE_SOURCE_UNVERIFIED: existing PostgreSQL schema is missing ' +
      'required current-schema markers (' + missing.join(', ') + '). ' +
      'No upgrade is attempted. Back up the database and follow a verified ' +
      'staged migration with schema reconciliation and recovery evidence; ' +
      'v1.122.0 and incomplete legacy installations are not yet approved for ' +
      'in-place upgrade. See docs/P7_D3_RELEASE_UPGRADE_PATH.md.',
    );
    this.name = 'UnverifiedUpgradeSourceError';
  }
}

/** Run under the boot advisory lock and before ANY DDL or inline migration. */
export async function verifyUpgradeSource(q: MigrationQueryable): Promise<void> {
  const result = await q.query<UpgradeSourceMarkers>(UPGRADE_SOURCE_MARKERS_SQL);
  if (result.rows.length !== 1) {
    throw new Error('BRIDGE_UPGRADE_SOURCE_UNVERIFIED: PostgreSQL schema probe returned no unique row.');
  }
  const markers = result.rows[0];

  // A new database has neither base table. The normal new-install path owns it.
  if (!markers.hasUsers && !markers.hasMessages) return;

  // Reject partial and legacy schema shapes without touching the migration
  // ledger. A successful partial CLI run can add both sentinel columns, so
  // the ledger must also prove a fully applied, reviewed 084 baseline.
  const missing: string[] = [];
  if (!markers.hasUsers) missing.push('users table');
  if (!markers.hasMessages) missing.push('messages table');
  if (!markers.hasSsoProvider) missing.push('users.ssoProvider');
  if (!markers.hasAckId) missing.push('messages.ackId');
  // The measured staged v1.122.0 attempt can reach migration 084 but retains
  // messages.embeds NOT NULL; a fresh/current baseline is nullable.
  if (!markers.hasNullableEmbeds) missing.push('messages.embeds nullable');
  if (!markers.hasMigrationsTable) missing.push('schema_migrations table');
  if (missing.length) throw new UnverifiedUpgradeSourceError(missing);

  // 084 is the exact previous-main baseline measured by the P7-D3 release
  // probe. A v1.122.0 CLI attempt can leave 001–045 recorded and still be
  // incompatible at 046; the two column checks alone would not catch it.
  const baseline = await q.query<{ applied: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM schema_migrations " +
    "WHERE split_part(id, '_', 1) = '084' AND rolled_back = FALSE) AS applied",
  );
  if (baseline.rows.length !== 1 || baseline.rows[0].applied !== true) {
    throw new UnverifiedUpgradeSourceError(['applied migration 084 baseline']);
  }
}
