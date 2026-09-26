'use strict';
process.env.NODE_ENV='test';
const query=jest.fn();
jest.mock('../db/postgres/pool',()=>({pool:{query}}));
const debug=jest.fn();
jest.mock('../lib/logger',()=>({__esModule:true,default:{debug}}));
import {searchContext,anchorParams,windowParams,windowSql,MAX_CONTEXT_RADIUS} from '../db/postgres/search-context';

describe('searchContext production privacy behavior',()=>{
  beforeEach(()=>{jest.clearAllMocks();});
  it('fails closed before SQL for malformed/unsupported scopes',async()=>{
    await expect(searchContext('', 'channel',{userId:'u',serverIds:['s']})).resolves.toBeNull();
    await expect(searchContext('m','channel',{userId:'',serverIds:['s']})).resolves.toBeNull();
    await expect(searchContext('m','bogus' as any,{userId:'u',serverIds:['s']})).resolves.toBeNull();
    await expect(searchContext('m','channel',{userId:'u',serverIds:[]})).resolves.toBeNull();
    await expect(searchContext('m','thread',{userId:'u',serverIds:[]})).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
  it('parameter helpers default missing server lists and bound window radius safely',()=>{
    expect(anchorParams('channel','m',{userId:'u',serverIds:undefined as any})).toEqual(['m',[]]);
    expect(windowParams('thread','t',{userId:'u',serverIds:undefined as any},5,2)).toEqual(['t',[],5,2]);
    expect(anchorParams('dm','m',{userId:'u',serverIds:[]})).toEqual(['m','u']);
    expect(windowSql('channel','before')).toMatch(/createdAt" < \$3/); expect(windowSql('thread','after')).toMatch(/createdAt" > \$3/);
    expect(windowSql('gdm','before')).toContain('JOIN group_dm_members'); expect(windowSql('dm','after')).toContain('c.participants ? $2');
    expect(MAX_CONTEXT_RADIUS).toBe(5);
  });
  it('returns null without distinguishing missing from unauthorized anchors',async()=>{
    query.mockResolvedValueOnce({rows:[]});
    await expect(searchContext('m','dm',{userId:'u',serverIds:[]})).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('returns null when anchor body vanishes after parallel authorization queries',async()=>{
    query.mockResolvedValueOnce({rows:[{createdAt:10,scope_id:'c',server_id:'s'}]})
      .mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]});
    await expect(searchContext('m','channel',{userId:'u',serverIds:['s']},2)).resolves.toBeNull();
  });
  it('builds ordered channel context, clamps radius high, and preserves canonical server/channel ids',async()=>{
    query.mockResolvedValueOnce({rows:[{createdAt:'10',scope_id:'c',server_id:'s'}]})
      .mockResolvedValueOnce({rows:[{_id:'b2',userId:'u2',displayName:null,content:'2',createdAt:9},{_id:'b1',userId:'u1',displayName:'A',content:'1',createdAt:8}]})
      .mockResolvedValueOnce({rows:[{_id:'a',userId:'u3',displayName:'C',content:null,createdAt:11}]})
      .mockResolvedValueOnce({rows:[{_id:'m',userId:'u',displayName:'Me',content:'anchor',createdAt:10}]});
    const out=await searchContext('m','channel',{userId:'u',serverIds:['s']},999);
    expect(out).toEqual({serverId:'s',channelId:'c',messages:[
      {_id:'b1',userId:'u1',displayName:'A',content:'1',createdAt:8,isAnchor:false},
      {_id:'b2',userId:'u2',displayName:null,content:'2',createdAt:9,isAnchor:false},
      {_id:'m',userId:'u',displayName:'Me',content:'anchor',createdAt:10,isAnchor:true},
      {_id:'a',userId:'u3',displayName:'C',content:null,createdAt:11,isAnchor:false},
    ]});
    expect(query.mock.calls[1][1].at(-1)).toBe(5);
  });
  it('resolves canonical parent channel for threads and handles missing thread parent privately',async()=>{
    query.mockResolvedValueOnce({rows:[{createdAt:10,scope_id:'t',server_id:'s'}]})
      .mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{_id:'m',userId:'u',createdAt:10}]})
      .mockResolvedValueOnce({rows:[{channelId:'c'}]});
    await expect(searchContext('m','thread',{userId:'u',serverIds:['s']},0)).resolves.toEqual(expect.objectContaining({channelId:'c',serverId:'s'}));
    jest.clearAllMocks();
    query.mockResolvedValueOnce({rows:[{createdAt:10,scope_id:'t',server_id:'s'}]})
      .mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{_id:'m',userId:'u',createdAt:10}]})
      .mockResolvedValueOnce({rows:[]});
    await expect(searchContext('m','thread',{userId:'u',serverIds:['s']})).resolves.toEqual(expect.objectContaining({channelId:null}));
  });
  it('DM/GDM contexts keep channel/server null and use user-scoped authorization parameters',async()=>{
    for(const source of ['dm','gdm'] as const){
      jest.clearAllMocks();
      query.mockResolvedValueOnce({rows:[{createdAt:10,scope_id:`${source}-1`,server_id:null}]})
        .mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{_id:'m',userId:'u',createdAt:10}]});
      const out=await searchContext('m',source,{userId:'u',serverIds:[]},2);
      expect(out).toEqual(expect.objectContaining({channelId:null,serverId:null}));
      expect(query.mock.calls[0][1]).toEqual(['m','u']);
      expect(query.mock.calls[1][1]).toEqual([`${source}-1`,'u',10,2]);
    }
  });
  it('logs internal query failures while returning privacy-preserving null',async()=>{
    query.mockRejectedValueOnce(new Error('db offline'));
    await expect(searchContext('m','dm',{userId:'u',serverIds:[]})).resolves.toBeNull();
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({event:'search_context.failed',source:'dm',messageId:'m',err:expect.any(Error)}),expect.any(String));
  });
  it('thread parent lookup failure is fail-closed to a null channel id',async()=>{
    query.mockResolvedValueOnce({rows:[{createdAt:10,scope_id:'t',server_id:'s'}]})
      .mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{_id:'m',userId:'u',createdAt:10}]})
      .mockRejectedValueOnce(new Error('parent lookup failed'));
    await expect(searchContext('m','thread',{userId:'u',serverIds:['s']})).resolves.toEqual(expect.objectContaining({channelId:null}));
  });
});
