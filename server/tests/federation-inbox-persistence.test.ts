// Incoming ActivityPub must not return semantic success from its handler when
// durable state failed to persist; the HTTP inbox can then return 5xx and the
// remote server can retry.
'use strict';
process.env.NODE_ENV = 'test';

const mockFindApMessageOne = jest.fn();
const mockInsertApMessage = jest.fn();
const mockUpdateApMessage = jest.fn();

jest.mock('../db/repositories', () => ({
  Federation: {
    findApMessageOne: (...args: unknown[]) => mockFindApMessageOne(...args),
    insertApMessage: (...args: unknown[]) => mockInsertApMessage(...args),
    updateApMessage: (...args: unknown[]) => mockUpdateApMessage(...args),
  },
  Notifications: { insertInbox: jest.fn() },
  Dms: {},
  Users: { findByApUrl: jest.fn(async () => null) },
}));

jest.mock('../routes/federation/delivery', () => ({ deliverApActivity: jest.fn() }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

import { handleApCreate, handleApDelete } from '../routes/federation/inbox-handlers';

describe('ActivityPub inbox persistence boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindApMessageOne.mockResolvedValue(null);
  });

  it('Create propagates AP message persistence failure', async () => {
    mockInsertApMessage.mockRejectedValueOnce(new Error('db write failed'));
    await expect(handleApCreate(null, {
      id: 'https://remote/activities/1',
      type: 'Create',
      actor: 'https://remote/users/alice',
      object: {
        id: 'https://remote/notes/1',
        type: 'Note',
        content: 'hello',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
      },
    })).rejects.toThrow('db write failed');
  });

  it('Delete propagates AP tombstone persistence failure', async () => {
    mockFindApMessageOne.mockResolvedValueOnce({
      _id: 'apmsg-1',
      apId: 'https://remote/notes/1',
      actorUrl: 'https://remote/users/alice',
      content: 'hello',
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
    });
    mockUpdateApMessage.mockRejectedValueOnce(new Error('db tombstone failed'));

    await expect(handleApDelete(null, {
      id: 'https://remote/activities/2',
      type: 'Delete',
      actor: 'https://remote/users/alice',
      object: 'https://remote/notes/1',
    })).rejects.toThrow('db tombstone failed');
  });
});
