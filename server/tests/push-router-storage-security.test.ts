process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = '12345678901234567890123456789012';

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createMockDb } from './helpers/mockDb';

const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);
jest.mock('../lib/pushSender', () => ({ sendPushToUser: jest.fn() }));

import { Notifications } from '../db/repositories';
import { pushRouter } from '../lib/notifications';

const app = express();
app.use(express.json());
app.use('/push', pushRouter);
const bearer = () => `Bearer ${jwt.sign({ id: 'u1', v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`;
const valid = { endpoint: 'https://push.example.com/sub', keys: { p256dh: 'p', auth: 'a' } };

describe('/push canonical web-push storage boundary', () => {
  beforeEach(async () => {
    mockDb._reset();
    jest.restoreAllMocks();
    // Token-version validation deliberately rejects tokens whose subject no
    // longer exists.  These storage-boundary tests need a live canonical user
    // so they reach the push validation/compensation paths under test.
    await mockDb.users.insert({
      _id: 'u1', username: 'u1', email: 'u1@example.test', password: 'hash',
      tokenVersion: 0, createdAt: Date.now(),
    });
  });

  it('rejects the alternate-route SSRF/storage-bloat bypasses', async () => {
    await request(app).post('/push/subscribe').set('Authorization', bearer())
      .send({ subscription: { ...valid, endpoint: 'https://127.0.0.1/internal' } }).expect(400);
    await request(app).post('/push/subscribe').set('Authorization', bearer())
      .send({ subscription: { ...valid, endpoint: 'https://push.example.com/' + 'x'.repeat(5000) } }).expect(400);
    await request(app).post('/push/subscribe').set('Authorization', bearer())
      .send({ subscription: { endpoint: valid.endpoint, keys: { p256dh: 'p' } } }).expect(400);
    expect(await mockDb.pushSubscriptions.count({})).toBe(0);
  });

  it('does not turn lookup, insert, unsubscribe or native-token storage failures into success', async () => {
    jest.spyOn(Notifications, 'findPushSubscriptionForUserEndpoint').mockRejectedValueOnce(new Error('db down'));
    await request(app).post('/push/subscribe').set('Authorization', bearer()).send({ subscription: valid }).expect(503);

    jest.restoreAllMocks();
    jest.spyOn(Notifications, 'insertPushSubscription').mockRejectedValueOnce(new Error('disk full'));
    await request(app).post('/push/subscribe').set('Authorization', bearer()).send({ subscription: valid }).expect(503);

    jest.restoreAllMocks();
    jest.spyOn(Notifications, 'removePushSubscriptionWhere').mockRejectedValueOnce(new Error('db down'));
    await request(app).delete('/push/unsubscribe').set('Authorization', bearer()).send({ endpoint: valid.endpoint }).expect(503);

    jest.restoreAllMocks();
    jest.spyOn(Notifications, 'upsertNativeToken').mockRejectedValueOnce(new Error('db down'));
    await request(app).post('/push/register-native').set('Authorization', bearer()).send({ token: 'native', platform: 'ios' }).expect(503);
  });
});
