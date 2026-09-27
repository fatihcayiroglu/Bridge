// server/db/repositories/BoostRepository.ts
// Sprint 98 — boosts route db.query() çağrıları repository katmanına taşındı.

import { pool } from '../postgres/pool';

export interface BoostInfoRow {
  boostCount: number;
  boostTier:  number;
}

export interface BoosterRow {
  userId:    string;
  boostedAt: number;
}

export interface LiveVanityServerRow {
  _id: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  iconUrl?: string | null;
  bannerUrl?: string | null;
  tags?: string | string[] | null;
  discoverable?: boolean | number | null;
}

class BoostRepository {
  async getServerBoostInfo(serverId: string): Promise<BoostInfoRow | null> {
    const now = Date.now();
    const res = await pool.query<BoostInfoRow>(
      `SELECT live."boostCount",
              CASE WHEN live."boostCount" >= 14 THEN 3
                   WHEN live."boostCount" >= 7  THEN 2
                   WHEN live."boostCount" >= 2  THEN 1
                   ELSE 0 END AS "boostTier"
         FROM servers s
         CROSS JOIN LATERAL (
           SELECT COUNT(*)::int AS "boostCount"
             FROM server_boosts b
            WHERE b."serverId"=s._id
              AND b.active=TRUE
              AND (b."expiresAt" IS NULL OR b."expiresAt" > $2)
              AND EXISTS (SELECT 1 FROM members bm
                           WHERE bm."serverId"=b."serverId" AND bm."userId"=b."userId"
                             AND COALESCE(bm.banned, FALSE)=FALSE)
         ) live
        WHERE s._id=$1`,
      [serverId, now]
    );
    return res.rows[0] ?? null;
  }

  async getBoosters(serverId: string): Promise<BoosterRow[]> {
    const res = await pool.query<BoosterRow>(
      `SELECT "userId", "boostedAt"
         FROM server_boosts
        WHERE "serverId"=$1 AND active=TRUE
          AND ("expiresAt" IS NULL OR "expiresAt" > $2)
          AND EXISTS (SELECT 1 FROM members bm
                       WHERE bm."serverId"=server_boosts."serverId" AND bm."userId"=server_boosts."userId"
                         AND COALESCE(bm.banned, FALSE)=FALSE)
        ORDER BY "boostedAt" DESC LIMIT 50`,
      [serverId, Date.now()]
    );
    return res.rows;
  }

  async getActiveBoost(serverId: string, userId: string): Promise<{ _id: string } | null> {
    const res = await pool.query<{ _id: string }>(
      `SELECT _id FROM server_boosts
        WHERE "serverId"=$1 AND "userId"=$2 AND active=TRUE
          AND ("expiresAt" IS NULL OR "expiresAt" > $3)
          AND EXISTS (SELECT 1 FROM members bm
                       WHERE bm."serverId"=server_boosts."serverId" AND bm."userId"=server_boosts."userId"
                         AND COALESCE(bm.banned, FALSE)=FALSE)`,
      [serverId, userId, Date.now()]
    );
    return res.rows[0] ?? null;
  }

  async addBoost(serverId: string, userId: string, expiresAt: number): Promise<boolean> {
    const now = Date.now();
    // Expired rows must not keep the partial unique index occupied forever.
    await pool.query(
      `UPDATE server_boosts SET active=FALSE
        WHERE "serverId"=$1 AND "userId"=$2 AND active=TRUE
          AND "expiresAt" IS NOT NULL AND "expiresAt" <= $3`,
      [serverId, userId, now]
    );
    const res = await pool.query<{ _id: string }>(
      `INSERT INTO server_boosts("serverId","userId","expiresAt",active)
       VALUES($1,$2,$3,TRUE)
       ON CONFLICT("userId","serverId") WHERE active=TRUE DO NOTHING
       RETURNING _id`,
      [serverId, userId, expiresAt]
    );
    return res.rowCount === 1;
  }

  async removeBoost(serverId: string, userId: string): Promise<void> {
    await pool.query(
      `UPDATE server_boosts SET active=FALSE WHERE "serverId"=$1 AND "userId"=$2`,
      [serverId, userId]
    );
  }

  async countActiveBoosts(serverId: string): Promise<number> {
    const res = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM server_boosts
        WHERE "serverId"=$1 AND active=TRUE
          AND ("expiresAt" IS NULL OR "expiresAt" > $2)
          AND EXISTS (SELECT 1 FROM members bm
                       WHERE bm."serverId"=server_boosts."serverId" AND bm."userId"=server_boosts."userId"
                         AND COALESCE(bm.banned, FALSE)=FALSE)`,
      [serverId, Date.now()]
    );
    return parseInt(res.rows[0]?.count ?? '0', 10);
  }

  async getHighestActiveTierForUser(userId: string): Promise<number> {
    const res = await pool.query<{ boostTier: number }>(
      `SELECT COALESCE(MAX(
                CASE WHEN live.c >= 14 THEN 3
                     WHEN live.c >= 7  THEN 2
                     WHEN live.c >= 2  THEN 1
                     ELSE 0 END
              ), 0)::int AS "boostTier"
         FROM members m
         JOIN servers s ON s._id=m."serverId"
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS c
             FROM server_boosts b
            WHERE b."serverId"=s._id
              AND b.active=TRUE
              AND (b."expiresAt" IS NULL OR b."expiresAt" > $2)
              AND EXISTS (SELECT 1 FROM members bm
                           WHERE bm."serverId"=b."serverId" AND bm."userId"=b."userId"
                             AND COALESCE(bm.banned, FALSE)=FALSE)
         ) live ON TRUE
        WHERE m."userId"=$1
          AND COALESCE(m.banned, FALSE)=FALSE`,
      [userId, Date.now()]
    );
    return res.rows[0]?.boostTier ?? 0;
  }

  async updateBoostStats(serverId: string, boostCount: number, boostTier: number): Promise<void> {
    await pool.query(
      `UPDATE servers SET "boostCount"=$1, "boostTier"=$2 WHERE _id=$3`,
      [boostCount, boostTier, serverId]
    );
  }

  async getServerOwnerAndTier(serverId: string): Promise<{ ownerId: string; boostTier: number } | null> {
    const res = await pool.query<{ ownerId: string; boostTier: number }>(
      `SELECT s."ownerId",
              CASE WHEN live.c >= 14 THEN 3
                   WHEN live.c >= 7  THEN 2
                   WHEN live.c >= 2  THEN 1
                   ELSE 0 END AS "boostTier"
         FROM servers s
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS c
             FROM server_boosts b
            WHERE b."serverId"=s._id
              AND b.active=TRUE
              AND (b."expiresAt" IS NULL OR b."expiresAt" > $2)
              AND EXISTS (SELECT 1 FROM members bm
                           WHERE bm."serverId"=b."serverId" AND bm."userId"=b."userId"
                             AND COALESCE(bm.banned, FALSE)=FALSE)
         ) live ON TRUE
        WHERE s._id=$1`,
      [serverId, Date.now()]
    );
    return res.rows[0] ?? null;
  }

  async getByVanityUrl(slug: string): Promise<{ _id: string; name: string; icon: string; description: string } | null> {
    const res = await pool.query<{ _id: string; name: string; icon: string; description: string }>(
      `SELECT s._id, s.name, s.icon, s.description
         FROM servers s
        WHERE LOWER(s."vanityUrl")=$1
          AND (SELECT COUNT(*)
                 FROM server_boosts b
                WHERE b."serverId"=s._id AND b.active=TRUE
                  AND (b."expiresAt" IS NULL OR b."expiresAt" > $2)
                  AND EXISTS (SELECT 1 FROM members bm
                               WHERE bm."serverId"=b."serverId" AND bm."userId"=b."userId"
                                 AND COALESCE(bm.banned, FALSE)=FALSE)) >= 14`,
      [slug, Date.now()]
    );
    return res.rows[0] ?? null;
  }

  async getLiveVanityServer(slug: string): Promise<LiveVanityServerRow | null> {
    const res = await pool.query<LiveVanityServerRow>(
      `SELECT s._id, s.name, s.description, s.icon, s."iconUrl", s."bannerUrl", s.tags, s.discoverable
         FROM servers s
        WHERE LOWER(s."vanityUrl")=$1
          AND (SELECT COUNT(*)
                 FROM server_boosts b
                WHERE b."serverId"=s._id AND b.active=TRUE
                  AND (b."expiresAt" IS NULL OR b."expiresAt" > $2)
                  AND EXISTS (SELECT 1 FROM members bm
                               WHERE bm."serverId"=b."serverId" AND bm."userId"=b."userId"
                                 AND COALESCE(bm.banned, FALSE)=FALSE)) >= 14`,
      [slug, Date.now()]
    );
    return res.rows[0] ?? null;
  }

  async mutateVanityAtomic(
    serverId: string,
    ownerId: string,
    slug: string | null,
  ): Promise<'ok' | 'not_found' | 'forbidden' | 'boost_required' | 'conflict'> {
    try {
      const res = await pool.query<{ _id: string }>(
        `UPDATE servers s
            SET "vanityUrl"=$3
          WHERE s._id=$1 AND s."ownerId"=$2
            AND ($3::text IS NULL OR (
              (SELECT COUNT(*) FROM server_boosts b
                WHERE b."serverId"=s._id AND b.active=TRUE
                  AND (b."expiresAt" IS NULL OR b."expiresAt" > $4)
                  AND EXISTS (SELECT 1 FROM members bm
                               WHERE bm."serverId"=b."serverId" AND bm."userId"=b."userId"
                                 AND COALESCE(bm.banned, FALSE)=FALSE)) >= 14
              AND NOT EXISTS (SELECT 1 FROM servers other
                               WHERE LOWER(other."vanityUrl")=LOWER($3) AND other._id<>s._id)
            ))
        RETURNING s._id`,
        [serverId, ownerId, slug, Date.now()]
      );
      if (res.rowCount === 1) return 'ok';
    } catch (error) {
      const code = String((error as { code?: unknown })?.code ?? '');
      if (code === '23505' || /unique/i.test(String((error as Error)?.message ?? ''))) return 'conflict';
      throw error;
    }

    const state = await this.getServerOwnerAndTier(serverId);
    if (!state) return 'not_found';
    if (state.ownerId !== ownerId) return 'forbidden';
    if (slug !== null && state.boostTier < 3) return 'boost_required';
    if (slug !== null && await this.checkVanityConflict(slug, serverId)) return 'conflict';
    // A concurrent entitlement/ownership change can make the UPDATE lose even
    // if the diagnostic reads have already moved again. Fail closed.
    return slug === null ? 'forbidden' : 'boost_required';
  }

  async checkVanityConflict(slug: string, excludeServerId: string): Promise<boolean> {
    const res = await pool.query<{ _id: string }>(
      `SELECT _id FROM servers WHERE LOWER("vanityUrl")=$1 AND _id!=$2`,
      [slug, excludeServerId]
    );
    return res.rows.length > 0;
  }

}

export const Boosts = new BoostRepository();
