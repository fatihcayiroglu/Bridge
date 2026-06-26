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

import { Messages, Bots } from '../db/repositories';
import logger from '../lib/logger';

import { safeCastAuthed as castAuthed } from '../lib/authSafe';
interface BotRow { _id: string; username?: string; contextCommands?: string | unknown[]; webhookUrl?: string }

const VALID_TYPES = ['button', 'select', 'modal_submit', 'user_command', 'message_command'];
const router: Router = express.Router();

router.post('/', authMiddleware, limits.write(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { type, messageId, customId, value, channelId, serverId,
          targetUserId, targetMessageId, modalData } = req.body as Record<string, string>;

  if (!VALID_TYPES.includes(type as string))
    return void res.status(400).json({ error: 'Invalid interaction type' });

  if (['button', 'select', 'modal_submit'].includes(type as string) && !messageId)
    return void res.status(400).json({ error: 'messageId required' });
  if (['button', 'select', 'modal_submit'].includes(type as string) && !customId)
    return void res.status(400).json({ error: 'customId required' });

  let bot: BotRow | null = null;
  let msg: { botId?: string | null } | null = null;

  if (messageId) {
    const foundMsg = await Messages.findById(messageId as string);
    const foundMsgRecord = foundMsg as unknown as { botId?: unknown } | null;
    msg = foundMsgRecord ? { botId: typeof foundMsgRecord.botId === 'string' ? foundMsgRecord.botId : null } : null;
    if (!msg) return void res.status(404).json({ error: 'Message not found' });
    bot = msg.botId ? await Bots.findById(msg.botId) as BotRow | null : null;
  }

  if (['user_command', 'message_command'].includes(type as string) && customId) {
    const allBots = await Bots.findWhere({});
    for (const b of allBots) {
      const cmds = Array.isArray(b.contextCommands) ? b.contextCommands as { name: string }[] : JSON.parse(typeof b.contextCommands === 'string' ? b.contextCommands : '[]') as { name: string }[];
      if (cmds.find(c => c.name === customId)) { bot = b as BotRow; break; }
    }
  }

  const payload = {
    type, customId: customId || null, value: value || null,
    messageId: messageId || null, channelId: channelId || null,
    serverId: serverId || null, userId: _u.id, displayName: (_u as { displayName?: string }).displayName,
    botId: bot?._id || msg?.botId || null,
    targetUserId: targetUserId || null, targetMessageId: targetMessageId || null,
    modalData: modalData || null,
  };

  const io = req.app.get('io') as { emit(event: string, data: unknown): void } | undefined;
  if (io) io.emit('interaction', payload);

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

  const serverBots = await Bots.findServerBots(String(serverId));
  const botIds     = serverBots.map(sb => sb.botId);
  const bots       = botIds.length ? await Bots.findWhere({ _id: { $in: botIds } }) : [];

  const commands: object[] = [];
  for (const b of bots) {
    const cmds = Array.isArray(b.contextCommands) ? b.contextCommands as object[] : JSON.parse(typeof b.contextCommands === 'string' ? b.contextCommands : '[]') as object[];
    cmds.forEach(c => commands.push({ ...c as object, botId: b._id, botName: b.username }));
  }
  res.json(commands);
});

 
export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
