/** P7 D2: bounded expiry primitives. No product endpoint is enabled here.
 * Existing NULL channels are permanent. Corrupt persisted timestamps fail
 * closed (throw), never interpreted as permission to read or republish.
 */
import { parsePersistedNonNegativeInteger } from './persistedInteger';

export const MIN_CHANNEL_LIFETIME_MS = 60 * 60 * 1000;
export const MAX_CHANNEL_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

function safeNow(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid server time');
  return now;
}

export type ChannelExpiryStatus = 'permanent' | 'active' | 'expired';

/** Database timestamps may be canonical PG BIGINT strings. */
export function channelExpiryStatus(expiresAt: unknown, now: number): ChannelExpiryStatus {
  safeNow(now);
  if (expiresAt === null || expiresAt === undefined) return 'permanent';
  const expires = parsePersistedNonNegativeInteger(expiresAt, 'channel expiry');
  if (expires === 0) throw new TypeError('Channel expiry must be positive');
  return expires <= now ? 'expired' : 'active';
}

/**
 * Strict future candidate validation, reserved for the eventual owner-only
 * create/update endpoint. No route uses it until expiry denial is authoritative.
 */
export function validateChannelExpiryCandidate(value: unknown, now: number): number | null {
  safeNow(now);
  if (value === null || value === undefined) return null;
  // Refuse coercion at the REST boundary; 64-bit DB string is NOT a valid
  // user input, even though reading that stored value is supported above.
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError('Invalid channel expiry request');
  }
  const earliest = now + MIN_CHANNEL_LIFETIME_MS;
  const latest = now + MAX_CHANNEL_LIFETIME_MS;
  if (!Number.isSafeInteger(latest) || value < earliest || value > latest) {
    throw new RangeError('Channel lifetime out of bounds');
  }
  return value;
}
