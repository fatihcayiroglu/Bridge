import { firstUsableRowTime } from '../lib/firstUsableRowTime';

describe('P6 persisted federation event time invariants', () => {
  const order = ['published', 'publishedAt', 'createdAt'] as const;

  it('ignores absent, null and blank publication fields rather than coercing them to epoch zero', () => {
    for (const published of [undefined, null, '', ' ', false, NaN, Infinity, -1, 'not-a-date']) {
      expect(firstUsableRowTime({ published, publishedAt: null, createdAt: '900' }, order)).toBe(900);
    }
  });

  it('keeps a genuinely persisted zero and gives valid publication time priority', () => {
    expect(firstUsableRowTime({ published: 0, createdAt: 900 }, order)).toBe(0);
    expect(firstUsableRowTime({ published: '0', createdAt: 900 }, order)).toBe(0);
    expect(firstUsableRowTime({ publishedAt: 120, createdAt: 900 }, order)).toBe(120);
    expect(firstUsableRowTime({ createdAt: 900 }, order)).toBe(900);
  });

  it('never trusts negative, fractional, unsafe or malformed persisted event times', () => {
    expect(firstUsableRowTime({ published: 0.5, publishedAt: Number.MAX_SAFE_INTEGER + 1, createdAt: 75 }, order)).toBe(75);
    expect(firstUsableRowTime({ published: -1, publishedAt: '-4', createdAt: 'invalid' }, order)).toBe(0);
    expect(firstUsableRowTime({}, order)).toBe(0);
  });
});
