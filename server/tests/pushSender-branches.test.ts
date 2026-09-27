'use strict';
process.env.NODE_ENV = 'test';

jest.mock('../lib/ssrfGuard', () => ({ assertUrlIsPublic: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../lib/notificationMute', () => ({
  isMuted: jest.fn((p: any) => p.level === 'mute' && (!p.muteUntil || p.muteUntil > Date.now())),
}));

import { Dms, Members, Channels, Messages, Notifications } from '../db/repositories';
import * as pushSender from '../lib/pushSender';

beforeEach(() => {
  jest.restoreAllMocks();
  delete process.env.APNS_KEY_PATH;
  delete process.env.APNS_KEY_ID;
  delete process.env.APNS_TEAM_ID;
  delete process.env.APNS_BUNDLE_ID;
  delete process.env.FCM_PROJECT_ID;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

describe('getUnreadCount — privacy/mute/failure branches', () => {
  it('counts incoming DM and visible unmuted channel messages after read cursors', async () => {
    jest.spyOn(Dms, 'findConversationsByUser').mockResolvedValue([
      { _id: 'd1', lastRead: { u: 100 } },
      { _id: 'd2', lastRead: {} },
    ] as any);
    jest.spyOn(Dms, 'findMessagesWhere').mockResolvedValue([
      { dmId: 'd1', createdAt: 99 }, { dmId: 'd1', createdAt: 101 },
      { dmId: 'd2', createdAt: 1 }, { dmId: 'd2', createdAt: 2 },
    ] as any);
    jest.spyOn(Members, 'findByUser').mockResolvedValue([{ serverId: 's1' }] as any);
    jest.spyOn(Channels, 'findWhere').mockResolvedValue([
      { _id: 'c1', lastRead: { u: 10 } },
      { _id: 'c2', lastRead: { u: 0 } },
    ] as any);
    jest.spyOn(Notifications, 'prefsFind').mockResolvedValue([
      { userId: 'u', channelId: 'c2', level: 'mute', muteUntil: Date.now() + 60_000 },
    ] as any);
    jest.spyOn(Messages, 'messagesFind').mockResolvedValue([
      { channelId: 'c1', createdAt: 9 }, { channelId: 'c1', createdAt: 11 },
      { channelId: 'c2', createdAt: 99 },
    ] as any);

    await expect(pushSender.getUnreadCount('u')).resolves.toBe(4); // d1=1,d2=2,c1=1,c2 muted
    expect(Messages.messagesFind).toHaveBeenCalledWith(expect.objectContaining({ channelId: { $in: ['c1'] } }));
  });

  it('expired mute no longer hides channel and result is capped at 99', async () => {
    jest.spyOn(Dms, 'findConversationsByUser').mockResolvedValue([] as any);
    jest.spyOn(Members, 'findByUser').mockResolvedValue([{ serverId: 's' }] as any);
    jest.spyOn(Channels, 'findWhere').mockResolvedValue([{ _id: 'c', lastRead: { u: 0 } }] as any);
    jest.spyOn(Notifications, 'prefsFind').mockResolvedValue([{ channelId: 'c', level: 'mute', muteUntil: Date.now() - 1 }] as any);
    jest.spyOn(Messages, 'messagesFind').mockResolvedValue(Array.from({ length: 150 }, (_, i) => ({ channelId: 'c', createdAt: i + 1 })) as any);
    await expect(pushSender.getUnreadCount('u')).resolves.toBe(99);
  });

  it('repository subqueries fail closed to empty sets instead of failing whole count', async () => {
    jest.spyOn(Dms, 'findConversationsByUser').mockRejectedValue(new Error('dm down'));
    jest.spyOn(Members, 'findByUser').mockRejectedValue(new Error('members down'));
    await expect(pushSender.getUnreadCount('u')).resolves.toBe(0);
  });

  it('preference-store failure alone suppresses channel badge counts', async () => {
    jest.spyOn(Dms, 'findConversationsByUser').mockResolvedValue([] as any);
    jest.spyOn(Members, 'findByUser').mockResolvedValue([{ serverId: 's' }] as any);
    jest.spyOn(Channels, 'findWhere').mockResolvedValue([{ _id:'c', lastRead:{ u:0 } }] as any);
    jest.spyOn(Notifications, 'prefsFind').mockRejectedValueOnce(new Error('prefs down'));
    jest.spyOn(Messages, 'messagesFind').mockResolvedValue([{ channelId:'c', createdAt:1 }] as any);
    await expect(pushSender.getUnreadCount('u')).resolves.toBe(0);
    expect(Messages.messagesFind).not.toHaveBeenCalled();
  });

  it('channel/prefs/message failures are individually treated as no unread data', async () => {
    jest.spyOn(Dms, 'findConversationsByUser').mockResolvedValue([] as any);
    jest.spyOn(Members, 'findByUser').mockResolvedValue([{ serverId: 's' }] as any);
    jest.spyOn(Channels, 'findWhere').mockRejectedValueOnce(new Error('channels down'));
    await expect(pushSender.getUnreadCount('u')).resolves.toBe(0);

    jest.spyOn(Channels, 'findWhere').mockResolvedValue([{ _id:'c', lastRead:{} }] as any);
    jest.spyOn(Notifications, 'prefsFind').mockRejectedValueOnce(new Error('prefs down'));
    jest.spyOn(Messages, 'messagesFind').mockRejectedValueOnce(new Error('messages down'));
    await expect(pushSender.getUnreadCount('u')).resolves.toBe(0);
  });

  it('unexpected synchronous-style repository error returns zero from outer safety boundary', async () => {
    jest.spyOn(Dms, 'findConversationsByUser').mockImplementation(() => { throw new Error('boom'); });
    await expect(pushSender.getUnreadCount('u')).resolves.toBe(0);
  });
});

describe('sendPushToUser — dispatch routing and isolation', () => {
  function baseRepoSpies() {
    jest.spyOn(Dms, 'findConversationsByUser').mockResolvedValue([] as any);
    jest.spyOn(Members, 'findByUser').mockResolvedValue([] as any);
    jest.spyOn(Notifications, 'findPushSubscriptionsForUser').mockResolvedValue([] as any);
    jest.spyOn(Notifications, 'findNativeTokensForUser').mockResolvedValue([] as any);
    jest.spyOn(Notifications, 'findFcmTokensForUser').mockResolvedValue([] as any);
  }

  it('no tokens/subscriptions is a no-op after computing badge', async () => {
    baseRepoSpies();
    await expect(pushSender.sendPushToUser('u', { title:'T', body:'B' })).resolves.toBeUndefined();
    expect(Notifications.findPushSubscriptionsForUser).toHaveBeenCalledWith('u');
    expect(Notifications.findNativeTokensForUser).toHaveBeenCalledWith('u');
    expect(Notifications.findFcmTokensForUser).toHaveBeenCalledWith('u');
  });

  it('without APNs config, both Android and iOS native tokens route through FCM; legacy tokens too', async () => {
    baseRepoSpies();
    jest.spyOn(Notifications, 'findNativeTokensForUser').mockResolvedValue([
      { token:'a', platform:'android' }, { token:'i', platform:'ios' }, { token:'n' },
    ] as any);
    jest.spyOn(Notifications, 'findFcmTokensForUser').mockResolvedValue([{ token:'legacy' }] as any);
    const fcm = jest.spyOn(pushSender, 'sendFCM').mockResolvedValue(undefined);
    const apns = jest.spyOn(pushSender, 'sendAPNs').mockResolvedValue(undefined);
    await pushSender.sendPushToUser('u',{title:'T',body:'B'});
    expect(apns).not.toHaveBeenCalled();
    expect(fcm.mock.calls.map(c=>c[0]).sort()).toEqual(['a','i','legacy','n']);
  });

  it('with APNs config, iOS goes APNs while non-iOS and legacy stay FCM', async () => {
    process.env.APNS_KEY_PATH='/k'; process.env.APNS_KEY_ID='id'; process.env.APNS_TEAM_ID='team'; process.env.APNS_BUNDLE_ID='bundle';
    baseRepoSpies();
    jest.spyOn(Notifications, 'findNativeTokensForUser').mockResolvedValue([{token:'ios',platform:'ios'},{token:'and',platform:'android'}] as any);
    jest.spyOn(Notifications, 'findFcmTokensForUser').mockResolvedValue([{token:'legacy'}] as any);
    const fcm=jest.spyOn(pushSender,'sendFCM').mockResolvedValue(undefined); const apns=jest.spyOn(pushSender,'sendAPNs').mockResolvedValue(undefined);
    await pushSender.sendPushToUser('u',{title:'T',body:'B'});
    expect(apns).toHaveBeenCalledWith('ios',expect.objectContaining({badge:0}));
    expect(fcm.mock.calls.map(c=>c[0]).sort()).toEqual(['and','legacy']);
  });

  it('E2E body is redacted before native dispatch', async () => {
    baseRepoSpies(); jest.spyOn(Notifications,'findNativeTokensForUser').mockResolvedValue([{token:'a',platform:'android'}] as any);
    const fcm=jest.spyOn(pushSender,'sendFCM').mockResolvedValue(undefined);
    await pushSender.sendPushToUser('u',{title:'Alice',body:'🔒e2e:cipher'});
    expect(fcm).toHaveBeenCalledWith('a',expect.objectContaining({body:'🔒 Şifreli mesaj'}));
  });

  it('one push-target store failure is isolated so other transports still dispatch', async () => {
    jest.spyOn(Dms,'findConversationsByUser').mockResolvedValue([] as any);
    jest.spyOn(Members,'findByUser').mockResolvedValue([] as any);
    jest.spyOn(Notifications,'findPushSubscriptionsForUser').mockRejectedValue(new Error('web db down'));
    jest.spyOn(Notifications,'findNativeTokensForUser').mockResolvedValue([{token:'android',platform:'android'}] as any);
    jest.spyOn(Notifications,'findFcmTokensForUser').mockResolvedValue([{token:'legacy'}] as any);
    const fcm=jest.spyOn(pushSender,'sendFCM').mockResolvedValue(undefined);
    await expect(pushSender.sendPushToUser('u',{title:'T',body:'B'})).resolves.toBeUndefined();
    expect(fcm.mock.calls.map(c=>c[0]).sort()).toEqual(['android','legacy']);
  });

  it('native target-store failure does not suppress legacy FCM delivery', async () => {
    jest.spyOn(Dms,'findConversationsByUser').mockResolvedValue([] as any);
    jest.spyOn(Members,'findByUser').mockResolvedValue([] as any);
    jest.spyOn(Notifications,'findPushSubscriptionsForUser').mockResolvedValue([] as any);
    jest.spyOn(Notifications,'findNativeTokensForUser').mockRejectedValue(new Error('native db down'));
    jest.spyOn(Notifications,'findFcmTokensForUser').mockResolvedValue([{token:'legacy'}] as any);
    const fcm=jest.spyOn(pushSender,'sendFCM').mockResolvedValue(undefined);
    await pushSender.sendPushToUser('u',{title:'T',body:'B'});
    expect(fcm).toHaveBeenCalledWith('legacy',expect.any(Object));
  });
});
