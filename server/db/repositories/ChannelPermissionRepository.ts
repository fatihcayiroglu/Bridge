// Kanal izin matrisi (rol bazlı channel_permissions)

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';
import { postgresPoolOrTestFallback } from './postgresInvariant';
import { parsePermissionPair } from '../../lib/permissionMaskInvariant';

type OverrideWrite = { roleId: string; allow: number; deny: number };

class ChannelPermissionRepository {
  private mutationSerial: Promise<void> = Promise.resolve();

  private async serializeFallback<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.mutationSerial;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.mutationSerial = prior.then(() => current);
    await prior;
    try { return await fn(); } finally { release(); }
  }

  private validateOverrides(overrides: OverrideWrite[]): void {
    if (!Array.isArray(overrides)) throw new TypeError('permission overrides must be an array');
    const seen = new Set<string>();
    for (const row of overrides) {
      if (!row || typeof row.roleId !== 'string' || !row.roleId.trim() || seen.has(row.roleId)) {
        throw new TypeError('invalid or duplicate channel permission override');
      }
      parsePermissionPair(row.allow, row.deny, 'channel permission override');
      seen.add(row.roleId);
    }
  }
  private store() {
    if (!db.channelPermissions) throw new Error('channelPermissions store unavailable');
    return db.channelPermissions;
  }

  async findByChannel(channelId: string) {
    return await this.store().find({ channelId }) ?? [];
  }

  async findOne(query: Record<string, unknown>) {
    return this.store().findOne(query);
  }

  async find(query: Record<string, unknown>) {
    return await this.store().find(query) ?? [];
  }

  async remove(query: Record<string, unknown>) {
    return this.store().remove(query);
  }

  async removeByChannel(channelId: string) {
    return this.store().remove({ channelId });
  }

  async insert(doc: Record<string, unknown>) {
    const store = this.store();
    const normalized = { ...doc };
    const pair = parsePermissionPair(normalized.allow ?? 0, normalized.deny ?? 0, 'channel permission override');
    normalized.allow = pair.allow;
    normalized.deny = pair.deny;
    if (normalized._id) return store.insert(normalized);
    return store.insert({ _id: uuidv4(), ...normalized });
  }

  async update(filter: Record<string, unknown>, modifier: Record<string, unknown>) {
    const store = this.store();
    const set = modifier?.$set;
    if (set && typeof set === 'object' && !Array.isArray(set) &&
        ('allow' in (set as Record<string, unknown>) || 'deny' in (set as Record<string, unknown>))) {
      const existing = await store.findOne(filter) as Record<string, unknown> | null;
      if (!existing) return store.update(filter, modifier);
      const mutableSet = { ...(set as Record<string, unknown>) };
      const pair = parsePermissionPair(
        mutableSet.allow ?? existing.allow ?? 0,
        mutableSet.deny ?? existing.deny ?? 0,
        'channel permission override',
      );
      mutableSet.allow = pair.allow;
      mutableSet.deny = pair.deny;
      return store.update(filter, { ...modifier, $set: mutableSet });
    }
    return store.update(filter, modifier);
  }

  async replaceManyChannelsAtomic(serverId: string, channelIds: string[], overrides: OverrideWrite[]): Promise<boolean> {
    if (!serverId || !Array.isArray(channelIds) || !channelIds.length ||
        channelIds.some((id) => typeof id !== 'string' || !id.trim()) || new Set(channelIds).size !== channelIds.length) {
      throw new TypeError('invalid channel permission replacement scope');
    }
    this.validateOverrides(overrides);
    const pool = postgresPoolOrTestFallback(
      (db as unknown as { _pool?: import('pg').Pool })._pool,
      'channel permission replacement',
    );
    if (!pool?.connect) {
      return this.serializeFallback(async () => {
        for (const channelId of channelIds) {
          await this.store().remove({ channelId });
          for (const row of overrides) {
            await this.store().insert({ _id: uuidv4(), channelId, serverId, roleId: row.roleId,
              allow: row.allow, deny: row.deny, createdAt: Date.now() });
          }
        }
        return true;
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{ _id: string }>(
        `SELECT _id FROM channels WHERE "serverId"=$1 AND _id=ANY($2::text[]) FOR UPDATE`, [serverId, channelIds]);
      const found = new Set(locked.rows.map((row) => String(row._id)));
      if (found.size !== channelIds.length || channelIds.some((id) => !found.has(id))) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('DELETE FROM channel_permissions WHERE "channelId"=ANY($1::text[])', [channelIds]);
      for (const channelId of channelIds) for (const row of overrides) {
        await client.query(
          `INSERT INTO channel_permissions (_id,"channelId","roleId","serverId",allow,deny,"createdAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [uuidv4(), channelId, row.roleId, serverId, row.allow, row.deny, Date.now()]);
      }
      await client.query('COMMIT');
      return true;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
      throw err;
    } finally { client.release(); }
  }

  async applyChannelBatchAtomic(serverId: string, channelId: string, upserts: OverrideWrite[], deletes: string[]): Promise<boolean> {
    if (!serverId || !channelId || !Array.isArray(deletes) ||
        deletes.some((id) => typeof id !== 'string' || !id.trim()) || new Set(deletes).size !== deletes.length) {
      throw new TypeError('invalid channel permission batch scope');
    }
    this.validateOverrides(upserts);
    const upsertIds = new Set(upserts.map((row) => row.roleId));
    if (deletes.some((id) => upsertIds.has(id))) throw new TypeError('channel permission role cannot be updated and deleted together');
    const pool = postgresPoolOrTestFallback(
      (db as unknown as { _pool?: import('pg').Pool })._pool,
      'channel permission mutation',
    );
    if (!pool?.connect) {
      return this.serializeFallback(async () => {
        for (const roleId of deletes) await this.store().remove({ channelId, roleId });
        for (const row of upserts) {
          const existing = await this.store().findOne({ channelId, roleId: row.roleId });
          if (existing) await this.store().update({ channelId, roleId: row.roleId }, { $set: { allow: row.allow, deny: row.deny, updatedAt: Date.now() } });
          else await this.store().insert({ _id: uuidv4(), channelId, roleId: row.roleId, serverId, allow: row.allow, deny: row.deny, createdAt: Date.now() });
        }
        return true;
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{ _id: string }>('SELECT _id FROM channels WHERE _id=$1 AND "serverId"=$2 FOR UPDATE', [channelId, serverId]);
      if (!locked.rows[0]) { await client.query('ROLLBACK'); return false; }
      if (deletes.length) await client.query('DELETE FROM channel_permissions WHERE "channelId"=$1 AND "roleId"=ANY($2::text[])', [channelId, deletes]);
      for (const row of upserts) {
        const now = Date.now();
        await client.query(
          `INSERT INTO channel_permissions (_id,"channelId","roleId","serverId",allow,deny,"createdAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT ("channelId","roleId") DO UPDATE SET allow=EXCLUDED.allow, deny=EXCLUDED.deny, "updatedAt"=$8`,
          [uuidv4(), channelId, row.roleId, serverId, row.allow, row.deny, now, now]);
      }
      await client.query('COMMIT');
      return true;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
      throw err;
    } finally { client.release(); }
  }
}

export default new ChannelPermissionRepository();
