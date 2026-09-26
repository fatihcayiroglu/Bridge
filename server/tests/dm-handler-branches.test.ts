'use strict';
process.env.NODE_ENV = 'test';

import { createMockDb, makeUser } from './helpers/mockDb';

let db: any;

jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  db = createMockDb();
  return db;
});

import { cache } from '../lib/redisAdapter';
import logger from '../lib/logger';
import { Dms, GroupDms, Social, Users } from '../db/repositories';
import { registerDmHandlers, registerGroupDmHandlers } from '../socket/handlers/dm';

function makeSocket(id: string = 'sock') {
  const handlers: Record<string, (payload?: any) => any> = {};
  const emitted: any[] = [];
  const rooms = new Set<string>([id]);
  return {
    id,
    data: { userId: id, displayName: id },
    rooms,
    on: jest.fn((ev: string, fn: any) => { handlers[ev] = fn; }),
    emit: jest.fn((ev: string, data: any) => { emitted.push({ ev, data }); }),
    join: jest.fn((room: string) => { rooms.add(room); }),
    leave: jest.fn((room: string) => { rooms.delete(room); }),
    to: jest.fn((room: string) => ({ emit: (ev: string, data: any) => emitted.push({ ev, data, room }) })),
    _handlers: handlers,
    _emitted: emitted,
    async trigger(ev: string, payload?: any) { return await handlers[ev]?.(payload); },
  } as any;
}

function makeIo() {
  const emitted: any[] = [];
  const roomSockets = new Map<string, any[]>();
  return {
    emitted,
    roomSockets,
    to: jest.fn((target: string) => ({ emit: (ev: string, data: any) => emitted.push({ ev, data, target }) })),
    in: jest.fn((room: string) => ({ fetchSockets: async () => roomSockets.get(room) ?? [] })),
  } as any;
}

function redisRateClient(count: number, reject = false) {
  const exec = reject ? jest.fn().mockRejectedValue(new Error('redis down')) : jest.fn().mockResolvedValue([1, 1, count, 1]);
  const pipe = {
    zAdd: jest.fn(), zRemRangeByScore: jest.fn(), zCard: jest.fn(), expire: jest.fn(), exec,
  };
  return { multi: jest.fn(() => pipe), pipe };
}

async function setupUsers(aOverrides: any = {}, bOverrides: any = {}) {
  const a = makeUser({ displayName: 'Alice', ...aOverrides });
  const b = makeUser({ displayName: 'Bob', ...bOverrides });
  await db.users.insert(a); await db.users.insert(b);
  return { a, b };
}

beforeEach(() => {
  jest.restoreAllMocks();
  db = createMockDb();
  Object.assign(require('../db/loader'), db);
});

afterEach(() => jest.useRealTimers());

describe('DM handler — failure/privacy/rate branches', () => {
  it('Redis rate limiter denies DM before any state mutation', async () => {
    // KANONIK SIRA: nonce cozumu (SALT OKUMA) -> hiz kapisi -> ilk MUTASYON.
    // Idempotent yeniden gonderimlerin ikinci bir hiz slotu tuketmemesi icin
    // kapi okuma adimlarinin ALTINDADIR; ancak `findOrCreateConversation`
    // (bir YAZMA) kapinin ALTINDA kalirsa reddedilen her gonderim yine de
    // konusma satiri yaratirdi. Sozlesme: reddedilen gonderim HICBIR yazma
    // yapmaz.
    const { a, b } = await setupUsers();
    jest.spyOn(cache, 'slidingWindowCount').mockResolvedValueOnce(999);
    const s = makeSocket(); const io = makeIo();
    registerDmHandlers(s, io, a, new Map());
    const createConversation = jest.spyOn(Dms, 'findOrCreateConversation');
    const insertMessage = jest.spyOn(Dms, 'insertMessage');
    await s.trigger('dm:send', { toUserId: b._id, content: 'x' });
    expect(s._emitted.some((e: any) => e.ev === 'error:dm_rate')).toBe(true);
    expect(createConversation).not.toHaveBeenCalled();
    expect(insertMessage).not.toHaveBeenCalled();
  });

  it('Redis failure falls back to in-memory limiter and allows first hit', async () => {
    const { a, b } = await setupUsers();
    jest.spyOn(cache, 'slidingWindowCount').mockRejectedValueOnce(new Error('redis down'));
    const s = makeSocket(); const io = makeIo();
    registerDmHandlers(s, io, a, new Map());
    await s.trigger('dm:send', { toUserId: b._id, content: 'fallback' });
    expect(s._emitted.some((e: any) => e.ev === 'dm:message')).toBe(true);
  });

  it('missing recipient, first-direction block and reverse-direction block all deny', async () => {
    const { a, b } = await setupUsers();
    jest.spyOn(cache, '_client').mockReturnValue(null);
    const mk = () => { const s=makeSocket(); const io=makeIo(); registerDmHandlers(s,io,a,new Map()); return {s,io}; };

    jest.spyOn(Users, 'findById').mockResolvedValueOnce(null as any);
    let h=mk(); await h.s.trigger('dm:send',{toUserId:'missing',content:'x'}); expect(h.io.emitted).toHaveLength(0);

    jest.spyOn(Social, 'findBlock').mockResolvedValueOnce({ _id:'block' } as any);
    h=mk(); await h.s.trigger('dm:send',{toUserId:b._id,content:'x'}); expect(h.io.emitted).toHaveLength(0);

    jest.spyOn(Social, 'findBlock').mockResolvedValueOnce(null as any).mockResolvedValueOnce({ _id:'reverse' } as any);
    h=mk(); await h.s.trigger('dm:send',{toUserId:b._id,content:'x'}); expect(h.io.emitted).toHaveLength(0);
  });

  it('privacy none denies new conversation; existing conversation bypasses restriction', async () => {
    const { a, b } = await setupUsers({}, { dmPrivacy: 'none' });
    jest.spyOn(cache, '_client').mockReturnValue(null);
    let s=makeSocket(); let io=makeIo(); registerDmHandlers(s,io,a,new Map());
    await s.trigger('dm:send',{toUserId:b._id,content:'new'});
    expect(s._emitted.some((e:any)=>e.ev==='error:dm_privacy')).toBe(true);

    await db.dmConversations.insert({ _id:[a._id,b._id].sort().join('_'), participants:[a._id,b._id], createdAt:1,lastMessageAt:1 });
    s=makeSocket(); io=makeIo(); registerDmHandlers(s,io,a,new Map());
    await s.trigger('dm:send',{toUserId:b._id,content:'existing'});
    expect(s._emitted.some((e:any)=>e.ev==='dm:message')).toBe(true);
  });

  it('friends privacy denies non-friend and allows accepted friendship', async () => {
    const { a, b } = await setupUsers({}, { dmPrivacy: 'friends' });
    jest.spyOn(cache, '_client').mockReturnValue(null);
    jest.spyOn(Social, 'findFriendship').mockResolvedValueOnce(null as any);
    let s=makeSocket(); let io=makeIo(); registerDmHandlers(s,io,a,new Map());
    await s.trigger('dm:send',{toUserId:b._id,content:'nope'});
    expect(s._emitted.some((e:any)=>e.ev==='error:dm_privacy')).toBe(true);

    jest.spyOn(Social, 'findFriendship').mockResolvedValueOnce({status:'accepted'} as any);
    s=makeSocket(); io=makeIo(); registerDmHandlers(s,io,a,new Map());
    await s.trigger('dm:send',{toUserId:b._id,content:'ok'});
    expect(s._emitted.some((e:any)=>e.ev==='dm:message')).toBe(true);
  });

  it('plain length cap and E2E length cap are independently enforced', async () => {
    const { a, b } = await setupUsers(); jest.spyOn(cache,'_client').mockReturnValue(null);
    const s=makeSocket(); const io=makeIo(); registerDmHandlers(s,io,a,new Map());
    await s.trigger('dm:send',{toUserId:b._id,content:'x'.repeat(2001)});
    await s.trigger('dm:send',{toUserId:b._id,content:'🔒e2e:'+'x'.repeat(20000)});
    expect(s._emitted.filter((e:any)=>e.ev==='dm:message')).toHaveLength(0);
    await s.trigger('dm:send',{toUserId:b._id,content:'🔒e2e:'+'x'.repeat(100)});
    expect(s._emitted.find((e:any)=>e.ev==='dm:message')?.data.e2e).toBe(true);
  });

  it('dm:read supports object payload and reports repository failure', async () => {
    const { a }=await setupUsers(); const s=makeSocket(); const io=makeIo(); registerDmHandlers(s,io,a,new Map());
    jest.spyOn(Dms,'markRead').mockResolvedValueOnce(true as any);
    await s.trigger('dm:read',{dmId:'dm-1'});
    expect(io.emitted.some((e:any)=>e.ev==='inbox:changed')).toBe(true);
    jest.spyOn(Dms,'markRead').mockRejectedValueOnce(new Error('db down'));
    const ce=jest.spyOn(console,'error').mockImplementation(()=>{});
    await s.trigger('dm:read','dm-2');
    expect(s._emitted.some((e:any)=>e.ev==='error:dm_read')).toBe(true); expect(ce).toHaveBeenCalled();
  });

  it('dm:join rejects outsider and replaces an old DM room for participant', async () => {
    const { a,b }=await setupUsers(); const s=makeSocket(); const io=makeIo(); s.rooms.add('dm:old'); registerDmHandlers(s,io,a,new Map());
    jest.spyOn(Dms,'findConversation').mockResolvedValueOnce({participants:[b._id]} as any);
    await s.trigger('dm:join','foreign'); expect(s.rooms.has('dm:foreign')).toBe(false);
    jest.spyOn(Dms,'findConversation').mockResolvedValueOnce({participants:[a._id,b._id]} as any);
    await s.trigger('dm:join','mine'); expect(s.rooms.has('dm:old')).toBe(false); expect(s.rooms.has('dm:mine')).toBe(true);
  });

  it('dm:react parses malformed JSON safely, adds then removes reaction', async () => {
    const {a,b}=await setupUsers(); const s=makeSocket(); const io=makeIo(); registerDmHandlers(s,io,a,new Map());
    const upd=jest.spyOn(Dms,'updateMessage').mockResolvedValue({} as any);
    jest.spyOn(Dms,'findMessage').mockResolvedValueOnce({_id:'m',reactions:'{bad'} as any).mockResolvedValueOnce({_id:'m',reactions:{'👍':[a._id]}} as any);
    jest.spyOn(Dms,'findConversation').mockResolvedValue({participants:[a._id,b._id]} as any);
    await s.trigger('dm:react',{messageId:'m',dmId:'d',emoji:'👍'});
    expect((upd.mock.calls[0][1] as any).reactions['👍']).toEqual([a._id]);
    await s.trigger('dm:react',{messageId:'m',dmId:'d',emoji:'👍'});
    expect((upd.mock.calls[1][1] as any).reactions['👍']).toBeUndefined();
  });

  it('dm:react fails closed after either participant blocks the other', async () => {
    const {a,b}=await setupUsers(); const s=makeSocket(); const io=makeIo(); registerDmHandlers(s,io,a,new Map());
    const upd=jest.spyOn(Dms,'updateMessage').mockResolvedValue({} as any);
    jest.spyOn(Dms,'findMessage').mockResolvedValue({_id:'m',reactions:{}} as any);
    jest.spyOn(Dms,'findConversation').mockResolvedValue({participants:[a._id,b._id]} as any);
    jest.spyOn(Social,'findBlock').mockResolvedValueOnce({ _id:'blocked' } as any);
    await s.trigger('dm:react',{messageId:'m',dmId:'d',emoji:'👍'});
    expect(upd).not.toHaveBeenCalled();
    expect(io.emitted.some((e:any)=>e.ev==='dm:reaction')).toBe(false);
  });

  it('dm:react contains malformed persisted state and prototype-shaped emoji keys', async () => {
    const {a,b}=await setupUsers(); const s=makeSocket(); const io=makeIo(); registerDmHandlers(s,io,a,new Map());
    const upd=jest.spyOn(Dms,'updateMessage').mockResolvedValue({} as any);
    jest.spyOn(Dms,'findConversation').mockResolvedValue({participants:[a._id,b._id]} as any);
    jest.spyOn(Dms,'findMessage')
      .mockResolvedValueOnce({_id:'m1',reactions:'null'} as any)
      .mockResolvedValueOnce({_id:'m2',reactions:{}} as any);

    await s.trigger('dm:react',{messageId:'m1',dmId:'d',emoji:'👍'});
    await s.trigger('dm:react',{messageId:'m2',dmId:'d',emoji:'__proto__'});

    expect(upd).toHaveBeenCalledTimes(2);
    expect((upd.mock.calls[0][1] as any).reactions['👍']).toEqual([a._id]);
    const prototypeMap=(upd.mock.calls[1][1] as any).reactions;
    expect(Object.prototype.hasOwnProperty.call(prototypeMap,'__proto__')).toBe(true);
    expect(prototypeMap['__proto__']).toEqual([a._id]);
  });

  it('call block, missed timeout, disconnect cleanup and wrong signaling target are protected', async () => {
    jest.useFakeTimers();
    const {a,b}=await setupUsers(); const s=makeSocket('sa'); const io=makeIo(); registerDmHandlers(s,io,a,new Map());
    jest.spyOn(Social,'findBlock').mockResolvedValueOnce({ _id:'blocked' } as any);
    await s.trigger('dm:call:start',{toUserId:b._id,type:'voice'});
    expect(s._emitted.some((e:any)=>e.ev==='dm:call:outgoing')).toBe(false);

    jest.spyOn(Social,'findBlock').mockResolvedValue(null as any);
    await s.trigger('dm:call:start',{toUserId:b._id,type:'voice'});
    const callId=s._emitted.find((e:any)=>e.ev==='dm:call:outgoing').data.callId;
    await s.trigger('dm:call:offer',{callId,targetUserId:'attacker',offer:{}});
    expect(io.emitted.some((e:any)=>e.ev==='dm:call:offer')).toBe(false);
    await jest.advanceTimersByTimeAsync(30_001);
    expect(s._emitted.some((e:any)=>e.ev==='dm:call:missed')).toBe(true);

    await s.trigger('dm:call:start',{toUserId:b._id,type:'video'});
    const call2=s._emitted.filter((e:any)=>e.ev==='dm:call:outgoing').at(-1).data.callId;
    await s.trigger('disconnect');
    expect(io.emitted.some((e:any)=>e.ev==='dm:call:ended' && e.data.callId===call2 && e.data.reason==='disconnect')).toBe(true);
  });
});

describe('GDM handler — membership/rate/call branches', () => {
  async function groupSetup() {
    const {a,b}=await setupUsers();
    const group={_id:'g-1',name:'G',createdBy:a._id,createdAt:1,lastMessageAt:1};
    await db.groupDmConversations.insert(group);
    await db.groupDmMembers.insert({_id:'ma',groupId:'g-1',userId:a._id,joinedAt:1});
    await db.groupDmMembers.insert({_id:'mb',groupId:'g-1',userId:b._id,joinedAt:1});
    return {a,b,group};
  }

  it('initial room join failure is observable', async () => {
    const {a}=await groupSetup(); const s=makeSocket(); const io=makeIo();
    jest.spyOn(GroupDms,'findGroupsByUser').mockRejectedValueOnce(new Error('db down'));
    const warn=jest.spyOn(logger,'warn').mockImplementation(()=>logger as any);
    registerGroupDmHandlers(s,io,a,new Map()); await new Promise(r=>setImmediate(r));
    expect(warn).toHaveBeenCalled();
  });

  it('Redis GDM rate denial happens before any state mutation', async () => {
    // Uyelik YETKI otoritesidir ve yeniden gonderimlerde de dogrulanmalidir,
    // bu yuzden hiz kapisinin USTUNDEDIR (salt okuma). Reddedilen gonderim
    // hicbir mesaj YAZMAZ.
    const {a}=await groupSetup(); jest.spyOn(cache,'slidingWindowCount').mockResolvedValueOnce(999);
    const insert=jest.spyOn(GroupDms,'insertMessage'); const s=makeSocket(); const io=makeIo(); registerGroupDmHandlers(s,io,a,new Map()); await new Promise(r=>setImmediate(r));
    insert.mockClear(); await s.trigger('gdm:send',{groupId:'g-1',content:'x'});
    expect(s._emitted.some((e:any)=>e.ev==='error:gdm_rate')).toBe(true); expect(insert).not.toHaveBeenCalled();
  });

  it('gdm read false does not broadcast; true does', async () => {
    const {a}=await groupSetup(); const s=makeSocket(); const io=makeIo(); registerGroupDmHandlers(s,io,a,new Map());
    jest.spyOn(GroupDms,'markRead').mockResolvedValueOnce(false as any).mockResolvedValueOnce(true as any);
    await s.trigger('gdm:read',{groupId:'g-1'}); expect(io.emitted).toHaveLength(0);
    await s.trigger('gdm:read','g-1'); expect(io.emitted.some((e:any)=>e.ev==='inbox:changed')).toBe(true);
  });

  it('gdm read rejects array/object identifier coercion before touching membership state', async () => {
    const {a}=await groupSetup(); const s=makeSocket(); const io=makeIo(); registerGroupDmHandlers(s,io,a,new Map());
    const mark=jest.spyOn(GroupDms,'markRead');
    await s.trigger('gdm:read',{groupId:['g-1']});
    await s.trigger('gdm:read',{groupId:{toString:()=> 'g-1'}});
    expect(mark).not.toHaveBeenCalled();
    expect(io.emitted).toHaveLength(0);
  });

  it('typing/member and call start invalid type/outside membership fail closed', async () => {
    const {a}=await groupSetup(); const s=makeSocket(); const io=makeIo(); registerGroupDmHandlers(s,io,a,new Map());
    jest.spyOn(GroupDms,'findMember').mockResolvedValueOnce(null as any);
    await s.trigger('gdm:typing',{groupId:'g-x'}); expect(s._emitted.some((e:any)=>e.ev==='gdm:typing')).toBe(false);
    await s.trigger('gdm:call:start',{groupId:'g-1',type:'screenshare'}); expect(s.rooms.has('gdm:voice:g-1')).toBe(false);
    jest.spyOn(GroupDms,'findMember').mockResolvedValueOnce(null as any);
    await s.trigger('gdm:call:start',{groupId:'g-x',type:'voice'}); expect(s.rooms.has('gdm:voice:g-x')).toBe(false);
  });

  it('call join enumerates existing peers, leave enforces participation, end ejects room sockets', async () => {
    const {a}=await groupSetup(); const s=makeSocket('mine'); const io=makeIo(); registerGroupDmHandlers(s,io,a,new Map());
    const peer={id:'peer',data:{userId:'u2',displayName:'Peer'},leave:jest.fn()}; io.roomSockets.set('gdm:voice:g-1',[s,peer]);
    await s.trigger('gdm:call:join',{groupId:'g-1',type:'video'});
    expect(s._emitted.find((e:any)=>e.ev==='gdm:call:existing:peers')?.data.peers).toEqual([{socketId:'peer',userId:'u2',displayName:'Peer'}]);
    await s.trigger('gdm:call:leave',{groupId:'g-1'}); expect(s.rooms.has('gdm:voice:g-1')).toBe(false);
    await s.trigger('gdm:call:end',{groupId:'g-1'}); expect(peer.leave).not.toHaveBeenCalled(); // no longer participant
    s.rooms.add('gdm:voice:g-1');
    await s.trigger('gdm:call:end',{groupId:'g-1'}); expect(peer.leave).toHaveBeenCalledWith('gdm:voice:g-1');
  });

  it('signaling requires sender call participation and target membership in voice room', async () => {
    const {a}=await groupSetup(); const s=makeSocket('mine'); const io=makeIo(); registerGroupDmHandlers(s,io,a,new Map());
    const peer={id:'peer',data:{userId:'u2'}}; io.roomSockets.set('gdm:voice:g-1',[s,peer]);
    await s.trigger('gdm:call:offer',{groupId:'g-1',targetSocketId:'peer',offer:{sdp:'x'}});
    expect(io.emitted.some((e:any)=>e.ev==='gdm:call:offer')).toBe(false);
    s.rooms.add('gdm:voice:g-1');
    await s.trigger('gdm:call:offer',{groupId:'g-1',targetSocketId:'missing',offer:{}});
    expect(io.emitted.some((e:any)=>e.ev==='gdm:call:offer')).toBe(false);
    await s.trigger('gdm:call:offer',{groupId:'g-1',targetSocketId:'peer',offer:{sdp:'ok'}});
    await s.trigger('gdm:call:answer',{groupId:'g-1',targetSocketId:'peer',answer:{sdp:'ok'}});
    await s.trigger('gdm:call:ice',{groupId:'g-1',targetSocketId:'peer',candidate:{c:'ok'}});
    expect(io.emitted.filter((e:any)=>e.target==='peer').map((e:any)=>e.ev)).toEqual(['gdm:call:offer','gdm:call:answer','gdm:call:ice']);
  });

  it('call state requires active voice-room membership', async () => {
    const {a}=await groupSetup(); const s=makeSocket('mine'); const io=makeIo(); registerGroupDmHandlers(s,io,a,new Map());
    await s.trigger('gdm:call:state',{groupId:'g-1',muted:true,video:false});
    expect(s._emitted.some((e:any)=>e.ev==='gdm:call:peer:state')).toBe(false);
    s.rooms.add('gdm:voice:g-1');
    await s.trigger('gdm:call:state',{groupId:'g-1',muted:true,video:false});
    expect(s._emitted.some((e:any)=>e.ev==='gdm:call:peer:state')).toBe(true);
  });
});
