process.env.NODE_ENV = 'test';

import db from '../db/loader';
import ChannelRepository from '../db/repositories/ChannelRepository';
import type { CreateChannelUnderCapInput } from '../db/repositories/ChannelRepository';
import { requireDoc } from './helpers/mockDb';

type QResult = { rows?: any[]; rowCount?: number };
function pgClient(handler: (sql: string, params?: unknown[]) => QResult | Promise<QResult>) {
  return {
    query: jest.fn((sql: string, params?: unknown[]) => Promise.resolve(handler(sql, params))),
    release: jest.fn(),
  };
}

const originalEnv = process.env.NODE_ENV;
afterAll(() => { process.env.NODE_ENV = originalEnv; delete (db as any)._pool; });

// Gecerli girdi URUN TIPINDEDIR; boylece asagidaki POZITIF cagrilar derleme
// zamaninda denetlenir ve urun imzasi degisirse burasi kirilir.
const validInput = (overrides: Partial<CreateChannelUnderCapInput> = {}): CreateChannelUnderCapInput => ({
  id: 'c1', serverId: 's1', name: 'general', type: 'text', topic: '', category: 'TEXT',
  nsfw: 0, bitrate: 64_000, slowmode: 0, forumTags: [], createdAt: 1000, cap: 500,
  ...overrides,
});

// ── KASITLI BOZUK GIRDI ────────────────────────────────────────────────────
// Asagidaki negatif testler urunun CALISMA ZAMANI dogrulamasini olcer; yukun
// tipe UYMAMASI testin ta kendisidir. Bu yuzden tek bir yerde, `unknown`
// uzerinden cagrilir — `as any` DEGIL: `any` cagri sonucunu da zehirlerdi,
// burada sonuc yine `unknown`tur ve `expect(...).rejects` ile sinanir.
const createWithUnvalidated =
  ChannelRepository.createUnderCapAtomic.bind(ChannelRepository) as unknown as
    (input: Record<string, unknown>) => Promise<unknown>;

const malformed = (patch: Record<string, unknown>): Record<string, unknown> =>
  ({ ...validInput(), ...patch });

describe('ChannelRepository behavior coverage', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    delete (db as any)._pool;
    (db as any)._reset?.();
    jest.restoreAllMocks();
  });

  test.each([
    ['id', { id: '' }], ['serverId', { serverId: '   ' }], ['name', { name: '' }],
    ['type', { type: '' }], ['category', { category: '' }],
  ])('createUnderCapAtomic rejects missing required string %s', async (_field, patch) => {
    await expect(createWithUnvalidated(malformed(patch))).rejects.toThrow(/required/);
  });

  test.each([
    ['nsfw', { nsfw: 1.5 }], ['bitrate', { bitrate: NaN }], ['slowmode', { slowmode: Infinity }],
    ['createdAt', { createdAt: '1000' }], ['cap', { cap: Number.MAX_SAFE_INTEGER + 1 }],
  ])('createUnderCapAtomic rejects non-safe integer %s', async (_field, patch) => {
    await expect(createWithUnvalidated(malformed(patch))).rejects.toThrow(/safe integer/);
  });

  test.each([
    [{ cap: 0 }, /positive/], [{ createdAt: 0 }, /positive/],
    [{ forumTags: '[]' }, /array/], [{ type: 'dm' }, /unsupported/i],
    [{ forumTags: [null] }, /malformed/i], [{ forumTags: [[]] }, /malformed/i],
    [{ forumTags: [{ id: 7 }] }, /malformed/i], [{ forumTags: [{ name: 9 }] }, /malformed/i],
    [{ forumTags: [{ color: 1 }] }, /malformed/i],
  ])('createUnderCapAtomic rejects malformed semantic input %#', async (patch, expected) => {
    await expect(createWithUnvalidated(malformed(patch))).rejects.toThrow(expected as RegExp);
  });

  test('in-memory atomic create distinguishes missing server, cap and successful ordered insert', async () => {
    await expect(ChannelRepository.createUnderCapAtomic(validInput())).resolves.toEqual({ status: 'server_not_found' });
    await db.servers.insert({ _id: 's1', name: 's', ownerId: 'u1' } as any);
    await db.channels.insert({ _id: 'existing', serverId: 's1', name: 'old', type: 'text' } as any);
    await expect(ChannelRepository.createUnderCapAtomic(validInput({ cap: 1 }))).resolves.toEqual({ status: 'limit' });

    const out = await ChannelRepository.createUnderCapAtomic(validInput({ id: 'c2', forumTags: [{ id: 'a', name: 'Tag', color: '#fff' }] }));
    expect(out.status).toBe('created');
    if (out.status === 'created') {
      expect(out.channel).toMatchObject({ _id: 'c2', order: 1, position: 1, type: 'text' });
      expect(out.channel.forumTags).toEqual([{ id: 'a', name: 'Tag', color: '#fff' }]);
    }
  });

  test('in-memory create serialization prevents two concurrent callers from both exceeding the cap', async () => {
    await db.servers.insert({ _id: 's1', name: 's', ownerId: 'u1' } as any);
    const [a, b] = await Promise.all([
      ChannelRepository.createUnderCapAtomic(validInput({ id: 'a', cap: 1 })),
      ChannelRepository.createUnderCapAtomic(validInput({ id: 'b', cap: 1 })),
    ]);
    expect([a.status, b.status].sort()).toEqual(['created', 'limit']);
    expect(await db.channels.count({ serverId: 's1' } as any)).toBe(1);
  });

  describe('PostgreSQL create owner', () => {
    beforeEach(() => { process.env.NODE_ENV = 'production'; });

    test('returns server_not_found and limit under parent lock without inserting', async () => {
      let mode: 'missing' | 'full' = 'missing';
      const client = pgClient((sql) => {
        if (/SELECT _id FROM servers/.test(sql)) return { rows: mode === 'missing' ? [] : [{ _id: 's1' }] };
        if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: '2' }] };
        return { rows: [] };
      });
      (db as any)._pool = { connect: jest.fn(async () => client) };
      await expect(ChannelRepository.createUnderCapAtomic(validInput({ cap: 2 }))).resolves.toEqual({ status: 'server_not_found' });
      mode = 'full';
      await expect(ChannelRepository.createUnderCapAtomic(validInput({ cap: 2 }))).resolves.toEqual({ status: 'limit' });
      expect(client.query.mock.calls.filter(([sql]) => String(sql) === 'ROLLBACK')).toHaveLength(2);
      expect(client.query.mock.calls.some(([sql]) => /INSERT INTO channels/.test(String(sql)))).toBe(false);
    });

    test('rejects corrupt count and missing RETURNING row, preserving the original failure even if rollback fails', async () => {
      let mode: 'count' | 'insert' = 'count';
      const client = pgClient((sql) => {
        if (/SELECT _id FROM servers/.test(sql)) return { rows: [{ _id: 's1' }] };
        if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: mode === 'count' ? 'oops' : '0' }] };
        if (/INSERT INTO channels/.test(sql)) return { rows: [] };
        if (String(sql) === 'ROLLBACK') throw new Error('rollback also failed');
        return { rows: [] };
      });
      (db as any)._pool = { connect: jest.fn(async () => client) };
      await expect(ChannelRepository.createUnderCapAtomic(validInput())).rejects.toThrow(/invalid channel count/i);
      mode = 'insert';
      await expect(ChannelRepository.createUnderCapAtomic(validInput())).rejects.toThrow(/insert returned no row/i);
      expect(client.release).toHaveBeenCalledTimes(2);
    });

    test('commits a successful insert with normalized persisted values', async () => {
      const inserted = { _id: 'c1', serverId: 's1', order: 3 };
      const client = pgClient((sql, params) => {
        if (/SELECT _id FROM servers/.test(sql)) return { rows: [{ _id: 's1' }] };
        if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: '3' }] };
        if (/INSERT INTO channels/.test(sql)) {
          expect(params?.[6]).toBe(3);
          expect(params?.[7]).toBe(3);
          expect(params).toHaveLength(13);
          expect(JSON.parse(String(params?.[11]))).toEqual([{ name: 'Tag' }]);
          return { rows: [inserted] };
        }
        return { rows: [] };
      });
      (db as any)._pool = { connect: jest.fn(async () => client) };
      await expect(ChannelRepository.createUnderCapAtomic(validInput({ forumTags: [{ name: 'Tag' }] }))).resolves.toEqual({ status: 'created', channel: inserted });
      expect(client.query).toHaveBeenCalledWith('COMMIT');
      expect(client.release).toHaveBeenCalled();
    });
  });

  test('basic channel/category repository methods remain tenant-scoped', async () => {
    await db.channels.insert({ _id: 'c1', serverId: 's1', name: 'one', order: 2 } as any);
    await db.channels.insert({ _id: 'c2', serverId: 's1', name: 'two', order: 1 } as any);
    await db.channels.insert({ _id: 'c3', serverId: 's2', name: 'three', order: 0 } as any);
    expect((await ChannelRepository.findByServer('s1')).map((x: any) => x._id)).toEqual(['c2','c1']);
    expect(await ChannelRepository.findByIdAndServer('c1','s2')).toBeNull();
    expect(await ChannelRepository.count('s1')).toBe(2);
    expect(await ChannelRepository.findIdsByServer('s1')).toEqual(expect.arrayContaining(['c1','c2']));
    await ChannelRepository.updateByIdAndServer('c1','s1',{ topic:'x' });
    expect(await ChannelRepository.findById('c1')).toMatchObject({ topic:'x' });
    await ChannelRepository.delete('c3');
    expect(await ChannelRepository.findById('c3')).toBeNull();

    const cat = await ChannelRepository.insertCategory({ serverId:'s1', name:'cat', position:2 }) as any;
    expect(await ChannelRepository.countCategories('s1')).toBe(1);
    expect(await ChannelRepository.findCategoryByIdAndServer(cat._id,'s1')).toBeTruthy();
    await ChannelRepository.updateCategory(cat._id,'s1',{ position:1 });
    expect((await ChannelRepository.findCategoriesByServer('s1') as any[])[0].position).toBe(1);
    await ChannelRepository.unlinkCategory(cat._id,'s1');
    await ChannelRepository.deleteCategory(cat._id,'s1');
    expect(await ChannelRepository.findCategoryById(cat._id)).toBeNull();
  });

  test('in-memory deleteGraphAtomic covers not-found, last-channel and owned-graph cleanup', async () => {
    await expect(ChannelRepository.deleteGraphAtomic('none','s1')).resolves.toBe('not_found');
    await db.channels.insert({ _id:'only', serverId:'s1', name:'only' } as any);
    await expect(ChannelRepository.deleteGraphAtomic('only','s1')).resolves.toBe('last_channel');
    await db.channels.insert({ _id:'other', serverId:'s1', name:'other' } as any);
    await (db as any).messages.insert({ _id:'m', channelId:'only' });
    await (db as any).channelBridges.insert({ _id:'b', sourceChannelId:'only', targetChannelId:'other' });
    await (db as any).savedMessages.insert({ _id:'sv', destinationType:'channel', destinationId:'only' });
    await (db as any).threads.insert({ _id:'t', channelId:'only' });
    await (db as any).threadMessages.insert({ _id:'tm', threadId:'t' });
    expect(await ChannelRepository.deleteGraphAtomic('only','s1')).toBe('deleted');
    expect(await db.channels.findOne({ _id:'only' } as any)).toBeNull();
    expect(await (db as any).messages.findOne({ _id:'m' })).toBeNull();
    expect(await (db as any).channelBridges.findOne({ _id:'b' })).toBeNull();
    expect(await (db as any).savedMessages.findOne({ _id:'sv' })).toBeNull();
    expect(await (db as any).threadMessages.findOne({ _id:'tm' })).toBeNull();
  });

  describe('PostgreSQL delete/category owners', () => {
    beforeEach(() => { process.env.NODE_ENV = 'production'; });

    test('deleteGraphAtomic discovers optional graph shapes and deletes every supported edge before the channel', async () => {
      const columns = [
        ['channel_bridges','sourceChannelId'],['channel_bridges','targetChannelId'],
        ['channel_follows','sourceChannelId'],['crosspost_log','targetChannelId'],
        ['saved_messages','destinationType'],['saved_messages','destinationId'],
        ['threads','channelId'],['thread_messages','threadId'],
        ['messages','channelId'],['channels','serverId'],
      ].map(([table_name,column_name])=>({table_name,column_name}));
      const client = pgClient((sql) => {
        if (/SELECT _id FROM channels WHERE _id=.*FOR UPDATE/.test(sql)) return { rows:[{_id:'c1'}] };
        if (/SELECT _id FROM channels WHERE "serverId"=.*FOR UPDATE/.test(sql)) return { rows:[{_id:'c1'},{_id:'c2'}] };
        if (/information_schema\.columns/.test(sql)) return { rows:columns };
        if (/SELECT _id FROM threads/.test(sql)) return { rows:[{_id:'t1'},{_id:'t2'}] };
        return { rows:[], rowCount:1 };
      });
      (db as any)._pool={connect:jest.fn(async()=>client)};
      await expect(ChannelRepository.deleteGraphAtomic('c1','s1')).resolves.toBe('deleted');
      const sqls=client.query.mock.calls.map(([sql])=>String(sql));
      expect(sqls.some(s=>/DELETE FROM "channel_bridges" WHERE "sourceChannelId"=\$1 OR "targetChannelId"=\$1/.test(s))).toBe(true);
      expect(sqls.some(s=>/DELETE FROM saved_messages/.test(s))).toBe(true);
      expect(sqls.some(s=>/DELETE FROM thread_messages/.test(s))).toBe(true);
      expect(sqls.some(s=>/DELETE FROM "messages" WHERE "channelId"=\$1/.test(s))).toBe(true);
      expect(sqls).toContain('DELETE FROM channels WHERE _id=$1 AND "serverId"=$2');
      expect(sqls).toContain('COMMIT');
    });

    test.each([
      ['not_found', [], [{_id:'c1'},{_id:'c2'}]],
      ['last_channel', [{_id:'c1'}], [{_id:'c1'}]],
    ])('deleteGraphAtomic returns %s without graph mutation', async (expected, lockedRows, siblingRows) => {
      const client=pgClient((sql)=>{
        if (/WHERE _id=.*FOR UPDATE/.test(sql)) return {rows:lockedRows as any[]};
        if (/WHERE "serverId"=.*FOR UPDATE/.test(sql)) return {rows:siblingRows as any[]};
        return {rows:[]};
      });
      (db as any)._pool={connect:jest.fn(async()=>client)};
      await expect(ChannelRepository.deleteGraphAtomic('c1','s1')).resolves.toBe(expected);
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    });

    test('deleteGraphAtomic preserves original delete failure when rollback also fails', async () => {
      const client=pgClient((sql)=>{
        if (/WHERE _id=.*FOR UPDATE/.test(sql)) return {rows:[{_id:'c1'}]};
        if (/WHERE "serverId"=.*FOR UPDATE/.test(sql)) return {rows:[{_id:'c1'},{_id:'c2'}]};
        if (/information_schema\.columns/.test(sql)) return {rows:[{table_name:'messages',column_name:'channelId'}]};
        if (/DELETE FROM "messages"/.test(sql)) throw new Error('child delete failed');
        if (sql==='ROLLBACK') throw new Error('rollback failed');
        return {rows:[]};
      });
      (db as any)._pool={connect:jest.fn(async()=>client)};
      await expect(ChannelRepository.deleteGraphAtomic('c1','s1')).rejects.toThrow('child delete failed');
      expect(client.release).toHaveBeenCalled();
    });

    test('deleteCategoryAtomic covers missing/success and reorder covers mismatch/success', async () => {
      let lockedRows:any[]=[];
      const client=pgClient((sql)=>{
        if (/SELECT _id FROM channel_categories WHERE _id/.test(sql)) return {rows:lockedRows};
        if (/SELECT _id FROM channel_categories WHERE "serverId"/.test(sql)) return {rows:lockedRows};
        return {rows:[],rowCount:1};
      });
      (db as any)._pool={connect:jest.fn(async()=>client)};
      await expect(ChannelRepository.deleteCategoryAtomic('cat','s1')).resolves.toBe(false);
      lockedRows=[{_id:'cat'}];
      await expect(ChannelRepository.deleteCategoryAtomic('cat','s1')).resolves.toBe(true);
      lockedRows=[{_id:'a'}];
      await expect(ChannelRepository.reorderCategoriesAtomic('s1',[{id:'a',position:0},{id:'b',position:1}])).resolves.toBe(false);
      lockedRows=[{_id:'a'},{_id:'b'}];
      await expect(ChannelRepository.reorderCategoriesAtomic('s1',[{id:'a',position:1},{id:'b',position:0}])).resolves.toBe(true);
      expect(client.query.mock.calls.some(([sql])=>/UPDATE channel_categories SET position/.test(String(sql)))).toBe(true);
    });

    test('category transactions rollback and release on write failure', async () => {
      const client=pgClient((sql)=>{
        if (/SELECT _id FROM channel_categories/.test(sql)) return {rows:[{_id:'cat'}]};
        if (/UPDATE channels SET "categoryId"=NULL/.test(sql)) throw new Error('unlink failed');
        return {rows:[]};
      });
      (db as any)._pool={connect:jest.fn(async()=>client)};
      await expect(ChannelRepository.deleteCategoryAtomic('cat','s1')).rejects.toThrow('unlink failed');
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
      expect(client.release).toHaveBeenCalled();
    });
  });

  test('in-memory category atomic fallback verifies every id before mutating positions', async () => {
    const a=await ChannelRepository.insertCategory({serverId:'s1',name:'a',position:0}) as any;
    const b=await ChannelRepository.insertCategory({serverId:'s1',name:'b',position:1}) as any;
    expect(await ChannelRepository.reorderCategoriesAtomic('s1',[{id:a._id,position:1},{id:'missing',position:0}])).toBe(false);
    expect((await ChannelRepository.findCategoryById(a._id) as any)?.position).toBe(0);
    expect(await ChannelRepository.reorderCategoriesAtomic('s1',[{id:a._id,position:1},{id:b._id,position:0}])).toBe(true);
    expect((await ChannelRepository.findCategoryById(a._id) as any)?.position).toBe(1);
    expect(await ChannelRepository.deleteCategoryAtomic('missing','s1')).toBe(false);
    expect(await ChannelRepository.deleteCategoryAtomic(a._id,'s1')).toBe(true);
  });
});
