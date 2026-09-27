import { parsePersistedNonNegativeInteger } from '../lib/persistedInteger';

describe('parsePersistedNonNegativeInteger', () => {
  it.each([
    [0, 0], [42, 42], ['0', 0], ['42', 42],
  ])('accepts canonical durable integer %p', (input, expected) => {
    expect(parsePersistedNonNegativeInteger(input)).toBe(expected);
  });

  it.each(['', ' 1', '01', '1 ', '1.0', '1e3', '0x10', '-0', -1, 1.5, NaN, Infinity, {}, []])(
    'rejects non-canonical/corrupt durable integer %p',
    (input) => expect(() => parsePersistedNonNegativeInteger(input)).toThrow(/Invalid persisted integer/),
  );

  it('supports explicit missing defaults and upper bounds', () => {
    expect(parsePersistedNonNegativeInteger(null, 'counter', { defaultWhenMissing: 0, max: 5 })).toBe(0);
    expect(() => parsePersistedNonNegativeInteger(undefined, 'counter')).toThrow('Invalid counter');
    expect(() => parsePersistedNonNegativeInteger(6, 'counter', { max: 5 })).toThrow('Invalid counter');
    expect(() => parsePersistedNonNegativeInteger(0, 'counter', { max: -1 })).toThrow('Invalid counter maximum');
  });
});
