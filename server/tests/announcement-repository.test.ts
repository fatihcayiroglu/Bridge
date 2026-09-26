'use strict';

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn(async () => ({ query: mockQuery, release: mockRelease }));

jest.mock('../db/postgres/pool', () => ({ pool: { connect: mockConnect, query: jest.fn() } }));

import { Announcements, type CrosspostMessageInput } from '../db/repositories/AnnouncementRepository';

const base: CrosspostMessageInput = {
  bridgeMessageId: 'bridge-new',
  sourceMessageId: 'msg-source',
  sourceChannelId: 'ch-source',
  sourceServerId: 'srv-source',
  targetChannelId: 'ch-target',
  targetServerId: 'srv-target',
  userId: 'u1',
  username: 'alice',
  displayName: '📢 Alice',
  avatarColor: '#123456',
  content: 'hello',
  createdAt: 123456,
};

beforeEach(() => {
  mockQuery.mockReset();
  mockRelease.mockClear();
  mockConnect.mockClear();
});

describe('AnnouncementRepository.persistCrosspost', () => {
  it('writes idempotency log and message in one transaction', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ bridgeMessageId: 'bridge-new' }] })
      .mockResolvedValueOnce({ rows: [{ _id: 'bridge-new' }] })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const out = await Announcements.persistCrosspost(base);

    expect(out).toEqual({ bridgeMessageId: 'bridge-new', created: true });
    expect(String(mockQuery.mock.calls[1][0])).toContain('ON CONFLICT("messageId","targetChannelId") DO NOTHING');
    expect(String(mockQuery.mock.calls[2][0])).toContain('INSERT INTO messages');
    expect(String(mockQuery.mock.calls[2][0])).toContain('$13::jsonb');
    expect(mockQuery.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('heals a legacy log row whose message was never persisted', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }) // log conflict
      .mockResolvedValueOnce({ rows: [{
        sourceChannelId: base.sourceChannelId,
        sourceServerId: base.sourceServerId,
        targetServerId: base.targetServerId,
        bridgeMessageId: 'bridge-legacy',
      }] })
      .mockResolvedValueOnce({ rows: [{ _id: 'bridge-legacy' }] })
      .mockResolvedValueOnce({ rows: [] });

    const out = await Announcements.persistCrosspost(base);
    expect(out).toEqual({ bridgeMessageId: 'bridge-legacy', created: true });
    expect(mockQuery.mock.calls[3][1]?.[0]).toBe('bridge-legacy');
  });

  it('treats an existing matching message as an idempotent replay', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        sourceChannelId: base.sourceChannelId,
        sourceServerId: base.sourceServerId,
        targetServerId: base.targetServerId,
        bridgeMessageId: 'bridge-existing',
      }] })
      .mockResolvedValueOnce({ rows: [] }) // message ON CONFLICT
      .mockResolvedValueOnce({ rows: [{ channelId: base.targetChannelId, serverId: base.targetServerId }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(Announcements.persistCrosspost(base)).resolves.toEqual({
      bridgeMessageId: 'bridge-existing', created: false,
    });
  });

  it('fails closed and rolls back when an existing log crosses tenant identity', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        sourceChannelId: base.sourceChannelId,
        sourceServerId: base.sourceServerId,
        targetServerId: 'srv-foreign',
        bridgeMessageId: 'bridge-corrupt',
      }] })
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    await expect(Announcements.persistCrosspost(base)).rejects.toThrow(/tenant integrity/i);
    expect(mockQuery.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
