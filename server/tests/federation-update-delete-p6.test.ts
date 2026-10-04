'use strict';
process.env.NODE_ENV = 'test';

const Federation = {
  findApFollowOne: jest.fn(), insertApFollow: jest.fn(),
  removeApFollow: jest.fn(), removeApLike: jest.fn(), removeApAnnounce: jest.fn(),
  updateApOutgoingFollow: jest.fn(), removeApOutgoingFollow: jest.fn(),
  findApMessageOne: jest.fn(), insertApMessage: jest.fn(),
  updateApMessage: jest.fn(), removeApMessage: jest.fn(),
  insertApLike: jest.fn(), insertApAnnounce: jest.fn(),
};
const Notifications = { insertInbox: jest.fn() };
const Dms = { findOrCreateConversation: jest.fn(), insertMessage: jest.fn() };
const Users = { findByApUrl: jest.fn() };
const deliverApActivity = jest.fn();
const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('../db/repositories', () => ({ Federation, Notifications, Dms, Users }));
jest.mock('../routes/federation/delivery', () => ({ deliverApActivity: (...a: unknown[]) => deliverApActivity(...a) }));
jest.mock('../lib/logger', () => ({
  __esModule: true, default: log,
  info: (...a: unknown[]) => log.info(...a),
  warn: (...a: unknown[]) => log.warn(...a),
  error: (...a: unknown[]) => log.error(...a),
}));

import { handleApCreate, handleApUpdate, handleApDelete } from '../routes/federation/inbox-handlers';

const ALICE = { _id: 'local-1', username: 'alice' } as never;
const REMOTE = 'https://remote.test/users/bob';
const OTHER = 'https://evil.test/users/mallory';
const NOTE = 'https://remote.test/notes/1';
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

beforeEach(() => {
  jest.clearAllMocks();
  Federation.findApMessageOne.mockResolvedValue(null);
  Federation.insertApMessage.mockResolvedValue(undefined);
  Federation.updateApMessage.mockResolvedValue(undefined);
  Notifications.insertInbox.mockResolvedValue(undefined);
  Users.findByApUrl.mockResolvedValue(null);
});

function create(updated = '2026-10-04T10:00:00.000Z') {
  return {
    id: 'https://remote.test/activities/create-1', type: 'Create', actor: REMOTE,
    object: { id: NOTE, type: 'Note', content: 'original', published: '2026-10-04T09:00:00.000Z', updated, to: [PUBLIC], cc: [] },
  } as never;
}

it('ignores an older Update instead of overwriting newer content', async () => {
  Federation.findApMessageOne.mockResolvedValue({
    apId: NOTE, actorUrl: REMOTE, content: 'newer', updatedAt: Date.parse('2026-10-04T12:00:00.000Z'), deletedAt: null,
  });
  await handleApUpdate(ALICE, {
    id: 'up-old', type: 'Update', actor: REMOTE,
    object: { id: NOTE, type: 'Note', content: 'STALE', updated: '2026-10-04T11:00:00.000Z' },
  } as never);
  expect(Federation.updateApMessage).not.toHaveBeenCalled();
  expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'federation.note.stale_update_ignored' }));
});

it('applies a strictly newer Update using the remote lifecycle timestamp', async () => {
  Federation.findApMessageOne.mockResolvedValue({
    apId: NOTE, actorUrl: REMOTE, content: 'old', updatedAt: Date.parse('2026-10-04T10:00:00.000Z'), deletedAt: null,
  });
  await handleApUpdate(ALICE, {
    id: 'up-new', type: 'Update', actor: REMOTE,
    object: { id: NOTE, type: 'Note', content: 'new', updated: '2026-10-04T11:00:00.000Z' },
  } as never);
  expect(Federation.updateApMessage).toHaveBeenCalledWith(
    { apId: NOTE, actorUrl: REMOTE },
    { $set: { content: 'new', updatedAt: Date.parse('2026-10-04T11:00:00.000Z') } },
  );
});

it('turns Delete into a durable tombstone instead of removing the row', async () => {
  Federation.findApMessageOne.mockResolvedValue({
    apId: NOTE, actorUrl: REMOTE, content: 'live', updatedAt: Date.parse('2026-10-04T10:00:00.000Z'), deletedAt: null,
  });
  await handleApDelete(ALICE, {
    id: 'del-1', type: 'Delete', actor: REMOTE, updated: '2026-10-04T11:00:00.000Z', object: NOTE,
  } as never);
  const ts = Date.parse('2026-10-04T11:00:00.000Z');
  expect(Federation.removeApMessage).not.toHaveBeenCalled();
  expect(Federation.updateApMessage).toHaveBeenCalledWith(
    { apId: NOTE, actorUrl: REMOTE }, { $set: { content: '', deletedAt: ts, updatedAt: ts } },
  );
});

it('persists a tombstone when Delete arrives before Create', async () => {
  await handleApDelete(ALICE, {
    id: 'del-first', type: 'Delete', actor: REMOTE, updated: '2026-10-04T11:00:00.000Z', object: NOTE,
  } as never);
  expect(Federation.insertApMessage).toHaveBeenCalledWith(expect.objectContaining({
    apId: NOTE, actorUrl: REMOTE, targetUserId: 'local-1', content: '',
    deletedAt: Date.parse('2026-10-04T11:00:00.000Z'),
  }));
});

it('does not resurrect a tombstoned note when a delayed Create arrives', async () => {
  Federation.findApMessageOne.mockResolvedValue({
    apId: NOTE, actorUrl: REMOTE, deletedAt: Date.parse('2026-10-04T11:00:00.000Z'), updatedAt: Date.parse('2026-10-04T11:00:00.000Z'),
  });
  await handleApCreate(ALICE, create('2026-10-04T10:00:00.000Z'));
  expect(Federation.insertApMessage).not.toHaveBeenCalled();
  expect(Notifications.insertInbox).not.toHaveBeenCalled();
  expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'federation.note.create_after_delete_ignored' }));
});

it('does not let another actor update or delete an object id it does not own', async () => {
  Federation.findApMessageOne.mockResolvedValue({ apId: NOTE, actorUrl: REMOTE, updatedAt: 1, deletedAt: null });
  await handleApUpdate(ALICE, {
    id: 'evil-up', type: 'Update', actor: OTHER,
    object: { id: NOTE, type: 'Note', content: 'hijack', updated: '2026-10-04T12:00:00.000Z' },
  } as never);
  await handleApDelete(ALICE, {
    id: 'evil-del', type: 'Delete', actor: OTHER, updated: '2026-10-04T12:00:00.000Z', object: NOTE,
  } as never);
  expect(Federation.updateApMessage).not.toHaveBeenCalled();
  expect(Federation.insertApMessage).not.toHaveBeenCalled();
});

it('ignores a stale Delete so it cannot erase a newer Update', async () => {
  Federation.findApMessageOne.mockResolvedValue({
    apId: NOTE, actorUrl: REMOTE, content: 'new', updatedAt: Date.parse('2026-10-04T12:00:00.000Z'), deletedAt: null,
  });
  await handleApDelete(ALICE, {
    id: 'del-old', type: 'Delete', actor: REMOTE, updated: '2026-10-04T11:00:00.000Z', object: NOTE,
  } as never);
  expect(Federation.updateApMessage).not.toHaveBeenCalled();
  expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'federation.note.stale_delete_ignored' }));
});
