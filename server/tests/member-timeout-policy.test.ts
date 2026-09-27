import { isMemberTimedOut, parseMemberTimeoutUntil } from '../lib/memberTimeout';

describe('member timeout persisted-state policy', () => {
  it.each([null, undefined, 0, '0'])(
    'treats %p as no timeout',
    (value) => expect(parseMemberTimeoutUntil(value)).toBeNull(),
  );

  it('accepts both numeric and PostgreSQL BIGINT-string timestamps', () => {
    expect(parseMemberTimeoutUntil(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(parseMemberTimeoutUntil('1700000000000')).toBe(1_700_000_000_000);
  });

  it.each(['', '12ms', '-1', '-5', '1.5', {}, [], NaN, Infinity, -1, 1.5])('fails closed on malformed persisted timeout %p', (value) => {
    expect(() => parseMemberTimeoutUntil(value)).toThrow(/Invalid persisted member timeout/);
  });

  it('reports timeout activity using a deterministic caller-supplied clock', () => {
    expect(isMemberTimedOut('2000', 1000)).toBe(true);
    expect(isMemberTimedOut('1000', 1000)).toBe(false);
    expect(isMemberTimedOut(null, 1000)).toBe(false);
  });

  it('rejects an invalid comparison clock instead of producing false authority', () => {
    expect(() => isMemberTimedOut(2000, -1)).toThrow(/now must be/);
  });
});
