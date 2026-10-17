import { classifyChannelExpiry as classify, validateChannelExpiryRequest as validate,
  type ChannelExpiryBounds } from '../lib/channelExpiryPolicy';
const now = 1_800_000_000_000;
const policy: ChannelExpiryBounds = { minLifetimeMs: 60000, maxLifetimeMs: 86400000, allowPermanent: true };

describe('P7 D2 fail-closed expiry foundation (NOT enabled)', () => {
  test('old rows and explicit null are permanent', () => {
    for (const row of [{ _id: 'legacy' }, { expiresAt: null }, { expiresAt: null, expiryTombstonedAt: null }])
      expect(classify(row, now)).toEqual({ state: 'permanent', accessible: true });
  });
  test('denies at equality; positive future expiry still active', () => {
    expect(classify({ expiresAt: now + 1 }, now)).toEqual({ state: 'active', accessible: true });
    expect(classify({ expiresAt: now }, now)).toEqual({ state: 'expired', accessible: false });
    expect(classify({ expiresAt: now - 1 }, now)).toEqual({ state: 'expired', accessible: false });
  });
  test('durable tombstones never resurrect on clock rollback', () => {
    for (const time of [now - 9999, now, now + 9999])
      expect(classify({ expiresAt: now - 1, expiryTombstonedAt: now }, time))
        .toEqual({ state: 'tombstoned', accessible: false });
  });
  test.each([
    null, [], 1, 'record', { expiresAt: undefined }, { expiresAt: 'ISO' },
    { expiresAt: new Date(now) }, { expiresAt: NaN }, { expiresAt: Infinity },
    { expiresAt: -1 }, { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { expiryTombstonedAt: now }, { expiresAt: null, expiryTombstonedAt: now },
    { expiresAt: now + 1, expiryTombstonedAt: now },
    { expiresAt: now - 1, expiryTombstonedAt: 'now' },
  ])('malformed persisted state fails closed %#', (row) => {
    expect(classify(row, now)).toEqual({ state: 'invalid', accessible: false });
  });
  test.each([undefined, null, -1, NaN, Infinity, 'time'])('untrusted clocks deny %#', (time) => {
    expect(classify({}, time)).toEqual({ state: 'invalid', accessible: false });
  });
  test('does not read inherited expiry metadata', () => {
    expect(classify(Object.create({ expiresAt: now - 1 }), now))
      .toEqual({ state: 'permanent', accessible: true });
    expect(classify(Object.assign(Object.create(null), { expiresAt: now + 1 }), now))
      .toEqual({ state: 'active', accessible: true });
  });
  test('explicit server bounds are inclusive; client omission is invalid', () => {
    expect(validate(now + 60000, now, policy)).toEqual({ valid: true, expiresAt: now + 60000 });
    expect(validate(now + 86400000, now, policy)).toEqual({ valid: true, expiresAt: now + 86400000 });
    for (const t of [now, now + 59999, now + 86400001])
      expect(validate(t, now, policy)).toEqual({ valid: false, reason: 'outside_window' });
    expect(validate(undefined, now, policy)).toEqual({ valid: false, reason: 'invalid_expiry' });
  });
  test('permanence is explicitly policy gated', () => {
    expect(validate(null, now, policy)).toEqual({ valid: true, expiresAt: null });
    expect(validate(null, now, { ...policy, allowPermanent: false }))
      .toEqual({ valid: false, reason: 'outside_window' });
  });
  test('bad policy, bad clocks and unsafe timestamps never permit expiry', () => {
    expect(validate(now + 60000, NaN, policy)).toEqual({ valid: false, reason: 'invalid_clock' });
    for (const p of [{ ...policy, minLifetimeMs: 0 }, { ...policy, maxLifetimeMs: 0 },
      { ...policy, maxLifetimeMs: Infinity }])
      expect(validate(now + 60000, now, p)).toEqual({ valid: false, reason: 'invalid_policy' });
    for (const t of [NaN, Infinity, -2, 'tomorrow', new Date(now), Number.MAX_SAFE_INTEGER + 1])
      expect(validate(t, now, policy)).toEqual({ valid: false, reason: 'invalid_expiry' });
  });
});
