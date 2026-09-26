// server/db/repositories/PollRepository.ts
// Anket sorgularını tek noktada toplar.

import { v4 as uuidv4 } from 'uuid';
import db from '../loader';
import { parsePersistedEpochMillis } from '../../lib/persistedEpoch';
import { postgresPoolOrTestFallback } from './postgresInvariant';

type PollOption = { id: string; text: string; votes: string[] };
type PollRow = {
  _id: string;
  channelId: string;
  serverId: string;
  createdBy: string;
  question: string;
  options: PollOption[];
  multiSelect?: boolean;
  allowVoteChange?: boolean;
  expiresAt?: number | string | null;
  closed?: boolean;
  [key: string]: unknown;
};

export type PollMutationResult =
  | { status: 'ok'; poll: PollRow }
  | { status: 'not_found' | 'closed' | 'expired' | 'single_choice' | 'invalid_option' | 'vote_change_forbidden' | 'has_votes' };

function normalizeOptions(value: unknown): PollOption[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const opt = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      id: String(opt.id ?? ''),
      text: String(opt.text ?? ''),
      votes: Array.isArray(opt.votes) ? opt.votes.map(String) : [],
    };
  });
}

class PollRepository {
  async findById(id: string) {
    return db.polls.findOne({ _id: id });
  }

  async findByChannel(channelId: string) {
    return await db.polls.find({ channelId }) ?? [];
  }

  async insert(data: Record<string, unknown>) {
    const fields = { ...data };
    delete fields._id;
    delete fields.createdAt;
    return db.polls.insert({ ...fields, _id: uuidv4(), createdAt: Date.now() });
  }

  async update(id: string, fields: Record<string, unknown>) {
    const allowed = new Set(['question', 'options', 'multiSelect', 'allowVoteChange', 'expiresAt', 'closed']);
    const entries = Object.entries(fields);
    if (entries.some(([key]) => !allowed.has(key))) throw new Error('Unsupported poll update field');
    if (!entries.length) return null;
    return db.polls.update({ _id: id }, { $set: Object.fromEntries(entries) });
  }

  async delete(id: string) {
    return db.polls.remove({ _id: id });
  }

  /**
   * Atomic PostgreSQL vote mutation. Unit-test/in-memory stores return null so
   * route tests can exercise the compatibility path without pretending to
   * model row locks. Real PostgreSQL locks the poll row before any read/modify
   * write, closing the concurrent lost-update window.
   */
  async mutateVoteAtomic(
    id: string,
    userId: string,
    optionIds: string[],
    mode: 'toggle' | 'remove',
  ): Promise<PollMutationResult | null> {
    if (mode !== 'toggle' && mode !== 'remove') throw new RangeError('invalid poll mutation mode');
    if (!Array.isArray(optionIds) || optionIds.length > 10 || optionIds.some((id) => typeof id !== 'string' || !id.trim())) {
      return { status: 'invalid_option' };
    }
    if (new Set(optionIds).size !== optionIds.length) return { status: 'invalid_option' };
    if (mode === 'remove' && optionIds.length) return { status: 'invalid_option' };
    if (mode === 'toggle' && !optionIds.length) return { status: 'invalid_option' };
    if (process.env.NODE_ENV === 'test') return null;
    const pool = postgresPoolOrTestFallback(
      (db as unknown as { _pool?: import('pg').Pool })._pool,
      'atomic poll mutation',
    );
    if (!pool?.connect) throw new Error('PostgreSQL pool cannot connect for atomic poll mutation');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<PollRow>('SELECT * FROM polls WHERE _id = $1 FOR UPDATE', [id]);
      if (!found.rows.length) { await client.query('ROLLBACK'); return { status: 'not_found' }; }
      const poll = found.rows[0]!;
      poll.options = normalizeOptions(poll.options);
      if (poll.closed) { await client.query('ROLLBACK'); return { status: 'closed' }; }
      if (poll.expiresAt !== null && poll.expiresAt !== undefined) {
        let expiresAt: number | null;
        try { expiresAt = parsePersistedEpochMillis(poll.expiresAt); }
        catch { expiresAt = null; }
        if (expiresAt === null || expiresAt <= Date.now()) {
          await client.query('ROLLBACK'); return { status: 'expired' };
        }
      }

      const requested = optionIds;
      if (!poll.multiSelect && requested.length > 1) { await client.query('ROLLBACK'); return { status: 'single_choice' }; }
      if (requested.some((oid) => !poll.options.some((o) => o.id === oid))) {
        await client.query('ROLLBACK');
        return { status: 'invalid_option' };
      }

      const existing = poll.options.filter((o) => o.votes.includes(userId)).map((o) => o.id).sort();
      if (poll.allowVoteChange === false && existing.length) {
        const desired = [...requested].sort();
        const exactIdempotentReplay = mode === 'toggle'
          && desired.length === existing.length
          && desired.every((v, i) => v === existing[i]);
        if (!exactIdempotentReplay) {
          await client.query('ROLLBACK');
          return { status: 'vote_change_forbidden' };
        }
        await client.query('COMMIT');
        return { status: 'ok', poll };
      }
      if (mode === 'remove' && poll.allowVoteChange === false) {
        await client.query('ROLLBACK');
        return { status: 'vote_change_forbidden' };
      }

      if (mode === 'remove') {
        for (const opt of poll.options) opt.votes = opt.votes.filter((v) => v !== userId);
      } else if (poll.multiSelect) {
        for (const oid of requested) {
          const opt = poll.options.find((o) => o.id === oid)!;
          opt.votes = opt.votes.includes(userId)
            ? opt.votes.filter((v) => v !== userId)
            : [...opt.votes, userId];
        }
      } else {
        const selected = poll.options.find((o) => o.id === requested[0])!;
        const alreadySelected = selected.votes.includes(userId);
        for (const opt of poll.options) opt.votes = opt.votes.filter((v) => v !== userId);
        if (!alreadySelected) selected.votes.push(userId);
      }

      const updated = await client.query<PollRow>(
        'UPDATE polls SET options = $2::jsonb WHERE _id = $1 RETURNING *',
        [id, JSON.stringify(poll.options)],
      );
      await client.query('COMMIT');
      const out = updated.rows[0]!;
      out.options = normalizeOptions(out.options);
      return { status: 'ok', poll: out };
    } catch (err) {
      // Some PoolClient implementations/mocks can throw synchronously before
      // returning a Promise.  A chained `.catch()` does not protect that path,
      // and must never let a best-effort ROLLBACK replace the mutation failure.
      try { await client.query('ROLLBACK'); } catch { /* preserve err */ }
      throw err;
    } finally {
      client.release();
    }
  }

  /** Atomically edit a poll while protecting the "options only before votes" rule. */
  async updateEditableAtomic(
    id: string,
    fields: Record<string, unknown>,
    optionsChanging: boolean,
  ): Promise<PollMutationResult | null> {
    if (process.env.NODE_ENV === 'test') return null;
    const pool = postgresPoolOrTestFallback(
      (db as unknown as { _pool?: import('pg').Pool })._pool,
      'atomic poll edit',
    );
    if (!pool?.connect) throw new Error('PostgreSQL pool cannot connect for atomic poll edit');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<PollRow>('SELECT * FROM polls WHERE _id = $1 FOR UPDATE', [id]);
      if (!found.rows.length) { await client.query('ROLLBACK'); return { status: 'not_found' }; }
      const poll = found.rows[0]!;
      poll.options = normalizeOptions(poll.options);
      if (poll.closed) { await client.query('ROLLBACK'); return { status: 'closed' }; }
      if (poll.expiresAt !== null && poll.expiresAt !== undefined) {
        let expiresAt: number | null;
        try { expiresAt = parsePersistedEpochMillis(poll.expiresAt); }
        catch { expiresAt = null; }
        if (expiresAt === null || expiresAt <= Date.now()) {
          await client.query('ROLLBACK'); return { status: 'expired' };
        }
      }
      if (optionsChanging && poll.options.some((o) => o.votes.length > 0)) {
        await client.query('ROLLBACK');
        return { status: 'has_votes' };
      }

      const entries = Object.entries(fields);
      if (!entries.length) { await client.query('COMMIT'); return { status: 'ok', poll }; }
      const allowed = new Set(['question', 'options', 'expiresAt', 'allowVoteChange']);
      if (entries.some(([k]) => !allowed.has(k))) throw new Error('Unsupported poll edit field');
      const assignments: string[] = [];
      const params: unknown[] = [id];
      for (const [key, value] of entries) {
        params.push(key === 'options' ? JSON.stringify(value) : value);
        const cast = key === 'options' ? '::jsonb' : '';
        assignments.push(`"${key}" = $${params.length}${cast}`);
      }
      const updated = await client.query<PollRow>(
        `UPDATE polls SET ${assignments.join(', ')} WHERE _id = $1 RETURNING *`, params,
      );
      await client.query('COMMIT');
      const out = updated.rows[0]!;
      out.options = normalizeOptions(out.options);
      return { status: 'ok', poll: out };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* preserve err */ }
      throw err;
    } finally {
      client.release();
    }
  }
}

export default new PollRepository();
