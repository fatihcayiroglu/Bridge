import type { MigrationQueryable } from '../db/postgres/versionedMigrations';
import {
  UnverifiedUpgradeSourceError,
  UPGRADE_SOURCE_MARKERS_SQL,
  verifyUpgradeSource,
} from '../db/postgres/upgradePreflight';

type Markers = {
  hasUsers: boolean;
  hasMessages: boolean;
  hasSsoProvider: boolean;
  hasAckId: boolean;
};

function probe(markers: Markers) {
  const query = jest.fn(async (_sql: string) => ({ rows: [markers] }));
  return { query, client: { query } as unknown as MigrationQueryable };
}

describe('P7 D3 upgrade source: fail closed before any mutation', () => {
  it('allows a genuinely empty database without starting a migration itself', async () => {
    const q = probe({ hasUsers: false, hasMessages: false, hasSsoProvider: false, hasAckId: false });
    await expect(verifyUpgradeSource(q.client)).resolves.toBeUndefined();
    expect(q.query).toHaveBeenCalledTimes(1);
    expect(q.query.mock.calls[0][0].trim()).toMatch(/^SELECT\s/i);
  });

  it('allows a current schema with the required persisted markers', async () => {
    const q = probe({ hasUsers: true, hasMessages: true, hasSsoProvider: true, hasAckId: true });
    await expect(verifyUpgradeSource(q.client)).resolves.toBeUndefined();
    expect(q.query).toHaveBeenCalledTimes(1);
  });

  it('refuses the measured v1.122.0 boot-only shape before any DDL', async () => {
    const q = probe({ hasUsers: true, hasMessages: true, hasSsoProvider: false, hasAckId: false });
    await expect(verifyUpgradeSource(q.client)).rejects.toMatchObject({
      name: 'UnverifiedUpgradeSourceError',
      code: 'BRIDGE_UPGRADE_SOURCE_UNVERIFIED',
      message: expect.stringContaining('users.ssoProvider'),
    });
    expect(q.query.mock.calls.map((call) => call[0].trim())).toEqual([
      UPGRADE_SOURCE_MARKERS_SQL.trim(),
    ]);
  });

  it.each([
    [{ hasUsers: true, hasMessages: false, hasSsoProvider: true, hasAckId: false }, 'messages table'],
    [{ hasUsers: false, hasMessages: true, hasSsoProvider: false, hasAckId: true }, 'users table'],
    [{ hasUsers: true, hasMessages: true, hasSsoProvider: true, hasAckId: false }, 'messages.ackId'],
    [{ hasUsers: true, hasMessages: true, hasSsoProvider: false, hasAckId: true }, 'users.ssoProvider'],
  ] as const)('refuses partial or incompatible shapes (%j)', async (markers, expectedMissing) => {
    const q = probe(markers);
    await expect(verifyUpgradeSource(q.client)).rejects.toThrow(expectedMissing);
    expect(q.query).toHaveBeenCalledTimes(1);
  });

  it('fails closed when its read-only probe fails', async () => {
    const query = jest.fn(async () => { throw new Error('database permission denied'); });
    await expect(verifyUpgradeSource({ query } as unknown as MigrationQueryable))
      .rejects.toThrow('database permission denied');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('fails closed on an inconsistent probe response', async () => {
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
