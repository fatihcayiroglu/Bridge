'use strict';
process.env.NODE_ENV = 'test';

const Federation = {
  findApMessageOne: jest.fn(),
  updateApMessage: jest.fn(),
  insertApMessage: jest.fn(),
};
const legacyCreate = jest.fn();
const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('../db/repositories', () => ({ Federation }));
jest.mock('../routes/federation/inbox-handlers', () => ({
  handleApCreate: (...args: unknown[]) => legacyCreate(...args),
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: log,
  info: (...args: unknown[]) => log.info(...args),
  warn: (...args: unknown[]) => log.warn(...args),
  error: (...args: unknown[]) => log.error(...args),
}));

import {
  handleApCreate,
  handleApUpdate,
  handleApDelete,
} from '../routes/federation/inbox-lifecycle';

const REMOTE = 'https://remote.test/users/bob';
const NOTE = 'https://remote.test/notes/1';
const ALICE = { _id: 'local-1', username: 'alice' } as never;

function activity(type: string, object: unknown, extra: Record<string, unknown> = {}) {
  return {
    id: `https://remote.test/activities/${type.toLowerCase()}`,
    type,
    actor: REMOTE,
    object,
    ...extra,
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  Federation.findApMessageOne.mockResolvedValue(null);
  Federation.updateApMessage.mockResolvedValue(undefined);
  Federation.insertApMessage.mockResolvedValue(undefined);
  legacyCreate.mockResolvedValue(undefined);
});

describe('P6 ActivityPub lifecycle ordering', () => {
  it('refuses a late Create after a tombstone and never calls the legacy Create path', async () => {
    Federation.findApMessageOne.mockResolvedValue({
      apId: NOTE,
      actorUrl: REMOTE,
      content: '',
      updatedAt: Date.parse('2026-10-04T10:00:00Z'),
      deletedAt: Date.parse('2026-10-04T10:00:00Z'),
    });

    await handleApCreate(ALICE, activity('Create', {
      id: NOTE,
      type: 'Note',
      content: 'old redelivery',
      published: '2026-10-04T09:00:00Z',
    }));

    expect(legacyCreate).not.toHaveBeenCalled();
    expect(Federation.updateApMessage).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.note.create_after_delete_ignored' }),
      expect.any(String),
    );
  });

  it('ignores an Update older than the stored lifecycle timestamp', async () => {
    Federation.findApMessageOne.mockResolvedValue({
      apId: NOTE,
      actorUrl: REMOTE,
      content: 'newest',
      updatedAt: Date.parse('2026-10-04T10:00:00Z'),
      deletedAt: null,
    });

    await handleApUpdate(null, activity('Update', {
      id: NOTE,
      type: 'Note',
      content: 'stale',
      updated: '2026-10-04T09:00:00Z',
    }));

    expect(Federation.updateApMessage).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.note.stale_update_ignored' }),
      expect.any(String),
    );
  });

  it('applies a newer Update with an atomic timestamp predicate', async () => {
    const incoming = Date.parse('2026-10-04T11:00:00Z');
    Federation.findApMessageOne.mockResolvedValue({
      apId: NOTE,
      actorUrl: REMOTE,
      content: 'old',
      updatedAt: Date.parse('2026-10-04T10:00:00Z'),
      deletedAt: null,
    });

    await handleApUpdate(null, activity('Update', {
      id: NOTE,
      type: 'Note',
      content: 'new',
      updated: '2026-10-04T11:00:00Z',
    }));

    expect(Federation.updateApMessage).toHaveBeenCalledWith(
      { apId: NOTE, actorUrl: REMOTE, deletedAt: null, updatedAt: { $lt: incoming } },
      { $set: { content: 'new', updatedAt: incoming } },
    );
  });

  it('turns an existing live row into a scrubbed tombstone instead of removing it', async () => {
    const deletedAt = Date.parse('2026-10-04T12:00:00Z');
    Federation.findApMessageOne.mockResolvedValue({
      apId: NOTE,
      actorUrl: REMOTE,
      content: 'secret old text',
      visibility: 'public',
      targetUserId: 'local-1',
      updatedAt: Date.parse('2026-10-04T10:00:00Z'),
      deletedAt: null,
    });

    await handleApDelete(ALICE, activity('Delete', NOTE, {
      published: '2026-10-04T12:00:00Z',
    }));

    expect(Federation.updateApMessage).toHaveBeenCalledWith(
      { apId: NOTE, actorUrl: REMOTE, updatedAt: { $lt: deletedAt } },
      { $set: expect.objectContaining({
        content: '',
        summary: null,
        attachments: [],
        tags: [],
        targetUserId: null,
        visibility: 'direct',
        deletedAt,
        updatedAt: deletedAt,
      }) },
    );
  });

  it('persists Delete-before-Create as a tombstone', async () => {
    const deletedAt = Date.parse('2026-10-04T12:00:00Z');

    await handleApDelete(ALICE, activity('Delete', NOTE, {
      published: '2026-10-04T12:00:00Z',
    }));

    expect(Federation.insertApMessage).toHaveBeenCalledWith(expect.objectContaining({
      apId: NOTE,
      actorUrl: REMOTE,
      content: '',
      visibility: 'direct',
      targetUserId: null,
      deletedAt,
      updatedAt: deletedAt,
    }));
  });

  it('refuses Update/Delete from an actor that does not own the object id', async () => {
    Federation.findApMessageOne.mockResolvedValue({
      apId: NOTE,
      actorUrl: 'https://elsewhere.test/users/alice',
      content: 'owned elsewhere',
      updatedAt: 1,
      deletedAt: null,
    });

    await handleApUpdate(null, activity('Update', {
      id: NOTE, type: 'Note', content: 'hijack', updated: '2026-10-04T11:00:00Z',
    }));
    await handleApDelete(null, activity('Delete', NOTE, {
      published: '2026-10-04T12:00:00Z',
    }));

    expect(Federation.updateApMessage).not.toHaveBeenCalled();
    expect(Federation.insertApMessage).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.note.update_actor_conflict' }),
      expect.any(String),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.note.delete_actor_conflict' }),
      expect.any(String),
    );
  });
});
