import logger from '../lib/logger';
import { currentRequestContext, runWithRequestContext } from '../lib/requestContext';
import { captureActualLogRecords } from './helpers/capture-actual-log-records';
import type { MediasoupRouter, SfuPeer } from '../socket/handlers/mediasoup/types';

const mockRouterClose = jest.fn();
const mockCreateRouter = jest.fn();
const mockIncrement = jest.fn();
const mockDecrement = jest.fn();
const mockClaim = jest.fn();
const mockRelease = jest.fn();
jest.mock('../socket/handlers/mediasoup/workers', () => ({
  getNextWorkerWithIndex: () => ({ worker: { createRouter: mockCreateRouter }, index: 0 }),
  incrementWorkerLoad: (...args: unknown[]) => mockIncrement(...args),
  decrementWorkerLoad: (...args: unknown[]) => mockDecrement(...args),
}));
jest.mock('../lib/sfuRegistry', () => ({
  INSTANCE_ID: 'private-node', NODE_LEASE_MS: 30_000, NODE_HEARTBEAT_MS: 10_000,
  claimRoom: (...args: unknown[]) => mockClaim(...args),
  releaseRoom: (...args: unknown[]) => mockRelease(...args),
  refreshRoom: jest.fn(async () => true),
}));

import { getOrCreateRoom, cleanupRoom, sfuRooms, RoomOwnedElsewhereError,
  _resetRoomsForTest } from '../socket/handlers/mediasoup/rooms';

const original = { requestId: 'sfu-room-correlation', userId: 'private-actor',
  socketId: 'private-socket', memo: new Map<string, unknown>() };

beforeEach(() => {
  jest.useFakeTimers();
  mockRouterClose.mockReset();
  mockCreateRouter.mockReset().mockResolvedValue({ close: mockRouterClose } as unknown as MediasoupRouter);
  mockClaim.mockReset().mockResolvedValue({ owned: true, owner: 'private-node' });
  mockRelease.mockReset().mockResolvedValue(undefined);
  mockIncrement.mockClear();
  mockDecrement.mockClear();
});
afterEach(() => {
  _resetRoomsForTest();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('real Pino records from SFU room lifecycle (native router and registry are unit stubs)', () => {
  it('creates and closes the actual room state without publishing private identifiers', async () => {
    const capture = captureActualLogRecords();
    try {
      await runWithRequestContext(original, async () => {
        const room = await getOrCreateRoom('private-channel');
        expect(sfuRooms.get('private-channel')).toBe(room);
        expect(mockIncrement).toHaveBeenCalledWith(0);
        cleanupRoom('private-channel');
        expect(sfuRooms.has('private-channel')).toBe(false);
        expect(mockRouterClose).toHaveBeenCalledTimes(1);
        expect(mockDecrement).toHaveBeenCalledWith(0);
        expect(mockRelease).toHaveBeenCalledWith('private-channel');
        expect(currentRequestContext()).toBe(original);
        logger.warn({ event: 'test.sfu-security-context' }, 'Security context control');
      });
      const info = capture.records.filter(row => row.level === 30);
      expect(info).toHaveLength(2);
      for (const row of info) {
        expect(row.requestId).toBe(original.requestId);
        expect(JSON.stringify(row)).not.toContain('private');
      }
      expect(capture.records.find(row => row.level === 40)).toMatchObject({
        userId: original.userId, socketId: original.socketId, requestId: original.requestId,
      });
    } finally { capture.restore(); }
  });

  it('keeps routing authority in the typed rejection, without putting it in routine INFO', async () => {
    mockClaim.mockResolvedValue({ owned: false, owner: 'private-other-node' });
    const capture = captureActualLogRecords();
    try {
      await runWithRequestContext(original, async () => {
        await expect(getOrCreateRoom('private-channel')).rejects.toMatchObject({
          name: RoomOwnedElsewhereError.name, channelId: 'private-channel', ownerNodeId: 'private-other-node',
        });
        expect(currentRequestContext()).toBe(original);
      });
      expect(mockCreateRouter).not.toHaveBeenCalled();
      expect(mockRelease).not.toHaveBeenCalled();
      expect(sfuRooms.size).toBe(0);
      expect(capture.records).toHaveLength(1);
      expect(capture.records[0]).toMatchObject({ event: 'sfu.room.claim_lost', requestId: original.requestId });
      expect(JSON.stringify(capture.records[0])).not.toContain('private');
    } finally { capture.restore(); }
  });

  it('cleans an abandoned background room at the existing deadline without inventing request context', async () => {
    const capture = captureActualLogRecords();
    try {
      await getOrCreateRoom('private-background-channel');
      await jest.advanceTimersByTimeAsync(4_999);
      expect(sfuRooms.has('private-background-channel')).toBe(true);
      expect(mockRouterClose).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(sfuRooms.has('private-background-channel')).toBe(false);
      expect(mockRouterClose).toHaveBeenCalledTimes(1);
      expect(mockRelease).toHaveBeenCalledWith('private-background-channel');
      expect(capture.records).toHaveLength(2);
      for (const row of capture.records) {
        expect(row.level).toBe(30);
        expect(row).not.toHaveProperty('requestId');
        expect(JSON.stringify(row)).not.toContain('private');
      }
    } finally { capture.restore(); }
  });

  it('does not close an occupied room or falsely log successful cleanup', async () => {
    await getOrCreateRoom('private-active-channel');
    sfuRooms.get('private-active-channel')!.peers.set('private-peer', {} as SfuPeer);
    const capture = captureActualLogRecords();
    try {
      await jest.advanceTimersByTimeAsync(5_000);
      expect(sfuRooms.has('private-active-channel')).toBe(true);
      expect(mockRouterClose).not.toHaveBeenCalled();
      expect(mockRelease).not.toHaveBeenCalled();
      expect(capture.records).toEqual([]);
    } finally { capture.restore(); }
  });

  it('preserves failure recovery and the caller scope for a registry release warning', async () => {
    const cause = new Error('Router unavailable');
    mockCreateRouter.mockRejectedValue(cause);
    mockRelease.mockRejectedValue(new Error('Registry unavailable'));
    const capture = captureActualLogRecords();
    try {
      await runWithRequestContext(original, async () => {
        await expect(getOrCreateRoom('private-channel')).rejects.toBe(cause);
        expect(currentRequestContext()).toBe(original);
      });
      expect(mockRelease).toHaveBeenCalledWith('private-channel');
      expect(sfuRooms.size).toBe(0);
      expect(capture.records).toHaveLength(1);
      expect(capture.records[0]).toMatchObject({ level: 40, event: 'sfu.registry.release_failed',
        channelId: 'private-channel', userId: original.userId, socketId: original.socketId });
    } finally { capture.restore(); }
  });
});
