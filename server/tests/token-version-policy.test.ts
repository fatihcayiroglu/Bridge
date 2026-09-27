import { parseTokenVersion } from '../lib/tokenVersion';

describe('tokenVersion security-state parser', () => {
  test.each([
    [undefined, 0], [null, 0], [0, 0], [1, 1], ['0', 0], ['42', 42],
  ])('accepts canonical representation %#', (input, expected) => {
    expect(parseTokenVersion(input)).toBe(expected);
  });

  test.each(['', '01', '+1', '-1', '1.0', '1e2', ' 1 ', true, {}, [], NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    'rejects malformed/corrupt security state %#', (input) => {
      expect(() => parseTokenVersion(input)).toThrow('Invalid tokenVersion');
    },
  );
});
