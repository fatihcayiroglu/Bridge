'use strict';
process.env.NODE_ENV='test';

let rows: any[] = [];
const sort = jest.fn(async () => rows);
const scheduledMsgs: any = {
  find: jest.fn(() => ({ sort })),
  findOne: jest.fn(),
  insert: jest.fn(async (x:any) => x),
  remove: jest.fn(async () => ({ removed: 1 })),
  update: jest.fn(async () => ({ updated: 1 })),
};
const db: any = { scheduledMsgs, _pool: undefined };
let uuid = 0;

jest.mock('../db/loader', () => ({ __esModule:true, default:db }));
jest.mock('uuid', () => ({ v4: jest.fn(() => `sched-${++uuid}`) }));

import Scheduled from '../db/repositories/ScheduledMessageRepository';

function pgClient(cancelRow?: any) {
  const client:any = { release: jest.fn() };
  client.query = jest.fn(async (sql:string, params?:unknown[]) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('WITH due AS')) return { rows: [{ _id:'pg1', claimOwner:params?.[1], claimUntil:params?.[2], dispatchAttempts:1 }] };
    if (sql.includes('SELECT sent')) return { rows: cancelRow === undefined ? [] : [cancelRow] };
    if (sql.includes('UPDATE scheduled_msgs')) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected SQL ${sql}`);
  });
  return client;
}

describe('ScheduledMessageRepository production branches',()=>{
  beforeEach(()=>{
    jest.clearAllMocks(); rows=[]; db._pool=undefined;
    scheduledMsgs.find.mockImplementation(() => ({ sort }));
    sort.mockImplementation(async()=>rows);
    scheduledMsgs.findOne.mockResolvedValue(null);
    scheduledMsgs.insert.mockImplementation(async (x:any)=>x);
    scheduledMsgs.remove.mockResolvedValue({removed:1});
    scheduledMsgs.update.mockResolvedValue({updated:1});
  });

  it('covers basic CRUD helpers and defaults',async()=>{
    rows=[{_id:'a'}];
    await expect(Scheduled.findPending('u')).resolves.toEqual(rows);
    expect(scheduledMsgs.find).toHaveBeenCalledWith({userId:'u',sent:false,failedAt:null,cancelledAt:null});
    scheduledMsgs.findOne.mockResolvedValueOnce({_id:'a'});
    await expect(Scheduled.findById('a','u')).resolves.toEqual({_id:'a'});
    const inserted:any=await Scheduled.insert({userId:'u',sendAt:5});
    expect(inserted).toEqual(expect.objectContaining({_id:expect.stringMatching(/^sched-/),sent:false,dispatchAttempts:0,createdAt:expect.any(Number)}));
    await Scheduled.delete('a'); expect(scheduledMsgs.remove).toHaveBeenCalledWith({_id:'a'});
    await Scheduled.deleteByServer('s'); expect(scheduledMsgs.remove).toHaveBeenCalledWith({serverId:'s'});
    await Scheduled.markSent('a',77); expect(scheduledMsgs.update).toHaveBeenCalledWith({_id:'a'},{$set:{sent:true,sentAt:77}});
    const due:any={then:(resolve:any)=>resolve(['due'])}; scheduledMsgs.find.mockReturnValueOnce(due);
    await expect(Scheduled.findDueBefore(99)).resolves.toEqual(['due']);
  });

  it('fallback claim filters active leases, clamps bounds and increments attempt counters',async()=>{
    rows=[
      {_id:'expired',sendAt:1,claimUntil:99,dispatchAttempts:2},
      {_id:'fresh',sendAt:2,claimUntil:101,dispatchAttempts:8},
      {_id:'never',sendAt:3,claimUntil:null},
    ];
    const claimed=await Scheduled.claimDueBefore(100,'w',1,500);
    expect(claimed.map(x=>x._id)).toEqual(['expired','never']);
    expect(claimed.map(x=>x.dispatchAttempts)).toEqual([3,1]);
    expect(claimed.every(x=>x.claimUntil===30100)).toBe(true);
    expect(scheduledMsgs.update).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{_id:'bad-lease',sendAt:1,claimUntil:'1e3',dispatchAttempts:0}, /persisted epoch timestamp/],
    [{_id:'bad-attempts',sendAt:1,claimUntil:null,dispatchAttempts:'01'}, /dispatch attempts/],
  ])('fallback claim rejects corrupt durable numeric state %#',async(row,error)=>{
    rows=[row];
    await expect(Scheduled.claimDueBefore(1000,'w')).rejects.toThrow(error);
    expect(scheduledMsgs.update).not.toHaveBeenCalled();
  });

  it.each([
    [NaN,'w',120000,50],
    [-1,'w',120000,50],
    [1.5,'w',120000,50],
    [100,'',120000,50],
    [100,' w',120000,50],
    [100,'w',0,50],
    [100,'w',1.5,50],
    [100,'w',120000,0],
    [100,'w',120000,1.5],
  ])('claim rejects malformed internal lease contract %#',async(timestamp,owner,lease,limit)=>{
    await expect(Scheduled.claimDueBefore(timestamp as number,owner as string,lease as number,limit as number)).rejects.toThrow(/Invalid/);
  });

  it('PostgreSQL claim uses transaction/SKIP LOCKED and clamps max lease/limit',async()=>{
    const client=pgClient(); db._pool={connect:jest.fn(async()=>client)};
    const out=await Scheduled.claimDueBefore(1000,'node',99999999,999);
    expect(out[0]._id).toBe('pg1');
    expect(client.query).toHaveBeenNthCalledWith(1,'BEGIN');
    const cte=client.query.mock.calls.find((c:any[])=>String(c[0]).includes('WITH due AS'));
    expect(cte[0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(cte[1]).toEqual([1000,'node',601000,100]);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('PostgreSQL claim rolls back and releases on query failure even if rollback also fails',async()=>{
    const client:any={release:jest.fn(),query:jest.fn()};
    client.query.mockResolvedValueOnce({rows:[]}) // BEGIN
      .mockRejectedValueOnce(new Error('claim fail'))
      .mockRejectedValueOnce(new Error('rollback fail'));
    db._pool={connect:jest.fn(async()=>client)};
    await expect(Scheduled.claimDueBefore(1,'n')).rejects.toThrow('claim fail');
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it.each([
    ['finalizeSent','finalizeSent',['id','owner',123], true],
    ['releaseClaim','releaseClaim',['id','owner','x'.repeat(1200),999], true],
    ['markFailed','markFailed',['id','owner','y'.repeat(1200),555], true],
  ])('%s reports update success and bounds stored error text',async(_label,method,args,expected)=>{
    const result=await (Scheduled as any)[method](...args);
    expect(result).toBe(expected);
    const call=scheduledMsgs.update.mock.calls[0];
    const set=call[1].$set;
    if(method==='releaseClaim') expect(set.lastError).toHaveLength(1000);
    if(method==='markFailed'){expect(set.failureReason).toHaveLength(1000);expect(set.lastError).toHaveLength(1000);}
  });

  it('finalizers reject malformed owner/timestamp contracts before persistence',async()=>{
    await expect(Scheduled.finalizeSent('id','',123)).rejects.toThrow(/Invalid/);
    await expect(Scheduled.releaseClaim('id','owner','err',-1)).rejects.toThrow(/Invalid/);
    await expect(Scheduled.markFailed('id','owner','err',1.5)).rejects.toThrow(/Invalid/);
    await expect(Scheduled.cancelPending('id','user',-1)).rejects.toThrow(/Invalid/);
    expect(scheduledMsgs.update).not.toHaveBeenCalled();
  });

  it('finalizers report false on null/zero update result',async()=>{
    scheduledMsgs.update.mockResolvedValueOnce(null);
    expect(await Scheduled.finalizeSent('id','o')).toBe(false);
    scheduledMsgs.update.mockResolvedValueOnce({updated:0});
    expect(await Scheduled.releaseClaim('id','o','e',1)).toBe(false);
    scheduledMsgs.update.mockResolvedValueOnce({});
    expect(await Scheduled.markFailed('id','o','e')).toBe(false);
  });

  it.each([
    ['not_found', undefined, 'ROLLBACK'],
    ['sent', {sent:true,claimOwner:null,claimUntil:null,cancelledAt:null}, 'ROLLBACK'],
    ['cancelled', {sent:false,claimOwner:null,claimUntil:null,cancelledAt:5}, 'COMMIT'],
    ['dispatching', {sent:false,claimOwner:'w',claimUntil:101,cancelledAt:null}, 'ROLLBACK'],
    ['cancelled', {sent:false,claimOwner:'old',claimUntil:99,cancelledAt:null}, 'COMMIT'],
  ])('PostgreSQL cancel state %s is atomic',async(expected,row,endTx)=>{
    const client=pgClient(row); db._pool={connect:jest.fn(async()=>client)};
    await expect(Scheduled.cancelPending('id','u',100)).resolves.toBe(expected);
    expect(client.query).toHaveBeenCalledWith(endTx);
    if(expected==='cancelled' && !row?.cancelledAt) expect(client.query.mock.calls.some((c:any[])=>String(c[0]).includes('SET "cancelledAt"'))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  it('PostgreSQL cancel rollback failure does not mask original error and client is released',async()=>{
    const client:any={release:jest.fn(),query:jest.fn()};
    client.query.mockResolvedValueOnce({rows:[]}).mockRejectedValueOnce(new Error('select fail')).mockRejectedValueOnce(new Error('rb fail'));
    db._pool={connect:jest.fn(async()=>client)};
    await expect(Scheduled.cancelPending('id','u')).rejects.toThrow('select fail');
    expect(client.release).toHaveBeenCalled();
  });

  it('fallback cancel rejects a non-canonical persisted lease instead of treating it as expired/busy',async()=>{
    scheduledMsgs.findOne.mockResolvedValueOnce({sent:false,cancelledAt:null,claimOwner:'w',claimUntil:'1e3'});
    await expect(Scheduled.cancelPending('id','u',100)).rejects.toThrow(/persisted epoch timestamp/);
    expect(scheduledMsgs.update).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', null],
    ['sent',{sent:true}],
    ['cancelled',{sent:false,cancelledAt:1}],
    ['dispatching',{sent:false,cancelledAt:null,claimOwner:'w',claimUntil:101}],
    ['cancelled',{sent:false,cancelledAt:null,claimOwner:'old',claimUntil:99}],
  // Dizi ACIKCA tiplenir: her satir kendi nesne tipini alip birlesime
  // donuyordu ve `row.cancelledAt` bazi dallarda yok sayiliyordu.
  ] as Array<[string, Record<string, unknown> | null]>)('fallback cancel returns %s with serialized decision',async(expected,row)=>{
    scheduledMsgs.findOne.mockResolvedValueOnce(row);
    await expect(Scheduled.cancelPending('id','u',100)).resolves.toBe(expected);
    if(expected==='cancelled' && row && !row.cancelledAt) expect(scheduledMsgs.update).toHaveBeenCalled();
  });
});
