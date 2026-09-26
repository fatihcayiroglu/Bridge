process.env.NODE_ENV = 'test';

import express from 'express';
import request from 'supertest';

const mockChannelsFindById = jest.fn();
const mockMembersFindOne = jest.fn();
const mockGetIo = jest.fn();
const mockGetPeers = jest.fn();
const mockResolvePermissions = jest.fn();

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => { req.user = { id: 'u1' }; next(); },
}));
jest.mock('../middleware/rateLimit', () => ({
  limits: { voiceState: () => (_req: any, _res: any, next: any) => next() },
}));
jest.mock('../db/repositories', () => ({
  Channels: { findById: (...a: any[]) => mockChannelsFindById(...a) },
  Members: { findOne: (...a: any[]) => mockMembersFindOne(...a) },
}));
jest.mock('../socket', () => ({ getIo: (...a: any[]) => mockGetIo(...a) }));
jest.mock('../socket/handlers/voice', () => ({ getVoiceRoomPeers: (...a: any[]) => mockGetPeers(...a) }));
jest.mock('../lib/permissions', () => ({
  resolvePermissions: (...a: any[]) => mockResolvePermissions(...a),
  hasPermission: (p: number, b: number) => (p & b) === b,
  PERMS: { VIEW_CHANNELS: 1, CONNECT: 2 },
}));

import voiceRouter from '../routes/channels/voice';

const app = express();
app.use(express.json());
app.use('/api/channels', voiceRouter);

beforeEach(() => {
  jest.clearAllMocks();
  mockChannelsFindById.mockResolvedValue({ _id: 'c1', serverId: 's1' });
  mockMembersFindOne.mockResolvedValue({ userId: 'u1', serverId: 's1' });
  mockResolvePermissions.mockResolvedValue(3);
  mockGetPeers.mockResolvedValue([{ userId: 'u1', socketId: 'sock1', selfMute: false, selfDeaf: false }]);
  mockGetIo.mockReturnValue({ to: jest.fn(() => ({ emit: jest.fn() })) });
});

describe('POST /:channelId/voice-state', () => {
  test('requires at least one boolean state field', async () => {
    const r = await request(app).post('/api/channels/c1/voice-state').send({ selfMute: 'yes' });
    expect(r.status).toBe(400);
    expect(mockChannelsFindById).not.toHaveBeenCalled();
  });

  test('returns 404 for missing channel', async () => {
    mockChannelsFindById.mockResolvedValueOnce(null);
    expect((await request(app).post('/api/channels/c1/voice-state').send({ selfMute: true })).status).toBe(404);
  });

  test('requires canonical server membership', async () => {
    mockMembersFindOne.mockResolvedValueOnce(null);
    expect((await request(app).post('/api/channels/c1/voice-state').send({ selfMute: true })).status).toBe(403);
    expect(mockMembersFindOne).toHaveBeenCalledWith('u1', 's1');
  });

  test('permission resolver failure and missing CONNECT both fail closed', async () => {
    mockResolvePermissions.mockRejectedValueOnce(new Error('perm down'));
    expect((await request(app).post('/api/channels/c1/voice-state').send({ selfMute: true })).status).toBe(403);
    mockResolvePermissions.mockResolvedValueOnce(1);
    expect((await request(app).post('/api/channels/c1/voice-state').send({ selfMute: true })).status).toBe(403);
  });

  test('rejects state mutation when caller is not actually in the voice room', async () => {
    mockGetPeers.mockResolvedValueOnce([{ userId: 'other' }]);
    const r = await request(app).post('/api/channels/c1/voice-state').send({ selfDeaf: true });
    expect(r.status).toBe(409);
    expect(mockGetIo).not.toHaveBeenCalled();
  });

  test('broadcasts canonical state to voice+channel rooms', async () => {
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    mockGetIo.mockReturnValueOnce({ to });
    const r = await request(app).post('/api/channels/c1/voice-state').send({ selfMute: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(to).toHaveBeenCalledWith(['voice:c1', 'channel:c1']);
    expect(emit).toHaveBeenCalledWith('voice:state-update', {
      channelId: 'c1', userId: 'u1', selfMute: true, selfDeaf: false,
    });
  });

  test('succeeds without broadcast when Socket.IO is unavailable', async () => {
    mockGetIo.mockReturnValueOnce(null);
    const r = await request(app).post('/api/channels/c1/voice-state').send({ selfDeaf: false });
    expect(r.status).toBe(200);
  });

  test('unexpected dependency errors return 500', async () => {
    mockChannelsFindById.mockRejectedValueOnce(new Error('db down'));
    expect((await request(app).post('/api/channels/c1/voice-state').send({ selfMute: false })).status).toBe(500);
  });
});

describe('GET /:channelId/voice-members', () => {
  test('returns 404/403 for missing channel or membership', async () => {
    mockChannelsFindById.mockResolvedValueOnce(null);
    expect((await request(app).get('/api/channels/c1/voice-members')).status).toBe(404);
    mockMembersFindOne.mockResolvedValueOnce(null);
    expect((await request(app).get('/api/channels/c1/voice-members')).status).toBe(403);
  });

  test('permission resolver failure and missing VIEW/CONNECT fail closed', async () => {
    mockResolvePermissions.mockRejectedValueOnce(new Error('perm'));
    expect((await request(app).get('/api/channels/c1/voice-members')).status).toBe(403);
    mockResolvePermissions.mockResolvedValueOnce(2);
    expect((await request(app).get('/api/channels/c1/voice-members')).status).toBe(403);
  });

  test('returns active peers for authorized caller', async () => {
    const peers = [{ userId: 'u1' }, { userId: 'u2' }];
    mockGetPeers.mockResolvedValueOnce(peers);
    const r = await request(app).get('/api/channels/c1/voice-members');
    expect(r.status).toBe(200);
    expect(r.body).toEqual(peers);
  });

  test('unexpected errors return 500', async () => {
    mockGetPeers.mockRejectedValueOnce(new Error('voice backend'));
    expect((await request(app).get('/api/channels/c1/voice-members')).status).toBe(500);
  });
});
