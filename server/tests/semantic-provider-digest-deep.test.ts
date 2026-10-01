process.env.NODE_ENV='test';
const request=require('supertest');
const express=require('express');

type Opts={
  ai?:boolean; pg?:boolean; provider?:string; cacheValue?:any; member?:any; viewable?:string[];
  searchMessages?:any[]; users?:any[]; channels?:any[]; embedding?:any; vectorMatches?:any[]; vectorError?:any; aiResult?:any; aiError?:any;
  findWhereMessages?: (filter:any)=>any[] | Promise<any[]>; members?:any[];
};

function setup(o:Opts={}){
  jest.resetModules();
  const cacheGet=jest.fn(async()=>o.cacheValue??null), cacheSet=jest.fn(async()=>undefined);
  const memberFindOne=jest.fn(async()=>o.member===undefined?{userId:'u1',serverId:'s1'}:o.member);
  const memberFindByServer=jest.fn(async()=>o.members??[{userId:'u1'},{userId:'u2'}]);
  const defaultMsgs=o.searchMessages??[
    {_id:'m1',serverId:'s1',channelId:'c1',userId:'u1',content:'alpha important decision',createdAt:100,reactions:'{"ok":["u1","u2"]}'},
    {_id:'m2',serverId:'s1',channelId:'c2',userId:'u2',content:'beta project update',createdAt:200,reactions:'bad-json'},
  ];
  const messagesFind=jest.fn((_f:any)=>({sort:jest.fn(()=>({limit:jest.fn(async()=>defaultMsgs.map(x=>({...x}))) }))}));
  const findWhere=jest.fn(async(filter:any)=> o.findWhereMessages ? await o.findWhereMessages(filter) : defaultMsgs.map(x=>({...x})));
  const usersFind=jest.fn(async()=>o.users??[{_id:'u1',displayName:'Alice',username:'alice'},{_id:'u2',displayName:'',username:'bob'}]);
  const channelFind=jest.fn(async()=>o.channels??[{_id:'c1',name:'general',serverId:'s1',type:'text'},{_id:'c2',name:'private',serverId:'s1',type:'text'}]);
  const viewableChannelIds=jest.fn(async(_u:string,_s:string,ids:string[])=>new Set(o.viewable??ids));
  const generateEmbedding=jest.fn(async()=>o.embedding===undefined?[0.1,0.2]:o.embedding);
  const vectorSearch=jest.fn(async()=>{if(o.vectorError!==undefined) throw o.vectorError; return o.vectorMatches??[];});
  const callAI=jest.fn(async()=>{if(o.aiError!==undefined) throw o.aiError; return o.aiResult??'{"indices":[0],"explanation":"picked"}';});

  jest.doMock('../middleware/auth',()=>({authMiddleware:(req:any,_res:any,next:any)=>{req.user={id:'u1'};next();}}));
  jest.doMock('../lib/authSafe',()=>({safeCastAuthed:(r:any)=>r}));
  jest.doMock('../middleware/rateLimit',()=>({limits:{ai:()=> (_r:any,_s:any,n:any)=>n()}}));
  jest.doMock('../lib/redisAdapter',()=>({cache:{get:cacheGet,set:cacheSet}}));
  jest.doMock('../db/repositories',()=>({
    Members:{findOne:memberFindOne,findByServer:memberFindByServer},
    Messages:{messagesFind,findWhere}, Users:{findByIds:usersFind}, Channels:{findWhere:channelFind},
    // P6: the per-server AI gate reads the server row; a migrated row allows AI by default.
    Servers:{findById:async()=>({_id:'s1',aiEnabled:true})},
  }));
  jest.doMock('../lib/permissions',()=>({viewableChannelIds}));
  jest.doMock('../lib/pgvector',()=>({generateEmbedding,vectorSearch,PGVECTOR_ENABLED:o.pg??false,EMBEDDING_PROVIDER:'test-embed'}));
  jest.doMock('../db/postgres',()=>({pool:{query:jest.fn()}}));
  jest.doMock('../lib/aiProvider',()=>({callAI,AI_ENABLED:o.ai??false,PROVIDER:o.provider??'mock-ai'}));
  jest.doMock('../lib/logger',()=>({__esModule:true,default:{warn:jest.fn(),info:jest.fn(),error:jest.fn(),debug:jest.fn()}}));

  const router=require('../routes/semantic').default; const app=express(); app.use(express.json()); app.use('/api/semantic',router);
  return {app,cacheGet,cacheSet,memberFindOne,memberFindByServer,messagesFind,findWhere,usersFind,channelFind,viewableChannelIds,generateEmbedding,vectorSearch,callAI};
}

describe('semantic search provider and privacy branches',()=>{
  afterEach(()=>{jest.restoreAllMocks();jest.clearAllMocks();});

  it.each([
    [{},'query gerekli'],
    [{query:'x'.repeat(501),serverId:'s1'},'query çok uzun'],
    [{query:'q'},'serverId gerekli'],
    [{query:'q',serverId:'s1',channelId:123},'channelId geçersiz'],
    [{query:'q',serverId:'s1',channelId:'   '},'channelId geçersiz'],
    [{query:'q',serverId:'s1',days:0},'days/limit'],
    [{query:'q',serverId:'s1',limit:51},'days/limit'],
  ])('rejects malformed search body %#',async(body,error)=>{const {app}=setup();const r=await request(app).post('/api/semantic/search').send(body);expect(r.status).toBe(400);expect(r.body.error).toMatch(new RegExp(error));});

  it('treats an array body as empty rather than trusting inherited request fields',async()=>{const {app}=setup();const r=await request(app).post('/api/semantic/search').send([]);expect(r.status).toBe(400);expect(r.body.error).toMatch(/query/);});

  it('returns a per-user cached result before querying messages',async()=>{const cached={matches:[{_id:'cached'}],query:'alpha',provider:'rules',total:1,days:7,limit:10};const s=setup({cacheValue:cached});const r=await request(s.app).post('/api/semantic/search').send({query:' alpha ',serverId:' s1 '});expect(r.status).toBe(200);expect(r.body.cached).toBe(true);expect(s.messagesFind).not.toHaveBeenCalled();expect(s.cacheGet).toHaveBeenCalledWith(expect.stringContaining('sem:u1:s1:'))});

  it('returns provider none when channel visibility filters every candidate before AI/vector processing',async()=>{const s=setup({ai:true,pg:true,viewable:[]});const r=await request(s.app).post('/api/semantic/search').send({query:'alpha',serverId:'s1'});expect(r.status).toBe(200);expect(r.body).toMatchObject({provider:'none',total:0,aiDisabled:false});expect(s.generateEmbedding).not.toHaveBeenCalled();expect(s.callAI).not.toHaveBeenCalled();});

  it('returns a 403 for a nonmember before touching cache or expensive providers',async()=>{const s=setup({member:null,ai:true,pg:true});const r=await request(s.app).post('/api/semantic/search').send({query:'q',serverId:'s1'});expect(r.status).toBe(403);expect(s.cacheGet).not.toHaveBeenCalled();expect(s.generateEmbedding).not.toHaveBeenCalled();});

  it('uses pgvector matches restricted to viewable channel ids and fills safe display fallbacks',async()=>{
    const s=setup({pg:true,viewable:['c1','c2'],vectorMatches:[{message_id:'missing'},{message_id:'m2'},{message_id:'m1'}],users:[{_id:'u1',displayName:'Alice',username:'alice'}],channels:[{_id:'c1',name:'general'}]});
    const r=await request(s.app).post('/api/semantic/search').send({query:'q',serverId:'s1',limit:2});
    expect(r.status).toBe(200); expect(r.body.provider).toBe('pgvector:test-embed'); expect(r.body.matches).toHaveLength(2); expect(r.body.matches[0]).toMatchObject({_id:'m2',username:'?',channelName:'?'});
    expect(s.vectorSearch).toHaveBeenCalledWith(expect.objectContaining({serverId:'s1',channelIds:['c1','c2'],limit:2}));
  });

  it('passes an explicit channelId to pgvector instead of a broader candidate list',async()=>{const s=setup({pg:true,searchMessages:[{_id:'m1',channelId:'c1',userId:'u1',content:'q',createdAt:1}],viewable:['c1'],vectorMatches:[{message_id:'m1'}]});const r=await request(s.app).post('/api/semantic/search').send({query:'q',serverId:'s1',channelId:'c1'});expect(r.status).toBe(200);expect(s.vectorSearch).toHaveBeenCalledWith(expect.objectContaining({channelId:'c1',channelIds:undefined}));});

  it.each([
    {name:'no embedding',opts:{pg:true,embedding:null}},
    {name:'empty vector result',opts:{pg:true,vectorMatches:[]}},
    {name:'vector IDs absent from fetched candidates',opts:{pg:true,vectorMatches:[{message_id:'missing'}]}},
    {name:'vector provider throws',opts:{pg:true,vectorError:new Error('vector down')}},
  ])('falls back to keyword rules when pgvector yields no usable result: $name',async({opts})=>{const s=setup(opts as any);const r=await request(s.app).post('/api/semantic/search').send({query:'alpha',serverId:'s1'});expect(r.status).toBe(200);expect(r.body.provider).toBe('rules');expect(r.body.matches[0]._id).toBe('m1');});

  it('uses AI JSON indices, rejects unsafe/out-of-range indices, deduplicated message metadata, and provider identity',async()=>{const s=setup({ai:true,provider:'groq-test',aiResult:'```json\n{"indices":[-1,0,999,1.5,1],"explanation":"why"}\n```'});const r=await request(s.app).post('/api/semantic/search').send({query:'project',serverId:'s1',limit:10});expect(r.status).toBe(200);expect(r.body.provider).toBe('groq-test');expect(r.body.matches.map((m:any)=>m._id)).toEqual(['m1','m2']);expect(r.body.explanation).toBe('why');expect(s.callAI).toHaveBeenCalledWith(expect.stringContaining('Semantic arama'),expect.stringContaining('Mesajlar:'),200);});

  it('accepts an AI object without indices/explanation as an empty, bounded AI result',async()=>{const s=setup({ai:true,aiResult:'{}'});const r=await request(s.app).post('/api/semantic/search').send({query:'alpha',serverId:'s1'});expect(r.status).toBe(200);expect(r.body.matches).toEqual([]);expect(r.body.explanation).toBe('');});

  it.each(['not json','```json\n{broken}\n```'])('falls back to keyword matching when AI output cannot be trusted: %s',async aiResult=>{const s=setup({ai:true,aiResult});const r=await request(s.app).post('/api/semantic/search').send({query:'project',serverId:'s1'});expect(r.status).toBe(200);expect(r.body.provider).toBe('rules');expect(r.body.explanation).toMatch(/Anahtar kelime/);expect(r.body.matches[0]._id).toBe('m2');});

  it('falls back to keyword matching when AI call itself fails',async()=>{const s=setup({ai:true,aiError:new Error('provider down')});const r=await request(s.app).post('/api/semantic/search').send({query:'important decision',serverId:'s1',limit:1});expect(r.status).toBe(200);expect(r.body.matches).toHaveLength(1);expect(r.body.matches[0]._id).toBe('m1');});
});

describe('semantic digest and engagement behavior',()=>{
  afterEach(()=>{jest.restoreAllMocks();jest.clearAllMocks();});

  it('serves digest cache without recomputing channel/message metadata',async()=>{const s=setup({cacheValue:{serverId:'s1',days:7,totalMessages:4}});const r=await request(s.app).get('/api/semantic/digest/s1');expect(r.status).toBe(200);expect(r.body.cached).toBe(true);expect(s.channelFind).not.toHaveBeenCalled();});

  it('digest excludes hidden channels/messages, tolerates malformed reactions, counts array reactions, and summarizes visible content',async()=>{
    const rows=[
      {_id:'m1',serverId:'s1',channelId:'c1',userId:'u1',content:'visible newest',createdAt:300,reactions:'{"a":[1,2],"b":"bad"}'},
      {_id:'m2',serverId:'s1',channelId:'c1',userId:'u2',content:'visible old',createdAt:200,reactions:'bad-json'},
      {_id:'secret',serverId:'s1',channelId:'c2',userId:'secret-user',content:'top secret',createdAt:400,reactions:'{"x":[1,2,3]}'},
    ];
    const s=setup({ai:true,viewable:['c1'],searchMessages:rows,findWhereMessages:()=>rows,aiResult:'digest summary'});
    const r=await request(s.app).get('/api/semantic/digest/s1?days=14');
    expect(r.status).toBe(200);expect(r.body.days).toBe(14);expect(r.body.totalMessages).toBe(2);expect(r.body.channelStats).toHaveLength(1);expect(r.body.channelStats[0].topMessages[0].reactionCount).toBe(2);expect(r.body.topUsers.map((x:any)=>x.userId)).not.toContain('secret-user');expect(r.body.aiSummary).toBe('digest summary');expect(s.callAI).toHaveBeenCalledWith(expect.stringContaining('digest'),expect.not.stringContaining('top secret'),300);expect(s.cacheSet).toHaveBeenCalledWith(expect.stringContaining('digest:u1:s1:14'),expect.any(Object),1800);
  });

  it('digest contains AI failure and returns null summary without losing deterministic stats',async()=>{const s=setup({ai:true,aiError:new Error('ai down')});const r=await request(s.app).get('/api/semantic/digest/s1');expect(r.status).toBe(200);expect(r.body.aiSummary).toBeNull();expect(r.body.totalMessages).toBe(2);});

  it('digest does not invoke AI for an empty visible corpus',async()=>{const s=setup({ai:true,viewable:[],findWhereMessages:()=>[]});const r=await request(s.app).get('/api/semantic/digest/s1');expect(r.status).toBe(200);expect(r.body.aiSummary).toBeNull();expect(s.callAI).not.toHaveBeenCalled();});

  it('engagement returns zero with no members and stable trend with no visible messages',async()=>{const s=setup({members:[],viewable:[],findWhereMessages:()=>[]});const r=await request(s.app).get('/api/semantic/engagement/s1');expect(r.status).toBe(200);expect(r.body.periods.every((p:any)=>p.engagementPct===0&&p.totalMembers===0)).toBe(true);expect(r.body.trend).toEqual({pct:0,direction:'stable'});expect(r.body.peakHour).toBe(0);expect(r.body.peakHourFormatted).toBe('0:00 - 1:00');});

  it.each([
    {label:'up',first:8,second:8,expected:'up'},
    {label:'down',first:1,second:8,expected:'down'},
  ])('computes $label trend and peak hour only from visible messages',async({first,second,expected})=>{
    let call=0; const now=Date.now();
    const s=setup({members:Array.from({length:4},(_,i)=>({userId:`u${i}`})),viewable:['c1'],findWhereMessages:()=>{call++; const n=call===1?first:call===2?second:3; return Array.from({length:n},(_,i)=>({channelId:'c1',userId:`u${i%3}`,createdAt:new Date(2026,0,1,23,0,i).getTime()}));}});
    jest.spyOn(Date,'now').mockReturnValue(now);
    const r=await request(s.app).get('/api/semantic/engagement/s1');expect(r.status).toBe(200);expect(r.body.trend.direction).toBe(expected);expect(r.body.peakHour).toBe(23);expect(r.body.peakHourFormatted).toBe('23:00 - 0:00');
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
