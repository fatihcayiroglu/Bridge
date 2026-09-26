'use strict';
process.env.NODE_ENV = 'test';

const store = {
  findOne: jest.fn(), insert: jest.fn(), find: jest.fn(), remove: jest.fn(),
};
jest.mock('../db/loader', () => ({ savedMessages: store }));

import SavedMessages from '../db/repositories/SavedMessageRepository';

function queryResult(rows: unknown[] = []) {
  const q: any = Promise.resolve(rows);
  q.sort = jest.fn(() => q);
  q.limit = jest.fn(() => q);
  return q;
}

const input = { userId: 'u1', destinationType: 'channel' as const, destinationId: 'c1', messageId: 'm1' };

describe('SavedMessageRepository durability and owner scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.findOne.mockResolvedValue(null);
    store.insert.mockResolvedValue({ _id: 'saved:u1:channel:m1', ...input, createdAt: 1 });
    store.find.mockImplementation(() => queryResult([]));
    store.remove.mockResolvedValue({ removed: 1 });
  });

  test('existing save is idempotent and does not write again', async () => {
    const row = { _id: 'saved:u1:channel:m1', ...input };
    store.findOne.mockResolvedValueOnce(row);
    await expect(SavedMessages.save(input)).resolves.toEqual({ row, created: false });
    expect(store.insert).not.toHaveBeenCalled();
  });

  test('new save persists deterministic owner-scoped identity', async () => {
    const out = await SavedMessages.save(input);
    expect(out.created).toBe(true);
    expect(store.insert).toHaveBeenCalledWith(expect.objectContaining({
      _id: 'saved:u1:channel:m1', userId: 'u1', destinationId: 'c1', messageId: 'm1', createdAt: expect.any(Number),
    }));
  });

  test.each([
    Object.assign(new Error('duplicate key'), { code: '23505' }),
    new Error('UNIQUE constraint failed'),
  ])('unique race resolves to the winning durable row', async (uniqueError) => {
    const winner = { _id: 'saved:u1:channel:m1', ...input, createdAt: 2 };
    store.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    store.insert.mockRejectedValueOnce(uniqueError);
    await expect(SavedMessages.save(input)).resolves.toEqual({ row: winner, created: false });
    expect(store.findOne).toHaveBeenLastCalledWith({ userId: 'u1', destinationType: 'channel', messageId: 'm1' });
  });

  test('non-unique insert failure is not converted to idempotent success', async () => {
    const failure = new Error('postgres unavailable');
    store.insert.mockRejectedValueOnce(failure);
    await expect(SavedMessages.save(input)).rejects.toBe(failure);
  });

  test('unique-looking error without a durable winner preserves original failure', async () => {
    const failure = Object.assign(new Error('duplicate key'), { code: '23505' });
    store.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    store.insert.mockRejectedValueOnce(failure);
    await expect(SavedMessages.save(input)).rejects.toBe(failure);
  });

  test('list applies owner scope, ordering and bounded limit', async () => {
    const q = queryResult([{ _id: 's1' }]);
    store.find.mockReturnValueOnce(q);
    await expect(SavedMessages.findForUser('u1', 999)).resolves.toEqual([{ _id: 's1' }]);
    expect(store.find).toHaveBeenCalledWith({ userId: 'u1' });
    expect(q.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(q.limit).toHaveBeenCalledWith(200);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('invalid list limit %p is rejected before querying', async (limit) => {
    await expect(SavedMessages.findForUser('u1', limit)).rejects.toThrow('Invalid saved-message limit');
    expect(store.find).not.toHaveBeenCalled();
  });

  test('delete cannot remove another users saved item', async () => {
    await SavedMessages.removeForUser('u1', 'saved-id');
    expect(store.remove).toHaveBeenCalledWith({ _id: 'saved-id', userId: 'u1' });
  });
});
