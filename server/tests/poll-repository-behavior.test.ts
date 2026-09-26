const mockDb: any = { polls: {} };
jest.mock('../db/loader', () => mockDb);

import Polls from '../db/repositories/PollRepository';

function pollStore() {
  return {
    findOne: jest.fn(), find: jest.fn(), insert: jest.fn(), update: jest.fn(), remove: jest.fn(),
  };
}

function resetDb() {
  mockDb.polls = pollStore();
  delete mockDb._pool;
}

function basePoll(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'p1', channelId: 'c1', serverId: 's1', createdBy: 'u1', question: 'Q',
    // `votes` ACIKCA `string[]`tir; bos dizi edebisi `never[]` cikariyor ve
    // `votes.push('u2')` reddediliyordu.
    options: [
      { id: '0', text: 'A', votes: [] as string[] },
      { id: '1', text: 'B', votes: [] as string[] },
    ],
    multiSelect: false, allowVoteChange: true, expiresAt: null, closed: false,
    ...overrides,
  };
}

function withPool(handler: (sql: string, params?: unknown[]) => any) {
  const client = {
    query: jest.fn(async (sql: string, params?: unknown[]) => handler(sql, params)),
    release: jest.fn(),
  };
  mockDb._pool = { connect: jest.fn(async () => client) };
  return client;
}

async function productionCall<T>(fn: () => Promise<T>): Promise<T> {
  const old = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { return await fn(); } finally { process.env.NODE_ENV = old; }
}

describe('PollRepository durable mutation contracts', () => {
  beforeEach(() => { jest.clearAllMocks(); resetDb(); });

  it('basic CRUD owns poll identity and rejects unsupported updates', async () => {
    mockDb.polls.findOne.mockResolvedValue({ _id: 'p1' });
    await expect(Polls.findById('p1')).resolves.toEqual({ _id: 'p1' });
    expect(mockDb.polls.findOne).toHaveBeenCalledWith({ _id: 'p1' });

    mockDb.polls.find.mockResolvedValue(undefined);
    await expect(Polls.findByChannel('c1')).resolves.toEqual([]);

    mockDb.polls.insert.mockImplementation(async (row: any) => row);
    const inserted: any = await Polls.insert({ _id: 'caller', createdAt: 1, channelId: 'c1', question: 'Q' });
    expect(inserted._id).not.toBe('caller');
    expect(inserted.createdAt).not.toBe(1);

    await expect(Polls.update('p1', { serverId: 'other' })).rejects.toThrow(/Unsupported poll update field/);
    await expect(Polls.update('p1', {})).resolves.toBeNull();
    mockDb.polls.update.mockResolvedValue({ _id: 'p1' });
    await Polls.update('p1', { question: 'New', closed: true });
    expect(mockDb.polls.update).toHaveBeenCalledWith({ _id: 'p1' }, { $set: { question: 'New', closed: true } });
    await Polls.delete('p1');
    expect(mockDb.polls.remove).toHaveBeenCalledWith({ _id: 'p1' });
  });

  it('rejects malformed vote commands before acquiring a PostgreSQL connection', async () => {
    const connect = jest.fn(); mockDb._pool = { connect };
    await expect(productionCall(() => Polls.mutateVoteAtomic('p1', 'u1', ['0'], 'bad' as any))).rejects.toThrow(/mode/);
    for (const ids of [[], [''], ['0', '0'], Array.from({ length: 11 }, (_, i) => String(i))]) {
      const out = await productionCall(() => Polls.mutateVoteAtomic('p1', 'u1', ids, 'toggle'));
      expect(out).toEqual({ status: 'invalid_option' });
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', undefined],
    ['closed', basePoll({ closed: true })],
    ['expired', basePoll({ expiresAt: Date.now() - 1000 })],
    ['expired', basePoll({ expiresAt: 'broken' })],
    ['expired', basePoll({ expiresAt: String(Date.now()) })],
  ])('vote returns %s and rolls back without writes', async (status, row) => {
    const client = withPool((sql) => sql.includes('SELECT * FROM polls') ? { rows: row ? [row] : [] } : { rows: [] });
    await expect(productionCall(() => Polls.mutateVoteAtomic('p1', 'u1', ['0'], 'toggle'))).resolves.toMatchObject({ status });
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query.mock.calls.some((c) => String(c[0]).includes('UPDATE polls'))).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rejects single-choice overflow and unknown options under the row lock', async () => {
    let row = basePoll();
    const client = withPool((sql) => sql.includes('SELECT * FROM polls') ? { rows: [row] } : { rows: [] });
    await expect(productionCall(() => Polls.mutateVoteAtomic('p1', 'u1', ['0', '1'], 'toggle'))).resolves.toEqual({ status: 'single_choice' });
    row = basePoll({ multiSelect: true });
    await expect(productionCall(() => Polls.mutateVoteAtomic('p1', 'u1', ['missing'], 'toggle'))).resolves.toEqual({ status: 'invalid_option' });
    expect(client.query.mock.calls.filter((c) => c[0] === 'ROLLBACK')).toHaveLength(2);
  });

  it('preserves immutable votes and accepts exact idempotent retry when vote changes are disabled', async () => {
    const poll = basePoll({ allowVoteChange: false, options: [
      { id: '0', text: 'A', votes: ['u1'] }, { id: '1', text: 'B', votes: [] },
    ]});
    const client = withPool((sql) => sql.includes('SELECT * FROM polls') ? { rows: [poll] } : { rows: [] });
    const replay = await productionCall(() => Polls.mutateVoteAtomic('p1', 'u1', ['0'], 'toggle'));
    expect(replay).toMatchObject({ status: 'ok' });
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.query.mock.calls.some((c) => String(c[0]).includes('UPDATE polls'))).toBe(false);

    const denied = await productionCall(() => Polls.mutateVoteAtomic('p1', 'u1', ['1'], 'toggle'));
    expect(denied).toEqual({ status: 'vote_change_forbidden' });
    const remove = await productionCall(() => Polls.mutateVoteAtomic('p1', 'u2', [], 'remove'));
    expect(remove).toEqual({ status: 'vote_change_forbidden' });
  });

  it('toggles single-choice votes atomically and normalizes returned JSONB options', async () => {
    const poll = basePoll();
    let updateParams: unknown[] | undefined;
    const client = withPool((sql, params) => {
      if (sql.includes('SELECT * FROM polls')) return { rows: [poll] };
      if (sql.includes('UPDATE polls')) {
        updateParams = params;
        return { rows: [{ ...poll, options: JSON.parse(String(params?.[1])) }] };
      }
      return { rows: [] };
    });
    const out: any = await productionCall(() => Polls.mutateVoteAtomic('p1', 'u1', ['1'], 'toggle'));
    expect(out.status).toBe('ok');
    expect(out.poll.options[1].votes).toEqual(['u1']);
    expect(JSON.parse(String(updateParams?.[1]))[1].votes).toEqual(['u1']);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('toggles multiple choices and removes only the acting user votes', async () => {
    let poll = basePoll({ multiSelect: true });
    const client = withPool((sql, params) => {
      if (sql.includes('SELECT * FROM polls')) return { rows: [poll] };
      if (sql.includes('UPDATE polls')) {
        const options = JSON.parse(String(params?.[1]));
        poll = { ...poll, options };
        return { rows: [poll] };
      }
      return { rows: [] };
    });
    const toggled: any = await productionCall(() => Polls.mutateVoteAtomic('p1', 'u1', ['0', '1'], 'toggle'));
    expect(toggled.poll.options.every((o: any) => o.votes.includes('u1'))).toBe(true);
    poll.options[0].votes.push('u2');
    const removed: any = await productionCall(() => Polls.mutateVoteAtomic('p1', 'u1', [], 'remove'));
    expect(removed.poll.options.every((o: any) => !o.votes.includes('u1'))).toBe(true);
    expect(removed.poll.options[0].votes).toContain('u2');
    expect(client.release).toHaveBeenCalledTimes(2);
  });

  it('rolls back vote mutations on PostgreSQL errors and preserves the original error', async () => {
    const original = new Error('write failed');
    const client = withPool((sql) => {
      if (sql.includes('SELECT * FROM polls')) return { rows: [basePoll()] };
      if (sql.includes('UPDATE polls')) throw original;
      if (sql === 'ROLLBACK') throw new Error('rollback failed too');
      return { rows: [] };
    });
    await expect(productionCall(() => Polls.mutateVoteAtomic('p1', 'u1', ['0'], 'toggle'))).rejects.toBe(original);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not_found', undefined],
    ['closed', basePoll({ closed: true })],
    ['expired', basePoll({ expiresAt: Date.now() - 1 })],
    ['expired', basePoll({ expiresAt: -1 })],
    ['has_votes', basePoll({ options: [{ id: '0', text: 'A', votes: ['u2'] }] })],
  ])('editable mutation returns %s without partial writes', async (status, row) => {
    const client = withPool((sql) => sql.includes('SELECT * FROM polls') ? { rows: row ? [row] : [] } : { rows: [] });
    await expect(productionCall(() => Polls.updateEditableAtomic('p1', { options: [] }, true))).resolves.toMatchObject({ status });
    expect(client.query.mock.calls.some((c) => String(c[0]).startsWith('UPDATE polls'))).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('editable mutation commits no-op, validates fields, and writes canonical JSONB updates', async () => {
    const poll = basePoll();
    const client = withPool((sql, params) => {
      if (sql.includes('SELECT * FROM polls')) return { rows: [poll] };
      if (sql.startsWith('UPDATE polls')) return { rows: [{ ...poll, question: 'New', options: JSON.parse(String(params?.[2])) }] };
      return { rows: [] };
    });
    await expect(productionCall(() => Polls.updateEditableAtomic('p1', {}, false))).resolves.toMatchObject({ status: 'ok' });
    await expect(productionCall(() => Polls.updateEditableAtomic('p1', { serverId: 'other' }, false))).rejects.toThrow(/Unsupported poll edit field/);
    const out: any = await productionCall(() => Polls.updateEditableAtomic('p1', {
      question: 'New', options: [{ id: '0', text: 'X', votes: [] }], allowVoteChange: false,
    }, true));
    expect(out.status).toBe('ok');
    const updateCall = client.query.mock.calls.find((c) => String(c[0]).startsWith('UPDATE polls'));
    expect(updateCall?.[0]).toContain('"options" = $3::jsonb');
  });

  it('editable mutation rolls back and releases on database failure', async () => {
    const original = new Error('edit write failed');
    const client = withPool((sql) => {
      if (sql.includes('SELECT * FROM polls')) return { rows: [basePoll()] };
      if (sql.startsWith('UPDATE polls')) throw original;
      return { rows: [] };
    });
    await expect(productionCall(() => Polls.updateEditableAtomic('p1', { question: 'New' }, false))).rejects.toBe(original);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
