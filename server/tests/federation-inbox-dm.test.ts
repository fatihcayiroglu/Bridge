// server/tests/federation-inbox-dm.test.ts
// ActivityPub DM routing — handleApCreate (Sprint 60)

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV = 'test';
process.env.INSTANCE_URL = 'https://bridge.example.com';

const mockInsertMessage = jest.fn().mockResolvedValue({});
const mockFindOrCreate = jest.fn().mockResolvedValue({ dmId: 'dm-conv-1' });
const mockFindByApUrl = jest.fn();
const mockInsertApMessage = jest.fn().mockResolvedValue({});
const mockFindApMessageOne = jest.fn().mockResolvedValue(null);
const mockInsertInbox = jest.fn().mockResolvedValue({});

jest.mock('../db/repositories', () => ({
  Users: { findByApUrl: (...args: unknown[]) => mockFindByApUrl(...args) },
  Dms: {
    findOrCreateConversation: (...args: unknown[]) => mockFindOrCreate(...args),
    insertMessage: (...args: unknown[]) => mockInsertMessage(...args),
  },
  Federation: {
    findApMessageOne: (...args: unknown[]) => mockFindApMessageOne(...args),
    insertApMessage: (...args: unknown[]) => mockInsertApMessage(...args),
  },
  Notifications: { insertInbox: (...args: unknown[]) => mockInsertInbox(...args) },
}));

jest.mock('../routes/federation/delivery', () => ({
  deliverApActivity: jest.fn().mockResolvedValue(undefined),
}));

import { handleApCreate } from '../routes/federation/inbox-handlers';

const TARGET_USER = { _id: 'target-user-id', username: 'bob' };
const SENDER = { _id: 'sender-user-id', username: 'alice' };
const SENDER_AP = 'https://bridge.example.com/api/federation/users/alice';
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

beforeEach(() => {
  mockFindByApUrl.mockReset().mockResolvedValue(null);
  mockFindOrCreate.mockReset().mockResolvedValue({ dmId: 'dm-conv-1' });
  mockInsertMessage.mockReset().mockResolvedValue({});
  mockInsertApMessage.mockReset().mockResolvedValue({});
  mockFindApMessageOne.mockReset().mockResolvedValue(null);
  mockInsertInbox.mockReset().mockResolvedValue({});
});

describe('handleApCreate — ActivityPub DM routing', () => {
  it('yerel gönderici + DM to[] → Dms.insertMessage çağrılır', async () => {
    mockFindByApUrl.mockResolvedValue(SENDER);

    const activity = {
      id: 'act-dm-1',
      type: 'Create',
      actor: SENDER_AP,
      object: {
        id: 'https://remote.social/notes/dm-1',
        type: 'Note',
        content: 'Merhaba DM',
        to: [SENDER_AP],
        cc: [],
        published: new Date().toISOString(),
      },
    };

    await handleApCreate(TARGET_USER, activity);

    expect(mockFindByApUrl).toHaveBeenCalledWith(SENDER_AP);
    expect(mockFindOrCreate).toHaveBeenCalledWith(SENDER._id, TARGET_USER._id);
    expect(mockInsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        dmId: 'dm-conv-1',
        userId: SENDER._id,
        displayName: expect.any(String),
        avatarColor: expect.any(String),
        content: 'Merhaba DM',
      }),
    );
    expect(mockInsertInbox).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TARGET_USER._id, type: 'dm', activityId: 'act-dm-1', dmId: 'dm-conv-1' }),
    );
    expect(mockInsertApMessage).not.toHaveBeenCalled();
  });

  it('#Public URL içeren to[] → DM değil, federated timeline kaydı', async () => {
    const activity = {
      id: 'act-pub-1',
      type: 'Create',
      actor: SENDER_AP,
      object: {
        id: 'https://remote.social/notes/pub-1',
        type: 'Note',
        content: 'Herkese açık',
        to: [PUBLIC],
        cc: [],
      },
    };

    await handleApCreate(TARGET_USER, activity);

    expect(mockInsertMessage).not.toHaveBeenCalled();
    expect(mockInsertApMessage).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'public' }),
    );
  });

  it('yerel gönderici bulunamazsa → insertMessage çağrılmaz', async () => {
    mockFindByApUrl.mockResolvedValue(null);

    const activity = {
      id: 'act-relay-1',
      type: 'Create',
      actor: 'https://other.instance/users/remote',
      object: {
        id: 'https://other.instance/notes/relay-1',
        type: 'Note',
        content: 'relay DM',
        to: ['https://other.instance/users/remote'],
        cc: [],
      },
    };

    await handleApCreate(TARGET_USER, activity);

    expect(mockInsertMessage).not.toHaveBeenCalled();
    expect(mockFindOrCreate).not.toHaveBeenCalled();
    expect(mockInsertApMessage).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'direct', targetUserId: TARGET_USER._id }),
    );
  });

  it('direct audience sender lookup storage failure cannot downgrade the message to public', async () => {
    mockFindByApUrl.mockRejectedValueOnce(new Error('users store unavailable'));
    const activity = {
      id: 'act-dm-store-fail', type: 'Create', actor: SENDER_AP,
      object: {
        id: 'https://remote.social/notes/dm-store-fail', type: 'Note', content: 'secret',
        to: [SENDER_AP], cc: [],
      },
    };

    await expect(handleApCreate(TARGET_USER, activity)).rejects.toThrow('users store unavailable');
    expect(mockInsertMessage).not.toHaveBeenCalled();
    expect(mockInsertApMessage).not.toHaveBeenCalled();
  });
});
