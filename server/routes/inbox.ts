/**
 * @openapi
 * /inbox:
 *   get: { tags: [Inbox], summary: List unified inbox entries, responses: { '200': { description: Inbox entries } } }
 * /inbox/{id}/read:
 *   patch:
 *     tags: [Inbox]
 *     summary: Mark one inbox entry read
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses: { '200': { description: Read state updated } }
 * /inbox/read-all:
 *   patch: { tags: [Inbox], summary: Mark all inbox entries read, responses: { '200': { description: Read state updated } } }
 */
// server/routes/inbox.ts — one canonical "what needs my attention?" surface.

import express from 'express';
import { authMiddleware } from '../middleware/auth';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
import { Dms, GroupDms, Notifications, Messages, Channels, Servers, Users, SavedMessages } from '../db/repositories';
import { resolvePermissions, hasPermission, PERMS } from '../lib/permissions';
import { sanitizeUser } from '../lib/userUtils';
import { parsePersistedEpochMillis } from '../lib/persistedEpoch';
import { storedMessageText } from '../lib/storedText';

const router = express.Router();
const MAX_CHANNEL_ITEMS = 100;
const MAX_RETURNED_ITEMS = 150;

type InboxFilter = 'all' | 'mentions' | 'watches' | 'replies' | 'dms' | 'reminders';

function safeFilter(value: unknown): InboxFilter {
  return value === 'mentions' || value === 'watches' || value === 'replies' || value === 'dms' || value === 'reminders' ? value : 'all';
}

function failClosedCursor(value: unknown, missing = 0): number {
  try {
    return parsePersistedEpochMillis(value) ?? missing;
  } catch {
    // A corrupt cursor must not reveal historical private-message content.
    return Number.MAX_SAFE_INTEGER;
  }
}

function membershipCursor(membership: Record<string, unknown>): number {
  const joinedAt = failClosedCursor(membership.joinedAt, Number.MAX_SAFE_INTEGER);
  const readAt = failClosedCursor(membership.readAt, 0);
  return Math.max(joinedAt, readAt);
}

function previewFor(message: Record<string, unknown> | null, channelMessage = false): string {
  if (!message) return '';
  if (message.type === 'e2ee' || message.e2e === true || message.isEncrypted === true) return 'Şifreli mesaj';
  if (message.type === 'file' || message.fileUrl) return 'Dosya mesajı';
  // Channel content is stored HTML-sanitized; DM and group DM content is raw (lib/storedText.ts).
  const text = channelMessage ? storedMessageText(message) : String(message.content ?? '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 140);
}

router.get('/', authMiddleware, async (req, res) => {
  const { user } = castAuthed(req);
  const filter = safeFilter(req.query.filter);

  try {
    // Channel attention records contain identifiers only. Every response is
    // re-hydrated from canonical rows and re-authorized now, not at send time.
    const attentionRows = await Notifications.findUnreadChannelAttention(user.id, MAX_CHANNEL_ITEMS) as Array<Record<string, unknown>>;
    const messageIds = [...new Set(attentionRows.map(row => String(row.messageId ?? '')).filter(Boolean))];
    const messages = messageIds.length ? await Messages.findWhere({ _id: { $in: messageIds } }) : [];
    const messageMap = new Map(messages.map(message => [String(message._id), message as unknown as Record<string, unknown>]));
    const channelIds = [...new Set(messages.map(message => String(message.channelId ?? '')).filter(Boolean))];
    const channels = channelIds.length ? await Channels.findWhere({ _id: { $in: channelIds } }) : [];
    const channelMap = new Map(channels.map(channel => [String(channel._id), channel as unknown as Record<string, unknown>]));
    const serverIds = [...new Set(channels.map(channel => String(channel.serverId ?? '')).filter(Boolean))];
    const servers = serverIds.length ? await Servers.findByIds(serverIds) : [];
    const serverMap = new Map(servers.map(server => [String(server._id), server as unknown as Record<string, unknown>]));

    const channelItems: Array<Record<string, unknown>> = [];
    const seenAttentionMessages = new Set<string>();
    for (const row of attentionRows) {
      const messageId = String(row.messageId ?? '');
      if (!messageId || seenAttentionMessages.has(messageId)) continue;
      seenAttentionMessages.add(messageId);
      const message = messageMap.get(messageId);
      if (!message || message.deletedAt) continue;

      const channelId = String(message.channelId ?? '');
      const serverId = String(message.serverId ?? '');
      const channel = channelMap.get(channelId);
      const server = serverMap.get(serverId);
      if (!channel || !server) continue;

      // Stored routing identifiers must still agree with the canonical row.
      if (String(row.channelId ?? '') !== channelId || String(row.serverId ?? '') !== serverId) continue;

      const permissions = await resolvePermissions(user.id, serverId, channelId).catch(() => 0);
      if (!hasPermission(permissions, PERMS.VIEW_CHANNELS) || !hasPermission(permissions, PERMS.READ_HISTORY)) continue;

      channelItems.push({
        id: String(row._id),
        kind: row.type === 'reply' ? 'reply' : row.type === 'watch' ? 'watch' : 'mention',
        unreadCount: 1,
        createdAt: Number(message.createdAt ?? row.createdAt ?? 0),
        sender: {
          _id: String(message.userId ?? row.actorId ?? ''),
          displayName: String(message.displayName ?? message.username ?? 'Bridge user'),
          avatarColor: String(message.avatarColor ?? '#2d9cdb'),
          avatarUrl: message.avatarUrl ?? null,
        },
        preview: previewFor(message, true),
        destination: {
          type: 'channel', messageId, channelId, serverId,
          channel: { _id: channelId, name: String(channel.name ?? 'channel'), type: String(channel.type ?? 'text') },
          server: { _id: serverId, name: String(server.name ?? 'Bridge'), iconUrl: server.iconUrl ?? null },
        },
      });
    }

    // Direct-message attention is derived from the existing conversation
    // read cursor and message timestamps; there is no parallel unread table.
    const conversations = await Dms.findConversationsByUser(user.id);
    const dmOtherIds = [...new Set(conversations
      .map(conv => (Array.isArray(conv.participants) ? conv.participants : []).find((id: string) => id !== user.id))
      .filter((id): id is string => Boolean(id)))];
    const dmUsers = dmOtherIds.length ? await Users.findByIds(dmOtherIds) : [];
    const dmUserMap = new Map(dmUsers.map(other => [String(other._id), other]));
    const dmItems = (await Promise.all(conversations.map(async conv => {
      const participants = Array.isArray(conv.participants) ? conv.participants : [];
      if (!participants.includes(user.id)) return null;
      const otherId = participants.find((id: string) => id !== user.id);
      const other = otherId ? dmUserMap.get(otherId) : null;
      if (!other) return null;
      const readAt = (conv.readAt && typeof conv.readAt === 'object')
        ? failClosedCursor((conv.readAt as Record<string, unknown>)[user.id], 0)
        : 0;
      const unreadCount = await Dms.countUnread(String(conv._id), user.id, readAt);
      if (unreadCount <= 0) return null;
      const latest = await Dms.findLatestUnread(String(conv._id), user.id, readAt) as unknown as Record<string, unknown> | null;
      return {
        id: `dm:${String(conv._id)}`,
        kind: 'dm',
        unreadCount,
        createdAt: Number(latest?.createdAt ?? conv.lastMessageAt ?? 0),
        sender: sanitizeUser(other),
        preview: previewFor(latest),
        destination: { type: 'dm', dmId: String(conv._id), user: sanitizeUser(other) },
      };
    }))).filter((item): item is NonNullable<typeof item> => item !== null);

    // GDM attention is likewise derived from the current membership row's
    // read cursor. Losing membership removes the row from this query entirely.
    const memberships = await GroupDms.findGroupsByUser(user.id) as Array<Record<string, unknown>>;
    const gdmItems = (await Promise.all(memberships.map(async membership => {
      const groupId = String(membership.groupId ?? '');
      const group = groupId ? await GroupDms.findById(groupId) : null;
      if (!group) return null;
      const after = membershipCursor(membership);
      const unreadCount = await GroupDms.countUnread(groupId, user.id, after);
      if (unreadCount <= 0) return null;
      const latest = await GroupDms.findLatestUnread(groupId, user.id, after) as unknown as Record<string, unknown> | null;
      return {
        id: `gdm:${groupId}`,
        kind: 'gdm',
        unreadCount,
        createdAt: Number(latest?.createdAt ?? group.lastMessageAt ?? 0),
        sender: latest ? {
          _id: String(latest.userId ?? ''),
          displayName: String(latest.displayName ?? 'Bridge user'),
          avatarColor: String(latest.avatarColor ?? '#2d9cdb'),
        } : null,
        preview: previewFor(latest),
        destination: {
          type: 'gdm', groupId,
          group: {
            _id: groupId,
            name: String(group.name ?? 'Grup DM'),
            icon: group.icon ?? null,
            ownerId: group.ownerId,
            lastMessageAt: group.lastMessageAt,
          },
        },
      };
    }))).filter((item): item is NonNullable<typeof item> => item !== null);

    // Saved follow-up reminders are personal identifiers only. They point
    // back to the Saved surface; message content is not copied into the
    // notification row and authorization is re-checked when Saved rehydrates.
    const reminderRows = await Notifications.findUnreadSavedReminders(user.id, 100) as Array<Record<string, unknown>>;
    const reminderItems: Array<Record<string, unknown>> = [];
    for (const row of reminderRows) {
      const savedId = String(row.noteId ?? '');
      if (!savedId || !(await SavedMessages.findByIdForUser(user.id, savedId))) {
        await Notifications.markSavedReminderRead(user.id, String(row._id ?? ''));
        continue;
      }
      reminderItems.push({
        id: String(row._id), kind: 'reminder', unreadCount: 1,
        createdAt: Number(row.createdAt ?? 0), sender: null,
        preview: 'Sonra bakmak için kaydettiğin bir mesaja dönme zamanı.',
        destination: { type: 'saved', savedId },
      });
    }

    const allItems = [...channelItems, ...dmItems, ...gdmItems, ...reminderItems]
      .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
    const counts = {
      mentions: channelItems.filter(item => item.kind === 'mention').length,
      watches: channelItems.filter(item => item.kind === 'watch').length,
      replies: channelItems.filter(item => item.kind === 'reply').length,
      dms: [...dmItems, ...gdmItems].reduce((sum, item) => sum + Number(item.unreadCount ?? 0), 0),
      reminders: reminderItems.length,
    };
    const filtered = allItems.filter(item => {
      if (filter === 'mentions') return item.kind === 'mention';
      if (filter === 'watches') return item.kind === 'watch';
      if (filter === 'replies') return item.kind === 'reply';
      if (filter === 'dms') return item.kind === 'dm' || item.kind === 'gdm';
      if (filter === 'reminders') return item.kind === 'reminder';
      return true;
    }).slice(0, MAX_RETURNED_ITEMS);

    res.json({
      items: filtered,
      counts: { ...counts, all: counts.mentions + counts.watches + counts.replies + counts.dms + counts.reminders },
      filter,
    });
  } catch {
    // No partial metadata on authorization/database failures.
    res.status(503).json({ error: 'Inbox temporarily unavailable', items: [], counts: { all: 0, mentions: 0, watches: 0, replies: 0, dms: 0, reminders: 0 } });
  }
});

router.patch('/:id/read', authMiddleware, async (req, res) => {
  const { user } = castAuthed(req);
  const id = String(req.params.id ?? '').trim();
  if (!id) return res.status(400).json({ error: 'Invalid notification' });
  await Notifications.markSavedReminderRead(user.id, id);
  return res.json({ read: true });
});

router.patch('/read-all', authMiddleware, async (req, res) => {
  const { user } = castAuthed(req);
  const now = Date.now();
  await Promise.all([
    Notifications.markAllChannelAttentionRead(user.id),
    Notifications.clearAllUnreadCounts(user.id),
    Notifications.markAllSavedRemindersRead(user.id),
  ]);

  const conversations = await Dms.findConversationsByUser(user.id);
  const memberships = await GroupDms.findGroupsByUser(user.id) as Array<Record<string, unknown>>;
  await Promise.all([
    ...conversations.map(conv => Dms.markRead(String(conv._id), user.id)),
    ...memberships.map(member => GroupDms.markRead(String(member.groupId ?? ''), user.id)),
  ]);

  res.json({ read: true, readAt: now });
});

export default router;
