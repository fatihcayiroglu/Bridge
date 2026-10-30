// server/socket/handlers/mediasoup/authority.ts
//
// Channel-backed SFU room authority, kept free of the mediasoup runtime so it
// can be verified against real PostgreSQL without media workers.

import { Channels, Members } from '../../../db/repositories';
import { PERMS, hasPermission, resolvePermissions } from '../../../lib/permissions';
import { isMemberTimedOut } from '../../../lib/memberTimeout';
import { channelLiveForMedia } from '../../../lib/channelContentAvailability';

export interface ChannelMediaAuthority { serverId: string; isGroup: false; channelType: 'voice' | 'stage' }

/**
 * Media authority for a channel-backed room. `'no-channel'` means no channel
 * row exists, so the caller may try a group-DM room; `null` is a refusal: the
 * room is a channel and this user may not use it now (no membership or
 * permission, wrong tenant, not a media channel, or the channel has expired).
 */
export async function authorizeChannelMediaRoom(
  userId: string,
  channelId: string,
  claimedServerId: string | null | undefined,
  requireSpeak = false,
): Promise<ChannelMediaAuthority | null | 'no-channel'> {
  const channel = await Channels.findById(channelId).catch(() => null);
  if (!channel) return 'no-channel';
  const actualServerId = String(channel.serverId ?? '');
  if (!actualServerId) return null;
  if (claimedServerId && claimedServerId !== actualServerId) return null;
  if (channel.type !== 'voice' && channel.type !== 'stage') return null;
  // Every sfu:* operation re-enters here, so an expired or tombstoned channel
  // stops admitting transports, producers and consumers at once (P7 D2).
  if (!await channelLiveForMedia(channelId, actualServerId)) return null;

  const membership = await Members.findOne(userId, actualServerId).catch(() => null);
  if (!membership || isMemberTimedOut(membership.timeoutUntil)) return null;

  const perms = await resolvePermissions(userId, actualServerId, channelId).catch(() => 0);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.CONNECT)) return null;
  if (requireSpeak && !hasPermission(perms, PERMS.SPEAK)) return null;
  return { serverId: actualServerId, isGroup: false, channelType: channel.type as 'voice' | 'stage' };
}
