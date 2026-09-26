/**
 * @openapi
 * /saved:
 *   get: { tags: [Saved], summary: List saved items, responses: { '200': { description: Saved items } } }
 *   post: { tags: [Saved], summary: Save an item, responses: { '201': { description: Item saved } } }
 * /saved/{id}/reminder:
 *   put:
 *     tags: [Saved]
 *     summary: Set a saved-item reminder
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses: { '200': { description: Reminder updated } }
 * /saved/{id}:
 *   delete:
 *     tags: [Saved]
 *     summary: Remove a saved item
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses: { '200': { description: Saved item removed } }
 */
// Personal Saved / Follow-up surface. Distinct from server pins and Inbox.

import express from 'express';
import { authMiddleware } from '../middleware/auth';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
import { Channels, Dms, GroupDms, Messages, SavedMessages, Servers, Users } from '../db/repositories';
import { hasPermission, PERMS, resolvePermissions } from '../lib/permissions';
import { sanitizeUser } from '../lib/userUtils';
import type { SavedDestinationType } from '../db/repositories/SavedMessageRepository';
import { limits } from '../middleware/rateLimit';
import { storedMessageText } from '../lib/storedText';

const router = express.Router();
const MAX_ITEMS = 100;

function destinationType(value: unknown): SavedDestinationType | null {
  return value === 'channel' || value === 'dm' || value === 'gdm' ? value : null;
}

function previewFor(message: Record<string, unknown>, channelMessage = false): string {
  if (message.type === 'e2ee' || message.e2e === true || message.isEncrypted === true) return 'Şifreli mesaj';
  if (message.type === 'file' || message.fileUrl) return 'Dosya mesajı';
  // Channel content is stored HTML-sanitized; DM and group DM content is raw (lib/storedText.ts).
  const text = channelMessage ? storedMessageText(message) : String(message.content ?? '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function reminderFields(row: Record<string, unknown>) {
  const remindAt = Number(row.remindAt ?? 0);
  const remindedAt = Number(row.remindedAt ?? 0);
  return {
    remindAt: Number.isSafeInteger(remindAt) && remindAt > 0 ? remindAt : null,
    remindedAt: Number.isSafeInteger(remindedAt) && remindedAt > 0 ? remindedAt : null,
  };
}

function unavailable(row: Record<string, unknown>) {
  return { id: String(row._id), savedAt: Number(row.createdAt ?? 0), unavailable: true, ...reminderFields(row) };
}

async function authorizeTarget(
  userId: string,
  type: SavedDestinationType,
  targetId: string,
  messageId: string,
): Promise<boolean> {
  if (type === 'channel') {
    const message = await Messages.findById(messageId) as unknown as Record<string, unknown> | null;
    if (!message || message.deletedAt || String(message.channelId ?? '') !== targetId) return false;
    const serverId = String(message.serverId ?? '');
    const permissions = await resolvePermissions(userId, serverId, targetId).catch(() => 0);
    return hasPermission(permissions, PERMS.VIEW_CHANNELS) && hasPermission(permissions, PERMS.READ_HISTORY);
  }

  if (type === 'dm') {
    const conversation = await Dms.findConversation(targetId);
    const participants = Array.isArray(conversation?.participants) ? conversation.participants : [];
    return participants.includes(userId) && Boolean(await Dms.findMessage(messageId, targetId));
  }

  return Boolean(await GroupDms.findMember(targetId, userId)) && Boolean(await GroupDms.findMessage(messageId, targetId));
}

router.post('/', authMiddleware, async (req, res) => {
  const { user } = castAuthed(req);
  const type = destinationType(req.body?.destinationType);
  const targetId = String(req.body?.destinationId ?? '').trim();
  const messageId = String(req.body?.messageId ?? '').trim();
  if (!type || !targetId || !messageId || targetId.length > 160 || messageId.length > 160) {
    return res.status(400).json({ error: 'Invalid saved message target' });
  }

  // Missing and inaccessible targets deliberately share one response so this
  // endpoint cannot be used as a message-existence oracle.
  if (!(await authorizeTarget(user.id, type, targetId, messageId))) {
    return res.status(404).json({ error: 'Message not available' });
  }

  const result = await SavedMessages.save({
    userId: user.id,
    destinationType: type,
    destinationId: targetId,
    messageId,
  });
  return res.status(result.created ? 201 : 200).json({
    id: String(result.row._id),
    saved: true,
    created: result.created,
  });
});

router.get('/', authMiddleware, async (req, res) => {
  const { user } = castAuthed(req);
  try {
    const rows = await SavedMessages.findForUser(user.id, MAX_ITEMS) as Array<Record<string, unknown>>;
    const items: Array<Record<string, unknown>> = [];

    for (const row of rows) {
      const type = destinationType(row.destinationType);
      const targetId = String(row.destinationId ?? '');
      const messageId = String(row.messageId ?? '');
      if (!type || !targetId || !messageId) { items.push(unavailable(row)); continue; }

      if (type === 'channel') {
        const message = await Messages.findById(messageId) as unknown as Record<string, unknown> | null;
        const channelId = String(message?.channelId ?? '');
        const serverId = String(message?.serverId ?? '');
        if (!message || message.deletedAt || channelId !== targetId) { items.push(unavailable(row)); continue; }
        const permissions = await resolvePermissions(user.id, serverId, channelId).catch(() => 0);
        if (!hasPermission(permissions, PERMS.VIEW_CHANNELS) || !hasPermission(permissions, PERMS.READ_HISTORY)) {
          items.push(unavailable(row)); continue;
        }
        const [channel, server] = await Promise.all([Channels.findById(channelId), Servers.findById(serverId)]);
        if (!channel || !server) { items.push(unavailable(row)); continue; }
        items.push({
          id: String(row._id), savedAt: Number(row.createdAt ?? 0), unavailable: false, ...reminderFields(row),
          preview: previewFor(message, true),
          sender: {
            _id: String(message.userId ?? ''),
            displayName: String(message.displayName ?? message.username ?? 'Bridge user'),
            avatarColor: String(message.avatarColor ?? '#2d9cdb'),
          },
          destination: {
            type, messageId, channelId, serverId,
            channel: { _id: channelId, name: channel.name, type: channel.type },
            server: { _id: serverId, name: server.name, iconUrl: server.iconUrl ?? null },
          },
        });
        continue;
      }

      if (type === 'dm') {
        const conversation = await Dms.findConversation(targetId);
        const participants = Array.isArray(conversation?.participants) ? conversation.participants : [];
        const message = participants.includes(user.id) ? await Dms.findMessage(messageId, targetId) : null;
        const otherId = participants.find((id: string) => id !== user.id);
        const other = otherId ? await Users.findById(otherId) : null;
        if (!message || !other) { items.push(unavailable(row)); continue; }
        items.push({
          id: String(row._id), savedAt: Number(row.createdAt ?? 0), unavailable: false, ...reminderFields(row),
          preview: previewFor(message as unknown as Record<string, unknown>),
          sender: {
            _id: String(message.userId ?? ''),
            displayName: String(message.displayName ?? 'Bridge user'),
            avatarColor: String(message.avatarColor ?? '#2d9cdb'),
          },
          destination: { type, messageId, dmId: targetId, user: sanitizeUser(other) },
        });
        continue;
      }

      const [membership, group, message] = await Promise.all([
        GroupDms.findMember(targetId, user.id),
        GroupDms.findById(targetId),
        GroupDms.findMessage(messageId, targetId),
      ]);
      if (!membership || !group || !message) { items.push(unavailable(row)); continue; }
      items.push({
        id: String(row._id), savedAt: Number(row.createdAt ?? 0), unavailable: false, ...reminderFields(row),
        preview: previewFor(message as unknown as Record<string, unknown>),
        sender: {
          _id: String(message.userId ?? ''),
          displayName: String(message.displayName ?? 'Bridge user'),
          avatarColor: String(message.avatarColor ?? '#2d9cdb'),
        },
        destination: {
          type, messageId, groupId: targetId,
          group: { _id: targetId, name: group.name, icon: group.icon ?? null, ownerId: group.ownerId },
        },
      });
    }

    res.json({ items, count: items.length });
  } catch {
    res.status(503).json({ error: 'Saved messages temporarily unavailable', items: [], count: 0 });
  }
});

router.put('/:id/reminder', authMiddleware, limits.api(), async (req, res) => {
  const { user } = castAuthed(req);
  const id = String(req.params.id ?? '').trim();
  if (!id) return res.status(400).json({ error: 'Invalid saved item' });
  const row = await SavedMessages.findByIdForUser(user.id, id);
  if (!row) return res.status(404).json({ error: 'Saved item not found' });

  if (req.body?.remindAt === null) {
    await SavedMessages.clearReminder(user.id, id);
    return res.json({ reminder: null });
  }
  const type = destinationType(row.destinationType);
  const targetId = String(row.destinationId ?? '');
  const messageId = String(row.messageId ?? '');
  if (!type || !targetId || !messageId || !(await authorizeTarget(user.id, type, targetId, messageId))) {
    return res.status(404).json({ error: 'Saved item not available' });
  }

  const remindAt = Number(req.body?.remindAt);
  const now = Date.now();
  const max = now + 30 * 24 * 60 * 60_000;
  if (!Number.isSafeInteger(remindAt) || remindAt < now + 5_000 || remindAt > max) {
    return res.status(400).json({ error: 'Reminder must be between 5 seconds and 30 days from now' });
  }
  const result = await SavedMessages.setReminder(user.id, id, remindAt);
  if (result?.updated !== 1) return res.status(409).json({ error: 'Saved item changed' });
  return res.json({ reminder: { remindAt, remindedAt: null } });
});

router.delete('/:id', authMiddleware, async (req, res) => {
  const { user } = castAuthed(req);
  await SavedMessages.removeForUser(user.id, String(req.params.id ?? ''));
  res.status(204).end();
});

export default router;
