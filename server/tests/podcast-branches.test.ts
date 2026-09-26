'use strict';
process.env.NODE_ENV='test';
process.env.JWT_SECRET='test-jwt-secret-long-enough-32chars!!';
process.env.RECORDINGS_DIR='/tmp/bridge-podcast-branches';

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

const mockResolvePermissions = jest.fn();
const mockHasLiveUploadReference = jest.fn();
const mockAssertUrlIsPublic = jest.fn();
const mockSpawn = jest.fn();

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../middleware/auth', () => {
  const jwt=require('jsonwebtoken');
  return {
    authMiddleware:(req:any,res:any,next:any)=>{
      const h=req.headers.authorization;
      if(!h?.startsWith('Bearer ')) return res.status(401).json({error:'No token'});
      try { req.user=jwt.verify(h.slice(7),process.env.JWT_SECRET); next(); } catch { return res.status(401).json({error:'Invalid token'}); }
    },
    verifyToken:(token:string)=>{ try { return jwt.verify(token,process.env.JWT_SECRET); } catch { return null; } },
  };
});
jest.mock('../lib/permissions',()=>({
  PERMS:{MANAGE_CHANNELS:1,MANAGE_SERVER:2},
  hasPermission:(p:number,b:number)=>(p&b)!==0,
  resolvePermissions:(...args:any[])=>mockResolvePermissions(...args),
}));
jest.mock('../lib/uploadReferenceSafety',()=>({hasLiveUploadReference:(...args:any[])=>mockHasLiveUploadReference(...args)}));
jest.mock('../lib/ssrfGuard',()=>({assertUrlIsPublic:(...args:any[])=>mockAssertUrlIsPublic(...args)}));
jest.mock('child_process',()=>({spawn:(...args:any[])=>mockSpawn(...args)}));

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import router from '../routes/podcast';
import { Podcasts } from '../db/repositories';
const db:any=require('../db/loader');

function app(){ const a=express(); a.use(express.json({limit:'5mb'})); a.use('/api/podcast',router); a.use((e:any,_q:any,r:any,_n:any)=>r.status(e.status||500).json({error:e.message})); return a; }
function tok(id:string){ return jwt.sign({id},process.env.JWT_SECRET!,{expiresIn:'1h'}); }

function fakeProc(){
  const p:any=new EventEmitter(); p.exitCode=null; p.signalCode=null;
  p.stdout=new EventEmitter(); p.stderr=new EventEmitter();
  p.kill=jest.fn((sig:string)=>{ p.signalCode=sig; queueMicrotask(()=>p.emit('exit',0,sig)); return true; });
  return p;
}

let A:any; const admin='pod-admin', outsider='pod-out', server='pod-srv';
async function seedChannel(id='pod-ch', owner=admin){
  if(!await db.users.findOne({_id:admin})) await db.users.insert({_id:admin,username:'admin',displayName:'Admin',isAdmin:false,tokenVersion:0});
  if(!await db.users.findOne({_id:outsider})) await db.users.insert({_id:outsider,username:'out',displayName:'Out',isAdmin:false,tokenVersion:0});
  if(!await db.servers.findOne({_id:server})) await db.servers.insert({_id:server,name:'Server',ownerId:owner});
  await db.channels.insert({_id:id,serverId:server,name:'Pod & <Channel>',type:'stage'});
  return id;
}

beforeAll(()=>{ fs.rmSync(process.env.RECORDINGS_DIR!,{recursive:true,force:true}); fs.mkdirSync(process.env.RECORDINGS_DIR!,{recursive:true}); });
afterAll(()=>fs.rmSync(process.env.RECORDINGS_DIR!,{recursive:true,force:true}));
beforeEach(()=>{
  db._reset?.(); A=app();
  jest.clearAllMocks(); mockResolvePermissions.mockResolvedValue(1); mockHasLiveUploadReference.mockResolvedValue(false); mockAssertUrlIsPublic.mockResolvedValue(undefined); mockSpawn.mockImplementation(()=>fakeProc());
  delete process.env.PODCAST_INPUT_ALLOWLIST; delete process.env.MAX_FILE_SIZE_MB;
});

describe('podcast public privacy/feed branches',()=>{
  it('RSS uses custom settings, escapes XML, season/episode and hour duration',async()=>{
    const ch=await seedChannel();
    await db.podcastSettings.insert({_id:'set',channelId:ch,title:'A & <B>',description:'D & <x>',author:'"Me"',imageUrl:'https://cdn.example/x?a=1&b=2',language:'en</language><owned>',category:'Tech & AI',explicit:true});
    await db.podcastEpisodes.insert({_id:'ep',channelId:ch,serverId:server,title:'E & <1>',description:'Desc <x>',audioUrl:'https://cdn.example/e?a=1&b=2',mimeType:'audio/mpeg" injected="yes',fileSize:22,durationSeconds:3661,season:2,episode:3,published:true,publishedAt:2,createdAt:1});
    const r=await request(A).get(`/api/podcast/${ch}/rss`);
    expect(r.status).toBe(200); expect(r.text).toContain('A &amp; &lt;B&gt;'); expect(r.text).toContain('<itunes:duration>1:01:01</itunes:duration>'); expect(r.text).toContain('<itunes:season>2</itunes:season>'); expect(r.text).toContain('a=1&amp;b=2'); expect(r.text).toContain('<itunes:explicit>yes</itunes:explicit>');
    expect(r.text).not.toContain('</language><owned>'); expect(r.text).toContain('en&lt;/language&gt;&lt;owned&gt;');
    expect(r.text).not.toContain('type="audio/mpeg" injected="yes"'); expect(r.text).toContain('type="audio/mpeg&quot; injected=&quot;yes"');
  });
  it('RSS and JSON feeds sort newest first and RSS contains CDATA terminators safely',async()=>{
    const ch=await seedChannel();
    await db.podcastEpisodes.insert({_id:'old',channelId:ch,title:'Old',description:'safe]]></description><injected>owned</injected><![CDATA[',filename:'old.mp3',published:true,publishedAt:1,createdAt:1});
    await db.podcastEpisodes.insert({_id:'new',channelId:ch,title:'New',filename:'new.mp3',published:true,publishedAt:2,createdAt:2});
    const rss=await request(A).get(`/api/podcast/${ch}/rss`);
    expect(rss.status).toBe(200);
    expect(rss.text.indexOf('<title>New</title>')).toBeLessThan(rss.text.indexOf('<title>Old</title>'));
    expect(rss.text).toContain('safe]]]]><![CDATA[></description><injected>owned</injected><![CDATA[');
    expect(rss.text).not.toContain('<![CDATA[safe]]></description><injected>owned</injected><![CDATA[]]>');
    const feed=await request(A).get(`/api/podcast/${ch}/feed.json`);
    expect(feed.status).toBe(200); expect(feed.body.items.map((item:any)=>item.title)).toEqual(['New','Old']);
  });
  it('JSON feed 404s unknown channel and default settings are synthesized without persistence',async()=>{
    expect((await request(A).get('/api/podcast/nope/feed.json')).status).toBe(404);
    const ch=await seedChannel(); await db.podcastEpisodes.insert({_id:'e',channelId:ch,title:'T',filename:'x.mp3',published:true,createdAt:1});
    const r=await request(A).get(`/api/podcast/${ch}/feed.json`); expect(r.status).toBe(200); expect(r.body.title).toBe('Pod & <Channel>'); expect(r.body.items[0].attachments[0].mime_type).toBe('audio/mpeg');
  });
  it('sparse legacy feed rows use safe public defaults without emitting broken optional markup',async()=>{
    const ch=await seedChannel();
    await db.channels.update({_id:ch},{$set:{name:''}});
    await db.podcastSettings.insert({_id:'sparse-settings',channelId:ch,title:'',description:'',author:'',imageUrl:'',language:'',category:'',explicit:false});
    await db.podcastEpisodes.insert({_id:'sparse-ep',channelId:ch,title:null,description:null,audioUrl:null,filename:'sparse.mp3',mimeType:null,fileSize:0,durationSeconds:0,season:null,episode:null,published:true,publishedAt:null,createdAt:10});

    const rss=await request(A).get(`/api/podcast/${ch}/rss`);
    expect(rss.status).toBe(200); expect(rss.text).toContain('<title>Bridge Podcast</title>');
    expect(rss.text).toContain('<language>tr</language>'); expect(rss.text).toContain('type="audio/mpeg"');
    expect(rss.text).toContain('<itunes:title>Episode</itunes:title>'); expect(rss.text).toContain('<itunes:duration>00:00</itunes:duration>');
    expect(rss.text).not.toContain('<itunes:season>'); expect(rss.text).not.toContain('<itunes:episode>');

    const feed=await request(A).get(`/api/podcast/${ch}/feed.json`);
    expect(feed.body).toMatchObject({title:'Bridge Podcast',description:'',authors:[{name:'Bridge'}],language:'tr'});
    expect(feed.body.items[0].attachments[0]).toMatchObject({mime_type:'audio/mpeg',size_in_bytes:0,duration_in_seconds:0});

    const embed=await request(A).get('/api/podcast/embed/sparse-ep');
    expect(embed.status).toBe(200); expect(embed.text).toContain('Podcast Episode');
    expect(embed.text).not.toContain('<div class="player-desc">'); expect(embed.text).not.toContain('<div class="player-duration">');
  });
  it('embed hides drafts, escapes HTML, and renders optional description/duration',async()=>{
    await seedChannel(); await db.podcastEpisodes.insert({_id:'draft',channelId:'pod-ch',title:'Draft',published:false});
    expect((await request(A).get('/api/podcast/embed/draft')).status).toBe(404);
    await db.podcastEpisodes.insert({_id:'pub',channelId:'pod-ch',title:'<b> & "x"',description:'<script>x</script>',audioUrl:'https://cdn.example/audio.mp3" onerror="alert(1)',durationSeconds:65,published:true});
    const r=await request(A).get('/api/podcast/embed/pub'); expect(r.status).toBe(200); expect(r.text).toContain('&lt;b&gt; &amp; &quot;x&quot;'); expect(r.text).not.toContain('<script>x</script>'); expect(r.text).toContain('1:05');
    expect(r.text).not.toContain('src="https://cdn.example/audio.mp3" onerror="alert(1)"');
    expect(r.text).toContain('src="https://cdn.example/audio.mp3&quot; onerror=&quot;alert(1)"');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
  it('episode listing silently narrows draft requests without valid/admin auth and honors page/limit',async()=>{
    const ch=await seedChannel();
    for(let i=0;i<4;i++) await db.podcastEpisodes.insert({_id:`e${i}`,channelId:ch,title:`E${i}`,filename:'x',published:i<2,publishedAt:i,createdAt:i});
    let r=await request(A).get(`/api/podcast/${ch}/episodes?published=all&page=bad&limit=bad`); expect(r.status).toBe(400);
    r=await request(A).get(`/api/podcast/${ch}/episodes?published=all`); expect(r.body.total).toBe(2); expect(r.body.page).toBe(1);
    mockResolvePermissions.mockResolvedValue(1);
    r=await request(A).get(`/api/podcast/${ch}/episodes?published=all&page=2&limit=2`).set('Authorization',`Bearer ${tok(admin)}`); expect(r.body.total).toBe(4); expect(r.body.page).toBe(2); expect(r.body.episodes).toHaveLength(2);
    mockResolvePermissions.mockRejectedValue(new Error('perm down'));
    r=await request(A).get(`/api/podcast/${ch}/episodes?published=false`).set('Authorization',`Bearer ${tok(admin)}`); expect(r.body.total).toBe(2);
  });
});

describe('podcast admin episode/settings branches',()=>{
  it('channel/server/permission authority fails closed',async()=>{
    expect((await request(A).post('/api/podcast/missing/episodes').set('Authorization',`Bearer ${tok(admin)}`).send({title:'T',filename:'x'})).status).toBe(404);
    await db.users.insert({_id:admin,username:'a',displayName:'A',isAdmin:false}); await db.channels.insert({_id:'orphan',serverId:'missing',name:'x'});
    expect((await request(A).post('/api/podcast/orphan/episodes').set('Authorization',`Bearer ${tok(admin)}`).send({title:'T',filename:'x'})).status).toBe(404);
    await seedChannel(); mockResolvePermissions.mockResolvedValue(0);
    expect((await request(A).post('/api/podcast/pod-ch/episodes').set('Authorization',`Bearer ${tok(outsider)}`).send({title:'T',filename:'x'})).status).toBe(403);
  });
  it('episode create validates required fields and parses false/numeric metadata',async()=>{
    const ch=await seedChannel();
    expect((await request(A).post(`/api/podcast/${ch}/episodes`).set('Authorization',`Bearer ${tok(admin)}`).send({filename:'x'})).status).toBe(400);
    expect((await request(A).post(`/api/podcast/${ch}/episodes`).set('Authorization',`Bearer ${tok(admin)}`).send({title:'T'})).status).toBe(400);
    const r=await request(A).post(`/api/podcast/${ch}/episodes`).set('Authorization',`Bearer ${tok(admin)}`).send({title:'  T  ',audioUrl:'https://cdn/e',published:'false',durationSeconds:'9',season:'2',episode:'4',fileSize:'12'});
    expect(r.status).toBe(201); expect(r.body.episode).toMatchObject({title:'T',published:false,publishedAt:null,durationSeconds:9,season:2,episode:4,fileSize:12});
    for (const bad of [
      { title:{x:1}, filename:'x' }, { title:'T', filename:'x', published:'maybe' },
      { title:'T', filename:'x', durationSeconds:'9x' }, { title:'T', filename:'x', fileSize:-1 },
      { title:'T', filename:'x', season:1.5 }, { title:'T', filename:'x', episode:'4x' },
      { title:'T', filename:'x', description:{x:1} }, { title:'T', filename:123 },
      { title:'T', audioUrl:123 }, { title:'T', filename:'x', mimeType:'' },
    ]) {
      expect((await request(A).post(`/api/podcast/${ch}/episodes`).set('Authorization',`Bearer ${tok(admin)}`).send(bad)).status).toBe(400);
    }
  });
  it('minimal episode create applies bounded canonical defaults',async()=>{
    const ch=await seedChannel();
    const r=await request(A).post(`/api/podcast/${ch}/episodes`).set('Authorization',`Bearer ${tok(admin)}`).send({title:'Minimal',filename:'minimal.mp3'});
    expect(r.status).toBe(201); expect(r.body.episode).toMatchObject({description:'',mimeType:'audio/mpeg',fileSize:0,durationSeconds:null,season:null,episode:null,published:true});
    expect(r.body.episode.publishedAt).toEqual(expect.any(Number));
  });
  it('delete 404s missing episode and removes an unreferenced local recording',async()=>{
    const ch=await seedChannel(); expect((await request(A).delete(`/api/podcast/${ch}/episodes/no`).set('Authorization',`Bearer ${tok(admin)}`)).status).toBe(404);
    const f='delete-me.mp3'; fs.writeFileSync(path.join(process.env.RECORDINGS_DIR!,f),Buffer.alloc(1200));
    await db.podcastEpisodes.insert({_id:'del',channelId:ch,title:'D',audioUrl:`/uploads/recordings/${f}`,published:true});
    const r=await request(A).delete(`/api/podcast/${ch}/episodes/del`).set('Authorization',`Bearer ${tok(admin)}`); expect(r.status).toBe(200); expect(fs.existsSync(path.join(process.env.RECORDINGS_DIR!,f))).toBe(false);
  });
  it('delete of a remote episode never treats its URL as a local recording path',async()=>{
    const ch=await seedChannel();
    await db.podcastEpisodes.insert({_id:'remote-delete',channelId:ch,title:'Remote',audioUrl:'https://cdn.example/remote.mp3',published:true});
    const r=await request(A).delete(`/api/podcast/${ch}/episodes/remote-delete`).set('Authorization',`Bearer ${tok(admin)}`);
    expect(r.status).toBe(200); expect(mockHasLiveUploadReference).not.toHaveBeenCalled();
  });
  it('shared reference or DB uncertainty preserves physical recording',async()=>{
    const ch=await seedChannel();
    for(const [id,mode] of [['shared','shared'],['uncertain','uncertain']] as const){ const f=`${id}.mp3`; fs.writeFileSync(path.join(process.env.RECORDINGS_DIR!,f),Buffer.alloc(1200)); await db.podcastEpisodes.insert({_id:id,channelId:ch,title:id,audioUrl:`/uploads/recordings/${f}`}); if(mode==='shared') mockHasLiveUploadReference.mockResolvedValueOnce(true); else mockHasLiveUploadReference.mockRejectedValueOnce(new Error('db down')); await request(A).delete(`/api/podcast/${ch}/episodes/${id}`).set('Authorization',`Bearer ${tok(admin)}`); expect(fs.existsSync(path.join(process.env.RECORDINGS_DIR!,f))).toBe(true); fs.unlinkSync(path.join(process.env.RECORDINGS_DIR!,f)); }
  });
  it('settings only persist allowlisted keys and merge existing values',async()=>{
    const ch=await seedChannel(); await db.podcastSettings.insert({_id:'s',channelId:ch,title:'Old',language:'tr'});
    const r=await request(A).patch(`/api/podcast/${ch}/settings`).set('Authorization',`Bearer ${tok(admin)}`).send({title:'New',explicit:true,evil:'x'}); expect(r.status).toBe(200); expect(r.body.settings).toMatchObject({title:'New',language:'tr',explicit:true}); expect(r.body.settings.evil).toBeUndefined();
  });
  it('settings reject malformed or unbounded public metadata instead of persisting it',async()=>{
    const ch=await seedChannel();
    for (const bad of [
      [],
      {title:{nested:true}},
      {description:'x'.repeat(2001)},
      {author:7},
      {imageUrl:'x'.repeat(2049)},
      {language:'x'.repeat(36)},
      {category:['Technology']},
      {explicit:'true'},
    ]) {
      const r=await request(A).patch(`/api/podcast/${ch}/settings`).set('Authorization',`Bearer ${tok(admin)}`).send(bad);
      expect(r.status).toBe(400);
    }
    const valid=await request(A).patch(`/api/podcast/${ch}/settings`).set('Authorization',`Bearer ${tok(admin)}`).send({title:null,description:null,explicit:false,unknown:'ignored'});
    expect(valid.status).toBe(200); expect(valid.body.settings).toMatchObject({title:null,description:null,explicit:false}); expect(valid.body.settings.unknown).toBeUndefined();
  });
});

describe('podcast recording lifecycle/security branches',()=>{
  it('start validates HTTPS + allowlist + SSRF before spawning',async()=>{
    const ch=await seedChannel(); process.env.PODCAST_INPUT_ALLOWLIST='media.example';
    expect((await request(A).post(`/api/podcast/${ch}/record/start`).set('Authorization',`Bearer ${tok(admin)}`).send({title:5})).status).toBe(400);
    expect((await request(A).post(`/api/podcast/${ch}/record/start`).set('Authorization',`Bearer ${tok(admin)}`).send({title:'x'.repeat(201)})).status).toBe(400);
    expect((await request(A).post(`/api/podcast/${ch}/record/start`).set('Authorization',`Bearer ${tok(admin)}`).send({inputUrl:5})).status).toBe(400);
    expect((await request(A).post(`/api/podcast/${ch}/record/start`).set('Authorization',`Bearer ${tok(admin)}`).send({inputUrl:'x'.repeat(2049)})).status).toBe(400);
    expect((await request(A).post(`/api/podcast/${ch}/record/start`).set('Authorization',`Bearer ${tok(admin)}`).send({inputUrl:'http://media.example/a'})).status).toBe(400);
    expect((await request(A).post(`/api/podcast/${ch}/record/start`).set('Authorization',`Bearer ${tok(admin)}`).send({inputUrl:'https://evil.example/a'})).status).toBe(400);
    mockAssertUrlIsPublic.mockRejectedValueOnce(new Error('private target'));
    expect((await request(A).post(`/api/podcast/${ch}/record/start`).set('Authorization',`Bearer ${tok(admin)}`).send({inputUrl:'https://media.example/a'})).status).toBe(400);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
  it('start spawns stub, duplicate returns 409, status shows active, stop publishes real-sized file',async()=>{
    const ch=await seedChannel(); const proc=fakeProc(); mockSpawn.mockReturnValueOnce(proc);
    let r=await request(A).post(`/api/podcast/${ch}/record/start`).set('Authorization',`Bearer ${tok(admin)}`).send({title:'Live'}); expect(r.status).toBe(200); expect(r.body.stub).toBe(true);
    expect((await request(A).post(`/api/podcast/${ch}/record/start`).set('Authorization',`Bearer ${tok(admin)}`).send({})).status).toBe(409);
    r=await request(A).get(`/api/podcast/${ch}/record/status`).set('Authorization',`Bearer ${tok(admin)}`); expect(r.body.recording).toBe(true);
    const out=mockSpawn.mock.calls[0][1].at(-1); fs.writeFileSync(out,Buffer.alloc(2048));
    r=await request(A).post(`/api/podcast/${ch}/record/stop`).set('Authorization',`Bearer ${tok(admin)}`).send({description:'done'}); expect(r.status).toBe(200); expect(r.body.episode.fileSize).toBe(2048); expect(proc.kill).toHaveBeenCalledWith('SIGTERM'); fs.unlinkSync(out);
  });
  it('spawn synchronous failure is a 500 and does not create active state',async()=>{
    const ch=await seedChannel(); mockSpawn.mockImplementationOnce(()=>{throw new Error('ENOENT')});
    const r=await request(A).post(`/api/podcast/${ch}/record/start`).set('Authorization',`Bearer ${tok(admin)}`).send({}); expect(r.status).toBe(500);
    expect((await request(A).get(`/api/podcast/${ch}/record/status`).set('Authorization',`Bearer ${tok(admin)}`)).body.recording).toBe(false);
  });
  it('client audio path rejects missing/non-string/oversize/tiny payload and accepts valid payload',async()=>{
    const ch=await seedChannel();
    expect((await request(A).post(`/api/podcast/${ch}/record/stop`).set('Authorization',`Bearer ${tok(admin)}`).send({})).status).toBe(404);
    expect((await request(A).post(`/api/podcast/${ch}/record/stop`).set('Authorization',`Bearer ${tok(admin)}`).send({audioFile:123})).status).toBe(400);
    process.env.MAX_FILE_SIZE_MB='1'; expect((await request(A).post(`/api/podcast/${ch}/record/stop`).set('Authorization',`Bearer ${tok(admin)}`).send({audioFile:Buffer.alloc(1_400_000).toString('base64')})).status).toBe(413);
    expect((await request(A).post(`/api/podcast/${ch}/record/stop`).set('Authorization',`Bearer ${tok(admin)}`).send({audioFile:Buffer.alloc(100).toString('base64')})).status).toBe(422);
    const r=await request(A).post(`/api/podcast/${ch}/record/stop`).set('Authorization',`Bearer ${tok(admin)}`).send({audioFile:Buffer.alloc(2048).toString('base64'),title:'Client'}); expect(r.status).toBe(200); const f=path.join(process.env.RECORDINGS_DIR!,r.body.episode.filename); expect(fs.existsSync(f)).toBe(true); fs.unlinkSync(f);
  });
  it('episode persistence failure cleans unreferenced client recording and propagates 500',async()=>{
    const ch=await seedChannel(); jest.spyOn(Podcasts,'insertEpisode').mockRejectedValueOnce(new Error('db fail'));
    const before=new Set(fs.readdirSync(process.env.RECORDINGS_DIR!)); const r=await request(A).post(`/api/podcast/${ch}/record/stop`).set('Authorization',`Bearer ${tok(admin)}`).send({audioFile:Buffer.alloc(2048).toString('base64'),title:'Fail'}); expect(r.status).toBe(500); const after=fs.readdirSync(process.env.RECORDINGS_DIR!).filter(x=>!before.has(x)); expect(after).toHaveLength(0);
  });
  it('falsy persistence acknowledgement also cleans client recording and propagates 500',async()=>{
    const ch=await seedChannel(); jest.spyOn(Podcasts,'insertEpisode').mockResolvedValueOnce(null as any);
    const before=new Set(fs.readdirSync(process.env.RECORDINGS_DIR!)); const r=await request(A).post(`/api/podcast/${ch}/record/stop`).set('Authorization',`Bearer ${tok(admin)}`).send({audioFile:Buffer.alloc(2048).toString('base64'),title:'Fail closed'}); expect(r.status).toBe(500); const after=fs.readdirSync(process.env.RECORDINGS_DIR!).filter(x=>!before.has(x)); expect(after).toHaveLength(0);
  });
});
