// server/db/repositories/BotMarketplaceRepository.ts
// Sprint 98 — bot-marketplace route pool.query() çağrıları repository katmanına taşındı.

import * as poolModule from '../postgres/pool';

function getPoolLike(): { query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number }> } {
  const mod = poolModule as unknown as {
    pool?: { query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number }> };
    default?: { query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number }> };
    getPool?: () => { query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number }> };
  };
  const candidate = mod.pool ?? mod.getPool?.() ?? mod.default;
  if (!candidate) throw new Error('PostgreSQL pool is not available');
  return candidate;
}

export interface MarketplaceBotRow {
  id:              string;
  name:            string;
  author:          string;
  authorVerified:  boolean;
  avatar:          string;
  category:        string;
  tags:            string[];
  description:     string;
  longDescription: string;
  verified:        boolean;
  featured:        boolean;
  installs:        number;
  rating:          number | string;
  ratingCount:     number;
  commands:        string[];
  permissions:     string[];
  changelog:       string;
  supportUrl:      string;
  sourceUrl:       string;
  approved:        boolean;
  submittedBy:     string | null;
  createdAt:       number;
  updatedAt:       number;
}

class BotMarketplaceRepository {
  async getCategories(): Promise<string[]> {
    const res = await getPoolLike().query<{ category: string }>(
      `SELECT DISTINCT category FROM bot_marketplace WHERE approved = TRUE ORDER BY category`
    );
    return res.rows.map((r) => r.category);
  }

  async listBots(opts: {
    category?: string;
    search?:   string;
    featured?: boolean;
    sort?:     string;
    limit:     number;
    offset:    number;
  }): Promise<{ rows: MarketplaceBotRow[]; total: number }> {
    const conditions: string[] = ['approved = TRUE'];
    const params: unknown[] = [];

    if (opts.category) {
      params.push(opts.category);
      conditions.push(`category = $${params.length}`);
    }
    if (opts.search) {
      params.push(`%${opts.search.toLowerCase()}%`);
      conditions.push(`(LOWER(name) LIKE $${params.length} OR LOWER(description) LIKE $${params.length})`);
    }
    if (opts.featured) {
      conditions.push('featured = TRUE');
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const sortMap: Record<string, string> = {
      installs: 'installs DESC',
      rating:   'rating DESC',
      newest:   '"createdAt" DESC',
    };
    const orderBy = sortMap[opts.sort ?? ''] ?? 'featured DESC, installs DESC';

    const countRes = await getPoolLike().query<{ count: string }>(
      `SELECT COUNT(*) FROM bot_marketplace ${where}`,
      params
    );
    const countRow = countRes.rows[0] as { count?: string; total?: string | number } | undefined;
    const total = parseInt(String(countRow?.count ?? countRow?.total ?? '0'), 10);

    params.push(opts.limit, opts.offset);
    const dataRes = await getPoolLike().query<MarketplaceBotRow>(
      `SELECT * FROM bot_marketplace ${where} ORDER BY ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return { rows: dataRes.rows, total };
  }

  async findById(botId: string): Promise<MarketplaceBotRow | null> {
    const res = await getPoolLike().query<MarketplaceBotRow>(
      `SELECT * FROM bot_marketplace WHERE id = $1`,
      [botId]
    );
    return res.rows[0] ?? null;
  }

  async submit(data: Omit<MarketplaceBotRow, 'rating' | 'ratingCount' | 'installs' | 'verified' | 'featured' | 'approved'>): Promise<MarketplaceBotRow | null> {
    const res = await getPoolLike().query<MarketplaceBotRow>(
      `INSERT INTO bot_marketplace
         (id, name, author, "authorVerified", avatar, category, tags, description,
          "longDescription", verified, featured, installs, rating, "ratingCount",
          commands, permissions, changelog, "supportUrl", "sourceUrl", approved,
          "submittedBy", "createdAt", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE,FALSE,0,0,0,$10,$11,$12,$13,$14,FALSE,$15,$16,$16)
       RETURNING *`,
      [
        data.id, data.name, data.author, data.authorVerified, data.avatar, data.category,
        JSON.stringify(data.tags), data.description, data.longDescription,
        JSON.stringify(data.commands), JSON.stringify(data.permissions),
        data.changelog, data.supportUrl, data.sourceUrl, data.submittedBy, data.createdAt,
      ]
    );
    return res.rows[0] ?? null;
  }

  async update(botId: string, fields: Partial<MarketplaceBotRow>): Promise<MarketplaceBotRow | null> {
    const ALLOWED = ['name','author','authorVerified','avatar','category','tags','description',
      'longDescription','verified','featured','commands','permissions','changelog',
      'supportUrl','sourceUrl','approved'];

    const sets: string[] = [];
    const vals: unknown[] = [];

    for (const key of ALLOWED) {
      if (key in fields) {
        sets.push(`"${key}" = $${vals.length + 1}`);
        const val = (fields as Record<string, unknown>)[key];
        vals.push(Array.isArray(val) ? JSON.stringify(val) : val);
      }
    }
    if (!sets.length) return null;

    sets.push(`"updatedAt" = $${vals.length + 1}`);
    vals.push(Date.now(), botId);

    const res = await getPoolLike().query<MarketplaceBotRow>(
      `UPDATE bot_marketplace SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    return res.rows[0] ?? null;
  }

  async deleteBot(botId: string): Promise<void> {
    await getPoolLike().query(`DELETE FROM bot_marketplace WHERE id = $1`, [botId]);
  }

  async incrementInstalls(botId: string): Promise<void> {
    await getPoolLike().query(`UPDATE bot_marketplace SET installs = installs + 1 WHERE id = $1`, [botId]);
  }

  async count(): Promise<number> {
    const res = await getPoolLike().query<{ c: string }>(`SELECT COUNT(*) AS c FROM bot_marketplace`);
    return parseInt(res.rows[0]?.c ?? '0', 10);
  }

  async addReview(opts: {
    id:         string;
    botId:      string;
    reviewerId: string;
    action:     'approve' | 'reject';
    note:       string;
    createdAt:  number;
  }): Promise<void> {
    await getPoolLike().query(
      `INSERT INTO bot_marketplace_reviews (_id, "botId", "reviewerId", action, note, "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [opts.id, opts.botId, opts.reviewerId, opts.action, opts.note, opts.createdAt]
    );
  }
}

export const BotMarketplace = new BotMarketplaceRepository();
