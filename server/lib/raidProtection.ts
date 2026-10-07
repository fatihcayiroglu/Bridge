// P7 B1 — bounded, explainable server join-raid protection.
//
// This module intentionally does NOT maintain a permanent user trust score.
// It observes only eligible join attempts, de-duplicates the same account for
// one short policy window, and keeps aggregate counters for that same window.
//
// Multi-node deployments use Redis through the existing authoritative cache
// primitives. Deliberate single-node/no-Redis deployments use process memory.

import { createHash } from 'crypto';
import { Auth, Members, Servers, Users } from '../db/repositories';
import { envSafeInt } from './envNumbers';
import { cache } from './redisAdapter';
import logger from './logger';

export type RaidMitigationLevel = 'off' | 'balanced' | 'strict';
export type RaidJoinSource = 'discoverable' | 'invite';

export interface RaidPolicy {
  windowMs: number;
  maxUniqueAccounts: number;
  /** How long raid mode lasts once the join surge crossed the threshold. */
  lockdownMs: number;
  /** strict refuses joins during raid mode; balanced admits them. */
  refuseJoins: boolean;
  /** Accounts younger than this that join in a surge are held from posting. */
  youngAccountMs: number;
}

// P7 B1 — measured by scripts/abuse-lab (ATK-08, LEG-08, LEG-10, LEG-11).
// The first version refused every join for 2 min once 31 accounts joined in
// 10 s: the lab measured 30 of 60 raiders admitted and posting, a 40-person
// launch losing 10 joins, and a real person arriving after a raid refused.
// Raid harm is posting, not joining. Balanced (the default) therefore never
// refuses a join: it holds accounts created in the last 24 h that joined in
// the surge — including the cohort that triggered it — from posting until raid
// mode ends (the ordinary member-timeout enforcement; moderators can lift it).
// Strict additionally refuses joins during raid mode.
const YOUNG_ACCOUNT_MS = envSafeInt('RAID_YOUNG_ACCOUNT_MS', 24 * 60 * 60_000, { min: 0, max: 365 * 24 * 60 * 60_000 });

export const RAID_POLICIES: Readonly<Record<Exclude<RaidMitigationLevel, 'off'>, RaidPolicy>> = Object.freeze({
  balanced: Object.freeze({
    windowMs: envSafeInt('RAID_BALANCED_WINDOW_MS', 10_000, { min: 1_000, max: 10 * 60_000 }),
    maxUniqueAccounts: envSafeInt('RAID_BALANCED_MAX_JOINS', 30, { min: 2, max: 100_000 }),
    lockdownMs: envSafeInt('RAID_BALANCED_MODE_MS', 10 * 60_000, { min: 10_000, max: 24 * 60 * 60_000 }),
    refuseJoins: false,
    youngAccountMs: YOUNG_ACCOUNT_MS,
  }),
  strict: Object.freeze({
    windowMs: envSafeInt('RAID_STRICT_WINDOW_MS', 10_000, { min: 1_000, max: 10 * 60_000 }),
    maxUniqueAccounts: envSafeInt('RAID_STRICT_MAX_JOINS', 10, { min: 2, max: 100_000 }),
    lockdownMs: envSafeInt('RAID_STRICT_MODE_MS', 5 * 60_000, { min: 10_000, max: 24 * 60 * 60_000 }),
    refuseJoins: true,
    youngAccountMs: YOUNG_ACCOUNT_MS,
  }),
});

/** A posting hold to apply to the joining account if it is young. */
export interface RaidJoinHold {
  until: number;
  youngAccountMs: number;
}

export type RaidJoinDecision =
  | {
      allowed: true;
      level: RaidMitigationLevel;
      counted: boolean;
      uniqueAccounts: number | null;
      hold: RaidJoinHold | null;
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
  heldMembers: number,
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
        refuseJoins: policy.refuseJoins,
        // A count, not identities: moderators see who is held in the member list.
        heldMembers,
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
    return { allowed: true, level, counted: false, uniqueAccounts: null, hold: null };
  }
  const policy = RAID_POLICIES[level];
  const holdFor = (until: number): RaidJoinHold => ({ until, youngAccountMs: policy.youngAccountMs });

  const currentLockdownUntil = lockdownUntilOf(input.server);
  if (currentLockdownUntil !== null && currentLockdownUntil > now) {
    if (!policy.refuseJoins) {
      return { allowed: true, level, counted: false, uniqueAccounts: null, hold: holdFor(currentLockdownUntil) };
    }
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
    return { allowed: true, level, counted: false, uniqueAccounts: null, hold: null };
  }

  const count = observed.count ?? 0;
  if (count <= policy.maxUniqueAccounts) {
    return { allowed: true, level, counted: true, uniqueAccounts: count, hold: null };
  }

  const lockdownUntil = now + policy.lockdownMs;

  if (count === policy.maxUniqueAccounts + 1) {
    try {
      await Servers.update(serverId, { raidLockdownUntil: lockdownUntil });
      // The surge cohort that is ALREADY in (joined within the window, young
      // accounts) is held too: otherwise the first wave of a raid posts freely.
      const heldMembers = await Members.holdRecentYoungJoiners(serverId, {
        joinedSince: now - policy.windowMs,
        accountCreatedSince: Math.max(0, now - policy.youngAccountMs),
        holdUntil: lockdownUntil,
      });
      await auditAutoLockdown(serverId, level, input.source, count, policy, lockdownUntil, heldMembers);
    } catch (error) {
      logger.error({
        event: 'raid.lockdown.persist_failed',
        serverId,
        level,
        err: error instanceof Error ? error.message : String(error),
      }, 'Raid burst detected but durable raid mode persistence failed.');
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

  if (!policy.refuseJoins) {
    return { allowed: true, level, counted: true, uniqueAccounts: count, hold: holdFor(lockdownUntil) };
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

/**
 * Applies a raid hold to an account that has just joined, if the account is
 * young. Never shortens a longer timeout. Returns whether a hold was placed.
 */
export async function applyRaidJoinHold(serverId: string, userId: string, hold: RaidJoinHold | null, now = Date.now()): Promise<boolean> {
  if (!hold || hold.until <= now) return false;
  const user = await Users.findById(userId) as { createdAt?: unknown } | null;
  const createdAt = Number(user?.createdAt);
  if (!Number.isFinite(createdAt) || createdAt < now - hold.youngAccountMs) return false;
  const member = await Members.findOne(userId, serverId) as { timeoutUntil?: unknown } | null;
  const current = Number(member?.timeoutUntil);
  if (Number.isFinite(current) && current >= hold.until) return false;
  await Members.setTimeout(serverId, userId, hold.until);
  return true;
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
