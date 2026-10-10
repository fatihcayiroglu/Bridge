import express from 'express';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createMockDb, makeUser } from './helpers/mockDb';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
const mockEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));
jest.mock('../socket', () => ({ getIo: () => ({ to: mockTo }) }));
import { router as activity } from '../routes/activity';
import users from '../routes/users';
import { makeToken } from '../middleware/auth';
import { cache } from '../lib/redisAdapter';
import { sanitizeUser, sanitizeOwnUser } from '../lib/userUtils';

const db = require('../db/loader') as ReturnType<typeof createMockDb>;
const app = express();
app.use(express.json());
app.use('/api/activity', activity);
app.use('/api/users', users);
let alice: ReturnType<typeof makeUser>, bob: ReturnType<typeof makeUser>, serverId: string;
const privateActivity = { type: 'coding', name: 'Synthetic private project', detail: 'Private work session' };
beforeEach(async () => {
  db._reset();
  mockEmit.mockClear();
  mockTo.mockClear();
  alice = makeUser({ _id: randomUUID(), username: 'alice', presenceVisibility: 'hidden', status: 'online', statusText: 'Private status', statusEmoji: '🔒', activity: privateActivity, activityUpdatedAt: Date.now() });
  bob = makeUser({ _id: randomUUID(), username: 'bob' });
  await db.users.insert(alice);
  await db.users.insert(bob);
  serverId = randomUUID();
  await db.servers.insert({ _id: serverId, name: 'Synthetic server', ownerId: bob._id });
  for (const userId of [alice._id, bob._id]) await db.members.insert({ userId, serverId, roles: [] });
});
const read = (path: string, user: ReturnType<typeof makeUser>) => request(app).get(path).set('Authorization', `Bearer ${makeToken(user)}`);

it('hides private presence in the shared public serializer while the account owner still sees it', () => {
  expect(sanitizeOwnUser(alice)).toMatchObject({ status: 'online', statusText: 'Private status', statusEmoji: '🔒' });
  expect(sanitizeUser(alice)).toMatchObject({ status: 'offline', statusText: '', statusEmoji: '' });
  const visible = { ...alice, presenceVisibility: 'visible' };
  expect(sanitizeUser(visible)).toMatchObject({ status: 'online', statusText: 'Private status' });
});

it.each([false, true])('applies hidden presence to activity with cached=%s; self remains an authorized positive control', async cached => {
  if (cached) await cache.set(`activity:${alice._id}`, privateActivity, 3600);
  const own = await read(`/api/activity/${alice._id}`, alice);
  expect(own.status).toBe(200);
  expect(own.body.activity).toMatchObject(privateActivity);
  const profile = await read(`/api/users/${alice._id}`, bob);
  expect(profile.status).toBe(200);
  expect(profile.body.status).toBe('offline');
  const other = await read(`/api/activity/${alice._id}`, bob);
  expect(other.status).toBe(200);
  expect(other.body.activity).toBeNull();
  expect(JSON.stringify(other.body)).not.toContain(privateActivity.name);
});

it('does not include hidden work activity in a shared-server activity roster', async () => {
  await db.users.update({ _id: bob._id }, { $set: { activity: { type: 'playing', name: 'Visible activity' }, activityUpdatedAt: Date.now() } });
  const response = await read(`/api/activity/server/${serverId}`, bob);
  expect(response.status).toBe(200);
  expect(response.body.active).toHaveLength(1);
  expect(response.body.active[0]).toMatchObject({ userId: bob._id, activity: { name: 'Visible activity' } });
  expect(JSON.stringify(response.body)).not.toContain(privateActivity.name);
});

it('revokes activity visibility immediately without deleting the owner’s cached activity', async () => {
  await db.users.update({ _id: alice._id }, { $set: { presenceVisibility: 'visible' } });
  await cache.set(`activity:${alice._id}`, privateActivity, 3600);
  const visible = await read(`/api/activity/${alice._id}`, bob);
  expect(visible.body.activity).toMatchObject(privateActivity);
  await db.users.update({ _id: alice._id }, { $set: { presenceVisibility: 'hidden' } });
  const hidden = await read(`/api/activity/${alice._id}`, bob);
  expect(hidden.status).toBe(200);
  expect(hidden.body.activity).toBeNull();
  const own = await read(`/api/activity/${alice._id}`, alice);
  expect(own.body.activity).toMatchObject(privateActivity);
});


it('suppresses hidden activity in broadcast payloads while visible activity still publishes', async () => {
  const update = (user: ReturnType<typeof makeUser>) => request(app).patch('/api/activity').set('Authorization', `Bearer ${makeToken(user)}`).send({ type: 'coding', name: 'Synthetic broadcast project' });
  const visible = await update(bob);
  expect(visible.status).toBe(200);
  expect(mockEmit).toHaveBeenLastCalledWith('user:activity', expect.objectContaining({ userId: bob._id, activity: expect.objectContaining({ name: 'Synthetic broadcast project' }) }));
  const hidden = await update(alice);
  expect(hidden.status).toBe(200);
  expect(hidden.body.activity.name).toBe('Synthetic broadcast project');
  expect(mockEmit).toHaveBeenLastCalledWith('user:activity', { userId: alice._id, activity: null });
  const own = await read(`/api/activity/${alice._id}`, alice);
  expect(own.body.activity.name).toBe('Synthetic broadcast project');
});
