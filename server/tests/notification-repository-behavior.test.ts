'use strict';
process.env.NODE_ENV='test';

const pref:any={findOne:jest.fn(),find:jest.fn(),insert:jest.fn(),update:jest.fn(),remove:jest.fn()};
const push:any={find:jest.fn(),findOne:jest.fn(),insert:jest.fn(),update:jest.fn(),remove:jest.fn()};
const native:any={find:jest.fn(),findOne:jest.fn(),insert:jest.fn(),update:jest.fn(),remove:jest.fn()};
const fcm:any={find:jest.fn(),remove:jest.fn()};
const unread:any={find:jest.fn(),findOne:jest.fn(),insert:jest.fn(),update:jest.fn()};
const notifications:any={find:jest.fn(),findOne:jest.fn(),insert:jest.fn(),update:jest.fn()};
const channels:any={find:jest.fn()};
const db:any={notificationPrefs:pref,pushSubscriptions:push,nativePushTokens:native,fcmTokens:fcm,unreadCounts:unread,notifications,channels,_pool:undefined};
jest.mock('../db/loader',()=>({__esModule:true,default:db}));
let serial=0;
jest.mock('uuid',()=>({v4:jest.fn(()=>`uuid-${++serial}`)}));
import Notifications from '../db/repositories/NotificationRepository';

describe('NotificationRepository behavior and fail-safe branches',()=>{
  beforeEach(()=>{
    jest.clearAllMocks(); process.env.NODE_ENV='test'; db._pool=undefined;
    for(const x of [pref,push,native,fcm,unread,notifications,channels]) for(const k of Object.keys(x)) (x[k] as jest.Mock).mockReset();
    pref.findOne.mockResolvedValue(null); pref.find.mockResolvedValue([]); pref.insert.mockImplementation(async(x:any)=>x); pref.update.mockResolvedValue({updated:1}); pref.remove.mockResolvedValue({removed:1});
    push.find.mockResolvedValue([]);push.findOne.mockResolvedValue(null);push.insert.mockImplementation(async(x:any)=>x);push.update.mockResolvedValue({updated:1});push.remove.mockResolvedValue({removed:1});
    native.find.mockResolvedValue([]);native.findOne.mockResolvedValue(null);native.insert.mockImplementation(async(x:any)=>x);native.update.mockResolvedValue({updated:1});native.remove.mockResolvedValue({removed:1});
    fcm.find.mockResolvedValue([]);fcm.remove.mockResolvedValue({removed:1}); unread.find.mockResolvedValue([]);unread.findOne.mockResolvedValue(null);unread.insert.mockImplementation(async(x:any)=>x);unread.update.mockResolvedValue({updated:1});
    notifications.find.mockResolvedValue([]);notifications.findOne.mockResolvedValue(null);notifications.insert.mockImplementation(async(x:any)=>x);notifications.update.mockResolvedValue({updated:1});channels.find.mockResolvedValue([]);
  });

  it('upserts preferences rather than creating duplicates',async()=>{
    await Notifications.upsertPref('u','c',{level:'all'});
    expect(pref.insert).toHaveBeenCalledWith({userId:'u',channelId:'c',level:'all'});
    pref.findOne.mockResolvedValueOnce({_id:'p'});
    await Notifications.upsertPref('u','c',{level:'mentions'});
    expect(pref.update).toHaveBeenCalledWith({userId:'u',channelId:'c'},{$set:{level:'mentions'}});
  });


  it('canonical preference identity and table columns cannot be overridden by dynamic fields',async()=>{
    await Notifications.upsertPref('owner','canonical',{level:'all',muteUntil:null,updatedAt:7,userId:'evil',channelId:'other',_id:'evil-id',serverId:'s',isServerLevel:true});
    expect(pref.insert).toHaveBeenCalledWith({userId:'owner',channelId:'canonical',level:'all',muteUntil:null,updatedAt:7});
  });

  it('concurrent preference insert loser converges on update but non-unique failures propagate',async()=>{
    pref.findOne.mockResolvedValue(null);
    const duplicate:any=new Error('duplicate key value violates unique constraint'); duplicate.code='23505';
    pref.insert.mockRejectedValueOnce(duplicate);
    await expect(Notifications.upsertPref('u','c',{level:'mute'})).resolves.toEqual({updated:1});
    expect(pref.update).toHaveBeenCalledWith({userId:'u',channelId:'c'},{$set:{level:'mute'}});

    const realFailure:any=new Error('disk write failed'); realFailure.code='XX001';
    pref.insert.mockRejectedValueOnce(realFailure);
    await expect(Notifications.upsertPref('u','other',{level:'all'})).rejects.toThrow('disk write failed');
  });

  it('push storage failures stay observable while genuine empty reads remain empty',async()=>{
    push.find.mockRejectedValueOnce(new Error('db')); await expect(Notifications.findPushSubscriptions('u')).rejects.toThrow('db');
    push.find.mockResolvedValueOnce(undefined); await expect(Notifications.findPushSubscriptionsForUser('u')).resolves.toEqual([]);
    push.findOne.mockRejectedValueOnce(new Error('db')); await expect(Notifications.findPushSubscriptionByEndpoint('e')).rejects.toThrow('db');
    push.findOne.mockRejectedValueOnce(new Error('db')); await expect(Notifications.findPushSubscriptionForUserEndpoint('u','e')).rejects.toThrow('db');
    await Notifications.insertPushSubscription({endpoint:'e'}); await Notifications.removePushSubscription('e');
    await Notifications.updatePushSubscription({endpoint:'e'},{$set:{x:1}}); await Notifications.removePushSubscriptionWhere({userId:'u'});
    expect(push.remove).toHaveBeenLastCalledWith({userId:'u'},{});
  });

  it('missing preference/inbox stores fail closed instead of fabricating empty policy state',async()=>{
    const oldPrefs=db.notificationPrefs, oldInbox=db.notifications;
    db.notificationPrefs=undefined;
    await expect(Notifications.findPref('u','c')).rejects.toThrow('notificationPrefs store unavailable');
    await expect(Notifications.findPrefsForUser('u')).rejects.toThrow('notificationPrefs store unavailable');
    expect(()=>Notifications.prefsFind({userId:'u'})).toThrow('notificationPrefs store unavailable');
    db.notificationPrefs=oldPrefs;
    db.notifications=undefined;
    await expect(Notifications.findInbox({userId:'u'})).rejects.toThrow('notifications store unavailable');
    await expect(Notifications.insertInbox({userId:'u'})).rejects.toThrow('notifications store unavailable');
    db.notifications=oldInbox;
  });

  it('preference/token collection helpers fail safely and server prefs only query real channel ids',async()=>{
    await expect(Notifications.prefsFindForUserChannels('u',[])).resolves.toEqual([]);
    pref.find.mockRejectedValueOnce(new Error('x')); await expect(Notifications.prefsFindForUserChannels('u',['c'])).rejects.toThrow('x');
    native.find.mockRejectedValueOnce(new Error('x')); await expect(Notifications.findNativeTokensForUser('u')).rejects.toThrow('x');
    fcm.find.mockRejectedValueOnce(new Error('x')); await expect(Notifications.findFcmTokensForUser('u')).rejects.toThrow('x');
    channels.find.mockResolvedValueOnce([{_id:'c1'},{_id:null},{}, {_id:'c2'}]); pref.find.mockResolvedValueOnce([{x:1}]);
    await expect(Notifications.findPrefsForUserInServer('u','s')).resolves.toEqual([{x:1}]);
    expect(pref.find).toHaveBeenLastCalledWith({userId:'u',channelId:{$in:['c1','c2']}});
    channels.find.mockResolvedValueOnce([]); await expect(Notifications.findPrefsForUserInServer('u','empty')).resolves.toEqual([]);
    channels.find.mockRejectedValueOnce(new Error('channels down')); await expect(Notifications.findPrefsForUserInServer('u','s')).rejects.toThrow('channels down');
    pref.find.mockRejectedValueOnce(new Error('x')); await expect(Notifications.findPrefsForUser('u')).rejects.toThrow('x');
    pref.findOne.mockRejectedValueOnce(new Error('x')); await expect(Notifications.findServerPref('u','s')).rejects.toThrow('x');
  });

  it('unread atomic owner is test-safe, fail-closed without PG, and executes one PG upsert in production',async()=>{
    await expect(Notifications.unreadIncrementAtomic('u','c',10)).resolves.toBe(false);
    process.env.NODE_ENV='production'; await expect(Notifications.unreadIncrementAtomic('u','c',10)).rejects.toThrow(/PostgreSQL pool unavailable/);
    const query=jest.fn<Promise<unknown>, [sql: string, params?: readonly unknown[]]>(async()=>({rows:[]})); db._pool={query};
    await expect(Notifications.unreadIncrementAtomic('u','c',10)).resolves.toBe(true);
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT ("userId", "channelId")');
    expect(query.mock.calls[0][1]).toEqual(['u','c',10]);
  });

  // P4-04: a device token identifies one installation. Before P4 rows were keyed per
  // user+platform while `token` is UNIQUE, so a second account on the same phone failed to
  // register and the first account kept receiving there (pg-integration/native-push-token-ownership).
  it('native tokens move to the account that registers them, per installation, without duplicates',async()=>{
    native.find.mockResolvedValue([]);
    await Notifications.upsertNativeToken('u','ios','a');
    expect(native.remove).toHaveBeenCalledWith({token:'a',userId:{$ne:'u'}});
    expect(native.insert).toHaveBeenCalledWith(expect.objectContaining({userId:'u',platform:'ios',token:'a',createdAt:expect.any(Number),updatedAt:expect.any(Number)}));
    expect(String(native.insert.mock.calls[0][0]._id)).toMatch(/^npt_/);

    native.insert.mockClear();
    native.findOne.mockResolvedValueOnce({_id:'old'}); await Notifications.upsertNativeToken('u','ios','a');
    expect(native.update).toHaveBeenCalledWith({_id:'old'},{$set:{platform:'ios',updatedAt:expect.any(Number)}});
    expect(native.insert).not.toHaveBeenCalled();

    await Notifications.removeNativeToken('u','ios'); expect(native.remove).toHaveBeenCalledWith({userId:'u',platform:'ios'});
    await Notifications.removeNativeTokenForUser('u','a'); expect(native.remove).toHaveBeenCalledWith({userId:'u',token:'a'});
  });

  it('keeps at most NATIVE_TOKENS_PER_USER installations, dropping the least recently updated',async()=>{
    const rows=Array.from({length:12},(_,i)=>({_id:`r${i}`,updatedAt:i}));
    native.find.mockResolvedValueOnce(rows);
    await Notifications.upsertNativeToken('u','android','fresh');
    expect(native.remove).toHaveBeenCalledWith({_id:{$in:['r1','r0']}});
  });

  it('channel attention is idempotent and distinguishes duplicates from real write failures',async()=>{
    notifications.findOne.mockResolvedValueOnce({_id:'exists'});
    await expect(Notifications.insertChannelAttention({userId:'u',type:'mention',serverId:'s',channelId:'c',messageId:'m',actorId:'a'})).resolves.toBe(false);
    notifications.findOne.mockResolvedValueOnce(null);
    await expect(Notifications.insertChannelAttention({userId:'u',type:'reply',serverId:'s',channelId:'c',messageId:'m2',actorId:'a',createdAt:123})).resolves.toBe(true);
    expect(notifications.insert).toHaveBeenCalledWith(expect.objectContaining({_id:'inbox:u:m2',createdAt:123,read:false}));
    notifications.findOne.mockResolvedValueOnce(null); notifications.insert.mockRejectedValueOnce(Object.assign(new Error('duplicate key'),{code:'23505'}));
    await expect(Notifications.insertChannelAttention({userId:'u',type:'mention',serverId:'s',channelId:'c',messageId:'m3',actorId:'a'})).resolves.toBe(false);
    notifications.findOne.mockResolvedValueOnce(null); notifications.insert.mockRejectedValueOnce(new Error('unique constraint'));
    await expect(Notifications.insertChannelAttention({userId:'u',type:'mention',serverId:'s',channelId:'c',messageId:'m4',actorId:'a'})).resolves.toBe(false);
    notifications.findOne.mockResolvedValueOnce(null); notifications.insert.mockRejectedValueOnce(new Error('disk offline'));
    await expect(Notifications.insertChannelAttention({userId:'u',type:'mention',serverId:'s',channelId:'c',messageId:'m5',actorId:'a'})).rejects.toThrow('disk offline');
  });

  it('attention listing clamps limits and read/clear mutations remain recipient scoped',async()=>{
    const limit=jest.fn(async()=>['x']); const sort=jest.fn(()=>({limit})); notifications.find.mockReturnValueOnce({sort});
    await expect(Notifications.findUnreadChannelAttention('u',999)).resolves.toEqual(['x']); expect(limit).toHaveBeenCalledWith(200);
    notifications.find.mockReturnValueOnce({sort}); await Notifications.findUnreadChannelAttention('u',0); expect(limit).toHaveBeenLastCalledWith(1);
    await Notifications.markChannelAttentionRead('u','c'); await Notifications.markAllChannelAttentionRead('u'); await Notifications.clearAllUnreadCounts('u');
    expect(notifications.update).toHaveBeenCalledWith({userId:'u',channelId:'c',read:false,type:{$in:['mention','reply','watch']}},{$set:{read:true}},{multi:true});
    expect(unread.update).toHaveBeenCalledWith({userId:'u',count:{$gt:0}},{$set:{count:0,updatedAt:expect.any(Number)}},{multi:true});
  });

  it('covers inbox and low-level collection adapters and propagates bulk failure truthfully',async()=>{
    await expect(Notifications.insertInbox({userId:'u'})).resolves.toEqual(expect.objectContaining({_id:expect.stringMatching(/^uuid-/),userId:'u',createdAt:expect.any(Number)}));
    await expect(Notifications.findInbox({userId:'u'})).resolves.toEqual([]);
    await Notifications.updateInbox({x:1},{$set:{y:2}}); await expect(Notifications.inboxFind({x:1})).resolves.toEqual([]);
    notifications.update.mockRejectedValueOnce(new Error('x')); await expect(Notifications.updateInboxMany({},{},{multi:true})).rejects.toThrow('x');
    await Notifications.removeNativeTokenWhere({token:'x'}); await Notifications.removeFcmTokenWhere({token:'y'});
    await Notifications.unreadFind({userId:'u'}); await Notifications.unreadFindOne({userId:'u'}); await Notifications.unreadUpdate({},{}); await Notifications.unreadInsert({});
    Notifications.prefsFind({userId:'u'}); await Notifications.deletePref('u','c'); await Notifications.deletePref('u',undefined,'s');
    expect(pref.remove).toHaveBeenLastCalledWith({userId:'u',channelId:'server:s'});
  });
});
