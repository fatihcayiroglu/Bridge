import logger from '../lib/logger';
import { currentRequestContext, runWithRequestContext } from '../lib/requestContext';
import { logRoutineMediaInfo } from '../lib/routineMediaLog';
import { captureActualLogRecords } from './helpers/capture-actual-log-records';

afterEach(() => jest.restoreAllMocks());

describe('routine media records rebuild a closed payload before actual Pino serialization', () => {
  it('does not forward structural extras, caller messages or DTO serializers', () => {
    const capture = captureActualLogRecords();
    const toJSON = jest.fn(() => ({ secret: 'private-serializer-value' }));
    const source = Object.freeze({ event: 'socket.channel_access_evicted', rooms: 3,
      userId: 'private-user', serverId: 'private-server', channelId: 'private-channel',
      message: 'private-caller-message', toJSON });
    const original = { requestId: 'media-correlation', userId: 'private-actor', socketId: 'private-socket', memo: new Map() };
    try {
      runWithRequestContext(original, () => {
        logRoutineMediaInfo(source as never);
        expect(currentRequestContext()).toBe(original);
        logger.warn({ event: 'test.media-security-context' }, 'Security context positive control.');
      });
      const info = capture.records.find(row => row.level === 30)!;
      expect(info).toMatchObject({ event: source.event, rooms: 3, requestId: original.requestId });
      expect(JSON.stringify(info)).not.toContain('private');
      expect(toJSON).not.toHaveBeenCalled();
      expect(source.userId).toBe('private-user');
      expect(capture.records.find(row => row.level === 40)).toMatchObject({
        userId: original.userId, socketId: original.socketId, requestId: original.requestId,
      });
    } finally { capture.restore(); }
  });

  it.each(['private-count', -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, { secret: 'private' }])(
    'does not turn malformed aggregates into data or a false zero', value => {
      const capture = captureActualLogRecords();
      try {
        logRoutineMediaInfo({ event: 'socket.voice_publish_revoked', producers: value } as never);
        logRoutineMediaInfo({ event: 'socket.channel_access_evicted', rooms: value } as never);
        expect(capture.records).toHaveLength(2);
        for (const row of capture.records) {
          expect(row).not.toHaveProperty('producers');
          expect(row).not.toHaveProperty('rooms');
          expect(JSON.stringify(row)).not.toContain('private');
        }
      } finally { capture.restore(); }
    },
  );

  it('reads permitted runtime getters only once and never forwards the source object', () => {
    const capture = captureActualLogRecords();
    let eventReads = 0;
    let countReads = 0;
    const source = {
      get event() { return ++eventReads === 1 ? 'socket.channel_access_evicted' : 'private-event'; },
      get rooms() { return ++countReads === 1 ? 2 : 'private-count'; },
    };
    try {
      logRoutineMediaInfo(source as never);
      expect(eventReads).toBe(1);
      expect(countReads).toBe(1);
      expect(capture.records).toHaveLength(1);
      expect(capture.records[0]).toMatchObject({ event: 'socket.channel_access_evicted', rooms: 2 });
      expect(JSON.stringify(capture.records[0])).not.toContain('private');
    } finally { capture.restore(); }
  });

  it('retains valid booleans/zero counts and the correlation of coordinator-only events', () => {
    const capture = captureActualLogRecords();
    try {
      runWithRequestContext({ requestId: 'media-coordinator', userId: 'private-actor' }, () => {
        logRoutineMediaInfo({ event: 'socket.voice_access_evicted' });
        logRoutineMediaInfo({ event: 'socket.voice_publish_revoked', producers: 0 });
        logRoutineMediaInfo({ event: 'socket.voice_evicted', sfu: false });
        logRoutineMediaInfo({ event: 'media.expiry_evicted' });
      });
      expect(capture.records).toHaveLength(4);
      for (const row of capture.records) {
        expect(row.requestId).toBe('media-coordinator');
        expect(JSON.stringify(row)).not.toContain('private');
      }
      expect(capture.records[1]).toHaveProperty('producers', 0);
      expect(capture.records[2]).toHaveProperty('sfu', false);
    } finally { capture.restore(); }
  });

  it.each(['private-event', '__proto__', 'constructor', null])('rejects unsupported event names without logging the input', event => {
    const capture = captureActualLogRecords();
    try {
      expect(() => logRoutineMediaInfo({ event } as never)).toThrow('Unsupported routine media event');
      expect(capture.records).toEqual([]);
      expect(currentRequestContext()).toBeUndefined();
    } finally { capture.restore(); }
  });
});
