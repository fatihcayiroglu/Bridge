'use strict';
process.env.NODE_ENV='test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
import Bots from '../db/repositories/BotRepository';
const db=require('../db/loader');

describe('BotRepository truthful store contracts',()=>{
  beforeEach(()=>{ db._reset?.(); jest.restoreAllMocks(); });

  it('findPublic propagates store failure instead of inventing an empty marketplace',async()=>{
    jest.spyOn(db.bots,'find').mockImplementationOnce(()=>({ then:(_r:any,reject:any)=>Promise.reject(new Error('bots down')).then(_r,reject) }) as any);
    await expect(Bots.findPublic({tag:'x'})).rejects.toThrow('bots down');
  });

  it('countServerInstalls propagates store failure and validates impossible counts',async()=>{
    jest.spyOn(db.serverBots,'count').mockRejectedValueOnce(new Error('links down'));
    await expect(Bots.countServerInstalls('b1')).rejects.toThrow('links down');
    jest.spyOn(db.serverBots,'count').mockResolvedValueOnce(-1);
    await expect(Bots.countServerInstalls('b1')).rejects.toThrow(/invalid install count/);
  });

  it('returns real public rows and exact install counts',async()=>{
    await db.bots.insert({_id:'b1',isPublic:true,active:true});
    await db.bots.insert({_id:'b2',isPublic:false,active:true});
    await db.serverBots.insert({_id:'l1',botId:'b1',serverId:'s1'});
    expect((await Bots.findPublic()).map((r:any)=>r._id)).toEqual(['b1']);
    await expect(Bots.countServerInstalls('b1')).resolves.toBe(1);
  });
});
