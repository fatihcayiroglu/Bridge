process.env.JWT_SECRET = 'stats-deep-secretxxxxxxxxxxxxxxx';
process.env.REFRESH_SECRET = 'stats-deep-refreshxxxxxxxxxxxxxx';
process.env.NODE_ENV = 'test';

const getServerStats = jest.fn();
const getGrowthSeries = jest.fn();
const getActivityDistribution = jest.fn();
const getRetention = jest.fn();
const getCsvData = jest.fn();
const memberFindOne = jest.fn();
const channelFindByServer = jest.fn();
const serverFindById = jest.fn();
const resolvePermissions = jest.fn();

jest.mock('../db/repositories/StatsRepository.js', () => ({
  Stats: { getServerStats, getGrowthSeries, getActivityDistribution, getRetention, getCsvData },
}));
jest.mock('../db/repositories', () => ({
  Members: { findOne: memberFindOne },
  Channels: { findByServer: channelFindByServer },
  Servers: { findById: serverFindById },
}));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: String(req.headers['x-user-id'] || 'u1') };
    next();
  },
}));
jest.mock('../lib/permissions', () => ({
  resolvePermissions,
  hasPermission: (perms: number, required: number) => (perms & required) === required,
  PERMS: { MANAGE_SERVER: 8 },
}));

import express from 'express';
import request from 'supertest';
import statsRouter from '../routes/stats';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/servers', statsRouter);
  return instance;
}

function allowStats() {
  memberFindOne.mockResolvedValue({ userId: 'u1', serverId: 's1' });
  resolvePermissions.mockResolvedValue(8);
  serverFindById.mockResolvedValue({ _id: 's1', ownerId: 'u1' });
  channelFindByServer.mockResolvedValue([{ _id: 'c1', name: 'general' }]);
}

describe('stats routes deep behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    allowStats();
    getServerStats.mockResolvedValue({
      memberCount: 4,
      channelCount: 2,
      totalMessages: 20,
      activeUsers7d: 3,
      activeUsers30d: 4,
      topUsers: [{ userId: 'u1', displayName: 'A', msgCount: 9 }],
      channelBreakdown: [
        { channelId: 'c1', msgCount: 12 },
        { channelId: 'missing', msgCount: 8 },
      ],
    });
  });

  it('fails closed when membership is absent or permission resolution fails', async () => {
    memberFindOne.mockResolvedValueOnce(null);
    expect((await request(app()).get('/api/servers/s1/stats')).status).toBe(403);

    memberFindOne.mockResolvedValue({ userId: 'u1' });
    resolvePermissions.mockRejectedValueOnce(new Error('permission store down'));
    expect((await request(app()).get('/api/servers/s1/stats')).status).toBe(403);
  });

  it('maps known channel names and falls back to the channel id', async () => {
    const res = await request(app()).get('/api/servers/s1/stats');
    expect(res.status).toBe(200);
    expect(res.body.channelBreakdown).toEqual([
      { channelId: 'c1', channelName: 'general', msgCount: 12 },
      { channelId: 'missing', channelName: 'missing', msgCount: 8 },
    ]);
    expect(res.body.isOwner).toBe(true);
  });

  it('zero-fills growth series and computes cumulative membership backwards', async () => {
    const now = Date.UTC(2026, 7, 30, 12, 0, 0);
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    const since = now - 3 * 86400_000;
    const d0 = new Date(since).toISOString().slice(0, 10);
    const d2 = new Date(since + 2 * 86400_000).toISOString().slice(0, 10);
    getGrowthSeries.mockResolvedValue({
      joinSeries: [{ day: d0, newMembers: 2 }, { day: d2, newMembers: 1 }],
      msgSeries: [{ day: d2, msgCount: 7 }],
      totalMembers: 10,
    });

    const res = await request(app()).get('/api/servers/s1/stats/growth?days=3');
    spy.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body.joinSeries.map((r: any) => r.newMembers)).toEqual([2, 0, 1]);
    expect(res.body.messageSeries.map((r: any) => r.msgCount)).toEqual([0, 0, 7]);
    expect(res.body.cumulativeSeries.map((r: any) => r.totalMembers)).toEqual([9, 9, 10]);
    expect(res.body.totalMembers).toBe(10);
  });

  it.each(['0', '-2', '1.5', '91', '1e2', ' 2 ', '0x10'])(
    'rejects non-canonical or out-of-range growth days=%s',
    async (days) => {
      expect((await request(app()).get(`/api/servers/s1/stats/growth?days=${encodeURIComponent(days)}`)).status).toBe(400);
    },
  );

  it('builds complete hourly/weekly distributions and stable peak values', async () => {
    getActivityDistribution.mockResolvedValue({
      hours: [{ hour: 0, msgCount: 5 }, { hour: 23, msgCount: 12 }],
      dows: [{ dow: 0, msgCount: 12 }, { dow: 6, msgCount: 3 }],
    });
    const res = await request(app()).get('/api/servers/s1/stats/activity');
    expect(res.status).toBe(200);
    expect(res.body.hourlyDistribution).toHaveLength(24);
    expect(res.body.weeklyDistribution).toHaveLength(7);
    expect(res.body.hourlyDistribution[1]).toEqual({ hour: 1, label: '01:00', msgCount: 0 });
    expect(res.body.peakHour).toEqual({ hour: 23, label: '23:00', msgCount: 12 });
    expect(res.body.peakDay).toEqual({ dow: 0, label: 'Pazar', msgCount: 12 });
  });

  it('returns bounded retention rates including the zero-member/zero-MAU case', async () => {
    getRetention.mockResolvedValueOnce({ dau: 2, wau: 5, mau: 8, memberTotal: 10 });
    const normal = await request(app()).get('/api/servers/s1/stats/retention');
    expect(normal.body).toMatchObject({ dauRate: 20, wauRate: 50, mauRate: 80, dauMauRatio: 25 });

    getRetention.mockResolvedValueOnce({ dau: 0, wau: 0, mau: 0, memberTotal: 0 });
    const empty = await request(app()).get('/api/servers/s1/stats/retention');
    expect(empty.body).toMatchObject({ dauRate: 0, wauRate: 0, mauRate: 0, dauMauRatio: 0 });
  });

  it('restricts CSV export to the owner and validates the requested period', async () => {
    serverFindById.mockResolvedValueOnce({ _id: 's1', ownerId: 'other' });
    expect((await request(app()).get('/api/servers/s1/stats/export.csv')).status).toBe(403);

    expect((await request(app()).get('/api/servers/s1/stats/export.csv?days=91')).status).toBe(400);
  });

  it('exports UTF-8 CSV while neutralizing formulas and escaping quotes', async () => {
    channelFindByServer.mockResolvedValue([
      { _id: 'c1', name: '=HYPERLINK("https://evil.invalid")' },
    ]);
    getCsvData.mockResolvedValue({
      joinRows: [{ day: '2026-08-29', newMembers: 2 }],
      msgRows: [{ day: '2026-08-29', msgCount: 4 }],
      topUsers: [
        { displayName: '+SUM(1,1)', msgCount: 10 },
        { displayName: 'Ada "quoted"', msgCount: 3 },
      ],
      chanBreakdown: [
        { channelId: 'c1', msgCount: 7 },
        { channelId: '@missing', msgCount: 1 },
      ],
    });

    const res = await request(app()).get('/api/servers/s1/stats/export.csv?days=7');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('bridge-analytics-s1-');
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    expect(res.text).toContain("\"'+SUM(1,1)\"");
    expect(res.text).toContain("\"'=HYPERLINK(\"\"https://evil.invalid\"\")\"");
    expect(res.text).toContain('\"Ada \"\"quoted\"\"\"');
    expect(res.text).toContain("\"'@missing\"");
  });
});
