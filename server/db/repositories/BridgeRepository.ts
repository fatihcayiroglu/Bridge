// Channel bridges (cross-server forwarding)

import db from '../loader';
import { postgresPoolOrTestFallback } from './postgresInvariant';

class BridgeRepository {
  private createPairTail: Promise<void> = Promise.resolve();
  async findOne(query: Record<string, unknown>) {
    return db.channelBridges.findOne(query);
  }

  async find(query: Record<string, unknown>) {
    return db.channelBridges.find(query) ?? [];
  }

  async insert(doc: Record<string, unknown>) {
    return db.channelBridges.insert(doc);
  }

  async createOrReactivateAtomic(data: {
    id: string;
    sourceChannelId: string;
    targetChannelId: string;
    sourceServerId: string;
    targetServerId: string;
    label: string;
    createdBy: string;
    createdAt: number;
  }): Promise<{ status: 'created' | 'reactivated'; bridge: Record<string, unknown> } | { status: 'exists' }> {
    for (const [field, value] of Object.entries(data)) {
      if (field === 'createdAt') continue;
      if (typeof value !== 'string' || (!value.trim() && field !== 'label')) throw new TypeError(`${field} is invalid`);
    }
    if (!Number.isSafeInteger(data.createdAt) || data.createdAt <= 0) throw new RangeError('createdAt must be positive');

    const rawPool = (db as unknown as { _pool?: import('pg').Pool })._pool;
    const pool = postgresPoolOrTestFallback(rawPool?.connect ? rawPool : null, 'BridgeRepository createOrReactivateAtomic');
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const pairKey = `bridge:${data.sourceChannelId}:${data.targetChannelId}`;
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [pairKey]);
        const existing = await client.query<Record<string, unknown>>(
          `SELECT * FROM channel_bridges
            WHERE "sourceChannelId"=$1 AND "targetChannelId"=$2
            FOR UPDATE`,
          [data.sourceChannelId, data.targetChannelId],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].active === true) {
            await client.query('ROLLBACK');
            return { status: 'exists' };
          }
          const updated = await client.query<Record<string, unknown>>(
            `UPDATE channel_bridges
                SET "sourceServerId"=$3, "targetServerId"=$4, label=$5,
                    "createdBy"=$6, "createdAt"=$7, active=TRUE
              WHERE "sourceChannelId"=$1 AND "targetChannelId"=$2
              RETURNING *`,
            [data.sourceChannelId, data.targetChannelId, data.sourceServerId, data.targetServerId, data.label, data.createdBy, data.createdAt],
          );
          const bridge = updated.rows[0];
          if (!bridge) throw new Error('Bridge reactivation returned no row');
          await client.query('COMMIT');
          return { status: 'reactivated', bridge };
        }

        const inserted = await client.query<Record<string, unknown>>(
          `INSERT INTO channel_bridges
             (_id, "sourceChannelId", "targetChannelId", "sourceServerId", "targetServerId", label, "createdBy", "createdAt", active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)
           RETURNING *`,
          [data.id, data.sourceChannelId, data.targetChannelId, data.sourceServerId, data.targetServerId, data.label, data.createdBy, data.createdAt],
        );
        const bridge = inserted.rows[0];
        if (!bridge) throw new Error('Bridge insert returned no row');
        await client.query('COMMIT');
        return { status: 'created', bridge };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }

    const previous = this.createPairTail;
    let release!: () => void;
    this.createPairTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const existing = await db.channelBridges.findOne({
        sourceChannelId: data.sourceChannelId,
        targetChannelId: data.targetChannelId,
      });
      if (existing) {
        if ((existing as { active?: unknown }).active === true) return { status: 'exists' };
        await db.channelBridges.update(
          { _id: existing._id },
          { $set: {
            sourceServerId: data.sourceServerId,
            targetServerId: data.targetServerId,
            label: data.label,
            createdBy: data.createdBy,
            createdAt: data.createdAt,
            active: true,
          } },
        );
        const bridge = await db.channelBridges.findOne({ _id: existing._id });
        if (!bridge) throw new Error('Bridge reactivation could not be loaded');
        return { status: 'reactivated', bridge: bridge as unknown as Record<string, unknown> };
      }
      const bridge = await db.channelBridges.insert({
        _id: data.id,
        sourceChannelId: data.sourceChannelId,
        targetChannelId: data.targetChannelId,
        sourceServerId: data.sourceServerId,
        targetServerId: data.targetServerId,
        label: data.label,
        createdBy: data.createdBy,
        createdAt: data.createdAt,
        active: true,
      });
      return { status: 'created', bridge: bridge as unknown as Record<string, unknown> };
    } finally {
      release();
    }
  }

  async update(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    return db.channelBridges.update(filter, modifier);
  }

  async findActiveFromSourceChannel(channelId: string) {
    return db.channelBridges.find({ sourceChannelId: channelId, active: true }) ?? [];
  }
}

export default new BridgeRepository();
