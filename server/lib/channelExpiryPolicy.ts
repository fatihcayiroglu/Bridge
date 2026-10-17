/**
 * P7 D2 -- dormant, server-time channel expiry policy. NOT wired to routes.
 * Do not enable ephemeral channel writes until PostgreSQL tombstones,
 * authorization gates, background cleanup, and offline/federation sync exist.
 */
export type ChannelExpiryState = 'permanent'|'active'|'expired'|'tombstoned'|'invalid';
export interface ChannelExpiryDecision { state: ChannelExpiryState; accessible: boolean }
const stamp = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const clock = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (v: Record<string, unknown>, field: string): boolean =>
  Object.prototype.hasOwnProperty.call(v, field);

/** Expiration-only access; NOT a replacement for membership/tenant checks. */
export function classifyChannelExpiry(record: unknown, nowMs: unknown): ChannelExpiryDecision {
  const invalid: ChannelExpiryDecision = { state: 'invalid', accessible: false };
  if (!clock(nowMs) || !object(record)) return invalid;
  const hasExpiry = own(record, 'expiresAt');
  const hasTombstone = own(record, 'expiryTombstonedAt');
  if (!hasExpiry && !hasTombstone) return { state: 'permanent', accessible: true };
  if (!hasExpiry) return invalid;
  const expiry = record.expiresAt;
  const tomb = hasTombstone ? record.expiryTombstonedAt : null;
  if (expiry === null) {
    if (tomb !== null && tomb !== undefined) return invalid;
    return { state: 'permanent', accessible: true };
  }
  if (!stamp(expiry)) return invalid;
  if (tomb !== null && tomb !== undefined) {
    if (!stamp(tomb) || tomb < expiry) return invalid;
    // Never resurrect a tombstone on backward-clock jumps.
    return { state: 'tombstoned', accessible: false };
  }
  return nowMs >= expiry
    ? { state: 'expired', accessible: false }
    : { state: 'active', accessible: true };
}
export interface ChannelExpiryBounds {
  minLifetimeMs: number;
  maxLifetimeMs: number;
  allowPermanent: boolean;
}
export type ChannelExpiryRequestResult =
  | { valid: true; expiresAt: number|null }
  | { valid: false; reason: 'invalid_clock'|'invalid_policy'|'invalid_expiry'|'outside_window' };

/** Must be called with a trusted SERVER time and explicitly authorized owner. */
export function validateChannelExpiryRequest(
  expiresAt: unknown, nowMs: unknown, bounds: ChannelExpiryBounds,
): ChannelExpiryRequestResult {
  if (!clock(nowMs)) return { valid: false, reason: 'invalid_clock' };
  if (!bounds || !Number.isSafeInteger(bounds.minLifetimeMs) ||
      bounds.minLifetimeMs < 1 || !Number.isSafeInteger(bounds.maxLifetimeMs) ||
      bounds.maxLifetimeMs < bounds.minLifetimeMs ||
      typeof bounds.allowPermanent !== 'boolean') {
    return { valid: false, reason: 'invalid_policy' };
  }
  if (expiresAt === null) return bounds.allowPermanent
    ? { valid: true, expiresAt: null }
    : { valid: false, reason: 'outside_window' };
  if (!stamp(expiresAt)) return { valid: false, reason: 'invalid_expiry' };
  const duration = expiresAt - nowMs;
  if (!Number.isSafeInteger(duration) ||
      duration < bounds.minLifetimeMs || duration > bounds.maxLifetimeMs) {
    return { valid: false, reason: 'outside_window' };
  }
  return { valid: true, expiresAt };
}
