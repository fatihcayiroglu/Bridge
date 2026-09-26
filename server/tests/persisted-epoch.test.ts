import { isPersistedEpochExpired, parsePersistedEpochMillis } from '../lib/persistedEpoch';

describe('persisted epoch parsing', () => {
  it.each([
    [0, 0],
    ['0', 0],
    [123, 123],
    ['123', 123],
    [null, null],
    [undefined, null],
  ])('parses canonical persisted epoch %p', (input, expected) => {
    expect(parsePersistedEpochMillis(input)).toBe(expected);
  });

  it.each([-1, -1.5, Number.NaN, Number.POSITIVE_INFINITY, '-1', '01', '1.5', '1e3', '123oops', {}, []])(
    'rejects malformed persisted epoch %p',
    (input) => expect(() => parsePersistedEpochMillis(input)).toThrow(),
  );

  it('treats missing and exact-now expiries as expired', () => {
    expect(isPersistedEpochExpired(null, 100)).toBe(true);
    expect(isPersistedEpochExpired('100', 100)).toBe(true);
    expect(isPersistedEpochExpired('101', 100)).toBe(false);
  });
});
