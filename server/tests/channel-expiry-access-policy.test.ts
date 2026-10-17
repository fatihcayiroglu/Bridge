import {
  classifyChannelExpiryWithTombstone as classify,
  validateChannelExpiryRequest as validate,
  type ChannelExpiryBounds,
} from '../lib/channelExpiry';

// These are INERT policy tests. No channel route consumes this helper until
// tombstone reads, owner authorization, worker and offline/federation gates ship.
const now = 1_800_000_000_000;
const policy: ChannelExpiryBounds = {
  minLifetimeMs: 60_000,
  maxLifetimeMs: 86_400_000,
  allowPermanent: true,
};
const channel = { _id: 'c1', serverId: 's1', expiresAt: null, expiryVersion: '0' };
const tombstone = {
  channelId: 'c1',
  serverId: 's1',
  expiredAt: String(now - 1),
  expiryVersion: '1',
  recordedAt: String(now),
  cleanupState: 'pending',
};

describe('P7 D2 migration-084 durable-tombstone access policy (not wired to routes)', () => {
  it('never treats a missing tombstone query as verified absence', () => {
    expect(classify(channel, undefined, now))
      .toEqual({ state: 'unverified', accessible: false });
    expect(classify({ _id: 'legacy' }, undefined, now))
      .toEqual({ state: 'unverified', accessible: false });
    expect(classify(null, undefined, now))
      .toEqual({ state: 'unverified', accessible: false });
  });

  it('allows legacy/permanent only after tombstone absence was checked', () => {
    expect(classify({ _id: 'legacy', serverId: 's1' }, null, now))
      .toEqual({ state: 'permanent', accessible: true });
    expect(classify(channel, null, now))
      .toEqual({ state: 'permanent', accessible: true });
    expect(classify({ ...channel, expiryVersion: '7' }, null, now))
      .toEqual({ state: 'permanent', accessible: true });
  });

  it('distinguishes active and expired at the authoritative server instant', () => {
    expect(classify({ ...channel, expiresAt: String(now + 1), expiryVersion: '1' }, null, now))
      .toEqual({ state: 'active', accessible: true });
    expect(classify({ ...channel, expiresAt: String(now), expiryVersion: '1' }, null, now))
      .toEqual({ state: 'expired', accessible: false });
    expect(classify({ ...channel, expiresAt: now - 1, expiryVersion: 2 }, null, now))
      .toEqual({ state: 'expired', accessible: false });
  });

  it('verified durable tombstones deny on backwards clocks, absent rows and stale channels', () => {
    for (const time of [now - 100_000, now, now + 100_000]) {
      expect(classify(channel, tombstone, time))
        .toEqual({ state: 'tombstoned', accessible: false });
      expect(classify(null, tombstone, time))
        .toEqual({ state: 'tombstoned', accessible: false });
    }
  });

  it('does not accept tombstones from a different channel or tenant', () => {
    expect(classify(channel, { ...tombstone, channelId: 'another' }, now))
      .toEqual({ state: 'invalid', accessible: false });
    expect(classify(channel, { ...tombstone, serverId: 'another' }, now))
      .toEqual({ state: 'invalid', accessible: false });
  });

  it.each([
    { ...tombstone, expiryVersion: 0 },
    { ...tombstone, expiryVersion: '01' },
    { ...tombstone, expiredAt: '-1' },
    { ...tombstone, recordedAt: String(now - 2) },
    { ...tombstone, cleanupState: 'invented' },
    { ...tombstone, channelId: '' },
    [],
    false,
  ])('malformed durable tombstones fail closed %#', (bad) => {
    expect(classify(channel, bad, now)).toEqual({ state: 'invalid', accessible: false });
  });

  it.each([
    { ...channel, expiresAt: '01', expiryVersion: '1' },
    { ...channel, expiresAt: String(now), expiryVersion: 0 },
    { ...channel, expiresAt: String(now), expiryVersion: undefined },
    { ...channel, expiresAt: Number.MAX_SAFE_INTEGER + 1, expiryVersion: 1 },
    { ...channel, expiresAt: now, expiryVersion: '01' },
    { ...channel, expiresAt: null, expiryVersion: -1 },
    { ...channel, expiresAt: undefined, expiryVersion: '0' },
  ])('bad persisted expiry state denies, never downgrades to permanent %#', (bad) => {
    expect(classify(bad, null, now)).toEqual({ state: 'invalid', accessible: false });
  });

  it('requires server time and an existing channel row in absence of tombstones', () => {
    for (const time of [NaN, Infinity, -1, null, 'timestamp'])
      expect(classify(channel, null, time)).toEqual({ state: 'invalid', accessible: false });
    expect(classify(null, null, now)).toEqual({ state: 'invalid', accessible: false });
  });

  it('validates explicit configured request window and permanent policy, never omissions', () => {
    expect(validate(now + policy.minLifetimeMs, now, policy))
      .toEqual({ valid: true, expiresAt: now + policy.minLifetimeMs });
    expect(validate(now + policy.maxLifetimeMs, now, policy))
      .toEqual({ valid: true, expiresAt: now + policy.maxLifetimeMs });
    expect(validate(null, now, policy)).toEqual({ valid: true, expiresAt: null });
    expect(validate(null, now, { ...policy, allowPermanent: false }))
      .toEqual({ valid: false, reason: 'outside_window' });
    expect(validate(undefined, now, policy)).toEqual({ valid: false, reason: 'invalid_expiry' });
    expect(validate(String(now + policy.minLifetimeMs), now, policy))
      .toEqual({ valid: false, reason: 'invalid_expiry' });
    for (const expiry of [now, now + 59_999, now + 86_400_001])
      expect(validate(expiry, now, policy)).toEqual({ valid: false, reason: 'outside_window' });
    for (const invalidPolicy of [
      { ...policy, minLifetimeMs: 0 },
      { ...policy, maxLifetimeMs: Infinity },
      { ...policy, maxLifetimeMs: 1 },
    ]) expect(validate(now + 60_000, now, invalidPolicy))
      .toEqual({ valid: false, reason: 'invalid_policy' });
  });
});
