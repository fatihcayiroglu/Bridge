jest.mock('../db/loader', () => ({ __esModule: true, default: { _pool: {} } }));
jest.mock('../db/repositories', () => ({ Channels: { findById: jest.fn() } }));
jest.mock('../lib/channelReadExpiryGuard', () => ({ channelLiveForMessageRead: jest.fn() }));

import db from '../db/loader';
import { Channels } from '../db/repositories';
import { channelLiveForMessageRead } from '../lib/channelReadExpiryGuard';
import { channelContentAvailability } from '../lib/channelContentAvailability';

const queryLive = jest.mocked(channelLiveForMessageRead);
const findChannel = jest.mocked(Channels.findById);
const channel = { _id: 'channel', serverId: 'server', name: 'Channel', createdAt: 1 };
const originalEnvironment = process.env.NODE_ENV;

function withPool(present: boolean) {
  Object.defineProperty(db, '_pool', { value: present ? {} : undefined, configurable: true });
}

beforeEach(() => {
  jest.resetAllMocks();
  process.env.NODE_ENV = 'test';
  withPool(true);
  queryLive.mockResolvedValue(true);
  findChannel.mockResolvedValue(channel);
});

afterAll(() => {
  if (originalEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment;
});

it('uses authoritative PostgreSQL even when a mock canonical row looks permanent', async () => {
  expect(await channelContentAvailability('channel', 'server')).toBe('live');
  expect(queryLive).toHaveBeenCalledWith(db._pool, 'channel', 'server');
  queryLive.mockResolvedValue(false);
  expect(await channelContentAvailability('channel', 'server')).toBe('missing');
  expect(findChannel).not.toHaveBeenCalled();
});

it('reports a database outage without falling back to a channel row', async () => {
  queryLive.mockRejectedValue(new Error('database offline'));
  expect(await channelContentAvailability('channel', 'server')).toBe('unavailable');
  expect(findChannel).not.toHaveBeenCalled();
});

it('requires a PostgreSQL pool outside unit-test mocks', async () => {
  withPool(false);
  process.env.NODE_ENV = 'production';
  expect(await channelContentAvailability('channel', 'server')).toBe('unavailable');
  expect(findChannel).not.toHaveBeenCalled();
});

it('allows only a matching canonical permanent channel in the legacy test store', async () => {
  withPool(false);
  expect(await channelContentAvailability('channel', 'server')).toBe('live');
  expect(findChannel).toHaveBeenCalledWith('channel');
  expect(queryLive).not.toHaveBeenCalled();
});

it.each([
  ['absent channel', null],
  ['another channel', { ...channel, _id: 'other' }],
  ['another tenant', { ...channel, serverId: 'other' }],
  ['expired parent', { ...channel, expiresAt: 1, expiryVersion: 1 }],
  ['partial expiry', { ...channel, expiresAt: 1 }],
] as const)('denies %s in the unit-test store', async (_label, row) => {
  withPool(false);
  findChannel.mockResolvedValue(row);
  expect(await channelContentAvailability('channel', 'server')).toBe('missing');
});

it('reports a failed canonical lookup in the test store as unavailable', async () => {
  withPool(false);
  findChannel.mockRejectedValue(new Error('store offline'));
  expect(await channelContentAvailability('channel', 'server')).toBe('unavailable');
});

it('rejects invalid scope before consulting a store', async () => {
  for (const [channelId, serverId] of [['', 'server'], ['channel', ''], ['x'.repeat(257), 'server']] as const) {
    expect(await channelContentAvailability(channelId, serverId)).toBe('missing');
  }
  expect(queryLive).not.toHaveBeenCalled();
  expect(findChannel).not.toHaveBeenCalled();
});
