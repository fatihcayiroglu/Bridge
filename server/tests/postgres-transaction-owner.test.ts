const connect = jest.fn();

jest.mock('../db/postgres/pool', () => ({
  pool: { connect: (...args: unknown[]) => connect(...args) },
}));

import { withTransaction } from '../db/postgres/transaction';

function clientHarness() {
  // Donus tipi ACIK: `mockImplementation` ile verilen gerceklestirmeler
  // `{ rows: [] }` donduruyor; cikarilan `{ rows: never[]; sql: string }`
  // tipi onlari reddediyordu.
  const query = jest.fn<Promise<{ rows: unknown[]; sql?: string }>, [sql: string]>(
    async (sql: string) => ({ rows: [], sql }),
  );
  const release = jest.fn();
  return { query, release };
}

describe('PostgreSQL canonical transaction owner', () => {
  beforeEach(() => { connect.mockReset(); });

  it('owns BEGIN -> callback -> COMMIT ordering and releases exactly once', async () => {
    const client = clientHarness();
    connect.mockResolvedValue(client);
    const callback = jest.fn(async (received: unknown) => {
      expect(received).toBe(client);
      await client.query('UPDATE things SET value = 1');
      return { ok: true };
    });

    await expect(withTransaction(callback as never)).resolves.toEqual({ ok: true });
    expect(client.query.mock.calls.map(call => call[0])).toEqual([
      'BEGIN', 'UPDATE things SET value = 1', 'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back callback failures, preserves the original error and releases', async () => {
    const client = clientHarness();
    connect.mockResolvedValue(client);
    const original = new Error('domain write failed');

    await expect(withTransaction(async () => { throw original; })).rejects.toBe(original);
    expect(client.query.mock.calls.map(call => call[0])).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('treats COMMIT failure as transaction failure and attempts rollback', async () => {
    const client = clientHarness();
    client.query.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') throw new Error('commit failed');
      return { rows: [] };
    });
    connect.mockResolvedValue(client);

    await expect(withTransaction(async () => 'value')).rejects.toThrow('commit failed');
    expect(client.query.mock.calls.map(call => call[0])).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('never lets rollback cleanup failure replace the canonical failure', async () => {
    const client = clientHarness();
    const original = new Error('original failure');
    client.query.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('rollback transport failed');
      return { rows: [] };
    });
    connect.mockResolvedValue(client);

    await expect(withTransaction(async () => { throw original; })).rejects.toBe(original);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  // A client whose ROLLBACK failed is disconnected or still inside the aborted
  // transaction; handing it back to the pool as healthy would poison the next
  // borrower (P1 multi-node harness, PostgreSQL disruption scenarios).
  it('destroys a client whose ROLLBACK failed instead of returning it to the pool', async () => {
    const client = clientHarness();
    const rollbackFailure = new Error('Connection terminated unexpectedly');
    client.query.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') throw rollbackFailure;
      return { rows: [] };
    });
    connect.mockResolvedValue(client);

    await expect(withTransaction(async () => { throw new Error('write failed'); })).rejects.toThrow('write failed');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(rollbackFailure);
  });

  it('returns a client to the pool (no discard argument) after a successful rollback or commit', async () => {
    const ok = clientHarness();
    connect.mockResolvedValue(ok);
    await withTransaction(async () => 'value');
    expect(ok.release).toHaveBeenCalledWith(undefined);

    const rolledBack = clientHarness();
    connect.mockResolvedValue(rolledBack);
    await expect(withTransaction(async () => { throw new Error('domain'); })).rejects.toThrow('domain');
    expect(rolledBack.release).toHaveBeenCalledWith(undefined);
  });

  it('does not fabricate a client when pool acquisition itself fails', async () => {
    connect.mockRejectedValue(new Error('pool exhausted'));
    await expect(withTransaction(async () => 'never')).rejects.toThrow('pool exhausted');
  });
});
