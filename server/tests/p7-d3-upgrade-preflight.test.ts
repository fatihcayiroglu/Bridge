import type { MigrationQueryable } from '../db/postgres/versionedMigrations';
import {
  UnverifiedUpgradeSourceError,
  UPGRADE_SOURCE_MARKERS_SQL,
  verifyUpgradeSource,
} from '../db/postgres/upgradePreflight';

type Markers = {
  hasUsers: boolean;
  hasMessages: boolean;
  hasMigrationsTable: boolean;
  hasSsoProvider: boolean;
  hasAckId: boolean;
};

const fresh: Markers = {
  hasUsers: false, hasMessages: false, hasMigrationsTable: false,
  hasSsoProvider: false, hasAckId: false,
};
const current: Markers = {
  hasUsers: true, hasMessages: true, hasMigrationsTable: true,
  hasSsoProvider: true, hasAckId: true,
};

function probe(markers: Markers, baseline084 = true) {
  const query = jest.fn(async (sql: string) =>
    sql.includes('FROM schema_migrations')
      ? { rows: [{ applied: baseline084 }] }
      : { rows: [markers] });
  return { query, client: { query } as unknown as MigrationQueryable };
}

describe('P7 D3 upgrade source: fail closed before any mutation', () => {
  it('allows a genuinely empty database without starting a migration itself', async () => {
    const q = probe(fresh);
    await expect(verifyUpgradeSource(q.client)).resolves.toBeUndefined();
    expect(q.query).toHaveBeenCalledTimes(1);
    expect(q.query.mock.calls[0][0].trim()).toMatch(/^SELECT\s/i);
  });

  it('allows only an existing reviewed 084-or-later baseline with required columns', async () => {
    const q = probe(current);
    await expect(verifyUpgradeSource(q.client)).resolves.toBeUndefined();
    expect(q.query).toHaveBeenCalledTimes(2);
    expect(q.query.mock.calls.every((call) => call[0].trim().startsWith('SELECT'))).toBe(true);
    expect(q.query.mock.calls[1][0]).toContain("split_part(id, '_', 1) = '084'");
  });

  it('refuses the measured v1.122.0 boot-only shape before any DDL', async () => {
    const q = probe({ ...current, hasMigrationsTable: false, hasSsoProvider: false, hasAckId: false });
    await expect(verifyUpgradeSource(q.client)).rejects.toMatchObject({
      name: 'UnverifiedUpgradeSourceError',
      code: 'BRIDGE_UPGRADE_SOURCE_UNVERIFIED',
      message: expect.stringContaining('users.ssoProvider'),
    });
    expect(q.query.mock.calls.map((call) => call[0].trim())).toEqual([
      UPGRADE_SOURCE_MARKERS_SQL.trim(),
    ]);
  });

  it('refuses a partial v1.122.0 CLI attempt despite new columns and a ledger through 045', async () => {
    const q = probe(current, false);
    await expect(verifyUpgradeSource(q.client)).rejects.toThrow('applied migration 084 baseline');
    expect(q.query).toHaveBeenCalledTimes(2);
    expect(q.query.mock.calls.every((call) => call[0].trim().startsWith('SELECT'))).toBe(true);
  });

  it.each([
    [{ ...current, hasMessages: false }, 'messages table'],
    [{ ...current, hasUsers: false }, 'users table'],
    [{ ...current, hasAckId: false }, 'messages.ackId'],
    [{ ...current, hasSsoProvider: false }, 'users.ssoProvider'],
    [{ ...current, hasMigrationsTable: false }, 'schema_migrations table'],
  ] as const)('refuses partial or incompatible shapes (%j)', async (markers, expectedMissing) => {
    const q = probe(markers);
    await expect(verifyUpgradeSource(q.client)).rejects.toThrow(expectedMissing);
    expect(q.query).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a database probe or ledger permission error', async () => {
    const q = probe(current);
    q.query.mockImplementationOnce(async () => { throw new Error('database permission denied'); });
    await expect(verifyUpgradeSource(q.client)).rejects.toThrow('database permission denied');
    expect(q.query).toHaveBeenCalledTimes(1);

    const ledger = probe(current);
    ledger.query.mockImplementationOnce(async () => ({ rows: [current] }));
    ledger.query.mockImplementationOnce(async () => { throw new Error('ledger permission denied'); });
    await expect(verifyUpgradeSource(ledger.client)).rejects.toThrow('ledger permission denied');
    expect(ledger.query).toHaveBeenCalledTimes(2);
  });

  it('fails closed on an inconsistent schema probe response', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    await expect(verifyUpgradeSource({ query } as unknown as MigrationQueryable))
      .rejects.toThrow('schema probe returned no unique row');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('only probes current schema tables and columns, never modification SQL', () => {
    expect(UPGRADE_SOURCE_MARKERS_SQL).toMatch(/current_schema\(\)/);
    expect(UPGRADE_SOURCE_MARKERS_SQL).toMatch(/information_schema\.columns/);
    expect(UPGRADE_SOURCE_MARKERS_SQL.trim()).toMatch(/^SELECT\s/i);
    expect(UPGRADE_SOURCE_MARKERS_SQL).not.toMatch(/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i);
    expect(new UnverifiedUpgradeSourceError(['users.ssoProvider']).message)
      .toContain('No upgrade is attempted');
  });
});
