process.env.NODE_ENV = 'test';

const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockGetClient = jest.fn(async (..._args: unknown[]) => ({ query: mockClientQuery, release: mockRelease }));

jest.mock('../db/postgres/pool', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  getClient: (...args: unknown[]) => mockGetClient(...args),
}));

import { BotMarketplace } from '../db/repositories/BotMarketplaceRepository';

describe('BotMarketplaceRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([0, 6, 1.5, Number.MAX_SAFE_INTEGER + 1])('rateBot rejects invalid rating %p before DB access', async (rating) => {
    await expect(BotMarketplace.rateBot('bot-a', 'user-a', rating)).rejects.toThrow(TypeError);
    expect(mockGetClient).not.toHaveBeenCalled();
  });

  it('rateBot returns null for a missing/unapproved bot and rolls back', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT approved FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    await expect(BotMarketplace.rateBot('missing', 'u1', 5)).resolves.toBeNull();
    expect(mockClientQuery.mock.calls.map(c => c[0])).toEqual([
      'BEGIN',
      expect.stringContaining('FOR UPDATE'),
      'ROLLBACK',
    ]);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('rateBot upserts a user rating, recomputes aggregate, commits and returns the catalog row', async () => {
    const row = { id: 'bot-a', approved: true, rating: '4.50', ratingCount: 2 };
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'bot-a' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(BotMarketplace.rateBot('bot-a', 'u1', 4)).resolves.toEqual(row);
    expect(String(mockClientQuery.mock.calls[2]?.[0])).toContain('ON CONFLICT ("botId", "userId") DO UPDATE');
    expect(String(mockClientQuery.mock.calls[3]?.[0])).toContain('AVG(rating)');
    expect(mockClientQuery.mock.calls[4]?.[0]).toBe('COMMIT');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('rateBot rolls back and rethrows a transaction error', async () => {
    const failure = Object.assign(new Error('db down'), { code: '08006' });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'bot-a' }] })
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ rows: [] });

    await expect(BotMarketplace.rateBot('bot-a', 'u1', 3)).rejects.toBe(failure);
    expect(mockClientQuery.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('gets distinct categories and builds filtered/sorted list queries', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ category: 'music' }, { category: 'utility' }] })
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'a' }] });

    await expect(BotMarketplace.getCategories()).resolves.toEqual(['music', 'utility']);
    await expect(BotMarketplace.listBots({
      category: 'music', search: 'LOUD', featured: true, sort: 'rating', limit: 7, offset: 3,
    })).resolves.toEqual({ rows: [{ id: 'a' }], total: 2 });

    const [countSql, countParams] = mockPoolQuery.mock.calls[1]!;
    expect(String(countSql)).toContain('category = $1');
    expect(String(countSql)).toContain('LOWER(name) LIKE $2');
    expect(String(countSql)).toContain('featured = TRUE');
    expect(countParams.slice(0, 2)).toEqual(['music', '%loud%']);
    expect(String(mockPoolQuery.mock.calls[2]![0])).toContain('ORDER BY rating DESC');
    expect(mockPoolQuery.mock.calls[2]![1]).toEqual(['music', '%loud%', 7, 3]);
  });

  it.each([
    [{ count: undefined, total: 5 }, 5, 'installs DESC'],
    [{ count: undefined, total: undefined }, 0, '"createdAt" DESC'],
  ])('normalizes legacy/missing count rows and supports list sort variants', async (countRow, expected, order) => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [countRow] })
      .mockResolvedValueOnce({ rows: [] });
    const sort = order.startsWith('installs') ? 'installs' : 'newest';
    await expect(BotMarketplace.listBots({ limit: 10, offset: 0, sort })).resolves.toEqual({ rows: [], total: expected });
    expect(String(mockPoolQuery.mock.calls[1]![0])).toContain(`ORDER BY ${order}`);
  });

  it('uses the safe approved-only query and default ranking when sort is omitted', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(BotMarketplace.listBots({ limit: 50, offset: 0 })).resolves.toEqual({ rows: [], total: 0 });
    expect(String(mockPoolQuery.mock.calls[0]![0])).toContain('WHERE approved = TRUE');
    expect(String(mockPoolQuery.mock.calls[1]![0])).toContain('ORDER BY featured DESC, installs DESC');
  });

  it('finds/submits rows and exposes null when PostgreSQL returns none', async () => {
    const row = { id: 'bot-a' };
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(BotMarketplace.findById('bot-a')).resolves.toEqual(row);
    await expect(BotMarketplace.findById('missing')).resolves.toBeNull();
    const submitted = {
      id: 'bot-a', name: 'A', author: 'U', authorVerified: false, avatar: '🤖', category: 'utility',
      tags: ['one'], description: 'D', longDescription: 'Long', commands: ['/a'], permissions: ['send'],
      changelog: '', supportUrl: '#', sourceUrl: '#', submittedBy: 'u1', createdAt: 1, updatedAt: 1,
    };
    await expect(BotMarketplace.submit(submitted)).resolves.toEqual(row);
    await expect(BotMarketplace.submit(submitted)).resolves.toBeNull();
    expect(mockPoolQuery.mock.calls[2]![1]).toEqual(expect.arrayContaining([
      JSON.stringify(['one']), JSON.stringify(['/a']), JSON.stringify(['send']),
    ]));
  });

  it('updates only allowed fields, serializes arrays, and handles no-op/missing rows', async () => {
    await expect(BotMarketplace.update('bot-a', { installs: 100 })).resolves.toBeNull();
    expect(mockPoolQuery).not.toHaveBeenCalled();

    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'bot-a', name: 'New' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(BotMarketplace.update('bot-a', {
      name: 'New', tags: ['a'], commands: ['/a'], permissions: ['send'], approved: true,
    })).resolves.toEqual({ id: 'bot-a', name: 'New' });
    expect(String(mockPoolQuery.mock.calls[0]![0])).toContain('"updatedAt"');
    expect(mockPoolQuery.mock.calls[0]![1]).toEqual(expect.arrayContaining([
      'New', JSON.stringify(['a']), JSON.stringify(['/a']), JSON.stringify(['send']), true, 'bot-a',
    ]));
    await expect(BotMarketplace.update('bot-a', { name: 'Gone' })).resolves.toBeNull();
  });

  it('deletes, increments, counts, and writes review audit rows', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ c: '9' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{}] });
    await expect(BotMarketplace.deleteBot('bot-a')).resolves.toBeUndefined();
    await expect(BotMarketplace.incrementInstalls('bot-a')).resolves.toBeUndefined();
    await expect(BotMarketplace.count()).resolves.toBe(9);
    await expect(BotMarketplace.addReview({
      id: 'r1', botId: 'bot-a', reviewerId: 'admin', action: 'approve', note: 'ok', createdAt: 1,
    })).resolves.toBeUndefined();
    await expect(BotMarketplace.count()).resolves.toBe(0);
  });

  it('returns null when aggregate recomputation unexpectedly returns no catalog row', async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'bot-a' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(BotMarketplace.rateBot('bot-a', 'u1', 3)).resolves.toBeNull();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('preserves the transaction failure even when rollback also fails', async () => {
    const failure = new Error('write failed');
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'bot-a' }] })
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(new Error('rollback failed'));
    await expect(BotMarketplace.rateBot('bot-a', 'u1', 2)).rejects.toBe(failure);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
