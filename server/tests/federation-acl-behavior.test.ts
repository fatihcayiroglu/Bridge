process.env.NODE_ENV='test';

import express from 'express';
import request from 'supertest';

const mockFed = {
  findWhitelist: jest.fn(), findWhitelistOne: jest.fn(), insertWhitelist: jest.fn(), removeWhitelistByDomain: jest.fn(),
  findBlacklist: jest.fn(), findBlacklistOne: jest.fn(), insertBlacklist: jest.fn(), removeBlacklistByDomain: jest.fn(),
};
const mockLogAction = jest.fn();

jest.mock('../middleware/auth',()=>({authMiddleware:(req:any,_res:any,next:any)=>{req.user={id:'admin1'};next();}}));
jest.mock('../db/repositories',()=>({Federation:mockFed}));
jest.mock('../routes/admin/middleware',()=>({adminOnly:(_req:any,_res:any,next:any)=>next(),logAction:(...a:any[])=>mockLogAction(...a)}));
jest.mock('uuid',()=>({v4:()=> 'acl-id'}));

import { router, checkFederationACL } from '../routes/admin/federation-acl';

const app=express();app.use(express.json());app.use('/api/admin',router);

beforeEach(()=>{
  jest.clearAllMocks();
  mockFed.findWhitelist.mockResolvedValue([]);mockFed.findBlacklist.mockResolvedValue([]);
  mockFed.findWhitelistOne.mockResolvedValue(null);mockFed.findBlacklistOne.mockResolvedValue(null);
  mockFed.insertWhitelist.mockResolvedValue(undefined);mockFed.insertBlacklist.mockResolvedValue(undefined);
  mockFed.removeWhitelistByDomain.mockResolvedValue(undefined);mockFed.removeBlacklistByDomain.mockResolvedValue(undefined);
  mockLogAction.mockResolvedValue(undefined);
});

describe('federation ACL admin routes',()=>{
  test('GET returns current whitelist and blacklist',async()=>{
    mockFed.findWhitelist.mockResolvedValueOnce([{domain:'a.test'}]);
    mockFed.findBlacklist.mockResolvedValueOnce([{domain:'b.test'}]);
    expect((await request(app).get('/api/admin/federation/whitelist')).body).toEqual({whitelist:[{domain:'a.test'}]});
    expect((await request(app).get('/api/admin/federation/blacklist')).body).toEqual({blacklist:[{domain:'b.test'}]});
  });

  test.each([undefined,'','localhost','bad domain','*.singlelabel','a'.repeat(254)])('whitelist rejects invalid domain %p',async(domain)=>{
    const r=await request(app).post('/api/admin/federation/whitelist').send({domain});
    expect(r.status).toBe(400); expect(mockFed.insertWhitelist).not.toHaveBeenCalled();
  });

  test('whitelist normalizes wildcard/domain, caps reason, rejects duplicate and audits',async()=>{
    mockFed.findWhitelistOne.mockResolvedValueOnce({domain:'example.com'});
    expect((await request(app).post('/api/admin/federation/whitelist').send({domain:'EXAMPLE.COM'})).status).toBe(409);

    const reason='r'.repeat(250);
    const r=await request(app).post('/api/admin/federation/whitelist').send({domain:'  *.Sub.Example.COM  ',reason});
    expect(r.status).toBe(200);
    expect(r.body.entry).toMatchObject({_id:'acl-id',domain:'*.sub.example.com',addedBy:'admin1'});
    expect(r.body.entry.reason).toHaveLength(200);
    expect(mockFed.insertWhitelist).toHaveBeenCalledWith(expect.objectContaining({domain:'*.sub.example.com'}));
    expect(mockLogAction).toHaveBeenCalledWith('admin1','federation_whitelist_add','*.sub.example.com',{reason:'r'.repeat(200)});
  });

  test('blacklist default reason, duplicate handling and audit',async()=>{
    mockFed.findBlacklistOne.mockResolvedValueOnce({domain:'evil.test'});
    expect((await request(app).post('/api/admin/federation/blacklist').send({domain:'evil.test'})).status).toBe(409);
    const r=await request(app).post('/api/admin/federation/blacklist').send({domain:' Evil.Example '});
    expect(r.status).toBe(200);
    expect(r.body.entry.reason).toBe('');
    expect(mockLogAction).toHaveBeenCalledWith('admin1','federation_blacklist_add','evil.example',{reason:''});
  });

  test('delete validates, decodes, normalizes and audits whitelist/blacklist',async()=>{
    expect((await request(app).delete('/api/admin/federation/whitelist/not-a-domain')).status).toBe(400);
    expect((await request(app).delete('/api/admin/federation/blacklist/not-a-domain')).status).toBe(400);
    const enc=encodeURIComponent('*.Sub.Example.COM');
    expect((await request(app).delete(`/api/admin/federation/whitelist/${enc}`)).status).toBe(200);
    expect(mockFed.removeWhitelistByDomain).toHaveBeenCalledWith('*.sub.example.com');
    expect(mockLogAction).toHaveBeenCalledWith('admin1','federation_whitelist_remove','*.sub.example.com');
    expect((await request(app).delete(`/api/admin/federation/blacklist/${enc}`)).status).toBe(200);
    expect(mockFed.removeBlacklistByDomain).toHaveBeenCalledWith('*.sub.example.com');
  });
});

describe('checkFederationACL',()=>{
  test('undefined domain is allowed without DB access',async()=>{
    await expect(checkFederationACL(undefined)).resolves.toEqual({allowed:true});
    expect(mockFed.findBlacklist).not.toHaveBeenCalled();
  });

  test('exact blacklist denies and exposes normalized entry defaults',async()=>{
    mockFed.findBlacklist.mockResolvedValueOnce([{domain:'evil.example',reason:123,addedAt:'bad',addedBy:null,_id:1},null,{foo:'bad'}]);
    const r=await checkFederationACL('EVIL.EXAMPLE');
    expect(r).toEqual({allowed:false,reason:'blacklisted',entry:{_id:'',domain:'evil.example',reason:'',addedAt:0,addedBy:'system'}});
    expect(mockFed.findWhitelist).not.toHaveBeenCalled();
  });

  test('FED-02: a stored row (createdAt, BIGINT as string) still blocks and reports when it was added',async()=>{
    mockFed.findBlacklist.mockResolvedValueOnce([{_id:'b1',domain:'evil.example',reason:'spam',createdAt:'1700000000000'}]);
    const r=await checkFederationACL('evil.example');
    expect(r).toEqual({allowed:false,reason:'blacklisted',entry:{_id:'b1',domain:'evil.example',reason:'spam',addedAt:1700000000000,addedBy:'system'}});
  });

  test('wildcard blacklist denies subdomain and apex',async()=>{
    mockFed.findBlacklist.mockResolvedValue([{_id:'b',domain:'*.evil.example',reason:'x',addedAt:1,addedBy:'a'}]);
    expect((await checkFederationACL('x.evil.example')).allowed).toBe(false);
    expect((await checkFederationACL('evil.example')).allowed).toBe(false);
  });

  test('empty whitelist means allow by default',async()=>{
    await expect(checkFederationACL('random.example')).resolves.toEqual({allowed:true});
  });

  test('non-empty whitelist supports exact and wildcard matches',async()=>{
    mockFed.findWhitelist.mockResolvedValue([
      {_id:'w1',domain:'allowed.example',reason:'',addedAt:1,addedBy:'a'},
      {_id:'w2',domain:'*.sub.example',reason:'',addedAt:1,addedBy:'a'},
    ]);
    expect(await checkFederationACL('allowed.example')).toEqual({allowed:true});
    expect(await checkFederationACL('x.sub.example')).toEqual({allowed:true});
    expect(await checkFederationACL('sub.example')).toEqual({allowed:true});
  });

  test('non-empty whitelist denies unmatched domain and blacklist has precedence',async()=>{
    mockFed.findWhitelist.mockResolvedValue([{_id:'w',domain:'allowed.example',reason:'',addedAt:1,addedBy:'a'}]);
    expect(await checkFederationACL('other.example')).toEqual({allowed:false,reason:'not_whitelisted'});

    mockFed.findBlacklist.mockResolvedValueOnce([{_id:'b',domain:'blocked.example',reason:'',addedAt:1,addedBy:'a'}]);
    mockFed.findWhitelist.mockResolvedValueOnce([{_id:'w',domain:'blocked.example',reason:'',addedAt:1,addedBy:'a'}]);
    expect((await checkFederationACL('blocked.example')).reason).toBe('blacklisted');
  });
});

describe('federation ACL runtime body validation', () => {
  test.each(['/federation/whitelist', '/federation/blacklist'])('rejects non-string reason on %s before persistence', async (path) => {
    const r = await request(app).post(`/api/admin${path}`).send({ domain: 'safe.example', reason: { nested: true } });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/reason/i);
    expect(mockFed.insertWhitelist).not.toHaveBeenCalled();
    expect(mockFed.insertBlacklist).not.toHaveBeenCalled();
  });
});
