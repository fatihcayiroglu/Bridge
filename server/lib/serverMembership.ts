// server/lib/serverMembership.ts
// Canonical discoverable-server membership owner.
//
// Direct /servers/:sid/join and legacy /discover/:serverId/join used to carry
// separate authorization logic. The discover route skipped bans + server MFA,
// while both used find-then-insert and could duplicate post-join side effects
// under concurrent requests. This module owns the shared policy and winner-only
// post-commit effects.

import { Members, Servers } from '../db/repositories';
import { cache } from './redisAdapter';
import { invalidateMemberships } from './presenceCache';
import { checkServerJoinMfa, type ServerMfaLevel } from './serverMfaPolicy';
import { tryRequire } from './_optional-require';
import logger from './logger';

export type DiscoverableJoinStatus =
  | 'joined'
  | 'not_found'
  | 'invite_required'
  | 'banned'
  | 'already_member'
  | 'mfa_required';

export interface DiscoverableJoinResult {
  status: DiscoverableJoinStatus;
  server?: Record<string, unknown>;
  mfaLevel?: ServerMfaLevel;
  mfaUnavailable?: boolean;
}

export interface JoinActor {
  id: string;
  username?: string;
  displayName?: string;
}

async function invalidateMemberCountBestEffort(serverId: string): Promise<void> {
  try {
    await cache.del(`discover:memberCount:${serverId}`);
  } catch (err) {
    logger.warn(
      { err, serverId, event: 'server_join.member_count_cache_invalidate_failed' },
      'Membership committed, but discover member-count cache invalidation failed.',
    );
  }
}

/**
 * Post-commit side effects. A committed membership must never be reported as a
 * failed join merely because cache/webhook/plugin infrastructure is degraded.
 * Exactly-one execution is guaranteed by `Members.insertIfAbsent` winner
 * ownership for discoverable joins; invite consumption already has its own
 * atomic winner.
 */
export async function afterMemberJoined(actor: JoinActor, serverId: string): Promise<void> {
  await Promise.all([
    invalidateMemberships(actor.id),
    invalidateMemberCountBestEffort(serverId),
  ]);

  const webhookModule = tryRequire<{
    dispatchEvent: (sid: string, ev: string, d: unknown) => Promise<unknown>;
  }>('../routes/outgoingWebhooks', require);
  if (webhookModule?.dispatchEvent) {
    void webhookModule.dispatchEvent(serverId, 'member:join', { userId: actor.id }).catch((err) => {
      logger.warn(
        { err, serverId, userId: actor.id, event: 'server_join.webhook_enqueue_failed' },
        'Membership committed, but outgoing member:join webhook enqueue failed.',
      );
    });
  }

  const pluginModule = tryRequire<{
    hooks: { emit: (ev: string, data: unknown) => unknown };
  }>('../plugins/loader', require);
  if (pluginModule?.hooks) {
    try {
      const maybePromise = pluginModule.hooks.emit('member:joined', {
        userId: actor.id,
        serverId,
        displayName: actor.displayName,
        username: actor.username,
      });
      if (maybePromise && typeof (maybePromise as { catch?: unknown }).catch === 'function') {
        void (maybePromise as Promise<unknown>).catch((err) => {
          logger.warn(
            { err, serverId, userId: actor.id, event: 'server_join.plugin_hook_failed' },
            'Membership committed, but plugin member:joined hook failed.',
          );
        });
      }
    } catch (err) {
      logger.warn(
        { err, serverId, userId: actor.id, event: 'server_join.plugin_hook_failed' },
        'Membership committed, but plugin member:joined hook failed.',
      );
    }
  }
}

export async function joinDiscoverableServer(
  actor: JoinActor,
  serverId: string,
): Promise<DiscoverableJoinResult> {
  const server = await Servers.findById(serverId) as Record<string, unknown> | null;
  if (!server) return { status: 'not_found' };

  // A ban is authoritative membership state regardless of how a join was
  // initiated.  Checking discoverability first incorrectly turned a durable
  // ban into INVITE_REQUIRED for private servers and let the same actor probe
  // different results through the invite and direct-join paths.
  const existing = await Members.findIncludingBanned(actor.id, serverId);
  if (existing && (existing as { banned?: unknown }).banned === true) {
    return { status: 'banned', server };
  }
  if (existing) return { status: 'already_member', server };
  if (!server.discoverable) return { status: 'invite_required', server };

  const mfa = await checkServerJoinMfa(actor.id, serverId, server.mfaLevel);
  if (mfa.required && !mfa.satisfied) {
    return {
      status: 'mfa_required',
      server,
      mfaLevel: mfa.level,
      mfaUnavailable: mfa.unavailable,
    };
  }

  const inserted = await Members.insertIfAbsent(actor.id, serverId, []);
  if (!inserted) {
    // A concurrent join/ban won after the optimistic read. Re-read canonical
    // state so the loser gets a truthful result and cannot replay side effects.
    const winner = await Members.findIncludingBanned(actor.id, serverId);
    if (winner && (winner as { banned?: unknown }).banned === true) {
      return { status: 'banned', server };
    }
    return { status: 'already_member', server };
  }

  await afterMemberJoined(actor, serverId);
  return { status: 'joined', server };
}
