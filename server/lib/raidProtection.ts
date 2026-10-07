// P7 B1 — bounded, explainable server join-raid protection.
//
// This module intentionally does NOT maintain a permanent user trust score.
// It observes only eligible join attempts, de-duplicates the same account for
// one short policy window, and keeps aggregate counters for that same window.
//
// Multi-node deployments use Redis through the existing authoritative cache
// primitives. Deliberate single-node/no-Redis deployments use process memory.

import { createHash } from 'crypto';
import { Auth, Servers } from '../db/repositories';
import { cache } from './redisAdapter';
import logger from './logger';

export type RaidMitigationLevel = 'off' | 'balanced' | 'strict';
export type RaidJoinSource = 'discoverable' | 'invite';

export interface RaidPolicy {
  windowMs: number;
  maxUniqueAccounts: number;
  lockdownMs: number;
}

export const RAID_POLICIES: Readonly<Record<Exclude<RaidMitigationLevel, 'off'>, RaidPolicy>> = Object.freeze({
  balanced: Object.freeze({
    windowMs: 10_000,
    maxUniqueAccounts: 30,
    lockdownMs: 2 * 60_000,
  }),
  strict: Object.freeze({
    windowMs: 10_000,
    maxUniqueAccounts: 10,
    lockdownMs: 5 * 60_000,
  }),
});

export type RaidJoinDecision =
  | {
      allowed: true;
      level: RaidMitigationLevel;
      counted: boolean;
      uniqueAccounts: number | null;
    }
  | {
      allowed: false;
      level: RaidMitigationLevel;
      code: 'RAID_LOCKDOWN' | 'RAID_AUTHORITY_UNAVAILABLE';
      retryAfterMs: number;
      lockdownUntil: number | null;
      uniqueAccounts: number | null;
    };

const localJoinWindows = new Map<string, number[]>();

function boundedId(value: string, label: string): string {
  const result = String(value ?? '').trim();
  if (!result || result.length > 512) throw new TypeError(label + ' must be a non-empty bounded string');
  return result;
}

function actorFingerprint(actorId: string): string {
  return createHash('sha256').update(actorId).digest('hex').slice(0, 24);
}

export function parseRaidMitigationLevel(value: unknown): RaidMitigationLevel {
  if (value === 'off' || value === 'balanced' || value === 'strict') return value;
  if (value === undefined || value === null || value === '') return 'balanced';
  logger.warn({ event: 'raid.invalid_level', valueType: typeof value },
    'Invalid persisted raid mitigation level; using strict policy.');
  return 'strict';
}

export function raidPolicyFor(level: RaidMitigationLevel): RaidPolicy | null {
  return level === 'off' ? null : RAID_POLICIES[level];
}

function lockdownUntilOf(server: Record<string, unknown>): number | null {
  const raw = server.raidLockdownUntil;
  if (raw === null || raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function localWindowCount(serverId: string, windowMs: number, now: number): number {
  const previous = localJoinWindows.get(serverId) ?? [];
  const live = previous.filter(timestamp => now - timestamp < windowMs);
  live.push(now);
  localJoinWindows.set(serverId, live);
  return live.length;
}

async function uniqueJoinCount(
  serverId: string,
  actorId: string,
  policy: RaidPolicy,
  now: number,
): Promise<{ counted: boolean; count: number | null }> {
  // The raw account id is not retained in the short-lived coordination key.
  const fingerprint = actorFingerprint(actorId);
  const actorKey = 'raid:join-actor:' + serverId + ':' + fingerprint;
  const remaining = await cache.claimCooldown(
    actorKey,
    policy.windowMs,
    policy.windowMs + 1_000,
    now,
  );
  if (remaining > 0) return { counted: false, count: null };

  const shared = await cache.slidingWindowCount('raid:join:' + serverId, policy.windowMs, now);
  if (shared !== null) return { counted: true, count: shared };
  return { counted: true, count: localWindowCount(serverId, policy.windowMs, now) };
}

async function auditAutoLockdown(
  serverId: string,
  level: Exclude<RaidMitigationLevel, 'off'>,
  source: RaidJoinSource,
  uniqueAccounts: number,
  policy: RaidPolicy,
  lockdownUntil: number,
): Promise<void> {
  try {
    await Auth.insertAuditLog({
      serverId,
      actorId: 'system',
      actorName: 'Bridge Safety',
      action: 'raid_lockdown_auto',
      target: serverId,
      extra: {
        level,
        source,
        uniqueAccounts,
        windowMs: policy.windowMs,
        maxUniqueAccounts: policy.maxUniqueAccounts,
        lockdownMs: policy.lockdownMs,
        lockdownUntil,
      },
    });
  } catch (error) {
    logger.warn({
      event: 'raid.audit.failed',
      serverId,
      err: error instanceof Error ? error.message : String(error),
    }, 'Automatic raid lockdown was applied but audit logging failed.');
  }
}

export async function checkServerJoinRaid(input: {
  serverId: string;
  actorId: string;
  server: Record<string, unknown>;
  source: RaidJoinSource;
  now?: number;
}): Promise<RaidJoinDecision> {
  const serverId = boundedId(input.serverId, 'serverId');
  const actorId = boundedId(input.actorId, 'actorId');
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('now must be a non-negative safe integer');

  const level = parseRaidMitigationLevel(input.server.raidMitigationLevel);
  if (level === 'off') {
    return { allowed: true, level, counted: false, uniqueAccounts: null };
  }
  const policy = RAID_POLICIES[level];

  const currentLockdownUntil = lockdownUntilOf(input.server);
  if (currentLockdownUntil !== null && currentLockdownUntil > now) {
    return {
      allowed: false,
      level,
      code: 'RAID_LOCKDOWN',
      retryAfterMs: currentLockdownUntil - now,
      lockdownUntil: currentLockdownUntil,
      uniqueAccounts: null,
    };
  }

  let observed: { counted: boolean; count: number | null };
  try {
    observed = await uniqueJoinCount(serverId, actorId, policy, now);
  } catch (error) {
    logger.error({
      event: 'raid.counter.authority_unavailable',
      serverId,
      level,
      err: error instanceof Error ? error.message : String(error),
    }, 'Raid counter authority unavailable; eligible join denied fail-closed.');
    return {
      allowed: false,
      level,
      code: 'RAID_AUTHORITY_UNAVAILABLE',
      retryAfterMs: 1_000,
      lockdownUntil: null,
      uniqueAccounts: null,
    };
  }

  if (!observed.counted) {
    return { allowed: true, level, counted: false, uniqueAccounts: null };
  }

  const count = observed.count ?? 0;
  if (count <= policy.maxUniqueAccounts) {
    return { allowed: true, level, counted: true, uniqueAccounts: count };
  }

  const lockdownUntil = now + policy.lockdownMs;

  if (count === policy.maxUniqueAccounts + 1) {
    try {
      await Servers.update(serverId, { raidLockdownUntil: lockdownUntil });
      await auditAutoLockdown(serverId, level, input.source, count, policy, lockdownUntil);
    } catch (error) {
      logger.error({
        event: 'raid.lockdown.persist_failed',
        serverId,
        level,
        err: error instanceof Error ? error.message : String(error),
      }, 'Raid burst detected but durable lockdown persistence failed.');
      return {
        allowed: false,
        level,
        code: 'RAID_LOCKDOWN',
        retryAfterMs: policy.windowMs,
        lockdownUntil: null,
        uniqueAccounts: count,
      };
    }
  }

  return {
    allowed: false,
    level,
    code: 'RAID_LOCKDOWN',
    retryAfterMs: policy.lockdownMs,
    lockdownUntil,
    uniqueAccounts: count,
  };
}

export function raidProtectionStatus(server: Record<string, unknown>, now = Date.now()): {
  level: RaidMitigationLevel;
  active: boolean;
  lockdownUntil: number | null;
  policy: RaidPolicy | null;
} {
  const level = parseRaidMitigationLevel(server.raidMitigationLevel);
  const lockdownUntil = lockdownUntilOf(server);
  return {
    level,
    active: level !== 'off' && lockdownUntil !== null && lockdownUntil > now,
    lockdownUntil,
    policy: raidPolicyFor(level),
  };
}

/** @internal test-only reset for deliberate single-node fallback state. */
export function _resetRaidProtectionForTests(): void {
  localJoinWindows.clear();
}
