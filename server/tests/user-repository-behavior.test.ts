process.env.NODE_ENV='test';
process.env.AP_ENCRYPTION_KEY = process.env.AP_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
import db from '../db/loader';
import Users from '../db/repositories/UserRepository';

describe('UserRepository direct behavior',()=>{
  const originalPool=(db as any)._pool;
  beforeEach(()=>{ db._reset?.(); (db as any)._pool=undefined; });
  afterAll(()=>{ (db as any)._pool=originalPool; });

  test('identity lookup normalizes username/email and AP URL patterns',async()=>{
    await Users.create({_id:'u1',username:'alice',email:'a@example.com',emailToken:'tok',createdAt:1});
    expect((await Users.findById('u1'))?.username).toBe('alice');
    expect((await Users.findByUsername('ALICE'))?._id).toBe('u1');
    expect((await Users.findByEmail('A@EXAMPLE.COM'))?._id).toBe('u1');
    expect(await Users.findByEmail('')).toBeNull();
    expect((await Users.findByEmailToken('tok'))?._id).toBe('u1');
    for(const url of ['https://x/api/federation/users/alice','https://x/users/alice','https://x/u/alice','https://x/accounts/alice']) expect((await Users.findByApUrl(url))?._id).toBe('u1');
    expect(await Users.findByApUrl('https://x/no-user')).toBeNull();
  });

  test('SSO identity lookup is issuer-scoped and legacy upgrades are conditional',async()=>{
    await Users.create({_id:'issuer-a',username:'a',ssoProvider:'oidc',ssoIssuer:'https://issuer-a.example',ssoId:'shared-sub'});
    await Users.create({_id:'issuer-b',username:'b',ssoProvider:'oidc',ssoIssuer:'https://issuer-b.example',ssoId:'shared-sub'});
    await Users.create({_id:'legacy',username:'legacy',ssoProvider:'oidc',ssoIssuer:'legacy:oidc',ssoId:'old-sub'});

    expect((await Users.findBySsoIdentity('oidc','https://issuer-a.example','shared-sub'))?._id).toBe('issuer-a');
    expect((await Users.findBySsoIdentity('oidc','https://issuer-b.example','shared-sub'))?._id).toBe('issuer-b');
    expect(await Users.findBySsoIdentity('oidc','https://issuer-c.example','shared-sub')).toBeNull();
    expect((await Users.findLegacySsoIdentity('oidc','old-sub'))?._id).toBe('legacy');
    await expect(Users.upgradeLegacySsoIdentity('legacy','oidc','https://trusted.example','wrong-sub')).resolves.toBe(false);
    await expect(Users.upgradeLegacySsoIdentity('legacy','oidc','https://trusted.example','old-sub')).resolves.toBe(true);
    expect((await Users.findById('legacy'))?.ssoIssuer).toBe('https://trusted.example');
  });

  test('concurrent SSO link attempts have exactly one conditional owner',async()=>{
    await Users.create({_id:'local',username:'local',ssoProvider:null,ssoIssuer:null,ssoId:null});
    const results=await Promise.all([
      Users.claimSsoIdentity('local','oidc','https://issuer.example','subject-a'),
      Users.claimSsoIdentity('local','oidc','https://issuer.example','subject-b'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner=await Users.findById('local');
    expect(winner).toMatchObject({ssoProvider:'oidc',ssoIssuer:'https://issuer.example'});
    expect(['subject-a','subject-b']).toContain(winner?.ssoId);
    await expect(Users.claimSsoIdentity('local','saml','https://other.example','same-email')).resolves.toBe(false);
  });

  test('CRUD/status/version/list/pagination helpers preserve filters',async()=>{
    await Users.create({_id:'u1',username:'alice',createdAt:10,tokenVersion:0});
    await Users.create({_id:'u2',username:'bob',createdAt:20,tokenVersion:1});
    await Users.update('u1',{displayName:'Alice'}); await Users.updateWhere({_id:'u2'},{$set:{displayName:'Bob'}});
    await Users.setStatus('u1','online' as any); await Users.incrementTokenVersion('u1');
    expect((await Users.findById('u1'))?.tokenVersion).toBe(1);
    expect(await Users.findByIds(['u1','u2'])).toHaveLength(2);
    expect(await Users.findByUsernames(['ALICE','BOB'])).toHaveLength(2);
    expect(await Users.count()).toBe(2);
    expect((await Users.searchPaginated({}, {skip:1,limit:1}))[0]._id).toBe('u1');
    expect(await Users.findWhere({username:'bob'})).toHaveLength(1);
    await Users.delete('u2'); expect(await Users.count()).toBe(1);
  });

  test('backup-code collection fallback handles array/json/invalid/missing/user-missing',async()=>{
    const legacyA='legacy-a'; const legacyB='legacy-b';
    const legacyC='legacy-c'; const legacyD='legacy-d';
    await Users.create({_id:'u1',twoFactorBackup:[legacyA,legacyB]});
    await expect(Users.consumeBackupCode('u1',legacyA)).resolves.toBe(true);
    expect(JSON.parse(String((await Users.findById('u1'))?.twoFactorBackup))).toEqual([legacyB]);
    await expect(Users.consumeBackupCode('u1',legacyA)).resolves.toBe(false);
    await Users.update('u1',{twoFactorBackup:JSON.stringify([legacyC,legacyD])}); await expect(Users.consumeBackupCode('u1',legacyC)).resolves.toBe(true);
    await Users.update('u1',{twoFactorBackup:'not-json'}); await expect(Users.consumeBackupCode('u1','x')).resolves.toBe(false);
    await Users.update('u1',{twoFactorBackup:'{}'}); await expect(Users.consumeBackupCode('u1','x')).resolves.toBe(false);
    await expect(Users.consumeBackupCode('missing','x')).resolves.toBe(false);
  });

  test('backup-code PostgreSQL fast path returns winner without collection rewrite',async()=>{
    const query=jest.fn().mockResolvedValue({rowCount:1}); (db as any)._pool={query};
    await expect(Users.consumeBackupCode('u1','stored')).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/twoFactorBackup.*@>/s),['u1','stored','["stored"]']);
  });

  test('backup-code PostgreSQL rowCount=0 rechecks canonical state before fallback',async()=>{
    const stored='legacy-stored';
    await Users.create({_id:'u1',twoFactorBackup:[stored]});
    (db as any)._pool={query:jest.fn().mockResolvedValue({rowCount:0})};
    await expect(Users.consumeBackupCode('u1',stored)).resolves.toBe(true);
    await expect(Users.consumeBackupCode('u1',stored)).resolves.toBe(false);
  });

  test('AP private key lives in separate encrypted authority and supports insert/update/delete',async()=>{
    await Users.create({_id:'u1',username:'alice'});
    expect(await Users.getApPrivateKey('u1')).toBeNull();
    await Users.saveApKeys('u1','pub1','private-one');
    expect((await Users.findById('u1'))?.apPublicKey).toBe('pub1');
    const stored=(await (db as any).userApKeys.findOne({userId:'u1'})).apPrivateKeyEnc;
    expect(stored).not.toContain('private-one'); expect(await Users.getApPrivateKey('u1')).toBe('private-one');
    await Users.saveApKeys('u1','pub2','private-two');
    expect(await Users.getApPrivateKey('u1')).toBe('private-two');
    await Users.deleteApKeys('u1'); expect(await Users.getApPrivateKey('u1')).toBeNull();
  });

  test('AP key helpers fail closed when required key authority is unavailable',async()=>{
    await Users.create({_id:'u1'}); const col=(db as any).userApKeys; (db as any).userApKeys=undefined;
    try {
      await expect(Users.getApPrivateKey('u1')).rejects.toThrow();
      await expect(Users.saveApKeys('u1','pub','private')).rejects.toThrow();
      await expect(Users.deleteApKeys('u1')).rejects.toThrow();
      expect((await Users.findById('u1'))?.apPublicKey).toBeUndefined();
    } finally {(db as any).userApKeys=col;}
  });

  test('AP key delete clears both private authority and public actor key',async()=>{
    await Users.create({_id:'u2',username:'bob'});
    await Users.saveApKeys('u2','pub-delete','private-delete');
    await Users.deleteApKeys('u2');
    expect(await Users.getApPrivateKey('u2')).toBeNull();
    expect((await Users.findById('u2'))?.apPublicKey ?? null).toBeNull();
  });
  test('registration identity fallback commits user + encrypted AP key or compensates on key failure',async()=>{
    const base={_id:'reg-u1',username:'reg',displayName:'Reg',password:'hash',avatarColor:'#123456',status:'online',bio:'',tokenVersion:0,createdAt:123};
    const user=await Users.createWithApKeys(base,'pub-reg','private-reg');
    expect(user._id).toBe('reg-u1');
    expect((await Users.findById('reg-u1'))?.apPublicKey).toBe('pub-reg');
    expect(await Users.getApPrivateKey('reg-u1')).toBe('private-reg');

    const keyStore=(db as any).userApKeys; (db as any).userApKeys=undefined;
    try {
      await expect(Users.createWithApKeys({...base,_id:'reg-u2',username:'reg2'},'pub','private')).rejects.toThrow();
      expect(await Users.findById('reg-u2')).toBeNull();
    } finally { (db as any).userApKeys=keyStore; }
  });

  test('registration identity PostgreSQL path is one transaction and rolls back key-write failure',async()=>{
    const release=jest.fn();
    const query=jest.fn()
      .mockResolvedValueOnce({rows:[]}) // BEGIN
      .mockResolvedValueOnce({rows:[{_id:'pg-reg',username:'pg'}]})
      .mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({rows:[]}); // COMMIT
    (db as any)._pool={connect:jest.fn().mockResolvedValue({query,release})};
    const base={_id:'pg-reg',username:'pg',displayName:'PG',password:'hash',avatarColor:'#123456',status:'online',bio:'',tokenVersion:0,createdAt:123};
    await expect(Users.createWithApKeys(base,'pub','private')).resolves.toMatchObject({_id:'pg-reg'});
    expect(query.mock.calls.map((c:any[])=>String(c[0]).trim().split(/\s+/)[0])).toEqual(['BEGIN','INSERT','INSERT','COMMIT']);
    expect(release).toHaveBeenCalledTimes(1);

    const release2=jest.fn();
    const query2=jest.fn()
      .mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({rows:[{_id:'pg-reg2'}]})
      .mockRejectedValueOnce(new Error('key write failed'))
      .mockResolvedValueOnce({rows:[]});
    (db as any)._pool={connect:jest.fn().mockResolvedValue({query:query2,release:release2})};
    await expect(Users.createWithApKeys({...base,_id:'pg-reg2',username:'pg2'},'pub','private')).rejects.toThrow('key write failed');
    expect(query2.mock.calls.map((c:any[])=>String(c[0]).trim().split(/\s+/)[0])).toEqual(['BEGIN','INSERT','INSERT','ROLLBACK']);
    expect(release2).toHaveBeenCalledTimes(1);
  });

});
