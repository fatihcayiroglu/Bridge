import type { HandlerServer } from '../socket/handler-contracts';
import { Bots } from '../db/repositories';
import { readPersistedCommandArray } from './botCommands';
import logger from './logger';

export interface SlashDispatchMessage {
  _id: string;
  serverId: string;
  channelId: string;
  userId: string;
  content: string;
  [key: string]: unknown;
}

function slashName(content: unknown): string | null {
  if (typeof content !== 'string' || !content.startsWith('/')) return null;
  const first = content.trim().slice(1).split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  return /^[a-z0-9_-]{1,32}$/.test(first) ? first : null;
}

/**
 * Deliver a persisted slash-command message only to bots that registered the
 * matching command for this server. Bots are never subscribed to all private
 * channel rooms merely to discover commands.
 */
export async function dispatchRegisteredBotCommand(io: HandlerServer, message: SlashDispatchMessage): Promise<number> {
  const name = slashName(message.content);
  if (!name) return 0;
  try {
    const bots = await Bots.findInstalledForServer(message.serverId);
    let delivered = 0;
    for (const bot of bots) {
      const commands = readPersistedCommandArray(bot.slashCommands);
      const owns = commands.some((command) => String(command.name ?? '').toLowerCase() === name);
      if (!owns || !bot._id) continue;
      io.to(`bot:${String(bot._id)}`).emit('message:new', message);
      delivered += 1;
    }
    return delivered;
  } catch (err) {
    // Message durability must not depend on optional bot discovery. The user
    // message is already committed; bot-delivery failure is observable/logged
    // and can be retried by the client, but never rolls back the chat message.
    logger.warn({ err, serverId: message.serverId, event: 'bot.command.dispatch.error' }, '[Bot] slash dispatch failed');
    return 0;
  }
}
