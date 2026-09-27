import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { Bots } from '../db/repositories';

export interface AuthenticatedBot {
  _id: string;
  serverId: string;
  ownerId?: string;
  username: string;
  description?: string;
  active: true;
  permissions?: number;
  contextCommands?: unknown[] | string;
  slashCommands?: unknown[] | string;
  avatarUrl?: string | null;
}

export type BotAuthedRequest = Request & { bot: AuthenticatedBot };

/**
 * Resolve an opaque Bridge bot token to its canonical active bot identity.
 *
 * The token itself is never persisted or logged; only its SHA-256 digest is
 * compared with the database. Any DB uncertainty fails closed by propagating
 * to the caller/middleware rather than being interpreted as an unknown bot.
 */
export async function resolveBotToken(token: unknown): Promise<AuthenticatedBot | null> {
  if (typeof token !== 'string' || !token.startsWith('brg_bot_') || token.length < 24 || token.length > 256) {
    return null;
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = await Bots.findByTokenHash(tokenHash) as AuthenticatedBot | null;
  if (!row || row.active !== true || !row._id || !row.serverId || !row.username) return null;
  return row;
}

export function extractBotAuthorization(req: Request): string | null {
  const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  if (!auth.startsWith('Bot ')) return null;
  const token = auth.slice(4).trim();
  return token || null;
}

export async function botAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractBotAuthorization(req);
  if (!token) {
    res.status(401).json({ error: 'Bot authorization required' });
    return;
  }
  try {
    const bot = await resolveBotToken(token);
    if (!bot) {
      res.status(401).json({ error: 'Invalid or inactive bot token' });
      return;
    }
    (req as BotAuthedRequest).bot = bot;
    next();
  } catch {
    // Authorization state is unavailable. Never turn a DB outage into an auth
    // bypass; distinguish it from a bad credential so callers can retry.
    res.status(503).json({ error: 'Bot authorization unavailable' });
  }
}
