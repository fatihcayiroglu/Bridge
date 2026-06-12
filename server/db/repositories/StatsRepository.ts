// server/db/repositories/StatsRepository.ts
// Sprint 98 — stats route pool.query() çağrıları repository katmanına taşındı.

import { pool } from '../postgres/pool';

export interface ServerStatsRow {
  memberCount:    number;
  channelCount:   number;
  totalMessages:  number;
  activeUsers7d:  number;
  activeUsers30d: number;
}

export interface TopUserRow {
  userId:      string;
  displayName: string;
  msgCount:    number;
}

export interface ChannelBreakdownRow {
  channelId: string;
  msgCount:  number;
}

export interface GrowthSeriesRow {
  day:        string;
  newMembers: number;
}

export interface MsgSeriesRow {
  day:      string;
  msgCount: number;
}

export interface HourDistRow {
  hour:     number;
  msgCount: number;
}

export interface DowDistRow {
  dow:      number;
  msgCount: number;
}

export interface RetentionRow {
  dau: number;
  wau: number;
  mau: number;
}

class StatsRepository {
  async getServerStats(serverId: string): Promise<{
    memberCount: number;
    channelCount: number;
    totalMessages: number;
    activeUsers7d: number;
    activeUsers30d: number;
    topUsers: TopUserRow[];
    channelBreakdown: ChannelBreakdownRow[];
  }> {
    const now = Date.now();
    const d7  = now - 7  * 86400_000;
    const d30 = now - 30 * 86400_000;

    const [memberRow, channelRow, totalMsgRow, activeLast7Row, activeLast30Row, topUsersRes, channelBreakdownRes] =
      await Promise.all([
        pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM members WHERE "serverId"=$1`, [serverId]),
        pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM channels WHERE "serverId"=$1`, [serverId]),
        pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM messages WHERE "serverId"=$1`, [serverId]),
        pool.query<{ count: string }>(`SELECT COUNT(DISTINCT "userId") AS count FROM messages WHERE "serverId"=$1 AND "createdAt">$2`, [serverId, d7]),
        pool.query<{ count: string }>(`SELECT COUNT(DISTINCT "userId") AS count FROM messages WHERE "serverId"=$1 AND "createdAt">$2`, [serverId, d30]),
        pool.query<{ userId: string; displayName: string; msgCount: string }>(
          `SELECT "userId", MAX("displayName") AS "displayName", COUNT(*) AS "msgCount"
           FROM messages WHERE "serverId"=$1 AND "createdAt">$2
           GROUP BY "userId" ORDER BY "msgCount" DESC LIMIT 10`,
          [serverId, d30]
        ),
        pool.query<{ channelId: string; msgCount: string }>(
          `SELECT "channelId", COUNT(*) AS "msgCount"
           FROM messages WHERE "serverId"=$1 AND "createdAt">$2
           GROUP BY "channelId" ORDER BY "msgCount" DESC LIMIT 15`,
          [serverId, d30]
        ),
      ]);

    return {
      memberCount:      parseInt(memberRow.rows[0]?.count ?? '0', 10),
      channelCount:     parseInt(channelRow.rows[0]?.count ?? '0', 10),
      totalMessages:    parseInt(totalMsgRow.rows[0]?.count ?? '0', 10),
      activeUsers7d:    parseInt(activeLast7Row.rows[0]?.count ?? '0', 10),
      activeUsers30d:   parseInt(activeLast30Row.rows[0]?.count ?? '0', 10),
      topUsers:         topUsersRes.rows.map(r => ({ ...r, msgCount: parseInt(r.msgCount, 10) })),
      channelBreakdown: channelBreakdownRes.rows.map(r => ({ channelId: r.channelId, msgCount: parseInt(r.msgCount, 10) })),
    };
  }

  async getGrowthSeries(serverId: string, since: number): Promise<{ joinSeries: GrowthSeriesRow[]; msgSeries: MsgSeriesRow[]; totalMembers: number }> {
    const [joinRes, msgRes, totalRes] = await Promise.all([
      pool.query<{ day: string; newMembers: string }>(
        `SELECT TO_CHAR(TO_TIMESTAMP("joinedAt"/1000) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                COUNT(*) AS "newMembers"
         FROM members WHERE "serverId"=$1 AND "joinedAt">=$2
         GROUP BY day ORDER BY day ASC`,
        [serverId, since]
      ),
      pool.query<{ day: string; msgCount: string }>(
        `SELECT TO_CHAR(TO_TIMESTAMP("createdAt"/1000) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                COUNT(*) AS "msgCount"
         FROM messages WHERE "serverId"=$1 AND "createdAt">=$2
         GROUP BY day ORDER BY day ASC`,
        [serverId, since]
      ),
      pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM members WHERE "serverId"=$1`, [serverId]),
    ]);

    return {
      joinSeries:   joinRes.rows.map(r => ({ day: r.day, newMembers: parseInt(r.newMembers, 10) })),
      msgSeries:    msgRes.rows.map(r => ({ day: r.day, msgCount: parseInt(r.msgCount, 10) })),
      totalMembers: parseInt(totalRes.rows[0]?.count ?? '0', 10),
    };
  }

  async getActivityDistribution(serverId: string, since: number): Promise<{ hours: HourDistRow[]; dows: DowDistRow[] }> {
    const [hourRes, dowRes] = await Promise.all([
      pool.query<{ hour: string; msgCount: string }>(
        `SELECT EXTRACT(HOUR FROM TO_TIMESTAMP("createdAt"/1000) AT TIME ZONE 'UTC')::int AS hour,
                COUNT(*) AS "msgCount"
         FROM messages WHERE "serverId"=$1 AND "createdAt">=$2
         GROUP BY hour ORDER BY hour ASC`,
        [serverId, since]
      ),
      pool.query<{ dow: string; msgCount: string }>(
        `SELECT EXTRACT(DOW FROM TO_TIMESTAMP("createdAt"/1000) AT TIME ZONE 'UTC')::int AS dow,
                COUNT(*) AS "msgCount"
         FROM messages WHERE "serverId"=$1 AND "createdAt">=$2
         GROUP BY dow ORDER BY dow ASC`,
        [serverId, since]
      ),
    ]);

    return {
      hours: hourRes.rows.map(r => ({ hour: parseInt(r.hour, 10), msgCount: parseInt(r.msgCount, 10) })),
      dows:  dowRes.rows.map(r => ({ dow: parseInt(r.dow, 10),   msgCount: parseInt(r.msgCount, 10) })),
    };
  }

  async getRetention(serverId: string): Promise<RetentionRow & { memberTotal: number }> {
    const now = Date.now();
    const [dau, wau, mau, memberTotal] = await Promise.all([
      pool.query<{ count: string }>(`SELECT COUNT(DISTINCT "userId") AS count FROM messages WHERE "serverId"=$1 AND "createdAt">=$2`, [serverId, now - 86400_000]),
      pool.query<{ count: string }>(`SELECT COUNT(DISTINCT "userId") AS count FROM messages WHERE "serverId"=$1 AND "createdAt">=$2`, [serverId, now - 7 * 86400_000]),
      pool.query<{ count: string }>(`SELECT COUNT(DISTINCT "userId") AS count FROM messages WHERE "serverId"=$1 AND "createdAt">=$2`, [serverId, now - 30 * 86400_000]),
      pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM members WHERE "serverId"=$1`, [serverId]),
    ]);

    return {
      dau:         parseInt(dau.rows[0]?.count  ?? '0', 10),
      wau:         parseInt(wau.rows[0]?.count  ?? '0', 10),
      mau:         parseInt(mau.rows[0]?.count  ?? '0', 10),
      memberTotal: parseInt(memberTotal.rows[0]?.count ?? '0', 10),
    };
  }

  async getCsvData(serverId: string, since: number): Promise<{
    joinRows:       { day: string; newMembers: string }[];
    msgRows:        { day: string; msgCount: string }[];
    topUsers:       { displayName: string; msgCount: string }[];
    chanBreakdown:  { channelId: string; msgCount: string }[];
  }> {
    const [joinRes, msgRes, topRes, chanRes] = await Promise.all([
      pool.query<{ day: string; newMembers: string }>(
        `SELECT TO_CHAR(TO_TIMESTAMP("joinedAt"/1000) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                COUNT(*) AS "newMembers"
         FROM members WHERE "serverId"=$1 AND "joinedAt">=$2
         GROUP BY day ORDER BY day ASC`,
        [serverId, since]
      ),
      pool.query<{ day: string; msgCount: string }>(
        `SELECT TO_CHAR(TO_TIMESTAMP("createdAt"/1000) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                COUNT(*) AS "msgCount"
         FROM messages WHERE "serverId"=$1 AND "createdAt">=$2
         GROUP BY day ORDER BY day ASC`,
        [serverId, since]
      ),
      pool.query<{ displayName: string; msgCount: string }>(
        `SELECT MAX("displayName") AS "displayName", COUNT(*) AS "msgCount"
         FROM messages WHERE "serverId"=$1 AND "createdAt">=$2
         GROUP BY "userId" ORDER BY "msgCount" DESC LIMIT 20`,
        [serverId, since]
      ),
      pool.query<{ channelId: string; msgCount: string }>(
        `SELECT "channelId", COUNT(*) AS "msgCount"
         FROM messages WHERE "serverId"=$1 AND "createdAt">=$2
         GROUP BY "channelId" ORDER BY "msgCount" DESC LIMIT 20`,
        [serverId, since]
      ),
    ]);

    return {
      joinRows:      joinRes.rows,
      msgRows:       msgRes.rows,
      topUsers:      topRes.rows,
      chanBreakdown: chanRes.rows,
    };
  }
}

export const Stats = new StatsRepository();
