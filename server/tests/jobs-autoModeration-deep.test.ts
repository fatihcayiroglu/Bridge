process.env.NODE_ENV = 'test';

const repo = {
  Channels: { findWhere: jest.fn(), insert: jest.fn() },
  Servers: { findById: jest.fn() },
  Messages: { findWhere: jest.fn(), create: jest.fn() },
  Users: { findById: jest.fn() },
};
const dbState: { _pool?: unknown } = {};
const callAI = jest.fn();
const rulesMod = jest.fn();

jest.mock('../db/repositories', () => repo);
jest.mock('../db/loader', () => ({ __esModule: true, default: dbState }));
jest.mock('../lib/aiProvider', () => ({ AI_ENABLED: true, callAI }));
jest.mock('../lib/modRules', () => ({ rulesMod }));

import { runScan, startAutoModerationJob, stopAutoModerationJob } from '../jobs/autoModeration';

const flagged = (overrides: Record<string, unknown> = {}) => ({
  _id: 'm1', channelId: 'c1', serverId: 's1', userId: 'u1',
  content: 'bad', displayName: 'Display', username: 'user', type: 'normal',
  ...overrides,
});

function fallbackChannel(): void {
  repo.Channels.findWhere.mockResolvedValue([]);
  repo.Channels.insert.mockResolvedValue({ _id: 'mod1', serverId: 's1', name: 'mod-log' });
}

function baseFlagged(message = flagged()): void {
  repo.Messages.findWhere
    .mockResolvedValueOnce([message])
    .mockResolvedValueOnce([]);
  repo.Servers.findById.mockResolvedValue({ _id: 's1', autoModerate: true });
  repo.Users.findById.mockResolvedValue({ _id: 'u1', displayName: 'Resolved User', username: 'resolved' });
  repo.Messages.create.mockImplementation(async (d) => ({ ...d }));
  rulesMod.mockReturnValue({ safe: false, score: 75, reason: 'rules', categories: { spam: true } });
  fallbackChannel();
}

beforeEach(() => {
  jest.clearAllMocks();
  delete dbState._pool;
  callAI.mockResolvedValue('{"safe":true,"score":1,"reason":"clean"}');
});

afterEach(() => {
  stopAutoModerationJob();
  jest.useRealTimers();
});

describe('AutoModeration production failure/AI/PG branches', () => {
  it('fails closed when recent-message query fails', async () => {
    repo.Messages.findWhere.mockRejectedValueOnce(new Error('db down'));
    await expect(runScan()).resolves.toBeUndefined();
    expect(repo.Servers.findById).not.toHaveBeenCalled();
  });

  it('isolates a server lookup failure and continues with another server', async () => {
    repo.Messages.findWhere
      .mockResolvedValueOnce([flagged({ serverId: 'bad' }), flagged({ _id: 'm2', serverId: 'good' })])
      .mockResolvedValueOnce([]);
    repo.Servers.findById
      .mockRejectedValueOnce(new Error('bad server row'))
      .mockResolvedValueOnce({ _id: 'good', autoModerate: true });
    repo.Users.findById.mockResolvedValue(null);
    repo.Messages.create.mockImplementation(async (d) => d);
    rulesMod.mockReturnValue({ safe: false, score: 80, reason: 'rules', categories: {} });
    fallbackChannel();

    await runScan();
    expect(repo.Messages.create).toHaveBeenCalledTimes(1);
  });

  it('fails closed when idempotency state cannot be read', async () => {
    repo.Messages.findWhere
      .mockResolvedValueOnce([flagged()])
      .mockRejectedValueOnce(new Error('lookup uncertain'));
    repo.Servers.findById.mockResolvedValue({ _id: 's1', autoModerate: true });
    await runScan();
    expect(rulesMod).not.toHaveBeenCalled();
    expect(repo.Messages.create).not.toHaveBeenCalled();
  });

  it('uses a stronger unsafe AI verdict and broadcasts the persisted alert', async () => {
    baseFlagged();
    callAI.mockResolvedValue('```json\n{"safe":false,"score":97,"reason":"ai toxic","categories":{"toxic":true}}\n```');
    const emit = jest.fn();
    const io = { to: jest.fn(() => ({ emit })) } as never;
    jest.useFakeTimers();
    startAutoModerationJob(io);

    await runScan();

    expect(callAI).toHaveBeenCalledTimes(1);
    const created = repo.Messages.create.mock.calls[0][0];
    expect(created.content).toContain('97/100');
    expect(created.content).toContain('Kaynak: [AI]');
    expect(created.content).toContain('Resolved User');
    expect(emit).toHaveBeenCalledWith('message:new', expect.objectContaining({ autoModAlert: true }));
  });

  it('falls back to rules when AI returns malformed JSON', async () => {
    baseFlagged();
    callAI.mockResolvedValue('not json');
    await runScan();
    expect(repo.Messages.create.mock.calls[0][0].content).toContain('Kaynak: Kural tabanlı');
  });

  it('prefers rules when AI is safe and lower-scored', async () => {
    baseFlagged();
    rulesMod.mockReturnValue({ safe: false, score: 92, reason: 'rules stronger', categories: {} });
    callAI.mockResolvedValue('{"safe":true,"score":20,"reason":"weak"}');
    await runScan();
    expect(repo.Messages.create.mock.calls[0][0].content).toContain('92/100');
    expect(repo.Messages.create.mock.calls[0][0].content).toContain('Kural tabanlı');
  });

  it('uses the PostgreSQL advisory-lock path and reuses an existing mod-log channel', async () => {
    baseFlagged();
    const queries: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('SELECT * FROM channels')) return { rows: [{ _id: 'pg-mod', serverId: 's1', name: 'mod-log' }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    dbState._pool = { connect: jest.fn(async () => client) };

    await runScan();

    expect(queries.some(q => q === 'BEGIN')).toBe(true);
    expect(queries.some(q => q.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(queries.some(q => q === 'COMMIT')).toBe(true);
    expect(queries.some(q => q.includes('INSERT INTO channels'))).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(repo.Messages.create).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'pg-mod' }));
  });

  it('atomically creates the PostgreSQL mod-log channel when absent', async () => {
    baseFlagged();
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT * FROM channels')) return { rows: [] };
        if (sql.includes('INSERT INTO channels')) return { rows: [{ _id: 'new-pg-mod', serverId: 's1', name: 'mod-log' }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    dbState._pool = { connect: jest.fn(async () => client) };

    await runScan();

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO channels'), expect.any(Array));
    expect(repo.Messages.create).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'new-pg-mod' }));
  });

  it('rolls back and skips alert creation when PostgreSQL channel creation returns no row', async () => {
    baseFlagged();
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT * FROM channels')) return { rows: [] };
        if (sql.includes('INSERT INTO channels')) return { rows: [] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    dbState._pool = { connect: jest.fn(async () => client) };

    await runScan();

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(repo.Messages.create).not.toHaveBeenCalled();
  });

  it('keeps the scan alive when author lookup and duplicate alert persistence fail', async () => {
    const a = flagged({ _id: 'm1' });
    const b = flagged({ _id: 'm2' });
    repo.Messages.findWhere
      .mockResolvedValueOnce([a, b])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    repo.Servers.findById.mockResolvedValue({ _id: 's1', autoModerate: true });
    repo.Users.findById.mockRejectedValue(new Error('users unavailable'));
    rulesMod.mockReturnValue({ safe: false, score: 80, reason: 'rules', categories: {} });
    fallbackChannel();
    repo.Messages.create
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }))
      .mockImplementationOnce(async d => d);

    await expect(runScan()).resolves.toBeUndefined();
    expect(repo.Messages.create).toHaveBeenCalledTimes(2);
    expect(repo.Messages.create.mock.calls[1][0].content).toContain('Display');
  });
});
