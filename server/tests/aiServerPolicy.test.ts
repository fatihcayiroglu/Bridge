// server/tests/aiServerPolicy.test.ts
//
// P6 — the per-server AI policy module on its own: storage forms of the flag,
// and the fail-closed paths (bad ids, unreadable rows) that the route-level
// suite (ai-server-optout.test.ts) does not reach.

const findById = jest.fn();
const findByIds = jest.fn();
const warn = jest.fn();

jest.mock('../db/repositories', () => ({ Servers: { findById: (...a: unknown[]) => findById(...a), findByIds: (...a: unknown[]) => findByIds(...a) } }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { warn: (...a: unknown[]) => warn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { rowAllowsAi, serverAllowsAi, serversAllowingAi } from '../lib/aiServerPolicy';

beforeEach(() => { findById.mockReset(); findByIds.mockReset(); warn.mockReset(); });

describe('rowAllowsAi — every storage form of "off" is off', () => {
  it.each([[false], [0], ['false'], ['f']])('aiEnabled = %p → off', (v) => {
    expect(rowAllowsAi({ aiEnabled: v })).toBe(false);
  });
  it.each([[true], [1], ['true'], ['t'], [undefined]])('aiEnabled = %p → on (the column default)', (v) => {
    expect(rowAllowsAi({ aiEnabled: v })).toBe(true);
  });
  it('no row → off', () => {
    expect(rowAllowsAi(null)).toBe(false);
    expect(rowAllowsAi(undefined)).toBe(false);
  });
});

describe('serverAllowsAi — fail closed', () => {
  it('a non-string or empty id never reaches the database', async () => {
    for (const id of [undefined, null, 42, '', { $ne: null }]) {
      expect(await serverAllowsAi(id)).toBe(false);
    }
    expect(findById).not.toHaveBeenCalled();
  });

  it('a database error means "no AI", logged without the stack', async () => {
    findById.mockRejectedValueOnce(new Error('connection terminated'));
    expect(await serverAllowsAi('s1')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'ai.server_policy.read_failed', err: 'connection terminated' }), expect.any(String));
  });

  it('a non-Error rejection is also "no AI"', async () => {
    findById.mockRejectedValueOnce('boom');
    expect(await serverAllowsAi('s1')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: 'non-error' }), expect.any(String));
  });

  it('reads the stored row on every call (no cache)', async () => {
    findById.mockResolvedValueOnce({ _id: 's1', aiEnabled: true }).mockResolvedValueOnce({ _id: 's1', aiEnabled: false });
    expect(await serverAllowsAi('s1')).toBe(true);
    expect(await serverAllowsAi('s1')).toBe(false);
    expect(findById).toHaveBeenCalledTimes(2);
  });
});

describe('serversAllowingAi — fail closed', () => {
  it('empty / invalid input → empty set without a query', async () => {
    expect([...await serversAllowingAi([])]).toEqual([]);
    expect([...await serversAllowingAi(['', null as unknown as string])]).toEqual([]);
    expect(findByIds).not.toHaveBeenCalled();
  });

  it('deduplicates ids and keeps only servers that allow AI', async () => {
    findByIds.mockResolvedValueOnce([{ _id: 'a', aiEnabled: true }, { _id: 'b', aiEnabled: false }]);
    expect([...await serversAllowingAi(['a', 'b', 'a', 'gone'])]).toEqual(['a']);
    expect(findByIds).toHaveBeenCalledWith(['a', 'b', 'gone']);
  });

  it('a database error → empty set (no server allows AI)', async () => {
    findByIds.mockRejectedValueOnce(new Error('timeout'));
    expect([...await serversAllowingAi(['a'])]).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'ai.server_policy.read_failed', err: 'timeout' }), expect.any(String));
    findByIds.mockRejectedValueOnce(undefined);
    expect([...await serversAllowingAi(['a'])]).toEqual([]);
  });
});
