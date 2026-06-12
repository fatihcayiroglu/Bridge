// server/db/repositories/OAuthRepository.ts
// Sprint 98 — spotify-oauth route db.query() çağrıları repository katmanına taşındı.

import { pool } from '../postgres/pool';

export interface OAuthTokenRow {
  accessToken:  string;
  refreshToken: string | null;
  expiresAt:    number;
}

class OAuthRepository {
  async upsertToken(
    userId:       string,
    platform:     string,
    accessToken:  string,
    refreshToken: string | null,
    expiresAt:    number,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO oauth_tokens ("userId", platform, "accessToken", "refreshToken", "expiresAt")
       VALUES($1, $2, $3, $4, $5)
       ON CONFLICT ("userId", platform) DO UPDATE
         SET "accessToken"  = EXCLUDED."accessToken",
             "refreshToken" = EXCLUDED."refreshToken",
             "expiresAt"    = EXCLUDED."expiresAt"`,
      [userId, platform, accessToken, refreshToken, expiresAt]
    );
  }

  async updateAccessToken(
    userId:      string,
    platform:    string,
    accessToken: string,
    expiresAt:   number,
  ): Promise<void> {
    await pool.query(
      `UPDATE oauth_tokens SET "accessToken"=$1, "expiresAt"=$2 WHERE "userId"=$3 AND platform=$4`,
      [accessToken, expiresAt, userId, platform]
    );
  }

  async getToken(userId: string, platform: string): Promise<OAuthTokenRow | null> {
    const res = await pool.query<OAuthTokenRow>(
      `SELECT "accessToken", "refreshToken", "expiresAt" FROM oauth_tokens WHERE "userId"=$1 AND platform=$2`,
      [userId, platform]
    );
    return res.rows[0] ?? null;
  }

  async deleteToken(userId: string, platform: string): Promise<void> {
    await pool.query(
      `DELETE FROM oauth_tokens WHERE "userId"=$1 AND platform=$2`,
      [userId, platform]
    );
  }

  async upsertConnection(userId: string, platform: string, username: string, url: string): Promise<void> {
    await pool.query(
      `INSERT INTO user_connections("userId", platform, username, url)
       VALUES($1, $2, $3, $4)
       ON CONFLICT("userId", platform) DO UPDATE SET username=$3, url=$4`,
      [userId, platform, username, url]
    );
  }
}

export const OAuth = new OAuthRepository();
