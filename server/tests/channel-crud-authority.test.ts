'use strict';
process.env.NODE_ENV='test';
import express from 'express';
import request from 'supertest';

const Channels:any={
  findByServer:jest.fn(),insert:jest.fn(),createUnderCapAtomic:jest.fn(),findByIdAndServer:jest.fn(),updateByIdAndServer:jest.fn(),deleteGraphAtomic:jest.fn(),
};
const Members:any={findOne:jest.fn()};
const getMemberPerms=jest.fn(); const resolvePermissions=jest.fn(); const viewableChannelIds=jest.fn();
const cache={get:jest.fn(),set:jest.fn(),del:jest.fn()};
const VIEW=1, MANAGE=2;
jest.mock('../db/repositories',()=>({Channels,Members}));
jest.mock('../middleware/auth',()=>({authMiddleware:(req:any,_res:any,next:any)=>{req.user={id:'u'};next();}}));
jest.mock('../middleware/rateLimit',()=>({limits:{channels:()=> (_req:any,_res:any,next:any)=>next()}}));
jest.mock('../routes/roles',()=>({getMemberPerms,hasPermission:(p:number,b:number)=>(p&b)!==0,PERMS:{VIEW_CHANNELS:VIEW,MANAGE_CHANNELS:MANAGE}}));
jest.mock('../lib/permissions',()=>({resolvePermissions,viewableChannelIds}));
jest.mock('../lib/authSafe',()=>({safeCastAuthed:(req:any)=>req}));
jest.mock('../lib/redisAdapter',()=>({cache}));
jest.mock('uuid',()=>({v4:()=> 'channel-id'}));
import router from '../routes/servers/channels';

const app=express();app.use(express.json());app.use('/api/servers/:sid/channels',router);

describe('channel CRUD canonical authority and validation',()=>{
  beforeEach(()=>{
    jest.clearAllMocks(); process.env.MAX_CHANNELS_PER_SERVER='500';
    getMemberPerms.mockResolvedValue(VIEW|MANAGE); resolvePermissions.mockResolvedValue(VIEW|MANAGE); viewableChannelIds.mockImplementation(async(_u:string,_s:string,ids:string[])=>new Set(ids));
    Members.findOne.mockResolvedValue({userId:'u',serverId:'s'}); cache.get.mockResolvedValue(null); cache.set.mockResolvedValue(undefined); cache.del.mockResolvedValue(undefined);
    Channels.findByServer.mockResolvedValue([]);Channels.insert.mockImplementation(async(x:any)=>x);
    Channels.createUnderCapAtomic.mockImplementation(async(input:any)=>{
      const existing=await Channels.findByServer(input.serverId);
      if(existing.length>=input.cap)return {status:'limit'};
      return {status:'created',channel:{_id:input.id,...input,order:existing.length,position:existing.length}};
    });
    Channels.findByIdAndServer.mockResolvedValue({_id:'c',serverId:'s',name:'general',forumTags:'[]'});Channels.updateByIdAndServer.mockResolvedValue({updated:1});Channels.deleteGraphAtomic.mockResolvedValue('deleted');
  });
  afterAll(()=>{delete process.env.MAX_CHANNELS_PER_SERVER;});

  it('GET list requires membership and filters every cache hit through current visibility',async()=>{
    Members.findOne.mockResolvedValueOnce(null);
    expect((await request(app).get('/api/servers/s/channels')).status).toBe(403);
    cache.get.mockResolvedValueOnce([{_id:'public',forumTags:'[]'},{_id:'private',forumTags:'[]'}]);
    viewableChannelIds.mockResolvedValueOnce(new Set(['public']));
    const r=await request(app).get('/api/servers/s/channels');
    expect(r.status).toBe(200);expect(r.headers['x-cache']).toBe('HIT');expect(r.body.map((x:any)=>x._id)).toEqual(['public']);
  });

  it('GET list falls back to DB on cache failure and cache writes are best effort',async()=>{
    cache.get.mockRejectedValueOnce(new Error('redis'));cache.set.mockRejectedValueOnce(new Error('redis'));
    Channels.findByServer.mockResolvedValueOnce([{_id:'c',forumTags:'bad'}]);
    const r=await request(app).get('/api/servers/s/channels');
    expect(r.status).toBe(200);expect(r.headers['x-cache']).toBe('MISS');expect(r.body[0].forumTags).toEqual([]);
  });
  it('GET list returns a sanitized 500 when membership lookup fails',async()=>{
    Members.findOne.mockRejectedValueOnce(new Error('membership db secret'));
    const r=await request(app).get('/api/servers/s/channels');
    expect(r.status).toBe(500);expect(r.body).toEqual({error:'Internal server error'});
    expect(Channels.findByServer).not.toHaveBeenCalled();
  });

  it('POST requires MANAGE_CHANNELS before validating body',async()=>{
    getMemberPerms.mockResolvedValue(VIEW);
    const r=await request(app).post('/api/servers/s/channels').send({});
    expect(r.status).toBe(403);expect(Channels.findByServer).not.toHaveBeenCalled();
  });
  it.each([
    [{type:'text'},'Channel name required'],
    [{name:'x',type:'invalid'},'Invalid channel type'],
    [{name:'x',type:'text',topic:5},'Invalid topic'],
    [{name:'x',type:'text',nsfw:'false'},'Invalid nsfw value'],
    [{name:'x',type:'voice',bitrate:1.5},'Invalid bitrate'],
    [{name:'x',type:'text',slowmode:7},'Invalid slowmode'],
    [{name:'x',type:'forum',forumTags:{}},'Invalid forumTags'],
  ])('POST rejects malformed channel input %#',async(body,msg)=>{
    const r=await request(app).post('/api/servers/s/channels').send(body);expect(r.status).toBe(400);expect(r.body.error).toBe(msg);
  });
  it('POST enforces a validated server channel cap without inserting',async()=>{
    process.env.MAX_CHANNELS_PER_SERVER='2';Channels.findByServer.mockResolvedValue([{_id:'1'},{_id:'2'}]);
    const r=await request(app).post('/api/servers/s/channels').send({name:'x',type:'text'});expect(r.status).toBe(400);expect(Channels.insert).not.toHaveBeenCalled();
  });
  it('POST fails closed on a malformed channel-cap configuration',async()=>{
    process.env.MAX_CHANNELS_PER_SERVER='-5';Channels.findByServer.mockResolvedValue(Array.from({length:500},(_,i)=>({_id:String(i)})));
    expect((await request(app).post('/api/servers/s/channels').send({name:'x',type:'text'})).status).toBe(500);
    expect(Channels.createUnderCapAtomic).not.toHaveBeenCalled();
  });
  it('POST canonicalizes fields and writes real JSONB-shaped forum tags',async()=>{
    Channels.findByServer.mockResolvedValue([{_id:'1'}]);
    const r=await request(app).post('/api/servers/s/channels').send({name:' My Cool CH! ',type:'voice',topic:'  hello  ',category:' social ',nsfw:true,bitrate:999999,slowmode:10,forumTags:[{id:'a',name:' Tag ',color:'#AABBCC'}]});
    expect(r.status).toBe(201);expect(Channels.createUnderCapAtomic).toHaveBeenCalledWith(expect.objectContaining({id:'channel-id',serverId:'s',name:'my-cool-ch',type:'voice',topic:'hello',category:'SOCIAL',nsfw:1,bitrate:384000,slowmode:10,forumTags:[{id:'a',name:'Tag',color:'#AABBCC'}],createdAt:expect.any(Number),cap:500}));
    expect(cache.del).toHaveBeenCalledWith('channels:list:s');
  });
  it('POST returns sanitized 500 on repository error',async()=>{getMemberPerms.mockRejectedValue(new Error('db secret'));const r=await request(app).post('/api/servers/s/channels').send({name:'x',type:'text'});expect(r.status).toBe(500);expect(r.body).toEqual({error:'Internal server error'});});

  it('PATCH resolves channel inside server before permission checks',async()=>{Channels.findByIdAndServer.mockResolvedValue(null);const r=await request(app).patch('/api/servers/s/channels/c').send({topic:'x'});expect(r.status).toBe(404);expect(resolvePermissions).not.toHaveBeenCalled();});
  it.each([0,VIEW,MANAGE])('PATCH requires both VIEW and MANAGE (%s)',async(perms)=>{resolvePermissions.mockResolvedValue(perms);const r=await request(app).patch('/api/servers/s/channels/c').send({topic:'x'});expect(r.status).toBe(403);expect(Channels.updateByIdAndServer).not.toHaveBeenCalled();});
  it('PATCH permission resolver failure fails closed',async()=>{resolvePermissions.mockRejectedValue(new Error('perm db'));const r=await request(app).patch('/api/servers/s/channels/c').send({topic:'x'});expect(r.status).toBe(403);});
  it.each([
    [{name:'   '},'Invalid channel name'],[{category:''},'Invalid category'],[{order:-1},'Invalid order'],[{position:1.5},'Invalid position'],[{slowmode:7},'Invalid slowmode'],[{forumTags:{}},'Invalid forumTags'],[{nsfw:'false'},'Invalid nsfw value'],[{bitrate:'64000'},'Invalid bitrate'],
  ])('PATCH rejects invalid typed update %#',async(body,msg)=>{const r=await request(app).patch('/api/servers/s/channels/c').send(body);expect(r.status).toBe(400);expect(r.body.error).toBe(msg);});
  it('PATCH canonicalizes scalar fields and sanitizes forum tags',async()=>{
    Channels.findByIdAndServer.mockResolvedValueOnce({_id:'c',serverId:'s'}).mockResolvedValueOnce({_id:'c',serverId:'s',forumTags:'[{"id":"ok","name":"Tag","color":"#abcdef"}]'});
    const tags=[{id:'id',name:'  Valid Tag  ',color:'#AABBCC'},{name:'',color:'#fff'},{name:'BadColor',color:'red'}];
    const r=await request(app).patch('/api/servers/s/channels/c').send({name:' New Name! ',topic:'  topic ',category:' cat ',order:4,position:3,slowmode:10,forumTags:tags,nsfw:false,bitrate:100});
    expect(r.status).toBe(200);
    const updates=Channels.updateByIdAndServer.mock.calls[0][2];expect(updates).toEqual(expect.objectContaining({name:'new-name',topic:'topic',category:'CAT',order:4,position:3,slowmode:10,nsfw:0,bitrate:8000}));
    expect(updates.forumTags).toEqual([{id:'id',name:'Valid Tag',color:'#AABBCC'},{id:expect.stringMatching(/^tag-/),name:'BadColor',color:'#2d9cdb'}]);
    expect(r.body.forumTags).toEqual([{id:'ok',name:'Tag',color:'#abcdef'}]);
  });
  it('PATCH returns null if the channel disappears after the scoped update',async()=>{Channels.findByIdAndServer.mockResolvedValueOnce({_id:'c',serverId:'s'}).mockResolvedValueOnce(null);const r=await request(app).patch('/api/servers/s/channels/c').send({topic:'x'});expect(r.status).toBe(200);expect(r.body).toBeNull();});
  it('PATCH returns 500 on update failure',async()=>{Channels.updateByIdAndServer.mockRejectedValue(new Error('db'));expect((await request(app).patch('/api/servers/s/channels/c').send({topic:'x'})).status).toBe(500);});

  it('GET hides missing, unauthorized and permission-store-failure channels with 404',async()=>{
    Channels.findByIdAndServer.mockResolvedValueOnce(null);expect((await request(app).get('/api/servers/s/channels/c')).status).toBe(404);
    Channels.findByIdAndServer.mockResolvedValueOnce({_id:'c',serverId:'s'});resolvePermissions.mockResolvedValueOnce(0);expect((await request(app).get('/api/servers/s/channels/c')).status).toBe(404);
    resolvePermissions.mockRejectedValueOnce(new Error('x'));expect((await request(app).get('/api/servers/s/channels/c')).status).toBe(404);
  });
  it('GET normalizes array/string/malformed forumTags safely',async()=>{
    Channels.findByIdAndServer.mockResolvedValueOnce({_id:'c',serverId:'s',forumTags:[{name:'x'}]});expect((await request(app).get('/api/servers/s/channels/c')).body.forumTags).toEqual([{name:'x'}]);
    Channels.findByIdAndServer.mockResolvedValueOnce({_id:'c',serverId:'s',forumTags:'bad'});expect((await request(app).get('/api/servers/s/channels/c')).body.forumTags).toEqual([]);
  });
  it('GET channel returns a sanitized 500 when the scoped lookup fails',async()=>{
    Channels.findByIdAndServer.mockRejectedValueOnce(new Error('channel db secret'));
    const r=await request(app).get('/api/servers/s/channels/c');
    expect(r.status).toBe(500);expect(r.body).toEqual({error:'Internal server error'});
    expect(resolvePermissions).not.toHaveBeenCalled();
  });

  it('DELETE requires both channel permissions before touching the graph',async()=>{
    Channels.findByIdAndServer.mockResolvedValueOnce(null);expect((await request(app).delete('/api/servers/s/channels/c')).status).toBe(404);
    for(const perms of [0,VIEW,MANAGE]){Channels.findByIdAndServer.mockResolvedValueOnce({_id:'c',serverId:'s'});resolvePermissions.mockResolvedValueOnce(perms);expect((await request(app).delete('/api/servers/s/channels/c')).status).toBe(403);}
    expect(Channels.deleteGraphAtomic).not.toHaveBeenCalled();
  });
  it('DELETE delegates durability/last-channel concurrency to the canonical repository owner',async()=>{
    Channels.deleteGraphAtomic.mockResolvedValueOnce('last_channel');expect((await request(app).delete('/api/servers/s/channels/c')).status).toBe(400);
    Channels.deleteGraphAtomic.mockResolvedValueOnce('not_found');expect((await request(app).delete('/api/servers/s/channels/c')).status).toBe(404);
    Channels.deleteGraphAtomic.mockResolvedValueOnce('deleted');const r=await request(app).delete('/api/servers/s/channels/c');expect(r.status).toBe(200);expect(r.body).toEqual({deleted:true});expect(Channels.deleteGraphAtomic).toHaveBeenLastCalledWith('c','s');
  });
  it('DELETE returns sanitized 500 on transaction failure',async()=>{Channels.deleteGraphAtomic.mockRejectedValueOnce(new Error('db secret'));const r=await request(app).delete('/api/servers/s/channels/c');expect(r.status).toBe(500);expect(r.body).toEqual({error:'Internal server error'});});
});
