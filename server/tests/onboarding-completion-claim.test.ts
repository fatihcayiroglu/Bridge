'use strict';
process.env.NODE_ENV='test';
jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb({withPgPool:true}));
import ServerAssets from '../db/repositories/ServerAssetRepository';
const db=require('../db/loader');

describe('ServerAssetRepository.claimOnboardingCompletion SQL contract', () => {
  beforeEach(()=>jest.clearAllMocks());
  const input={_id:'c1',serverId:'s1',userId:'u1',completedAt:123,answers:'{"q":"a"}'};
  it('returns true only for the INSERT winner and uses the server/user unique conflict key', async()=>{
    db._pool.query.mockResolvedValueOnce({rowCount:1,rows:[{_id:'c1'}]});
    await expect(ServerAssets.claimOnboardingCompletion(input)).resolves.toBe(true);
    const [sql,params]=db._pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO onboarding_completions');
    expect(sql).toContain('ON CONFLICT ("serverId","userId") DO NOTHING');
    expect(sql).toContain('RETURNING _id');
    expect(params).toEqual(['c1','s1','u1',123,'{"q":"a"}']);
  });
  it('returns false for the concurrent loser', async()=>{
    db._pool.query.mockResolvedValueOnce({rowCount:0,rows:[]});
    await expect(ServerAssets.claimOnboardingCompletion(input)).resolves.toBe(false);
  });
});
