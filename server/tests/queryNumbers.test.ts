import {
  parseBoundedPositiveIntQuery, parseNonNegativeSafeIntQuery,
  parsePositiveIntWithinBoundQuery, parsePositiveIntWithinBoundValue,
} from '../lib/queryNumbers';

describe('strict numeric query parsing', () => {
  it('uses defaults only when a query key is absent', () => {
    expect(parseBoundedPositiveIntQuery(undefined, 50, 100)).toBe(50);
    expect(parseNonNegativeSafeIntQuery(undefined, 123,)).toBe(123);
  });

  it('accepts decimal safe integers and clamps positive limits', () => {
    expect(parseBoundedPositiveIntQuery('1', 50, 100)).toBe(1);
    expect(parseBoundedPositiveIntQuery('100', 50, 100)).toBe(100);
    expect(parseBoundedPositiveIntQuery('999', 50, 100)).toBe(100);
    expect(parseNonNegativeSafeIntQuery('0', 123)).toBe(0);
    expect(parseNonNegativeSafeIntQuery('1700000000000', 123)).toBe(1700000000000);
  });

  it.each([
    '', '-1', '+1', '1.5', '1e3', '10oops', ' 10 ',
    String(Number.MAX_SAFE_INTEGER + 1),
  ])('rejects malformed/unsafe limit %p', (raw) => {
    expect(parseBoundedPositiveIntQuery(raw, 50, 100)).toBeNull();
  });

  it.each([
    '', '-1', '+1', '1.5', '1e3', '10oops', ' 10 ',
    String(Number.MAX_SAFE_INTEGER + 1),
  ])('rejects malformed/unsafe timestamp %p', (raw) => {
    expect(parseNonNegativeSafeIntQuery(raw, 123)).toBeNull();
  });

  it('rejects non-string Express query shapes', () => {
    expect(parseBoundedPositiveIntQuery(['5'], 50, 100)).toBeNull();
    expect(parseBoundedPositiveIntQuery({ value: '5' }, 50, 100)).toBeNull();
    expect(parseNonNegativeSafeIntQuery(['5'], 123)).toBeNull();
  });

  it('strict hard-bound parsers reject overflow instead of silently clamping', () => {
    expect(parsePositiveIntWithinBoundQuery(undefined, 7, 90)).toBe(7);
    expect(parsePositiveIntWithinBoundQuery('1', 7, 90)).toBe(1);
    expect(parsePositiveIntWithinBoundQuery('90', 7, 90)).toBe(90);
    expect(parsePositiveIntWithinBoundQuery('91', 7, 90)).toBeNull();
    expect(parsePositiveIntWithinBoundQuery('0', 7, 90)).toBeNull();
    expect(parsePositiveIntWithinBoundQuery(['5'], 7, 90)).toBeNull();

    expect(parsePositiveIntWithinBoundValue(undefined, 10, 50)).toBe(10);
    expect(parsePositiveIntWithinBoundValue(1, 10, 50)).toBe(1);
    expect(parsePositiveIntWithinBoundValue(50, 10, 50)).toBe(50);
    for (const invalid of [0, 51, 1.5, Number.MAX_SAFE_INTEGER + 1, '5', null]) {
      expect(parsePositiveIntWithinBoundValue(invalid, 10, 50)).toBeNull();
    }
  });

});
