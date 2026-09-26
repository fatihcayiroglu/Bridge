import express from 'express';
import request from 'supertest';

const mockGetStats = jest.fn();
const mockRooms = new Map<string, any>();
let mockReady = true;

jest.mock('../middleware/auth', () => ({ authMiddleware: (_req: any, _res: any, next: any) => next() }));
jest.mock('../routes/admin/core', () => ({ adminOnly: (_req: any, _res: any, next: any) => next() }));
jest.mock('../lib/sfuRegistry', () => ({ getStats: (...args: unknown[]) => mockGetStats(...args) }));
jest.mock('../socket/handlers/mediasoup', () => ({
  sfuRooms: mockRooms,
  sfuPeers: new Map(),
  isSFUReady: () => mockReady,
}));

import sfuRouter from '../routes/admin/sfu';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/admin', sfuRouter);
  return instance;
}

describe('admin SFU statistics route', () => {
  beforeEach(() => {
    jest.clearAllMocks(); mockRooms.clear(); mockReady = true;
    mockGetStats.mockResolvedValue({ nodeId: 'n1', clusterRooms: 3 });
  });

  it('merges cluster stats with local room/media details without leaking transport objects', async () => {
    mockRooms.set('c1', {
      createdAt: 123,
      router: { rtpCapabilities: { codecs: [{ mimeType: 'audio/opus' }, { mimeType: 'video/VP8' }] } },
      peers: new Map([
        ['s1', { userId: 'u1', displayName: 'One', producers: new Map([['a', { kind: 'audio' }]]) }],
        ['s2', { userId: 'u2', displayName: 'Two', producers: new Map([['v', { kind: 'video' }]]) }],
        ['s3', { userId: 'u3', displayName: 'Three' }],
      ]),
    });
    const uptime = jest.spyOn(process, 'uptime').mockReturnValue(42);

    const res = await request(app()).get('/api/admin/sfu/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      available: true, nodeId: 'n1', clusterRooms: 3, totalPeers: 3, uptime: 42,
    }));
    expect(res.body.localRoomDetails).toEqual([
      expect.objectContaining({
        channelId: 'c1', peerCount: 3, createdAt: 123,
        routerRtpCapabilities: ['audio/opus', 'video/VP8'],
        peers: [
          { userId: 'u1', displayName: 'One', hasVideo: false, hasAudio: true },
          { userId: 'u2', displayName: 'Two', hasVideo: true, hasAudio: false },
          { userId: 'u3', displayName: 'Three', hasVideo: false, hasAudio: false },
        ],
      }),
    ]);
    uptime.mockRestore();
  });

  it('returns an empty local detail set when mediasoup is not ready', async () => {
    mockReady = false;
    const res = await request(app()).get('/api/admin/sfu/stats');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.localRoomDetails).toEqual([]);
    expect(res.body.totalPeers).toBe(0);
  });

  it('contains registry failures as an honest unavailable response', async () => {
    mockGetStats.mockRejectedValueOnce(new Error('redis registry down'));
    const res = await request(app()).get('/api/admin/sfu/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, error: 'redis registry down' });
  });
});
