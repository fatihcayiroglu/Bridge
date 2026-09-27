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
        softDelete: jest.fn(),
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
    const scrub = queries.find(q => q.sql.includes('UPDATE messages') && q.sql.includes('\"deletedAt\"'));
    expect(scrub).toBeDefined();
    expect(scrub!.sql).toContain('\"encryptedContent\" = NULL');
    expect(scrub!.sql).toContain('\"fileUrl\" = NULL');
    expect(scrub!.sql).toContain("\"editHistory\" = '[]'::jsonb");
    expect(queries.some(q => q.sql.includes('unread_counts'))).toBe(true);
  });

  // Sprint 122 — Reply UX: silinen mesaja yapılmış yanıtların önizlemesi
  // "deleted" olarak işaretlenmeli ki durum reload sonrası da korunsun.
  it('silinen mesaja yapılan yanıtların replyTo anlık görüntüsü deleted olarak işaretlenir', async () => {
    const queries: { sql: string; params?: unknown[] }[] = [];
    const pgDb = {
      _transaction: async (fn: (c: { query: (sql: string, params?: unknown[]) => Promise<void> }) => Promise<void>) => {
        await fn({
          query: async (sql: string, params?: unknown[]) => { queries.push({ sql, params }); },
        });
      },
    };

    jest.doMock('../db/loader', () => pgDb);
    jest.doMock('../db/repositories', () => ({
      Messages: { softDelete: jest.fn(), deleteByChannel: jest.fn() },
    }));
    jest.doMock('../db/repositories/ThreadRepository', () => ({
      __esModule: true,
      default: { delete: jest.fn() },
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { deleteMessageWithCascade } = require('../lib/deleteMessageCascade');

    const ok = await deleteMessageWithCascade('msg-reply-target', 'ch-reply', {
      _id: 'msg-reply-target',
      channelId: 'ch-reply',
      serverId: 'srv-reply',
    });

    expect(ok).toBe(true);

    const markQuery = queries.find(q => q.sql.includes('jsonb_set') && q.sql.includes('"replyTo"'));
    expect(markQuery).toBeDefined();
    // Yalnızca aynı kanaldaki, o mesaja yanıt veren kayıtlar güncellenmeli
    expect(markQuery!.sql).toContain(`"replyTo"->>'_id' = $2`);
    expect(markQuery!.params).toEqual(['ch-reply', 'msg-reply-target']);
    // Soft-delete işlemi reply snapshot işaretlemesinden ÖNCE gelmeli.
    const delIdx  = queries.findIndex(q => q.sql.includes('UPDATE messages') && q.sql.includes('\"deletedAt\"'));
    const markIdx = queries.findIndex(q => q.sql.includes('jsonb_set'));
    expect(delIdx).toBeGreaterThanOrEqual(0);
    expect(markIdx).toBeGreaterThan(delIdx);
  });

  it('tx yoksa (mock/in-memory) markRepliesDeleted repository üzerinden çağrılır', async () => {
    const markRepliesDeleted = jest.fn();
    const softDelete = jest.fn();
    jest.doMock('../db/loader', () => ({ _reset: () => {} })); // mockDb sinyali
    jest.doMock('../db/repositories', () => ({
      Messages: { softDelete, deleteByChannel: jest.fn(), markRepliesDeleted },
    }));
    jest.doMock('../db/repositories/ThreadRepository', () => ({
      __esModule: true,
      default: { delete: jest.fn() },
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { deleteMessageWithCascade } = require('../lib/deleteMessageCascade');

    const ok = await deleteMessageWithCascade('msg-mock-1', 'ch-mock-1', {
      _id: 'msg-mock-1',
      channelId: 'ch-mock-1',
      serverId: 'srv-mock-1',
    });

    expect(ok).toBe(true);
    expect(softDelete).toHaveBeenCalledWith('msg-mock-1', 'system');
    expect(markRepliesDeleted).toHaveBeenCalledWith('ch-mock-1', 'msg-mock-1');
  });

  it('_transaction hata verirse false döner', async () => {
    const pgDb = {
      _transaction: async () => {
        throw new Error('tx failed');
      },
    };

    jest.doMock('../db/loader', () => pgDb);
    jest.doMock('../db/repositories', () => ({
      Messages: { softDelete: jest.fn(), deleteByChannel: jest.fn() },
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

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
