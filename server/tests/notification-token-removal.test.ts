process.env.NODE_ENV = 'test';

let db: any;
jest.mock('../db/loader', () => ({
  get pushSubscriptions() { return db.pushSubscriptions; },
  get nativePushTokens() { return db.nativePushTokens; },
  get fcmTokens() { return db.fcmTokens; },
}));

import Notifications from '../db/repositories/NotificationRepository';

describe('notification token removal durability', () => {
  beforeEach(() => {
    db = {
      pushSubscriptions: { remove: jest.fn().mockResolvedValue({ deleted: 1 }) },
      nativePushTokens: { remove: jest.fn().mockResolvedValue({ deleted: 1 }) },
      fcmTokens: { remove: jest.fn().mockResolvedValue({ deleted: 1 }) },
    };
  });

  it('propagates web-push DB deletion failures so unsubscribe cannot report false success', async () => {
    db.pushSubscriptions.remove.mockRejectedValueOnce(new Error('db down'));
    await expect(Notifications.removePushSubscriptionWhere({ userId: 'u1', endpoint: 'https://push.example/x' }))
      .rejects.toThrow('db down');
  });

  it('propagates native token deletion failures', async () => {
    db.nativePushTokens.remove.mockRejectedValueOnce(new Error('db down'));
    await expect(Notifications.removeNativeTokenWhere({ userId: 'u1', token: 't1' }))
      .rejects.toThrow('db down');
  });

  it('propagates legacy FCM token deletion failures', async () => {
    db.fcmTokens.remove.mockRejectedValueOnce(new Error('db down'));
    await expect(Notifications.removeFcmTokenWhere({ userId: 'u1', token: 't1' }))
      .rejects.toThrow('db down');
  });
});
