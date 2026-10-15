// server/tests/mediasoup-room-authority.test.ts
//
// Who may enter, publish into and keep using a voice / stage / group-call SFU
// room. `authorizeMediaRoom` resolves that from server-side state on every
// step; the client only names a room. The existing SFU suite drives the
// happy path; none of the refusals had run. Here, through the real handlers
// (mediasoup, the cluster registry and ICE config stubbed as in
// mediasoup-handlers.test.ts; repositories, permission resolution and the
// stage roster are per-test stubs):
//   - capabilities and join are refused FORBIDDEN, and no room or peer is
//     created, for: a text channel, a channel without a server, a non-member,
//     a timed-out member, missing VIEW_CHANNELS, missing CONNECT, a claimed
//     server that is not the channel's, and any lookup that fails (fail closed);
//   - a stage room additionally requires being on the stage roster;
//   - a group-call room (no channel row) requires group membership and never
//     accepts a claimed server id;
//   - publishing requires SPEAK (and, on a stage, being a speaker); without it
//     nothing is produced;
//   - screen video must be video, screen audio must be audio, never both;
//   - access revoked after joining refuses new transports and consumers, and
//     drops state updates and speaking indicators.

process.env.NODE_ENV = 'test';

function makeTransportStub(id: string) {
  return {
    id,
    iceParameters: { usernameFragment: 'uf', password: 'pw', iceLite: false },
    iceCandidates: [],
    dtlsParameters: { fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB' }], role: 'auto' },
    connect: jest.fn(async () => {}),
    produce: jest.fn(async () => ({ id: `${id}-producer`, kind: 'audio', type: 'simple', close: jest.fn(), on: jest.fn() })),
    consume: jest.fn(async () => ({ id: `${id}-consumer`, kind: 'audio', rtpParameters: {}, type: 'simple', resume: jest.fn(), close: jest.fn(), on: jest.fn() })),
    close: jest.fn(),
    on: jest.fn(),
  };
}
let transportSerial = 0;
const mockCreateRouter = jest.fn(async () => ({
  rtpCapabilities: { codecs: [{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }], headerExtensions: [] },
  canConsume: jest.fn(() => true),
  createWebRtcTransport: jest.fn(async () => makeTransportStub(`t${++transportSerial}`)),
  close: jest.fn(),
  on: jest.fn(),
}));
const mediasoupStub = { createWorker: jest.fn(async () => ({ _id: 'w1', createRouter: mockCreateRouter, close: jest.fn(), on: jest.fn() })) };
jest.mock('mediasoup', () => mediasoupStub, { virtual: true });

jest.mock('../lib/sfuRegistry', () => ({
  INSTANCE_ID: 'test-node', ROOM_LEASE_TTL_SECONDS: 3600, NODE_LEASE_MS: 30_000, NODE_HEARTBEAT_MS: 10_000,
  isLocalRoom: jest.fn(async () => true),
  getRoomOwner: jest.fn(async () => null),
  claimRoom: jest.fn(async () => ({ owned: true, owner: 'test-node' })),
  releaseRoom: jest.fn(async () => {}),
  refreshRoom: jest.fn(async () => true),
}));
jest.mock('../lib/turnConfig', () => ({ getRtcIceConfig: jest.fn(() => ({ iceServers: [], iceTransportPolicy: 'all' })) }));
jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockChannel = jest.fn();
const mockMember = jest.fn();
const mockGroupMember = jest.fn();
const mockPerms = jest.fn();
const mockStageParticipant = jest.fn();
const mockStageSpeaker = jest.fn();
jest.mock('../db/repositories', () => ({
  Channels: { findById: (...a: unknown[]) => mockChannel(...a) },
  Members: { findOne: (...a: unknown[]) => mockMember(...a) },
  GroupDms: { findMember: (...a: unknown[]) => mockGroupMember(...a) },
}));
const VIEW = 1, CONNECT = 2, SPEAK = 4;
jest.mock('../lib/permissions', () => ({
  PERMS: { VIEW_CHANNELS: 1, CONNECT: 2, SPEAK: 4 },
  hasPermission: (perms: number, flag: number) => (perms & flag) === flag,
  resolvePermissions: (...a: unknown[]) => mockPerms(...a),
}));
jest.mock('../socket/handlers/stage', () => ({
  isStageParticipant: (...a: unknown[]) => mockStageParticipant(...a),
  isStageSpeaker: (...a: unknown[]) => mockStageSpeaker(...a),
}));

import { initMediasoup, _resetWorkersForTest, _setMediasoupForTest } from '../socket/handlers/mediasoup/workers';
import { sfuRooms, sfuPeers, _resetRoomsForTest } from '../socket/handlers/mediasoup/rooms';
import { registerSFUHandlers } from '../socket/handlers/mediasoup/index';
import type { BridgeSocket, BridgeIO, MediasoupModule } from '../socket/handlers/mediasoup/types';

const RTP_CAPS = { codecs: [{ kind: 'audio' as const, mimeType: 'audio/opus', clockRate: 48000, channels: 2 }], headerExtensions: [] };
const AUDIO_RTP = { codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2 }] };
const VIDEO_RTP = { codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000 }] };

type Emitted = { event: string; data: Record<string, unknown> };
function makeSocket(id: string) {
  const emitted: Emitted[] = [];
  const handlers: Record<string, (d: unknown) => unknown> = {};
  const socket = {
    id,
    emitted,
    emit: (event: string, data: Record<string, unknown>) => { emitted.push({ event, data }); },
    join: jest.fn(),
    leave: jest.fn(async () => {}),
    to: (room: string) => ({ emit: (event: string, data: Record<string, unknown>) => { emitted.push({ event: `to:${room}:${event}`, data }); } }),
    on: (event: string, h: (d: unknown) => unknown) => { handlers[event] = h; },
    currentVoiceChannel: null as string | null,
    currentVoiceServer: null as string | null,
    fire: async (event: string, data: unknown) => handlers[event]!(data),
  };
  return socket;
}
const io = { to: () => ({ emit: () => {} }) } as unknown as BridgeIO;
const user = { _id: 'user-1', displayName: 'Ana', avatarColor: '#2d9cdb' };
const errors = (s: ReturnType<typeof makeSocket>) => s.emitted.filter(e => e.event === 'sfu:error').map(e => `${e.data.operation}:${e.data.code}`);

function connect(id = 'sock-1') {
  const s = makeSocket(id);
  registerSFUHandlers(s as unknown as BridgeSocket, io, user);
  return s;
}

beforeEach(async () => {
  _resetWorkersForTest();
  _resetRoomsForTest();
  mockCreateRouter.mockClear();
  _setMediasoupForTest(mediasoupStub as unknown as MediasoupModule);
  await initMediasoup();
  // A member of srv-1 with VIEW + CONNECT + SPEAK on the voice channel `vc`.
  mockChannel.mockReset().mockImplementation(async (id: string) => (
    id === 'vc' ? { _id: 'vc', serverId: 'srv-1', type: 'voice' }
      : id === 'stage' ? { _id: 'stage', serverId: 'srv-1', type: 'stage' }
        : id === 'text' ? { _id: 'text', serverId: 'srv-1', type: 'text' }
          : id === 'orphan' ? { _id: 'orphan', serverId: '', type: 'voice' }
            : null));
  mockMember.mockReset().mockResolvedValue({ userId: 'user-1', timeoutUntil: null });
  mockGroupMember.mockReset().mockResolvedValue(null);
  mockPerms.mockReset().mockResolvedValue(VIEW | CONNECT | SPEAK);
  mockStageParticipant.mockReset().mockResolvedValue(false);
  mockStageSpeaker.mockReset().mockResolvedValue(false);
});

const join = (s: ReturnType<typeof makeSocket>, channelId: string, serverId: string | null = null) =>
  s.fire('sfu:join', { channelId, serverId, rtpCapabilities: RTP_CAPS });

describe('entering a media room', () => {
  it.each([
    ['a text channel', 'text', () => {}],
    ['a channel without a server', 'orphan', () => {}],
    ['a non-member', 'vc', () => mockMember.mockResolvedValue(null)],
    ['a timed-out member', 'vc', () => mockMember.mockResolvedValue({ userId: 'user-1', timeoutUntil: Date.now() + 60_000 })],
    ['a member without VIEW_CHANNELS', 'vc', () => mockPerms.mockResolvedValue(CONNECT | SPEAK)],
    ['a member without CONNECT', 'vc', () => mockPerms.mockResolvedValue(VIEW | SPEAK)],
    ['a failing channel lookup', 'vc', () => mockChannel.mockRejectedValue(new Error('db down'))],
    ['a failing membership lookup', 'vc', () => mockMember.mockRejectedValue(new Error('db down'))],
    ['a failing permission resolution', 'vc', () => mockPerms.mockRejectedValue(new Error('db down'))],
  ])('%s: capabilities and join are refused; no room, no peer', async (_label, channelId, arrange) => {
    arrange();
    const s = connect();
    await s.fire('sfu:get-rtp-capabilities', { channelId });
    await join(s, channelId);
    expect(errors(s)).toEqual(['capabilities:FORBIDDEN', 'join:FORBIDDEN']);
    expect(mockCreateRouter).not.toHaveBeenCalled();
    expect(sfuRooms.has(channelId)).toBe(false);
    expect(sfuPeers.has(s.id)).toBe(false);
  });

  it('a voice channel member with VIEW + CONNECT joins (the refusals above are not blanket)', async () => {
    const s = connect();
    await join(s, 'vc', 'srv-1');
    expect(errors(s)).toEqual([]);
    expect(sfuPeers.get(s.id)).toMatchObject({ channelId: 'vc', serverId: 'srv-1' });
  });

  it('a join that claims a server the channel does not belong to is refused', async () => {
    const s = connect();
    await join(s, 'vc', 'srv-other');
    expect(errors(s)).toEqual(['join:FORBIDDEN']);
    expect(sfuPeers.has(s.id)).toBe(false);
  });

  it('a stage room also requires being on the stage roster', async () => {
    const outside = connect('sock-out');
    await join(outside, 'stage');
    expect(errors(outside)).toEqual(['join:FORBIDDEN']);
    expect(mockStageParticipant).toHaveBeenCalledWith('stage', 'user-1');

    mockStageParticipant.mockResolvedValue(true);
    const listener = connect('sock-in');
    await join(listener, 'stage');
    expect(errors(listener)).toEqual([]);
    expect(sfuPeers.get('sock-in')).toMatchObject({ channelId: 'stage' });
  });

  it('a group-call room requires group membership and never accepts a claimed server id', async () => {
    const stranger = connect('sock-stranger');
    await join(stranger, 'gdm-1');
    expect(errors(stranger)).toEqual(['join:FORBIDDEN']);
    expect(mockGroupMember).toHaveBeenCalledWith('gdm-1', 'user-1');

    mockGroupMember.mockResolvedValue({ userId: 'user-1', groupId: 'gdm-1' });
    const claimed = connect('sock-claimed');
    await join(claimed, 'gdm-1', 'srv-1');
    expect(errors(claimed)).toEqual(['join:FORBIDDEN']);

    const member = connect('sock-member');
    await join(member, 'gdm-1');
    expect(errors(member)).toEqual([]);
    expect(sfuPeers.get('sock-member')).toMatchObject({ channelId: 'gdm-1', serverId: null });

    mockGroupMember.mockRejectedValue(new Error('db down'));
    const failing = connect('sock-failing');
    await join(failing, 'gdm-1');
    expect(errors(failing)).toEqual(['join:FORBIDDEN']);
  });
});

describe('publishing into a media room', () => {
  async function joinedWithSendTransport(channelId: string) {
    const s = connect();
    await join(s, channelId);
    await s.fire('sfu:create-transport', { channelId, direction: 'send' });
    expect(errors(s)).toEqual([]);
    return s;
  }
  const produced = (s: ReturnType<typeof makeSocket>) => s.emitted.filter(e => e.event === 'sfu:produced');

  it('without SPEAK nothing is produced', async () => {
    const s = await joinedWithSendTransport('vc');
    mockPerms.mockResolvedValue(VIEW | CONNECT);
    await s.fire('sfu:produce', { channelId: 'vc', kind: 'audio', rtpParameters: AUDIO_RTP });
    expect(errors(s)).toEqual(['produce:FORBIDDEN']);
    expect(produced(s)).toEqual([]);
    expect(sfuPeers.get(s.id)!.producers.size).toBe(0);
  });

  it('on a stage, a listener cannot publish; a speaker can', async () => {
    mockStageParticipant.mockResolvedValue(true);
    const s = await joinedWithSendTransport('stage');
    await s.fire('sfu:produce', { channelId: 'stage', kind: 'audio', rtpParameters: AUDIO_RTP });
    expect(errors(s)).toEqual(['produce:FORBIDDEN']);
    expect(produced(s)).toEqual([]);

    mockStageSpeaker.mockResolvedValue(true);
    await s.fire('sfu:produce', { channelId: 'stage', kind: 'audio', rtpParameters: AUDIO_RTP });
    expect(produced(s)).toHaveLength(1);
  });

  it.each([
    ['screen video sent as audio', 'audio', { screen: true }, AUDIO_RTP],
    ['screen audio sent as video', 'video', { screenAudio: true }, VIDEO_RTP],
    ['a track claiming to be both', 'video', { screen: true, screenAudio: true }, VIDEO_RTP],
  ])('%s is refused', async (_label, kind, appData, rtpParameters) => {
    const s = await joinedWithSendTransport('vc');
    await s.fire('sfu:produce', { channelId: 'vc', kind, rtpParameters, appData });
    expect(errors(s)).toEqual(['produce:INVALID_PRODUCER']);
    expect(produced(s)).toEqual([]);
  });
});

describe('access revoked after joining', () => {
  it('new transports and consumers are refused; state updates and speaking indicators are dropped', async () => {
    const publisher = connect('sock-pub');
    await join(publisher, 'vc');
    await publisher.fire('sfu:create-transport', { channelId: 'vc', direction: 'send' });
    await publisher.fire('sfu:produce', { channelId: 'vc', kind: 'audio', rtpParameters: AUDIO_RTP });
    const producerId = String(publisher.emitted.find(e => e.event === 'sfu:produced')!.data.producerId);

    const s = connect('sock-sub');
    await join(s, 'vc');
    await s.fire('sfu:create-transport', { channelId: 'vc', direction: 'recv' });
    expect(errors(s)).toEqual([]);

    mockPerms.mockResolvedValue(0); // e.g. the member's role lost CONNECT
    await s.fire('sfu:create-transport', { channelId: 'vc', direction: 'send' });
    await s.fire('sfu:consume', { channelId: 'vc', producerId, rtpCapabilities: RTP_CAPS });
    await s.fire('voice:state-update', { channelId: 'vc', muted: true, deafened: false, screensharing: false, video: false });
    await s.fire('voice:activity', { channelId: 'vc', speaking: true });

    expect(errors(s)).toEqual(['create-transport:FORBIDDEN', 'consume:FORBIDDEN']);
    expect(s.emitted.filter(e => e.event === 'sfu:consumed' || e.event.endsWith(':voice:peer-state') || e.event.endsWith(':voice:activity'))).toEqual([]);
    expect(sfuPeers.get('sock-sub')!.consumers.size).toBe(0);
    expect(sfuPeers.get('sock-sub')!.muted).toBe(false);
  });
});
