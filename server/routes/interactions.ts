/**
 * @openapi
 * tags:
 *   - name: Interactions
 *     description: Interactions API endpoints

 *
 * /interactions:
 *   post:
 *     tags: [Bots]
 *     summary: Bot interaction webhook alici
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type:    { type: integer }
 *               data:    { type: object }
 *               token:   { type: string }
 *     responses:
 *       200:
 *         description: Interaction islendi
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /interactions/{interactionId}/callback:
 *   post:
 *     tags: [Bots]
 *     summary: Interaction callback gonder
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: interactionId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type:    { type: integer }
 *               data:    { type: object }
 *     responses:
 *       200:
 *         description: Callback islendi
 */

// server/routes/interactions.ts
// Bot button/select/modal/context-menu interaction routing
import express, { Request, Response, Router } from 'express';
import { authMiddleware} from '../middleware/auth';
import { fetchT } from '../lib/fetch';
import { limits } from '../middleware/rateLimit';

import { Messages, Bots, Channels, Members } from '../db/repositories';
import logger from '../lib/logger';
import { resolvePermissions, hasPermission, PERMS } from '../lib/permissions';

import { safeCastAuthed as castAuthed } from '../lib/authSafe';
interface BotRow { _id: string; username?: string; contextCommands?: string | unknown[]; webhookUrl?: string }

const VALID_TYPES = ['button', 'select', 'modal_submit', 'user_command', 'message_command'];
const router: Router = express.Router();

router.post('/', authMiddleware, limits.write(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
    ? req.body as Record<string, unknown>
    : {};
  const type = typeof body.type === 'string' ? body.type : '';
  const stringField = (key: string): string | undefined => {
    const value = body[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  const messageId = stringField('messageId');
  const customId = stringField('customId');
  const value = stringField('value');
  const channelId = stringField('channelId');
  const serverId = stringField('serverId');
  const targetUserId = stringField('targetUserId');
  const targetMessageId = stringField('targetMessageId');
  const modalData = body.modalData;

  if (!VALID_TYPES.includes(type))
    return void res.status(400).json({ error: 'Invalid interaction type' });

  const isComponent = ['button', 'select', 'modal_submit'].includes(type);
  const isContext = ['user_command', 'message_command'].includes(type);
  if (isComponent && !messageId) return void res.status(400).json({ error: 'messageId required' });
  if ((isComponent || isContext) && !customId) return void res.status(400).json({ error: 'customId required' });
  if (type === 'message_command' && !targetMessageId)
    return void res.status(400).json({ error: 'targetMessageId required' });
  if (type === 'user_command' && !targetUserId)
    return void res.status(400).json({ error: 'targetUserId required' });
  if (type === 'modal_submit' && (modalData === null || typeof modalData !== 'object' || Array.isArray(modalData)))
    return void res.status(400).json({ error: 'modalData must be an object' });

  let bot: BotRow | null = null;
  let authoritativeChannelId = '';
  let authoritativeServerId = '';
  let authoritativeMessageId: string | null = null;

  const authorizeChannel = async (candidateChannelId: string, candidateServerId: string): Promise<boolean> => {
    const channel = await Channels.findById(candidateChannelId) as { _id: string; serverId: string } | null;
    if (!channel || String(channel.serverId) !== candidateServerId) return false;
    const perms = await resolvePermissions(_u.id, candidateServerId, candidateChannelId).catch(() => 0);
    return hasPermission(perms, PERMS.VIEW_CHANNELS) && hasPermission(perms, PERMS.USE_BOT_COMMANDS);
  };

  if (isComponent) {
    const foundMsg = await Messages.findById(messageId as string) as {
      _id: string; botId?: string | null; channelId?: string; serverId?: string;
    } | null;
    if (!foundMsg) return void res.status(404).json({ error: 'Message not found' });
    authoritativeChannelId = String(foundMsg.channelId ?? '');
    authoritativeServerId = String(foundMsg.serverId ?? '');
    if (!authoritativeChannelId || !authoritativeServerId)
      return void res.status(409).json({ error: 'Message is missing channel/server authority' });
    if ((channelId && channelId !== authoritativeChannelId) || (serverId && serverId !== authoritativeServerId))
      return void res.status(400).json({ error: 'Interaction channel/server mismatch' });
    if (!await authorizeChannel(authoritativeChannelId, authoritativeServerId))
      return void res.status(403).json({ error: 'No permission for interaction channel' });
    if (!foundMsg.botId) return void res.status(400).json({ error: 'Message is not an interactive bot message' });
    const installedBots = await Bots.findInstalledForServer(authoritativeServerId);
    const installed = installedBots.find((entry) => String((entry as { _id?: unknown })._id ?? '') === String(foundMsg.botId));
    if (!installed) return void res.status(403).json({ error: 'Bot is not installed in this server' });
    bot = installed;
    authoritativeMessageId = foundMsg._id;
  } else if (isContext) {
    if (type === 'message_command') {
      const targetMsg = await Messages.findById(targetMessageId as string) as {
        _id: string; channelId?: string; serverId?: string;
      } | null;
      if (!targetMsg) return void res.status(404).json({ error: 'Target message not found' });
      authoritativeChannelId = String(targetMsg.channelId ?? '');
      authoritativeServerId = String(targetMsg.serverId ?? '');
      authoritativeMessageId = targetMsg._id;
      if ((channelId && channelId !== authoritativeChannelId) || (serverId && serverId !== authoritativeServerId))
        return void res.status(400).json({ error: 'Interaction channel/server mismatch' });
      if (!await authorizeChannel(authoritativeChannelId, authoritativeServerId))
        return void res.status(403).json({ error: 'No permission for interaction channel' });
    } else {
      authoritativeServerId = String(serverId ?? '');
      if (!authoritativeServerId) return void res.status(400).json({ error: 'serverId required' });
      const membership = await Members.findOne(_u.id, authoritativeServerId);
      if (!membership) return void res.status(403).json({ error: 'Not a server member' });
      if (channelId) {
        authoritativeChannelId = String(channelId);
        if (!await authorizeChannel(authoritativeChannelId, authoritativeServerId))
          return void res.status(403).json({ error: 'No permission for interaction channel' });
      } else {
        const perms = await resolvePermissions(_u.id, authoritativeServerId, null).catch(() => 0);
        if (!hasPermission(perms, PERMS.USE_BOT_COMMANDS))
          return void res.status(403).json({ error: 'No USE_BOT_COMMANDS permission' });
      }
      if (!await Members.findOne(String(targetUserId), authoritativeServerId))
        return void res.status(404).json({ error: 'Target user is not a server member' });
    }

    const candidates = await Bots.findInstalledForServer(authoritativeServerId);
    for (const candidate of candidates) {
      let cmds: { name?: string }[];
      try {
        cmds = Array.isArray(candidate.contextCommands)
          ? candidate.contextCommands as { name?: string }[]
          : JSON.parse(typeof candidate.contextCommands === 'string' ? candidate.contextCommands : '[]') as { name?: string }[];
      } catch { cmds = []; }
      if (cmds.some(c => c.name === customId)) { bot = candidate; break; }
    }
    if (!bot) return void res.status(404).json({ error: 'Context command is not installed in this server' });
  }

  const payload = {
    type, customId: customId || null, value: value || null,
    messageId: authoritativeMessageId,
    channelId: authoritativeChannelId || null,
    serverId: authoritativeServerId || null,
    userId: _u.id, displayName: (_u as { displayName?: string }).displayName,
    botId: bot?._id || null,
    targetUserId: type === 'user_command' ? targetUserId : null,
    targetMessageId: type === 'message_command' ? targetMessageId : null,
    modalData: modalData ?? null,
  };

  // Never globally rebroadcast a client-originated interaction. Scope realtime
  // delivery to the server-authoritative channel/server derived above.
  const io = req.app.get('io') as { to(room: string): { emit(event: string, data: unknown): void } } | undefined;
  if (io && authoritativeChannelId) io.to(`channel:${authoritativeChannelId}`).emit('interaction', payload);
  else if (io && authoritativeServerId) io.to(`server:${authoritativeServerId}`).emit('interaction', payload);
  // Executable bots use a private room so interaction delivery does not depend
  // on subscribing the bot to every channel (and does not expose unrelated
  // private-channel traffic).
  if (io && bot?._id) io.to(`bot:${bot._id}`).emit('interaction', payload);

  if (bot?.webhookUrl) {
    fetchT(bot.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'INTERACTION', data: payload }),
      timeoutMs: 8000,
    }).catch((e: unknown) => logger.warn({ err: e, event: 'interaction.webhook.error' }, '[Interaction webhook]'));
  }

  res.json({ ok: true });
});

router.get('/context-commands', authMiddleware, async (req: Request, res: Response) => {
  const { serverId } = req.query;
  if (!serverId) return void res.status(400).json({ error: 'serverId required' });

  const sid = String(serverId);
  const membership = await Members.findOne(castAuthed(req).user.id, sid);
  if (!membership) return void res.status(403).json({ error: 'Not a server member' });
  const perms = await resolvePermissions(castAuthed(req).user.id, sid, null).catch(() => 0);
  if (!hasPermission(perms, PERMS.USE_BOT_COMMANDS)) return void res.status(403).json({ error: 'No USE_BOT_COMMANDS permission' });

  const bots = await Bots.findInstalledForServer(sid);

  const commands: object[] = [];
  for (const b of bots) {
    let cmds: object[] = [];
    try {
      const parsed = Array.isArray(b.contextCommands)
        ? b.contextCommands
        : JSON.parse(typeof b.contextCommands === 'string' ? b.contextCommands : '[]') as unknown;
      if (Array.isArray(parsed)) cmds = parsed.filter((entry): entry is object => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
    } catch {
      // Malformed persisted plugin/bot metadata must not take down the whole command list.
      cmds = [];
    }
    cmds.forEach(c => commands.push({ ...c, botId: b._id, botName: b.username }));
  }
  res.json(commands);
});

 
export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
