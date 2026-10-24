const mockReferences = jest.fn();
jest.mock('../lib/uploadReferenceSafety', () => ({
  ...jest.requireActual('../lib/uploadReferenceSafety'),
  liveUploadReferenceKeys: (...args: unknown[]) => mockReferences(...args),
}));
import { reserveUploadReleaseKeys } from '../lib/uploadReleaseFence';

function fixture() {
  const client = { query: jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] })), release: jest.fn() };
  const pool = { query: client.query, connect: jest.fn(async () => client) };
  return { client, pool };
}
beforeEach(() => { mockReferences.mockReset(); mockReferences.mockResolvedValue(new Set()); });

it('requires a transaction-capable database before reserving a deletion', async () => {
  await expect(reserveUploadReleaseKeys(undefined, ['uploads/a.png'])).rejects.toThrow('PostgreSQL transaction');
});

it.each(['../secret', 'uploads/a/b/c.png', 'uploads/stickers/a.png', "uploads/a.png';DROP TABLE users"])(
  'rejects an unsupported key without touching the database: %s', async key => {
    const { pool } = fixture();
    await expect(reserveUploadReleaseKeys(pool, [key])).rejects.toThrow('Invalid upload release key');
    expect(pool.connect).not.toHaveBeenCalled();
  },
);

it('does no database work for an empty batch', async () => {
  const { pool } = fixture();
  expect(await reserveUploadReleaseKeys(pool, [])).toEqual(new Set());
  expect(pool.connect).not.toHaveBeenCalled();
});

it('reserves each key once in a stable order, retains shared keys and releases the transaction', async () => {
  const { pool, client } = fixture();
  mockReferences.mockResolvedValue(new Set(['uploads/b.png']));
  expect(await reserveUploadReleaseKeys(pool, ['uploads/b.png', 'uploads/a.png', 'uploads/b.png']))
    .toEqual(new Set(['uploads/b.png']));
  expect(mockReferences).toHaveBeenCalledWith(client, ['uploads/a.png', 'uploads/b.png']);
  expect(client.query).toHaveBeenCalledWith(expect.stringContaining('reserved = FALSE'), [['uploads/b.png']]);
  expect(client.query).toHaveBeenLastCalledWith('COMMIT');
  expect(client.release).toHaveBeenCalledTimes(1);
});

it('preserves an unavailable-evidence error even when rollback also fails', async () => {
  const { pool, client } = fixture();
  mockReferences.mockRejectedValue(new Error('reference evidence unavailable'));
  client.query.mockImplementation(async sql => {
    if (sql === 'ROLLBACK') throw new Error('connection lost');
    return { rows: [] };
  });
  await expect(reserveUploadReleaseKeys(pool, ['uploads/a.png'])).rejects.toThrow('reference evidence unavailable');
  expect(client.query).not.toHaveBeenCalledWith('COMMIT');
  expect(client.release).toHaveBeenCalledTimes(1);
});

it('does not report a reservation when COMMIT fails', async () => {
  const { pool, client } = fixture();
  client.query.mockImplementation(async sql => {
    if (sql === 'COMMIT') throw new Error('commit lost');
    return { rows: [] };
  });
  await expect(reserveUploadReleaseKeys(pool, ['uploads/a.png'])).rejects.toThrow('commit lost');
  expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
  expect(client.release).toHaveBeenCalledTimes(1);
});
