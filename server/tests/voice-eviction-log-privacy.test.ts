jest.mock('../socket/handlers/voice', () => ({
  leaveVoice: jest.fn(async (socket: { currentVoiceChannel: string | null }) => {
    socket.currentVoiceChannel = null;
  }),
}));
jest.mock('../socket/handlers/mediasoup/rooms', () => ({
  sfuPeers: new Map(), cleanupPeer: jest.fn(async () => undefined),
  revokeStagePublishers: jest.fn(() => 0),
}));

import logger from '../lib/logger';
import { currentRequestContext, runWithRequestContext, type RequestContext } from '../lib/requestContext';
import { evictLocalVoiceSessions, revokeLocalVoicePublishing } from '../socket/voiceEviction';
import { revokeStagePublishers, sfuPeers } from '../socket/handlers/mediasoup/rooms';
import { captureActualLogRecords } from './helpers/capture-actual-log-records';

const CHANNEL = 'private-voice-channel';
const USER = 'private-voice-participant';
const ACTOR = 'private-authorized-actor';
const SOCKET = 'private-client-socket';

function fixture() {
  const socket = {
    id: SOCKET, userId: USER, rooms: new Set([`voice:${CHANNEL}`]),
    currentVoiceChannel: CHANNEL as string | null, currentVoiceServer: 'private-server',
    leave: jest.fn(), emit: jest.fn(),
  };
  const io = { in: () => ({ local: { fetchSockets: async () => [socket] } }) };
  return { socket, io };
}

function context(requestId = 'voice-correlation') {
  return { requestId, userId: ACTOR, socketId: SOCKET, memo: new Map([['authorization', true]]) };
}

function expectPrivateInfo(record: Record<string, unknown>, requestId: string) {
  expect(record).toMatchObject({ level: 30, requestId });
  for (const field of ['userId', 'socketId', 'channelId', 'serverId', 'memo']) {
    expect(record).not.toHaveProperty(field);
  }
  const serialized = JSON.stringify(record);
  for (const value of [CHANNEL, USER, ACTOR, SOCKET, 'private-server']) expect(serialized).not.toContain(value);
}

beforeEach(() => { sfuPeers.clear(); jest.mocked(revokeStagePublishers).mockReturnValue(0); });
afterEach(() => { jest.restoreAllMocks(); sfuPeers.clear(); });

describe('routine voice INFO privacy at the actual Pino serialization boundary', () => {
  it.each(['p2p-access', 'sfu-access', 'p2p-speak', 'sfu-speak'] as const)(
    '%s retains correlation and restores the caller actor/memo for security logs', async kind => {
      const { socket, io } = fixture();
      if (kind === 'sfu-access' || kind === 'sfu-speak') {
        sfuPeers.set(SOCKET, { channelId: CHANNEL, serverId: 'private-server' } as never);
      }
      if (kind === 'sfu-speak') jest.mocked(revokeStagePublishers).mockReturnValue(2);
      const capture = captureActualLogRecords();
      const original = context();
      try {
        await runWithRequestContext(original, async () => {
          if (kind.endsWith('access')) await evictLocalVoiceSessions(io as never, USER, [CHANNEL]);
          else await revokeLocalVoicePublishing(io as never, USER, CHANNEL);
          expect(currentRequestContext()).toBe(original);
          expect(currentRequestContext()?.memo).toBe(original.memo);
          logger.warn({ event: 'test.voice-security-context' }, 'Security context positive control.');
        });
        const info = capture.records.filter(row => row.level === 30);
        expect(info).toHaveLength(1);
        expectPrivateInfo(info[0]!, original.requestId);
        if (kind === 'sfu-speak') expect(info[0]).toMatchObject({ producers: 2 });
        if (kind.endsWith('access')) expect(info[0]).toMatchObject({ sfu: kind === 'sfu-access' });
        expect(capture.records.find(row => row.event === 'test.voice-security-context')).toMatchObject({
          level: 40, userId: ACTOR, socketId: SOCKET, requestId: original.requestId,
        });
      } finally { capture.restore(); }
      expect(currentRequestContext()).toBeUndefined();
    },
  );

  it('does not manufacture a context for a background eviction', async () => {
    const { io } = fixture();
    const capture = captureActualLogRecords();
    try {
      await evictLocalVoiceSessions(io as never, USER, [CHANNEL]);
      expect(capture.records).toHaveLength(1);
      expect(capture.records[0]).not.toHaveProperty('requestId');
      expect(capture.records[0]).not.toHaveProperty('userId');
      expect(currentRequestContext()).toBeUndefined();
    } finally { capture.restore(); }
  });

  it('concurrent evictions retain separate request correlation and actor contexts', async () => {
    const capture = captureActualLogRecords();
    const finish = new Map<string, () => void>();
    const run = (id: string) => {
      const { socket } = fixture();
      const original: RequestContext = { ...context(id), userId: 'actor-' + id };
      const io = { in: () => ({ local: { fetchSockets: () => new Promise(resolve => {
        finish.set(id, () => resolve([socket]));
      }) } }) };
      return runWithRequestContext(original, async () => {
        await evictLocalVoiceSessions(io as never, USER, [CHANNEL]);
        expect(currentRequestContext()).toBe(original);
      });
    };
    try {
      const a = run('trace-a');
      const b = run('trace-b');
      finish.get('trace-b')!();
      await b;
      finish.get('trace-a')!();
      await a;
      expect(capture.records.map(row => row.requestId)).toEqual(['trace-b', 'trace-a']);
      for (const row of capture.records) expectPrivateInfo(row, String(row.requestId));
    } finally { capture.restore(); }
  });

  it('restores caller context when a logging sink throws', async () => {
    const { io } = fixture();
    const original = context();
    jest.spyOn(logger, 'info').mockImplementationOnce(() => { throw new Error('sink-unavailable'); });
    await runWithRequestContext(original, async () => {
      await expect(evictLocalVoiceSessions(io as never, USER, [CHANNEL])).rejects.toThrow('sink-unavailable');
      expect(currentRequestContext()).toBe(original);
      expect(currentRequestContext()?.memo).toBe(original.memo);
    });
    expect(currentRequestContext()).toBeUndefined();
  });
});
