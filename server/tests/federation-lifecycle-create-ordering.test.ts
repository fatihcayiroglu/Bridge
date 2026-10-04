'use strict';
process.env.NODE_ENV = 'test';

const Federation = {
  findApMessageOne: jest.fn(),
  updateApMessage: jest.fn(),
};
const legacyCreate = jest.fn();
const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('../db/repositories', () => ({ Federation }));
jest.mock('../routes/federation/inbox-handlers', () => ({
  handleApCreate: (...args: unknown[]) => legacyCreate(...args),
}));
jest.mock('../lib/logger', () => ({ __esModule: true, default: log }));

import { handleApCreate } from '../routes/federation/inbox-lifecycle';

const REMOTE = 'https://remote.test/users/bob';
const NOTE = 'https://remote.test/notes/1';

beforeEach(() => {
  jest.clearAllMocks();
  legacyCreate.mockResolvedValue(undefined);
  Federation.updateApMessage.mockResolvedValue(undefined);
});

describe('P6 duplicate Create ordering', () => {
  it('does not lower updatedAt when an older Create is redelivered after a newer Update', async () => {
    Federation.findApMessageOne.mockResolvedValue({
      apId: NOTE,
      actorUrl: REMOTE,
      updatedAt: Date.parse('2026-10-04T12:00:00Z'),
      deletedAt: null,
    });

    await handleApCreate(null, {
      id: 'create-old',
      type: 'Create',
      actor: REMOTE,
      object: {
        id: NOTE,
        type: 'Note',
        content: 'original',
        published: '2026-10-04T10:00:00Z',
      },
    } as never);

    expect(legacyCreate).toHaveBeenCalledTimes(1);
    expect(Federation.updateApMessage).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.note.stale_create_ignored' }),
      expect.any(String),
    );
  });

  it('advances a duplicate Create lifecycle only when its generation is newer', async () => {
    const ts = Date.parse('2026-10-04T13:00:00Z');
    Federation.findApMessageOne.mockResolvedValue({
      apId: NOTE,
      actorUrl: REMOTE,
      updatedAt: Date.parse('2026-10-04T12:00:00Z'),
      deletedAt: null,
    });

    await handleApCreate(null, {
      id: 'create-newer',
      type: 'Create',
      actor: REMOTE,
      object: {
        id: NOTE,
        type: 'Note',
        content: 'same object generation',
        published: '2026-10-04T13:00:00Z',
      },
    } as never);

    expect(Federation.updateApMessage).toHaveBeenCalledWith(
      { apId: NOTE, actorUrl: REMOTE, deletedAt: null, updatedAt: { $lt: ts } },
      { $set: { updatedAt: ts } },
    );
  });
});
