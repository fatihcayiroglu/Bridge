const query = jest.fn();
jest.mock('../db/postgres/pool', () => ({ pool: { query } }));

import { Stats } from '../db/repositories/StatsRepository';

beforeEach(() => query.mockReset());

describe('StatsRepository PostgreSQL behavior', () => {
  it('returns normalized server stats and excludes banned rows from active membership count', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ count: '12' }] })
      .mockResolvedValueOnce({ rows: [{ count: '4' }] })
      .mockResolvedValueOnce({ rows: [{ count: '81' }] })
      .mockResolvedValueOnce({ rows: [{ count: '5' }] })
      .mockResolvedValueOnce({ rows: [{ count: '9' }] })
      .mockResolvedValueOnce({ rows: [{ userId: 'u1', displayName: 'One', msgCount: '7' }] })
      .mockResolvedValueOnce({ rows: [{ channelId: 'c1', msgCount: '11' }] });

    await expect(Stats.getServerStats('s1')).resolves.toEqual({
      memberCount: 12,
      channelCount: 4,
      totalMessages: 81,
      activeUsers7d: 5,
      activeUsers30d: 9,
      topUsers: [{ userId: 'u1', displayName: 'One', msgCount: 7 }],
      channelBreakdown: [{ channelId: 'c1', msgCount: 11 }],
    });

    expect(query).toHaveBeenCalledTimes(7);
    expect(query.mock.calls[0][0]).toContain('COALESCE(banned, FALSE)=FALSE');
    expect(query.mock.calls[0][1]).toEqual(['s1']);
    expect(query.mock.calls[3][1][0]).toBe('s1');
    expect(Number.isSafeInteger(query.mock.calls[3][1][1])).toBe(true);
    expect(query.mock.calls[5][0]).toContain('LIMIT 10');
    expect(query.mock.calls[6][0]).toContain('LIMIT 15');
  });

  it('uses zero defaults when aggregate count rows are unexpectedly absent', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const out = await Stats.getServerStats('s1');
    expect(out).toEqual({
      memberCount: 0, channelCount: 0, totalMessages: 0,
      activeUsers7d: 0, activeUsers30d: 0, topUsers: [], channelBreakdown: [],
    });
  });

  it('returns growth series as numbers and keeps both growth queries scoped to active members/server', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ day: '2026-08-01', newMembers: '3' }] })
      .mockResolvedValueOnce({ rows: [{ day: '2026-08-01', msgCount: '14' }] })
      .mockResolvedValueOnce({ rows: [{ count: '20' }] });

    await expect(Stats.getGrowthSeries('s1', 1234)).resolves.toEqual({
      joinSeries: [{ day: '2026-08-01', newMembers: 3 }],
      msgSeries: [{ day: '2026-08-01', msgCount: 14 }],
      totalMembers: 20,
    });
    expect(query.mock.calls[0][0]).toContain('COALESCE(banned, FALSE)=FALSE');
    expect(query.mock.calls[0][1]).toEqual(['s1', 1234]);
    expect(query.mock.calls[1][1]).toEqual(['s1', 1234]);
    expect(query.mock.calls[2][0]).toContain('COALESCE(banned, FALSE)=FALSE');
  });

  it('normalizes hourly and day-of-week activity distribution', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ hour: '7', msgCount: '8' }, { hour: '23', msgCount: '2' }] })
      .mockResolvedValueOnce({ rows: [{ dow: '1', msgCount: '6' }] });

    await expect(Stats.getActivityDistribution('s1', 5678)).resolves.toEqual({
      hours: [{ hour: 7, msgCount: 8 }, { hour: 23, msgCount: 2 }],
      dows: [{ dow: 1, msgCount: 6 }],
    });
    expect(query.mock.calls[0][1]).toEqual(['s1', 5678]);
    expect(query.mock.calls[1][1]).toEqual(['s1', 5678]);
  });

  it('returns retention counts and excludes banned rows from the membership denominator', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({ rows: [{ count: '7' }] })
      .mockResolvedValueOnce({ rows: [{ count: '13' }] })
      .mockResolvedValueOnce({ rows: [{ count: '21' }] });

    await expect(Stats.getRetention('s1')).resolves.toEqual({ dau: 2, wau: 7, mau: 13, memberTotal: 21 });
    expect(query.mock.calls[3][0]).toContain('COALESCE(banned, FALSE)=FALSE');
    for (const idx of [0, 1, 2]) {
      expect(query.mock.calls[idx][1][0]).toBe('s1');
      expect(Number.isSafeInteger(query.mock.calls[idx][1][1])).toBe(true);
    }
  });

  it('returns CSV rows without mutating database string values and excludes banned joins', async () => {
    const joinRows = [{ day: '2026-08-01', newMembers: '2' }];
    const msgRows = [{ day: '2026-08-01', msgCount: '9' }];
    const topUsers = [{ displayName: 'Alice', msgCount: '5' }];
    const chanBreakdown = [{ channelId: 'c1', msgCount: '9' }];
    query
      .mockResolvedValueOnce({ rows: joinRows })
      .mockResolvedValueOnce({ rows: msgRows })
      .mockResolvedValueOnce({ rows: topUsers })
      .mockResolvedValueOnce({ rows: chanBreakdown });

    await expect(Stats.getCsvData('s1', 999)).resolves.toEqual({ joinRows, msgRows, topUsers, chanBreakdown });
    expect(query.mock.calls[0][0]).toContain('COALESCE(banned, FALSE)=FALSE');
    expect(query.mock.calls[2][0]).toContain('LIMIT 20');
    expect(query.mock.calls[3][0]).toContain('LIMIT 20');
  });

  it('propagates PostgreSQL failures rather than returning fabricated analytics', async () => {
    query.mockRejectedValueOnce(new Error('postgres unavailable'));
    await expect(Stats.getServerStats('s1')).rejects.toThrow('postgres unavailable');
  });
});
