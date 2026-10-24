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
  hasSsoProvider: boolean;
  hasAckId: boolean;
}

// Exactly one read-only statement. Use the same current_schema() as unqualified
// boot DDL; never infer installation compatibility from a version string alone.
export const UPGRADE_SOURCE_MARKERS_SQL = `
  SELECT
    to_regclass(format('%I.%I', current_schema(), 'users')) IS NOT NULL AS "hasUsers",
    to_regclass(format('%I.%I', current_schema(), 'messages')) IS NOT NULL AS "hasMessages",
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'users' AND column_name = 'ssoProvider'
    ) AS "hasSsoProvider",
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'messages' AND column_name = 'ackId'
    ) AS "hasAckId"
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

  // A current installation has both base tables and the two columns that
  // distinguish it from the measured, incompatible v1.122.0 boot-only schema.
  if (markers.hasUsers && markers.hasMessages && markers.hasSsoProvider && markers.hasAckId) return;

  const missing: string[] = [];
  if (!markers.hasUsers) missing.push('users table');
  if (!markers.hasMessages) missing.push('messages table');
  if (!markers.hasSsoProvider) missing.push('users.ssoProvider');
  if (!markers.hasAckId) missing.push('messages.ackId');
  throw new UnverifiedUpgradeSourceError(missing);
}
