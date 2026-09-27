// server/plugins/actions.ts
// Sprint 107→108: Plugin emit aksiyonlarını sunucu tarafında işler.
// plugin:sendMessage | plugin:deleteMessage | plugin:grantRole

import type { Server as IOServer } from 'socket.io';
import { Messages, Members, Channels, Roles } from '../db/repositories';
import { systemMsg } from '../socket/handlers/messages-types';
import { deleteMessageWithCascade } from '../lib/deleteMessageCascade';
import { invalidateChannelMessages } from '../lib/messageCache';
import { publishPersistedMessage } from '../lib/channelActivity';
import logger from '../lib/logger';
import { PERMS } from '../lib/permissions';
import { parsePermissionMask } from '../lib/permissionMaskInvariant';
import { authorizePluginAction, type PluginActionEvent } from './capabilities';

const MAX_PLUGIN_MESSAGE_LENGTH = 2_000;
const MAX_PLUGIN_BOT_NAME_LENGTH = 80;
const SAFE_AUTO_ASSIGN_BITS =
  PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES | PERMS.EMBED_LINKS |
  PERMS.ATTACH_FILES | PERMS.ADD_REACTIONS | PERMS.USE_SLASH |
  PERMS.READ_HISTORY | PERMS.CONNECT | PERMS.SPEAK | PERMS.USE_BOT_COMMANDS;

function pluginPayload<T>(raw: unknown, event: PluginActionEvent): { pluginId: string; payload: T } | null {
  const authorized = authorizePluginAction<T>(raw, event);
  if (!authorized) {
    logger.warn({ action: event, event: 'plugin.action.denied' }, 'Plugin action denied: missing origin/capability envelope.');
    return null;
  }
  return { pluginId: authorized.pluginId, payload: authorized.payload };
}

function normalizeRoleIds(raw: unknown): string[] {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((role): role is string => typeof role === 'string' && role.length > 0))];
}

interface HookBus {
  on(event: string, handler: (payload: unknown) => void | Promise<void>): void;
}

type ActionRegistrationState = { io: IOServer };
const actionRegistrations = new WeakMap<object, ActionRegistrationState>();

interface PluginSendPayload {
  channelId: string;
  serverId:  string;
  content:   string;
  botName?:  string;
}

interface PluginDeletePayload {
  messageId: string;
  channelId: string;
  serverId:  string;
}

interface PluginGrantRolePayload {
  userId:   string;
  serverId: string;
  roleId:   string;
}

export function registerPluginActionHandlers(hooks: HookBus, io: IOServer): void {
  const hookOwner = hooks as unknown as object;
  const existing = actionRegistrations.get(hookOwner);
  if (existing) {
    // Keep one stable handler set per bus, but refresh the current Socket.IO
    // owner in case application wiring is reconstructed in tests/dev.
    existing.io = io;
    return;
  }
  const state: ActionRegistrationState = { io };
  actionRegistrations.set(hookOwner, state);

  hooks.on('plugin:sendMessage', async (raw) => {
    const action = pluginPayload<PluginSendPayload>(raw, 'plugin:sendMessage');
    if (!action) return;
    const { pluginId, payload } = action;
    const { channelId, serverId, content, botName } = payload;
    if (!channelId || !serverId || typeof content !== 'string' || !content.trim() || content.length > MAX_PLUGIN_MESSAGE_LENGTH) return;
    if (botName !== undefined && (typeof botName !== 'string' || botName.length > MAX_PLUGIN_BOT_NAME_LENGTH)) return;

    try {
      const channel = await Channels.findByIdAndServer(channelId, serverId);
      if (!channel) {
        logger.warn({ channelId, serverId, event: 'plugin.sendMessage.denied' }, 'channel/server mismatch');
        return;
      }
      const msg = {
        ...systemMsg(String(channel._id), String(channel.serverId), content.trim()),
        displayName: botName || '🤖 Plugin Bot',
        username:    `plugin-${pluginId}`,
      };
      const saved = await Messages.create(msg);
      await publishPersistedMessage(state.io, saved);
    } catch (err) {
      logger.error({ err: (err as Error).message, event: 'plugin.sendMessage' }, 'plugin:sendMessage failed');
    }
  });

  hooks.on('plugin:deleteMessage', async (raw) => {
    const action = pluginPayload<PluginDeletePayload>(raw, 'plugin:deleteMessage');
    if (!action) return;
    const { pluginId, payload } = action;
    const { messageId, channelId, serverId } = payload;
    if (!messageId || !channelId || !serverId) return;

    try {
      const msg = await Messages.findById(messageId);
      if (!msg) return;
      const canonicalChannelId = String(msg.channelId);
      const canonicalServerId = String(msg.serverId);
      if (channelId !== canonicalChannelId || serverId !== canonicalServerId) {
        logger.warn({ messageId, channelId, serverId, canonicalChannelId, canonicalServerId, event: 'plugin.deleteMessage.denied' },
          'message/channel/server mismatch');
        return;
      }
      const ok = await deleteMessageWithCascade(messageId, canonicalChannelId, {
        _id: String(msg._id), channelId: canonicalChannelId,
        serverId: canonicalServerId, threadId: msg.threadId as string | undefined,
      }, `plugin:${pluginId}`);
      if (!ok) return;
      // Invalidate BEFORE announcing, same ordering as the socket delete path:
      // otherwise a client that refetches on `message:deleted` can be served a
      // cached first page that still contains the message.
      await invalidateChannelMessages(canonicalChannelId);
      state.io.to(`channel:${canonicalChannelId}`).emit('message:deleted', { id: messageId });
      logger.info({ messageId, channelId: canonicalChannelId, event: 'plugin.deleteMessage' }, 'plugin deleted message');
    } catch (err) {
      logger.error({ err: (err as Error).message, event: 'plugin.deleteMessage' }, 'plugin:deleteMessage failed');
    }
  });

  hooks.on('plugin:grantRole', async (raw) => {
    const action = pluginPayload<PluginGrantRolePayload>(raw, 'plugin:grantRole');
    if (!action) return;
    const { pluginId, payload } = action;
    const { userId, serverId, roleId } = payload;
    if (!userId || !serverId || !roleId) return;

    try {
      const member = await Members.findOne(userId, serverId);
      if (!member) return;
      const role = await Roles.findByIdAndServer(roleId, serverId);
      if (!role) {
        logger.warn({ userId, serverId, roleId, event: 'plugin.grantRole.denied' }, 'role/server mismatch');
        return;
      }

      const rolePermissions = parsePermissionMask(
        (role as { permissions?: unknown }).permissions ?? 0,
        'plugin grant role permissions',
      );
      if ((rolePermissions & ~SAFE_AUTO_ASSIGN_BITS) !== 0) {
        logger.warn(
          { pluginId, userId, serverId, roleId, event: 'plugin.grantRole.privileged_denied' },
          'Plugin role grant denied for an authority-delegating role.',
        );
        return;
      }

      const roles = normalizeRoleIds((member as { roles?: unknown }).roles);
      if (roles.includes(roleId)) return;

      roles.push(roleId);
      await Members.setRoles(userId, serverId, roles);

      // Role membership is tenant-scoped state. Never broadcast it to every
      // connected account: only sockets that joined this server's room may
      // observe the mutation.
      state.io.to(`server:${serverId}`).emit('role:granted', { serverId, roleId, userId, source: `plugin:${pluginId}` });
    } catch (err) {
      logger.error({ err: (err as Error).message, event: 'plugin.grantRole' }, 'plugin:grantRole failed');
    }
  });

  logger.info({ event: 'plugins.actions.registered' }, 'Plugin action handlers registered');
}
