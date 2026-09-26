// server/tests/account-deletion-core.test.ts
//
// Final21 Faz 19 — lib/accountDeletion.ts + lib/accountErasure.ts birim sözleşmeleri.
// Gerçek veritabanı davranışı `tests/pg-integration/account-erasure.pgtest.ts` ve
// `admin-account-deletion.pgtest.ts` içindedir; burada eski/kısmi şemalar, yönetici temizliği,
// sürücünün `rowCount` vermediği durumlar ve sahiplik engeli hesaplaması ölçülür.

jest.mock('../lib/messageCache', () => ({ invalidateChannelMessages: jest.fn(async () => undefined) }));
jest.mock('../lib/uploadRelease', () => {
  const actual = jest.requireActual('../lib/uploadRelease');
  return { ...actual, releaseUnreferencedUploads: jest.fn(async () => ({ removed: 1, alreadyAbsent: 0, stillReferenced: 0, failed: 0 })) };
});

import { eraseAccountData, ownershipBlockers, releaseAfterErasure, type Queryable } from '../lib/accountDeletion';
import { prepareAuthorErasure, snapshotAssignments } from '../lib/accountErasure';
import { invalidateChannelMessages } from '../lib/messageCache';
import { releaseUnreferencedUploads } from '../lib/uploadRelease';

type Reply = { rows?: unknown[]; rowCount?: number | null } | Error;
/** Scripted fake: the first matching rule answers; every SQL is recorded. */
function fakeDb(rules: Array<[RegExp, (params?: unknown[]) => Reply]>, schema: Record<string, string[]>) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const db: Queryable = {
    query: (async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (/information_schema\.tables/.test(sql)) return { rows: Object.keys(schema).map((table_name) => ({ table_name })) };
      if (/information_schema\.columns/.test(sql)) return { rows: (schema[String(params?.[0])] ?? []).map((column_name) => ({ column_name })) };
      for (const [re, fn] of rules) {
        if (re.test(sql)) {
          const r = fn(params);
          if (r instanceof Error) throw r;
          return { rows: r.rows ?? [], rowCount: r.rowCount };
        }
      }
      return { rows: [], rowCount: 0 };
    }) as Queryable['query'],
  };
  const transaction = (async <T>(fn: (c: Queryable) => Promise<T>) => fn(db)) as Parameters<typeof eraseAccountData>[1];
  return { db, calls, transaction };
}

describe('snapshotAssignments', () => {
  it('only the author identity column of a snapshot table gets assignments, for columns that exist', () => {
    expect(snapshotAssignments('messages', 'userId', new Set(['userId', 'displayName', 'avatarUrl']), 3))
      .toEqual({ sql: ', "displayName" = $3, "avatarUrl" = $4', params: ['', null] });
    expect(snapshotAssignments('messages', 'deletedBy', new Set(['displayName']), 3)).toEqual({ sql: '', params: [] });
    expect(snapshotAssignments('polls', 'userId', new Set(['displayName']), 3)).toEqual({ sql: '', params: [] });
    expect(snapshotAssignments('voice_messages', 'userId', new Set(['userId']), 3)).toEqual({ sql: '', params: [] });
  });
});

describe('prepareAuthorErasure on partial schemas', () => {
  it('does nothing when the tables or identity columns are absent', async () => {
    const { db, calls } = fakeDb([], { messages: ['_id'], users: ['_id'], members: ['userId'] });
    const plan = await prepareAuthorErasure(db, 'u1', new Set(['messages', 'users', 'members']), async (t) => new Set(({ messages: ['_id'], users: ['_id'], members: ['userId'] } as Record<string, string[]>)[t]));
    expect(plan).toEqual({ assetUrls: [], channelIds: [], repliesScrubbed: 0 });
    expect(calls).toEqual([]);
  });

  it('works without replyTo/avatarUrl columns and tolerates a driver without rowCount or empty aggregates', async () => {
    const { db, calls } = fakeDb([
      [/array_agg/, () => ({ rows: [{ channels: null }] })],
      [/FROM users WHERE/, () => ({ rows: [] })],
    ], {});
    const cols: Record<string, string[]> = { messages: ['userId', 'channelId'], users: ['avatarUrl'], members: ['userId', 'serverProfile'] };
    const plan = await prepareAuthorErasure(db, 'u1', new Set(['messages', 'users']), async (t) => new Set(cols[t]));
    expect(plan).toEqual({ assetUrls: [], channelIds: [], repliesScrubbed: 0 });
    expect(calls.some((c) => /replyTo/.test(c.sql))).toBe(false);
    expect(calls.find((c) => /array_agg/.test(c.sql))?.sql).not.toMatch(/avatarUrl/);
  });

  it('collects channels (skipping nulls), avatars, banner and member-profile images; foreign URLs are dropped', async () => {
    const { db } = fakeDb([
      [/"replyTo" - 'displayName'/, () => ({ rows: [], rowCount: undefined })],
      [/array_agg/, () => ({ rows: [{ channels: ['c1', null, 'c2'], avatars: ['/uploads/avatars/old.png', 'https://cdn.example/x.png'] }] })],
      [/FROM users WHERE/, () => ({ rows: [{ avatarUrl: '/uploads/avatars/now.png', bannerUrl: null }] })],
      [/FROM members WHERE/, () => ({ rows: [{ serverProfile: { avatarUrl: '/uploads/member-profiles/m.webp' } }] })],
    ], {});
    const cols: Record<string, string[]> = { messages: ['userId', 'channelId', 'replyTo', 'avatarUrl'], users: ['avatarUrl', 'bannerUrl'], members: ['userId', 'serverProfile'] };
    const plan = await prepareAuthorErasure(db, 'u1', new Set(['messages', 'users', 'members']), async (t) => new Set(cols[t]));
    expect(plan.channelIds).toEqual(['c1', 'c2']);
    expect(plan.repliesScrubbed).toBe(0);                 // driver gave no rowCount
    expect(plan.assetUrls.sort()).toEqual(['/uploads/avatars/now.png', '/uploads/avatars/old.png', '/uploads/member-profiles/m.webp']);
  });
});

describe('eraseAccountData', () => {
  it('ADMIN purge deletes the person\'s channel messages inside the same transaction, before the policy runs', async () => {
    const schema = { messages: ['userId', 'channelId'], refresh_tokens: ['userId'], servers: ['ownerId'] };
    const { db, calls, transaction } = fakeDb([[/DELETE FROM messages WHERE "userId"/, () => ({ rowCount: 3 })]], schema);
    const { applied } = await eraseAccountData(db, transaction, 'u1', { purgeChannelMessages: true });
    expect(applied[0]).toEqual({ table: 'messages', disposition: 'PURGE_BY_ADMIN', rows: 3 });
    const purgeIdx = calls.findIndex((c) => /DELETE FROM messages WHERE "userId"/.test(c.sql));
    const anonymizeIdx = calls.findIndex((c) => /UPDATE "messages"/.test(c.sql));
    expect(purgeIdx).toBeGreaterThanOrEqual(0);
    expect(anonymizeIdx).toBeGreaterThan(purgeIdx);     // nothing left to anonymize afterwards, but the policy still runs
    expect(calls.at(-1)?.sql).toBe('DELETE FROM users WHERE _id = $1');
  });

  it('without the messages table there is no purge; missing owner columns skip; rowCount absent counts 0', async () => {
    const schema = { refresh_tokens: ['userId'], servers: ['name'], bots: ['ownerId'] };
    const { db, calls, transaction } = fakeDb([[/DELETE FROM "bots"/, () => ({ rows: [] })]], schema);
    const { applied } = await eraseAccountData(db, transaction, 'u1', { purgeChannelMessages: true });
    expect(calls.some((c) => /DELETE FROM messages/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /DELETE FROM "servers"/.test(c.sql))).toBe(false);
    expect(applied).toContainEqual({ table: 'bots', disposition: 'DELETE_SOLE_OWNED', rows: 0 });
    expect(applied).toContainEqual({ table: 'refresh_tokens', disposition: 'DELETE', rows: 0 });
  });
});

describe('ownershipBlockers', () => {
  it('reports only servers and group DMs with other members; bad counts are treated as 0', async () => {
    const { db } = fakeDb([
      [/FROM servers s WHERE/, () => ({ rows: [{ _id: 's1', name: 'Solo', cnt: '1' }, { _id: 's2', name: 'Team', cnt: '5' }, { _id: 's3', name: 'Odd', cnt: 'x' }] })],
      [/FROM group_dm_conversations g WHERE/, () => ({ rows: [{ _id: 'g1', cnt: '2' }, { _id: 'g2', cnt: 'nope' }, { _id: 'g3', cnt: '1' }] })],
    ], { servers: [], members: [], group_dm_conversations: [], group_dm_members: [] });
    await expect(ownershipBlockers(db, 'u1')).resolves.toEqual([
      { kind: 'server', id: 's2', name: 'Team', memberCount: 5 },
      { kind: 'group_dm', id: 'g1', memberCount: 2 },
    ]);
  });

  it('a failing group-DM lookup on a drifted schema is isolated (no blockers from it)', async () => {
    const { db } = fakeDb([[/FROM group_dm_conversations/, () => new Error('legacy table drift')]], { group_dm_conversations: [], group_dm_members: [] });
    await expect(ownershipBlockers(db, 'u1')).resolves.toEqual([]);
  });
});

describe('releaseAfterErasure', () => {
  it('releases the planned files and drops every affected channel page cache', async () => {
    const { db } = fakeDb([], {});
    const onError = jest.fn();
    const result = await releaseAfterErasure(db, { assetUrls: ['/uploads/avatars/a.png'], channelIds: ['c1', 'c2'], repliesScrubbed: 0 }, onError);
    expect(result.removed).toBe(1);
    expect(releaseUnreferencedUploads).toHaveBeenCalledWith(db, ['/uploads/avatars/a.png'], onError);
    expect((invalidateChannelMessages as jest.Mock).mock.calls.map((c) => c[0])).toEqual(['c1', 'c2']);
  });
});
