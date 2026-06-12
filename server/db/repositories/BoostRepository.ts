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

class BoostRepository {
  async getServerBoostInfo(serverId: string): Promise<BoostInfoRow | null> {
    const res = await pool.query<BoostInfoRow>(
      `SELECT "boostCount", "boostTier" FROM servers WHERE _id=$1`,
      [serverId]
    );
    return res.rows[0] ?? null;
  }

  async getBoosters(serverId: string): Promise<BoosterRow[]> {
    const res = await pool.query<BoosterRow>(
      `SELECT "userId", "boostedAt" FROM server_boosts WHERE "serverId"=$1 AND active=TRUE ORDER BY "boostedAt" DESC LIMIT 50`,
      [serverId]
    );
    return res.rows;
  }

  async getActiveBoost(serverId: string, userId: string): Promise<{ _id: string } | null> {
    const res = await pool.query<{ _id: string }>(
      `SELECT _id FROM server_boosts WHERE "serverId"=$1 AND "userId"=$2 AND active=TRUE`,
      [serverId, userId]
    );
    return res.rows[0] ?? null;
  }

  async addBoost(serverId: string, userId: string, expiresAt: number): Promise<void> {
    await pool.query(
      `INSERT INTO server_boosts("serverId","userId","expiresAt",active)
       VALUES($1,$2,$3,TRUE)
       ON CONFLICT("userId","serverId") WHERE active=TRUE DO NOTHING`,
      [serverId, userId, expiresAt]
    );
  }

  async removeBoost(serverId: string, userId: string): Promise<void> {
    await pool.query(
      `UPDATE server_boosts SET active=FALSE WHERE "serverId"=$1 AND "userId"=$2`,
      [serverId, userId]
    );
  }

  async countActiveBoosts(serverId: string): Promise<number> {
    const res = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM server_boosts WHERE "serverId"=$1 AND active=TRUE`,
      [serverId]
    );
    return parseInt(res.rows[0]?.count ?? '0', 10);
  }

  async updateBoostStats(serverId: string, boostCount: number, boostTier: number): Promise<void> {
    await pool.query(
      `UPDATE servers SET "boostCount"=$1, "boostTier"=$2 WHERE _id=$3`,
      [boostCount, boostTier, serverId]
    );
  }

  async getServerOwnerAndTier(serverId: string): Promise<{ ownerId: string; boostTier: number } | null> {
    const res = await pool.query<{ ownerId: string; boostTier: number }>(
      `SELECT "ownerId", "boostTier" FROM servers WHERE _id=$1`,
      [serverId]
    );
    return res.rows[0] ?? null;
  }

  async getByVanityUrl(slug: string): Promise<{ _id: string; name: string; icon: string; description: string } | null> {
    const res = await pool.query<{ _id: string; name: string; icon: string; description: string }>(
      `SELECT _id, name, icon, description FROM servers WHERE LOWER("vanityUrl")=$1`,
      [slug]
    );
    return res.rows[0] ?? null;
  }

  async checkVanityConflict(slug: string, excludeServerId: string): Promise<boolean> {
    const res = await pool.query<{ _id: string }>(
      `SELECT _id FROM servers WHERE LOWER("vanityUrl")=$1 AND _id!=$2`,
      [slug, excludeServerId]
    );
    return res.rows.length > 0;
  }

  async setVanityUrl(serverId: string, slug: string | null): Promise<void> {
    await pool.query(`UPDATE servers SET "vanityUrl"=$1 WHERE _id=$2`, [slug, serverId]);
  }
}

export const Boosts = new BoostRepository();
