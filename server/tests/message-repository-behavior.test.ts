'use strict';
process.env.NODE_ENV='test';

let foundRows:any[]=[];
const limit=jest.fn(async()=>foundRows);
const sort=jest.fn(()=>({limit, then:(resolve:any)=>resolve(foundRows)}));
const find=jest.fn(()=>({sort,limit}));
const messages:any={
  find,
  findOne:jest.fn(), insert:jest.fn(), update:jest.fn(), remove:jest.fn(), count:jest.fn(),
};
const db:any={messages,_pool:undefined,_ftsSearch:undefined,_unifiedSearch:undefined,_searchContext:undefined};
jest.mock('../db/loader',()=>({__esModule:true,default:db}));

import Messages from '../db/repositories/MessageRepository';

describe('MessageRepository production behavior',()=>{
  beforeEach(()=>{
    jest.clearAllMocks(); foundRows=[];
    db._pool=undefined; db._ftsSearch=undefined; db._unifiedSearch=undefined; db._searchContext=undefined;
    messages.find.mockImplementation(()=>({sort,limit}));
    sort.mockImplementation(()=>({limit,then:(resolve:any)=>resolve(foundRows)}));
    limit.mockImplementation(async()=>foundRows);
    messages.findOne.mockResolvedValue(null);
    messages.insert.mockImplementation(async(x:any)=>x);
    messages.update.mockResolvedValue({updated:1});
    messages.remove.mockResolvedValue({removed:1});
    messages.count.mockResolvedValue(0);
  });

  // Final21 Faz 8 — F21-8-03: koleksiyon yolu da AYNI sinirli anlami tasir.
  // Eski yol `userId: {$ne}` filtresini sorguya koyup `.limit(1)` aliyordu;
  // PostgreSQL yolu ile ayni sinir burada da gecerli olmalidir.
  it('findFirstUnreadAfter (collection path) scans a bounded window and skips the reader own rows',async()=>{
    const { FIRST_UNREAD_SCAN_WINDOW } = await import('../db/repositories/MessageRepository');
    foundRows=[
      {_id:'m1',userId:'reader',createdAt:2},
      {_id:'m2',userId:'reader',createdAt:3},
      {_id:'m3',userId:'other',createdAt:4},
      {_id:'m4',userId:'other',createdAt:5},
    ];
    const row = await Messages.findFirstUnreadAfter('c1','reader',1,'m0');
    expect(row).toEqual({_id:'m3',userId:'other',createdAt:4});
    // Sinir: pencere boyutu kadar aday istenir, fazlasi DEGIL.
    expect(limit).toHaveBeenCalledWith(FIRST_UNREAD_SCAN_WINDOW);
    // Okuyucu filtresi artik sorguda degil pencerede uygulanir.
    const query = (find.mock.calls as unknown as Array<[Record<string, unknown>]>).at(-1)?.[0];
    expect(query).not.toHaveProperty('userId');

    // Penceredeki satirlarin HEPSI okuyucunun ise ayrac yoktur.
    foundRows=[{_id:'m1',userId:'reader',createdAt:2},{_id:'m2',userId:'reader',createdAt:3}];
    await expect(Messages.findFirstUnreadAfter('c1','reader',1,'m0')).resolves.toBeNull();
  });

  it('reports optional search capabilities and preserves privacy-safe empty fallbacks',async()=>{
    expect(Messages.hasFtsSearch()).toBe(false);
    expect(Messages.hasUnifiedSearch()).toBe(false);
    expect(Messages.hasSearchContext()).toBe(false);
    await expect(Messages.ftsSearch('needle','s',10)).resolves.toEqual([]);
    await expect(Messages.unifiedSearch('needle',{userId:'u',serverIds:['s']},10)).resolves.toEqual([]);
    await expect(Messages.searchContext('m','channel',{userId:'u',serverIds:['s']})).resolves.toBeNull();

    db._ftsSearch=jest.fn(async()=>['fts']);
    db._unifiedSearch=jest.fn(async()=>['unified']);
    db._searchContext=jest.fn(async()=>({messages:[],channelId:'c',serverId:'s'}));
    expect(Messages.hasFtsSearch()).toBe(true);
    expect(Messages.hasUnifiedSearch()).toBe(true);
    expect(Messages.hasSearchContext()).toBe(true);
    await expect(Messages.ftsSearch('q','s','7', ['c'])).resolves.toEqual(['fts']);
    expect(db._ftsSearch).toHaveBeenCalledWith('q',['s'],7,['c']);
    await expect(Messages.ftsSearch('q',['s1','s2'],5)).resolves.toEqual(['fts']);
    expect(db._ftsSearch).toHaveBeenLastCalledWith('q',['s1','s2'],5,undefined);
    await expect(Messages.unifiedSearch('q',{userId:'u',serverIds:['s']},'9')).resolves.toEqual(['unified']);
    expect(db._unifiedSearch).toHaveBeenCalledWith('q',{userId:'u',serverIds:['s']},9);
    await expect(Messages.searchContext('m','dm',{userId:'u',serverIds:[]},3)).resolves.toEqual({messages:[],channelId:'c',serverId:'s'});
    expect(db._searchContext).toHaveBeenCalledWith('m','dm',{userId:'u',serverIds:[]},3);
  });

  it('uses atomic PostgreSQL reaction path and distinguishes unsupported, capped/not-found and updated states',async()=>{
    await expect(Messages.toggleReactionAtomic('m','👍','u')).resolves.toBeNull();
    const query=jest.fn<Promise<unknown>, unknown[]>()
      .mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({rows:[{reactions:null}]})
      .mockResolvedValueOnce({rows:[{reactions:{'👍':['u']}}]});
    db._pool={query};
    await expect(Messages.toggleReactionAtomic('m','👍','u')).resolves.toBe(false);
    await expect(Messages.toggleReactionAtomic('m','👍','u')).resolves.toEqual({});
    await expect(Messages.toggleReactionAtomic('m','👍','u')).resolves.toEqual({'👍':['u']});
    const [sql,params]=query.mock.calls[0];
    expect(sql).toContain('UPDATE messages');
    expect(sql).toContain('jsonb_object_keys');
    expect(params).toEqual(['m','👍','u']);
  });

  it('increments super reactions atomically on PG and preserves fallback semantics elsewhere',async()=>{
    const query=jest.fn<Promise<unknown>, unknown[]>().mockResolvedValueOnce({rows:[{count:'4'}]}).mockResolvedValueOnce({rows:[]});
    db._pool={query};
    await expect(Messages.incrementSuperReactionAtomic('m','⚡')).resolves.toBe(4);
    await expect(Messages.incrementSuperReactionAtomic('missing','⚡')).resolves.toBeNull();

    db._pool=undefined;
    messages.findOne.mockResolvedValueOnce(null);
    await expect(Messages.incrementSuperReactionAtomic('x','⚡')).resolves.toBeNull();
    messages.findOne.mockResolvedValueOnce({_id:'m',superReactions:null});
    await expect(Messages.incrementSuperReactionAtomic('m','⚡')).resolves.toBe(1);
    expect(messages.update).toHaveBeenLastCalledWith({_id:'m'},{$set:{superReactions:{'⚡':1}}});
    messages.findOne.mockResolvedValueOnce({_id:'m',superReactions:{'⚡':2}});
    await expect(Messages.incrementSuperReactionAtomic('m','⚡')).resolves.toBe(3);
  });

  it('paginates in the correct direction, caps limits and escapes LIKE metacharacters',async()=>{
    foundRows=[{_id:'1',createdAt:1},{_id:'2',createdAt:2}];
    await expect(Messages.findByChannel('c')).resolves.toEqual([{_id:'2',createdAt:2},{_id:'1',createdAt:1}]);
    // Final21 Phase 16: soft-deleted rows are audit state and must not be listed (a deleted
    // message used to come back after a reload as a '[Mesaj silindi]' line).
    expect(find).toHaveBeenLastCalledWith({channelId:'c',deletedAt:null});
    expect(sort).toHaveBeenLastCalledWith({createdAt:-1,_id:-1});
    expect(limit).toHaveBeenLastCalledWith(50);

    foundRows=[{_id:'2',createdAt:2},{_id:'3',createdAt:3}];
    await expect(Messages.findByChannel('c',{after:1,limit:999,search:'50%_\\x'})).resolves.toEqual(foundRows);
    expect(find).toHaveBeenLastCalledWith({channelId:'c',deletedAt:null,$or:[{createdAt:{$gt:1}}],content:{$regex:'50\\%\\_\\\\x'}});
    expect(sort).toHaveBeenLastCalledWith({createdAt:1,_id:1});
    expect(limit).toHaveBeenLastCalledWith(101);

    await Messages.findByChannel('c',{before:9,limit:1});
    expect(find).toHaveBeenLastCalledWith({channelId:'c',deletedAt:null,$or:[{createdAt:{$lt:9}}]});
  });

  it('uses message ids as deterministic tie-breakers in both cursor directions',async()=>{
    await Messages.findByChannel('c',{before:9,beforeId:'m-050',limit:11});
    expect(find).toHaveBeenLastCalledWith({
      channelId:'c',
      deletedAt:null,
      $or:[{createdAt:{$lt:9}},{createdAt:9,_id:{$lt:'m-050'}}],
    });
    expect(sort).toHaveBeenLastCalledWith({createdAt:-1,_id:-1});

    await Messages.findByChannel('c',{after:0,afterId:'m-050',limit:11});
    expect(find).toHaveBeenLastCalledWith({
      channelId:'c',
      deletedAt:null,
      $or:[{createdAt:{$gt:0}},{createdAt:0,_id:{$gt:'m-050'}}],
    });
    expect(sort).toHaveBeenLastCalledWith({createdAt:1,_id:1});
  });

  it('covers CRUD, soft-delete and user/server cleanup helpers without changing their contracts',async()=>{
    messages.findOne.mockResolvedValueOnce({_id:'m'}).mockResolvedValueOnce({_id:'s'}).mockResolvedValueOnce({_id:'a'});
    await expect(Messages.findById('m')).resolves.toEqual({_id:'m'});
    await expect(Messages.findByScheduledId('sched')).resolves.toEqual({_id:'s'});
    await expect(Messages.findByAckIdForUser('ack','u')).resolves.toEqual({_id:'a'});
    // Final21 Phase 16: every new channel message is stored RAW (contentFormat 1).
    await expect(Messages.create({content:'x'})).resolves.toEqual({contentFormat:1,content:'x'});
    // A caller copying a LEGACY row keeps that row's format.
    await expect(Messages.create({content:'y',contentFormat:0})).resolves.toEqual({contentFormat:0,content:'y'});
    await Messages.update('m',{content:'y'});
    await Messages.softDelete('m','mod');
    const set=messages.update.mock.calls.at(-1)[1].$set;
    expect(set).toEqual(expect.objectContaining({content:'[Mesaj silindi]',deletedBy:'mod',deletedAt:expect.any(Number),fileUrl:null,editHistory:[]}));
    await expect(Messages.bulkSoftDelete([], 'mod')).resolves.toBe(0);
    await expect(Messages.bulkSoftDelete(Array.from({length:105},(_,i)=>String(i)),'mod')).resolves.toBe(100);
    await Messages.delete('m'); await Messages.deleteByChannel('c'); await Messages.removeByUser('u'); await Messages.removeByServer('s');
    await Messages.deleteUserMessages('u');
    await Messages.deleteUserMessages('u','s',new Date(123));
    await Messages.deleteUserMessages('u','s',456);
    expect(messages.remove).toHaveBeenCalledWith({userId:'u',serverId:'s',createdAt:{$gt:123}});
    expect(messages.remove).toHaveBeenCalledWith({userId:'u',serverId:'s',createdAt:{$gt:456}});
    messages.count.mockResolvedValueOnce(3).mockResolvedValueOnce(4);
    await expect(Messages.count({serverId:'s'})).resolves.toBe(3);
    await expect(Messages.countByChannel('c')).resolves.toBe(4);
  });

  it('marks only live reply snapshots deleted',async()=>{
    const rows=[
      {_id:'a',replyTo:{_id:'gone',content:'x'}},
      {_id:'b',replyTo:{_id:'gone',deleted:true}},
      {_id:'c',replyTo:{_id:'other'}},
    ];
    messages.find.mockResolvedValueOnce(rows);
    await expect(Messages.markRepliesDeleted('c','gone')).resolves.toBe(1);
    expect(messages.update).toHaveBeenCalledWith({_id:'a'},{$set:{replyTo:{_id:'gone',content:'x',deleted:true}}});
  });

  it('covers projection/raw-find/pin/thread helper contracts',async()=>{
    const raw:any={sort:jest.fn(()=>raw),limit:jest.fn(async()=>['pin'])};
    messages.find.mockReturnValue(raw);
    await Messages.findProjected({x:1},{projection:{x:1}});
    expect(messages.find).toHaveBeenCalledWith({x:1},{projection:{x:1}});
    await Messages.findWhere({y:2});
    expect(Messages.messagesFind({z:3})).toBe(raw);
    await expect(Messages.findPinsInChannel('c',7)).resolves.toEqual(['pin']);
    expect(raw.sort).toHaveBeenCalledWith({createdAt:-1}); expect(raw.limit).toHaveBeenCalledWith(7);
    await expect(Messages.clearThreadFromParent(null)).resolves.toBeNull();
    await Messages.clearThreadFromParent('m');
    expect(messages.update).toHaveBeenCalledWith({_id:'m'},{$set:{threadId:null,threadCount:0}});
    await Messages.findPinned('c');
    expect(messages.find).toHaveBeenCalledWith({channelId:'c',pinned:1,deletedAt:null});
  });

  it('findLastTimestamps fails fast on empty input and uses one indexed PG query',async()=>{
    await expect(Messages.findLastTimestamps([])).resolves.toEqual([]);
    // Imza URUN cagrisini yansitir: `query(sql, params)`. Parametresiz
    // yazilinca `mock.calls[0][1]` "tuple has no element at index 1" veriyordu.
    const query=jest.fn<Promise<unknown>, [sql: string, params?: readonly unknown[]]>(async()=>({rows:[{channelId:'c1',lastAt:'123'},{channelId:'c2',lastAt:456}]}));
    db._pool={query};
    await expect(Messages.findLastTimestamps(['c1','c2'])).resolves.toEqual([{channelId:'c1',lastAt:123},{channelId:'c2',lastAt:456}]);
    expect(query.mock.calls[0][0]).toContain('LEFT JOIN LATERAL');
    expect(query.mock.calls[0][1]).toEqual([['c1','c2']]);
  });

  it('findLastTimestamps fallback de-duplicates channels keeping newest sorted rows',async()=>{
    const chain:any={sort:jest.fn(async()=>[
      {channelId:'c1',createdAt:9},
      {channelId:'c2',createdAt:8},
      {channelId:'c1',createdAt:2},
    ])};
    messages.find.mockReturnValueOnce(chain);
    await expect(Messages.findLastTimestamps(['c1','c2'])).resolves.toEqual([{channelId:'c1',lastAt:9},{channelId:'c2',lastAt:8}]);
    expect(messages.find).toHaveBeenCalledWith({channelId:{$in:['c1','c2']}});
    expect(chain.sort).toHaveBeenCalledWith({createdAt:-1});
  });
});
