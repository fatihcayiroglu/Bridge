/**
 * AuthRepository direct behavioral/transaction-contract coverage.
 * PostgreSQL client stubs prove transaction/branch ownership only.
 */
process.env.NODE_ENV = 'test';
import db from '../db/loader';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AuthRepository = require('../db/repositories/AuthRepository');
// Havuz ikizi YALNIZCA `connect` sunar; urun tipi (`pg.Pool`) taklit
// EDILEMEZ ve edilmesine de gerek yok — bu suit yalnizca `connect()`
// uzerinden islem akisini olcuyor.
type PoolDouble = { connect: jest.Mock; query?: jest.Mock };
type MockDb = Omit<typeof db, '_pool'> & { _pool?: PoolDouble };
const mdb = db as MockDb;
function pgClient(handler: (sql: string, params?: unknown[]) => unknown | Promise<unknown>) {
  return { query: jest.fn((sql: string, params?: unknown[]) => Promise.resolve(handler(sql, params))), release: jest.fn() };
}
const input = { oldTokenHash:'old-hash', newTokenHash:'new-hash', newFamily:'family-new', now:1000, expiresAt:9000 };

describe('AuthRepository behavior', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalPool = mdb._pool;
  beforeEach(() => { process.env.NODE_ENV='test'; db._reset?.(); mdb._pool=originalPool; });
  afterAll(() => { process.env.NODE_ENV=originalEnv; mdb._pool=originalPool; });

  test('refresh CRUD/family helpers preserve canonical filters', async () => {
    const future = Date.now() + 60_000;
    await AuthRepository.insertRefreshToken('u1','t1',future,3);
    await AuthRepository.insertRefreshTokenRow({userId:'u1',token:'t2',expiresAt:future + 1,tokenVersion:3,family:'fam'});
    await AuthRepository.insertRefreshTokenRow({userId:'u2',token:'t3',expiresAt:future + 2,tokenVersion:4,family:'fam'});
    expect((await AuthRepository.findRefreshToken('t1'))?.userId).toBe('u1');
    expect(await AuthRepository.findByFamily('')).toEqual([]);
    expect((await AuthRepository.findByFamily('fam')).map((r:any)=>r.token).sort()).toEqual(['t2','t3']);
    await AuthRepository.updateRefreshTokenWhere({token:'t1'},{$set:{used:true}});
    expect((await AuthRepository.findRefreshToken('t1'))?.used).toBe(true);
    await AuthRepository.revokeRefreshToken('t1');
    expect(await AuthRepository.findRefreshToken('t1')).toBeNull();
    await AuthRepository.revokeByFamily('');
    await AuthRepository.revokeByFamily('fam');
    expect(await AuthRepository.findByFamily('fam')).toEqual([]);
    await AuthRepository.insertRefreshToken('u1','a',future + 3,3); await AuthRepository.insertRefreshToken('u1','b',future + 4,3);
    await AuthRepository.revokeAllForUser('u1');
    expect(await AuthRepository.findRefreshToken('a')).toBeNull();
  });

  test.each([
    ['direct missing version', () => AuthRepository.insertRefreshToken('u1','t',Date.now()+60_000, undefined as any)],
    ['direct expired row', () => AuthRepository.insertRefreshToken('u1','t',Date.now()-1, 1)],
    ['rotation-row missing version', () => AuthRepository.insertRefreshTokenRow({userId:'u1',token:'t',expiresAt:Date.now()+60_000})],
    ['rotation-row invalid family', () => AuthRepository.insertRefreshTokenRow({userId:'u1',token:'t',expiresAt:Date.now()+60_000,tokenVersion:1,family:''})],
  ])('refresh row boundary rejects malformed persistence input: %s', async (_label, action) => {
    await expect(action()).rejects.toThrow('Invalid refresh-token row');
  });

  test('family/remove helpers keep persistence failures visible', async () => {
    const findSpy=jest.spyOn(db.refreshTokens!,'find').mockImplementationOnce(()=>{throw new Error('db down');});
    await expect(AuthRepository.findByFamily('fam')).rejects.toThrow('db down'); findSpy.mockRestore();
    const removeSpy=jest.spyOn(db.refreshTokens!,'remove').mockRejectedValueOnce(new Error('db down'));
    await expect(AuthRepository.removeRefreshTokensWhere({userId:'u1'})).rejects.toThrow('db down'); removeSpy.mockRestore();
  });

  test('missing refresh/audit stores fail closed instead of becoming fake logout or empty logs', async () => {
    const refresh=(db as any).refreshTokens, audit=(db as any).auditLogs, admin=(db as any).adminLogs;
    try {
      (db as any).refreshTokens=undefined;
      await expect(AuthRepository.revokeAllForUser('u1')).rejects.toThrow('Refresh-token store is unavailable');
      (db as any).refreshTokens=refresh; (db as any).auditLogs=undefined;
      await expect(AuthRepository.findAuditLogs('s1')).rejects.toThrow('Audit-log store is unavailable');
      (db as any).auditLogs=audit; (db as any).adminLogs=undefined;
      await expect(AuthRepository.insertAdminLog({action:'x'})).rejects.toThrow('Admin-log store is unavailable');
    } finally { (db as any).refreshTokens=refresh; (db as any).auditLogs=audit; (db as any).adminLogs=admin; }
  });

  test.each([
    [{...input, oldTokenHash:''}],
    [{...input, now:-1}],
    [{...input, expiresAt:999}],
    [{...input, expiresAt:1.5}],
  ])('rotation rejects malformed internal contract %#', async (bad) => {
    await expect(AuthRepository.rotateRefreshTokenAtomic(bad)).rejects.toThrow('Invalid refresh-token rotation input');
  });

  test('rotation returns null for test adapter or missing PostgreSQL pool', async () => {
    await expect(AuthRepository.rotateRefreshTokenAtomic(input)).resolves.toBeNull();
    // `_pool` ISTEGE BAGLIdir; 'havuz yok' durumu SILMEKLE kurulur.
    process.env.NODE_ENV='production'; delete mdb._pool;
    await expect(AuthRepository.rotateRefreshTokenAtomic(input)).rejects.toThrow('PostgreSQL pool unavailable');
  });

  describe('rotation PostgreSQL control flow',()=>{
    beforeEach(()=>{process.env.NODE_ENV='production';});
    function useClient(handler: Parameters<typeof pgClient>[0]) { const c=pgClient(handler); mdb._pool={query:jest.fn(),connect:jest.fn().mockResolvedValue(c)}; return c; }
    test('not found commits',async()=>{ const c=useClient(()=>({rows:[]})); await expect(AuthRepository.rotateRefreshTokenAtomic(input)).resolves.toEqual({status:'not_found'}); expect(c.query).toHaveBeenCalledWith('COMMIT'); expect(c.release).toHaveBeenCalledTimes(1); });
    test.each([
      [{token:'old-hash',userId:'u1',expiresAt:8000,used:true,family:'fam',tokenVersion:2},'DELETE FROM refresh_tokens WHERE family = $1',['fam']],
      [{token:'old-hash',userId:'u1',expiresAt:8000,used:1,family:null,tokenVersion:2},'DELETE FROM refresh_tokens WHERE "userId" = $1',['u1']],
    ])('replay revokes correct scope %#',async(row,sql,params)=>{ const c=useClient(q=>/FOR UPDATE/.test(q)?{rows:[row]}:{rows:[]}); await expect(AuthRepository.rotateRefreshTokenAtomic(input)).resolves.toEqual({status:'reuse'}); expect(c.query).toHaveBeenCalledWith(sql,params); });
    test('expired token is deleted',async()=>{ const c=useClient(q=>/FOR UPDATE/.test(q)?{rows:[{token:'old-hash',userId:'u1',expiresAt:'999',used:false,family:'fam',tokenVersion:2}]}:{rows:[]}); await expect(AuthRepository.rotateRefreshTokenAtomic(input)).resolves.toEqual({status:'expired'}); expect(c.query).toHaveBeenCalledWith('DELETE FROM refresh_tokens WHERE token = $1',['old-hash']); });
    test.each([' 8000','08','8e3','8000.0','0x1f40'])('non-canonical persisted expiry %p is revoked as unusable instead of coerced',async(expiresAt)=>{ const c=useClient(q=>/FOR UPDATE/.test(q)?{rows:[{token:'old-hash',userId:'u1',expiresAt,used:false,family:'fam',tokenVersion:2}]}:{rows:[]}); await expect(AuthRepository.rotateRefreshTokenAtomic(input)).resolves.toEqual({status:'expired'}); expect(c.query).toHaveBeenCalledWith('DELETE FROM refresh_tokens WHERE token = $1',['old-hash']); });
    test('token expiring exactly at now is already expired',async()=>{ const c=useClient(q=>/FOR UPDATE/.test(q)?{rows:[{token:'old-hash',userId:'u1',expiresAt:1000,used:false,family:'fam',tokenVersion:2}]}:{rows:[]}); await expect(AuthRepository.rotateRefreshTokenAtomic(input)).resolves.toEqual({status:'expired'}); expect(c.query).toHaveBeenCalledWith('DELETE FROM refresh_tokens WHERE token = $1',['old-hash']); });
    test('missing user deletes stale token',async()=>{ const c=useClient(q=>/FOR UPDATE/.test(q)?{rows:[{token:'old-hash',userId:'u1',expiresAt:8000,used:false,family:'fam',tokenVersion:2}]}:/SELECT \* FROM users/.test(q)?{rows:[]}:{rows:[]}); await expect(AuthRepository.rotateRefreshTokenAtomic(input)).resolves.toEqual({status:'user_not_found'}); expect(c.query).toHaveBeenCalledWith('DELETE FROM refresh_tokens WHERE token = $1',['old-hash']); });
    test.each([['existing family','fam-existing'],['legacy family',null]])('successful rotation %s',async(_n,family)=>{ const c=useClient(q=>/FOR UPDATE/.test(q)?{rows:[{token:'old-hash',userId:'u1',expiresAt:8000,used:false,family,tokenVersion:2}]}:/SELECT \* FROM users/.test(q)?{rows:[{_id:'u1',tokenVersion:2}]}:{rows:[]}); await expect(AuthRepository.rotateRefreshTokenAtomic(input)).resolves.toEqual({status:'ok',user:{_id:'u1',tokenVersion:2}}); const fam=family||'family-new'; expect(c.query).toHaveBeenCalledWith(expect.stringMatching(/SET used = TRUE/),['old-hash',1000,fam]); expect(c.query).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO refresh_tokens/),['new-hash','u1',9000,1000,fam,2]); expect(c.query).toHaveBeenCalledWith('COMMIT'); });
    test('stale issuance tokenVersion revokes the session family instead of minting a fresh token',async()=>{ const c=useClient(q=>/FOR UPDATE/.test(q)?{rows:[{token:'old-hash',userId:'u1',expiresAt:8000,used:false,family:'fam',tokenVersion:1}]}:/SELECT \* FROM users/.test(q)?{rows:[{_id:'u1',tokenVersion:2}]}:{rows:[]}); await expect(AuthRepository.rotateRefreshTokenAtomic(input)).resolves.toEqual({status:'revoked'}); expect(c.query).toHaveBeenCalledWith('DELETE FROM refresh_tokens WHERE family = $1',['fam']); expect(c.query).toHaveBeenCalledWith('COMMIT'); });
    test.each([['non-canonical issuance version','01',1],['missing issuance version',null,1],['non-canonical current version',1,'01']])('%s fails closed instead of Number coercion',async(_label,issued,current)=>{ const c=useClient(q=>/FOR UPDATE/.test(q)?{rows:[{token:'old-hash',userId:'u1',expiresAt:8000,used:false,family:'fam',tokenVersion:issued}]}:/SELECT \* FROM users/.test(q)?{rows:[{_id:'u1',tokenVersion:current}]}:{rows:[]}); await expect(AuthRepository.rotateRefreshTokenAtomic(input)).resolves.toEqual({status:'revoked'}); expect(c.query).toHaveBeenCalledWith('DELETE FROM refresh_tokens WHERE family = $1',['fam']); expect(c.query).toHaveBeenCalledWith('COMMIT'); });
    test('query failure rolls back/releases preserving original',async()=>{ const err=new Error('select failed'); const c=useClient(q=>{if(q==='BEGIN')return{rows:[]}; if(/FOR UPDATE/.test(q))throw err; if(q==='ROLLBACK')return{rows:[]}; return{rows:[]};}); await expect(AuthRepository.rotateRefreshTokenAtomic(input)).rejects.toBe(err); expect(c.query).toHaveBeenCalledWith('ROLLBACK'); expect(c.release).toHaveBeenCalledTimes(1); });
    test('rollback failure does not mask original',async()=>{ const err=new Error('original'); const c=useClient(q=>{if(q==='BEGIN')return{rows:[]}; if(/FOR UPDATE/.test(q))throw err; if(q==='ROLLBACK')throw new Error('rollback failed'); return{rows:[]};}); await expect(AuthRepository.rotateRefreshTokenAtomic(input)).rejects.toBe(err); expect(c.release).toHaveBeenCalledTimes(1); });
  });

  test('WebAuthn CRUD scopes to canonical credential store',async()=>{
    expect(AuthRepository.hasWebauthnCollection()).toBe(true);
    const created=await AuthRepository.insertCredential({userId:'u1',credentialId:'cred-1',counter:0});
    expect(created._id).toEqual(expect.any(String)); expect((await AuthRepository.findCredential('cred-1'))?.userId).toBe('u1');
    expect((await AuthRepository.findCredentialByDocId(created._id))?.credentialId).toBe('cred-1'); expect((await AuthRepository.findCredentialByDocId(created._id,'u1'))?.credentialId).toBe('cred-1'); expect(await AuthRepository.findCredentialByDocId(created._id,'u2')).toBeNull(); expect(await AuthRepository.findCredentialsByUser('u1')).toHaveLength(1);
    await AuthRepository.updateCredential('cred-1',{counter:1}); expect((await AuthRepository.findCredential('cred-1'))?.counter).toBe(1); await AuthRepository.updateCredentialByDocId(created._id,{deviceName:'Key'}); expect((await AuthRepository.findCredential('cred-1'))?.deviceName).toBe('Key'); await AuthRepository.deleteCredential(created._id,'u2'); expect(await AuthRepository.findCredential('cred-1')).not.toBeNull(); await AuthRepository.deleteCredential(created._id,'u1'); expect(await AuthRepository.findCredential('cred-1')).toBeNull();
  });

  test.each(['01','1e3',' 1','1.0'])('WebAuthn fallback rejects non-canonical persisted counter %p',async(counter)=>{
    const created=await AuthRepository.insertCredential({userId:'u1',credentialId:`cred-corrupt-${counter}`,counter});
    await expect(AuthRepository.advanceCredentialCounterByDocId(created._id,6,100)).rejects.toThrow(/persisted WebAuthn counter/);
  });

  test('WebAuthn counter advancement is monotonic in fallback storage',async()=>{
    const created=await AuthRepository.insertCredential({userId:'u1',credentialId:'cred-counter',counter:1});
    await expect(AuthRepository.advanceCredentialCounterByDocId(created._id,6,100)).resolves.toBe(true);
    await expect(AuthRepository.advanceCredentialCounterByDocId(created._id,5,101)).resolves.toBe(false);
    await expect(AuthRepository.advanceCredentialCounterByDocId(created._id,0,102)).resolves.toBe(false);
    expect((await AuthRepository.findCredential('cred-counter'))?.counter).toBe(6);
  });

  test('WebAuthn counter PostgreSQL update carries monotonic predicate',async()=>{
    const query=jest.fn().mockResolvedValue({rowCount:1}); (db as any)._pool={query};
    await expect(AuthRepository.advanceCredentialCounterByDocId('c1',9,123)).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/counter\s*<\s*\$2/s),['c1',9,123]);
  });

  test('WebAuthn zero counter only refreshes lastUsedAt while stored counter is also zero',async()=>{
    const query=jest.fn().mockResolvedValue({rowCount:0}); (db as any)._pool={query};
    await expect(AuthRepository.advanceCredentialCounterByDocId('c1',0,124)).resolves.toBe(false);
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/WHERE _id=\$1 AND counter=0/),['c1',124]);
  });

  test('WebAuthn fails closed when canonical store unavailable',async()=>{ const c=db.webauthnCredentials; (db as any).webauthnCredentials=undefined; try { expect(AuthRepository.hasWebauthnCollection()).toBe(false); await expect(AuthRepository.findCredential('x')).rejects.toThrow('WebAuthn credential store is unavailable'); await expect(AuthRepository.findCredentialsByUser('u1')).rejects.toThrow('WebAuthn credential store is unavailable'); } finally {(db as any).webauthnCredentials=c;} });

  test('admin/audit helpers apply sort pagination filters counts',async()=>{
    await AuthRepository.insertAdminLog({action:'A',actorId:'u1'}); await AuthRepository.insertAdminLog({action:'B',actorId:'u2'}); expect(await AuthRepository.findAdminLogs({},1)).toHaveLength(1);
    await AuthRepository.insertAuditLog({serverId:'s1',action:'DELETE',createdAt:100}); await AuthRepository.insertAuditLog({serverId:'s1',action:'EDIT',createdAt:200}); await AuthRepository.insertAuditLog({serverId:'s1',action:'DELETE',createdAt:300}); await AuthRepository.insertAuditLog({serverId:'s2',action:'DELETE',createdAt:400});
    expect(await AuthRepository.findAuditLogs('s1',2)).toHaveLength(2); const numeric=await AuthRepository.getAuditLog('s1',1); expect(numeric.entries).toHaveLength(1); expect(numeric.total).toBe(3);
    const f=await AuthRepository.getAuditLog('s1',{action:'DELETE',after:150,before:350,offset:0,limit:10}); expect(f.total).toBe(1); expect(f.entries[0].action).toBe('DELETE');
    expect((await AuthRepository.getAuditLog('s1',{after:150})).total).toBe(2); expect((await AuthRepository.getAuditLog('s1',{before:250})).total).toBe(2); expect(await AuthRepository.findAuditLogsWhere({serverId:'s1',action:'EDIT'})).toHaveLength(1); expect(await AuthRepository.auditLogsFind({serverId:'s2'})).toHaveLength(1);
  });
});
