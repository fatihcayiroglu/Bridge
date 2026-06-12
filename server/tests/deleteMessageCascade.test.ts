// server/tests/deleteMessageCascade.test.ts
// PG _transaction yolu — mockDb (_reset) olmadan SQL cascade doğrulaması

'use strict';
process.env.NODE_ENV = 'test';

describe('deleteMessageWithCascade — PG transaction path', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('threadId ile _transaction içinde thread + message + unread SQL', async () => {
    const queries: { sql: string; params?: unknown[] }[] = [];
    const pgDb = {
      _transaction: async (fn: (c: { query: (sql: string, params?: unknown[]) => Promise<void> }) => Promise<void>) => {
        await fn({
          query: async (sql: string, params?: unknown[]) => {
            queries.push({ sql, params });
          },
        });
      },
    };

    jest.doMock('../db/loader', () => pgDb);
    jest.doMock('../db/repositories', () => ({
      Messages: {
        delete: jest.fn(),
        deleteByChannel: jest.fn(),
      },
    }));
    jest.doMock('../db/repositories/ThreadRepository', () => ({
      __esModule: true,
      default: { delete: jest.fn() },
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { deleteMessageWithCascade } = require('../lib/deleteMessageCascade');

    const ok = await deleteMessageWithCascade('msg-pg-1', 'ch-pg-1', {
      _id: 'msg-pg-1',
      channelId: 'ch-pg-1',
      serverId: 'srv-pg-1',
      threadId: 'th-pg-1',
    });

    expect(ok).toBe(true);
    expect(queries.some(q => q.sql.includes('thread_messages'))).toBe(true);
    expect(queries.some(q => q.sql.includes('DELETE FROM threads'))).toBe(true);
    expect(queries.some(q => q.sql.includes('DELETE FROM messages'))).toBe(true);
    expect(queries.some(q => q.sql.includes('unread_counts'))).toBe(true);
  });

  it('_transaction hata verirse false döner', async () => {
    const pgDb = {
      _transaction: async () => {
        throw new Error('tx failed');
      },
    };

    jest.doMock('../db/loader', () => pgDb);
    jest.doMock('../db/repositories', () => ({
      Messages: { delete: jest.fn(), deleteByChannel: jest.fn() },
    }));
    jest.doMock('../db/repositories/ThreadRepository', () => ({
      __esModule: true,
      default: { delete: jest.fn() },
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { deleteMessageWithCascade } = require('../lib/deleteMessageCascade');

    const ok = await deleteMessageWithCascade('msg-err', 'ch-err', {
      _id: 'msg-err',
      channelId: 'ch-err',
      serverId: 'srv-err',
    });

    expect(ok).toBe(false);
  });
});
