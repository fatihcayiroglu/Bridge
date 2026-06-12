// server/tests/federation-inbox-dm.test.ts
// ActivityPub DM routing — handleApCreate (Sprint 60)

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV = 'test';
process.env.INSTANCE_URL = 'https://bridge.example.com';

const mockInsertMessage = jest.fn().mockResolvedValue({});
const mockFindOrCreate = jest.fn().mockResolvedValue({ dmId: 'dm-conv-1' });
const mockFindByApUrl = jest.fn();
const mockInsertApMessage = jest.fn().mockResolvedValue({});
const mockInsertInbox = jest.fn().mockResolvedValue({});

jest.mock('../db/repositories', () => ({
  Users: { findByApUrl: (...args: unknown[]) => mockFindByApUrl(...args) },
  Dms: {
    findOrCreateConversation: (...args: unknown[]) => mockFindOrCreate(...args),
    insertMessage: (...args: unknown[]) => mockInsertMessage(...args),
  },
  Federation: { insertApMessage: (...args: unknown[]) => mockInsertApMessage(...args) },
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
        senderId: SENDER._id,
        content: 'Merhaba DM',
        apId: 'https://remote.social/notes/dm-1',
      }),
    );
    expect(mockInsertInbox).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TARGET_USER._id, type: 'dm', dmId: 'dm-conv-1' }),
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
    expect(mockInsertApMessage).toHaveBeenCalled();
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
    expect(mockInsertApMessage).toHaveBeenCalled();
  });
});
