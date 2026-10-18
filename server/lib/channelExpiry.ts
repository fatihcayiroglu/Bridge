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


/**
 * P7 D2 canonical expiry-only policy for migration 084, NOT an authorization grant.
 * Callers must query the channel and the separate durable tombstone using
 * tenant-scoped server-side SQL. Undefined tombstone means NOT QUERIED;
 * explicit null means QUERY COMPLETED, NO TOMBSTONE. Never conflate the two.
 * No API or worker is enabled by this pure module.
 */
export type ChannelExpiryDecisionState =
  | 'permanent' | 'active' | 'expired' | 'tombstoned' | 'invalid' | 'unverified';
export interface ChannelExpiryDecision {
  state: ChannelExpiryDecisionState;
  accessible: boolean;
}
export interface ChannelExpiryBounds {
  minLifetimeMs: number;
  maxLifetimeMs: number;
  allowPermanent: boolean;
}
export type ChannelExpiryRequestResult =
  | { valid: true; expiresAt: number | null }
  | { valid: false; reason: 'invalid_clock' | 'invalid_policy' | 'invalid_expiry' | 'outside_window' };

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function positiveStoredStamp(value: unknown, label: string): number {
  const parsed = parsePersistedNonNegativeInteger(value, label);
  if (parsed === 0) throw new TypeError('Invalid ' + label);
  return parsed;
}

/**
 * A verified tombstone is terminal even on clock rollback. Corrupt, missing,
 * or mismatched query evidence denies. Caller MUST additionally check
 * membership, server permissions and requested channel identity.
 */
export function classifyChannelExpiryWithTombstone(
  channel: unknown, tombstone: unknown, nowMs: unknown,
): ChannelExpiryDecision {
  const invalid: ChannelExpiryDecision = { state: 'invalid', accessible: false };
  if (typeof nowMs !== 'number' || !Number.isSafeInteger(nowMs) || nowMs < 0) return invalid;
  if (tombstone === undefined) return { state: 'unverified', accessible: false };
  if (tombstone !== null) {
    if (!objectRecord(tombstone)) return invalid;
    try {
      if (typeof tombstone.channelId !== 'string' || !tombstone.channelId ||
          typeof tombstone.serverId !== 'string' || !tombstone.serverId ||
          positiveStoredStamp(tombstone.expiredAt, 'tombstone expiration') >
            positiveStoredStamp(tombstone.recordedAt, 'tombstone recording') ||
          parsePersistedNonNegativeInteger(tombstone.expiryVersion, 'tombstone version') === 0 ||
          typeof tombstone.cleanupState !== 'string' ||
          !['pending', 'objects_cleaned', 'converged'].includes(tombstone.cleanupState)) {
        return invalid;
      }
      if (channel !== null && channel !== undefined) {
        if (!objectRecord(channel) ||
            channel._id !== tombstone.channelId ||
            channel.serverId !== tombstone.serverId) return invalid;
      }
      return { state: 'tombstoned', accessible: false };
    } catch {
      return invalid;
    }
  }
  if (!objectRecord(channel)) return invalid;
  try {
    // A pre-084 channel may omit BOTH columns and remains permanent.
    // Any expiry without version evidence must deny, never downgrade to legacy.
    const hasExpiry = Object.prototype.hasOwnProperty.call(channel, 'expiresAt');
    const hasVersion = Object.prototype.hasOwnProperty.call(channel, 'expiryVersion');
    if (hasExpiry !== hasVersion) return invalid;
    if (hasExpiry && channel.expiresAt === undefined) return invalid;
    const version = hasVersion
      ? parsePersistedNonNegativeInteger(channel.expiryVersion, 'expiry version') : 0;
    const status = channelExpiryStatus(hasExpiry ? channel.expiresAt : null, nowMs);
    if (status !== 'permanent' && version === 0) return invalid;
    return { state: status, accessible: status !== 'expired' };
  } catch {
    return invalid;
  }
}

/**
 * Owner-authorized request validator for a future endpoint. Policy bounds
 * are mandatory, not implicit defaults. Missing input is invalid.
 */
export function validateChannelExpiryRequest(
  expiresAt: unknown, nowMs: unknown, bounds: ChannelExpiryBounds,
): ChannelExpiryRequestResult {
  if (typeof nowMs !== 'number' || !Number.isSafeInteger(nowMs) || nowMs < 0)
    return { valid: false, reason: 'invalid_clock' };
  if (!bounds || !Number.isSafeInteger(bounds.minLifetimeMs) || bounds.minLifetimeMs < 1 ||
      !Number.isSafeInteger(bounds.maxLifetimeMs) ||
      bounds.maxLifetimeMs < bounds.minLifetimeMs ||
      typeof bounds.allowPermanent !== 'boolean')
    return { valid: false, reason: 'invalid_policy' };
  if (expiresAt === null)
    return bounds.allowPermanent
      ? { valid: true, expiresAt: null }
      : { valid: false, reason: 'outside_window' };
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0)
    return { valid: false, reason: 'invalid_expiry' };
  const duration = expiresAt - nowMs;
  if (!Number.isSafeInteger(duration) ||
      duration < bounds.minLifetimeMs || duration > bounds.maxLifetimeMs)
    return { valid: false, reason: 'outside_window' };
  return { valid: true, expiresAt };
}
