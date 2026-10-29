process.env.NODE_ENV = 'test';
import { createMockDb, makeChannel, makeServer, makeUser } from './helpers/mockDb';
const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));

import express from 'express';
import request from 'supertest';
import router from '../routes/bots';
import { Messages } from '../db/repositories';
import * as policy from '../lib/messageContentPolicy';
import * as authority from '../lib/channelWriteGuard';
import { cache } from '../lib/redisAdapter';
import * as publicationAuthority from '../lib/channelLiveReadSet';

const events: string[] = [];
const app = express();
app.set('io', { to: () => ({ emit: (event: string) => events.push(event) }) });
app.use(express.json());
app.use('/api/webhooks', router);
let channel: ReturnType<typeof makeChannel>;
const TOKEN = 'disposable-webhook-expiry-fixture';
const send = (token = TOKEN) => request(app).post('/api/webhooks/expiry-fixture')
  .query({ token }).send({ content: 'Webhook expiry fixture' });
const expire = () => mockDb.channels.update({ _id: channel._id }, { $set: { expiresAt: 1, expiryVersion: 1 } });
const rows = () => mockDb.messages.find({ channelId: channel._id });

beforeEach(async () => {
  mockDb._reset(); events.length = 0;
  const owner = makeUser();
  const server = makeServer(owner._id);
  channel = makeChannel(server._id);
  await mockDb.users.insert(owner);
  await mockDb.servers.insert(server);
  await mockDb.channels.insert(channel);
  await mockDb.webhooks.insert({ _id: 'expiry-fixture', channelId: channel._id, serverId: server._id,
    name: 'Expiry fixture', token: TOKEN, createdAt: Date.now() });
});
afterEach(() => jest.restoreAllMocks());

it('permanent receiving channels keep the existing webhook principal and both events', async () => {
  expect((await send()).status).toBe(200);
  expect(await rows()).toEqual([expect.objectContaining({ userId: 'webhook:expiry-fixture', isWebhook: true })]);
  expect(events).toEqual(['message:new', 'channel:activity']);
});

it('expired channels reject an otherwise valid webhook without persistence or publication', async () => {
  await expire();
  const response = await send();
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ error: 'Channel unavailable' });
  expect(await rows()).toHaveLength(0);
  expect(events).toEqual([]);
});

it('unverifiable channel authority is a retryable refusal', async () => {
  jest.spyOn(authority, 'channelWriteAvailability').mockResolvedValue('unverifiable');
  const response = await send();
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ error: 'Channel unavailable' });
  expect(await rows()).toHaveLength(0);
  expect(events).toEqual([]);
});

it('expiry during actual target moderation refuses insertion', async () => {
  const original = policy.machineContentRefused;
  jest.spyOn(policy, 'machineContentRefused').mockImplementationOnce(async (...args) => {
    const result = await original(...args); await expire(); return result;
  });
  expect((await send()).status).toBe(404);
  expect(await rows()).toHaveLength(0);
  expect(events).toEqual([]);
});

it('expiry after persistence refuses success and publication without deleting committed data', async () => {
  const original = Messages.create.bind(Messages);
  jest.spyOn(Messages, 'create').mockImplementationOnce(async data => {
    const saved = await original(data); await expire(); return saved;
  });
  expect((await send()).status).toBe(404);
  expect(await rows()).toHaveLength(1);
  expect(events).toEqual([]);
});

it('expiry during asynchronous cache invalidation refuses success and both events', async () => {
  const original = cache.invalidatePattern.bind(cache);
  jest.spyOn(cache, 'invalidatePattern').mockImplementationOnce(async prefix => {
    await original(prefix); await expire();
  });
  expect((await send()).status).toBe(404);
  expect(await rows()).toHaveLength(1);
  expect(events).toEqual([]);
});

it('invalid credentials are checked before expiry authority', async () => {
  await expire();
  const check = jest.spyOn(authority, 'channelWriteAvailability');
  expect((await send('invalid-credential')).status).toBe(401);
  expect(check).not.toHaveBeenCalled();
  expect(await rows()).toHaveLength(0);
  expect(events).toEqual([]);
});

it('a caller-live result cannot override a final publication refusal or produce HTTP success', async () => {
  jest.spyOn(publicationAuthority, 'liveChannelSet').mockResolvedValue(new Set());
  const response = await send();
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ error: 'Channel unavailable' });
  expect(await rows()).toHaveLength(1);
  expect(events).toEqual([]);
});

it('tenant mismatch is refused before expiry authority', async () => {
  await mockDb.webhooks.update({ _id: 'expiry-fixture' }, { $set: { serverId: 'another-tenant' } });
  const check = jest.spyOn(authority, 'channelWriteAvailability');
  expect((await send()).status).toBe(403);
  expect(check).not.toHaveBeenCalled();
  expect(await rows()).toHaveLength(0);
  expect(events).toEqual([]);
});
