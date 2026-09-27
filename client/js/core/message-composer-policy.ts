import type { OutboxEntry } from './outbox-store.ts';

export type DraftKind = 'channel' | 'dm' | 'gdm';

export interface PendingSend {
  entry: OutboxEntry;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface PendingMutation {
  nonce: string;
  messageId: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export type NewOutboxEntry = Pick<OutboxEntry,
  'channelId' | 'serverId' | 'draftKind' | 'messageType' | 'content'
  | 'replyToId' | 'replyPreview' | 'fileUrl' | 'fileName' | 'fileType'
  | 'stickerPackId' | 'stickerId' | 'stickerSnapshot'>;

export function outboxPayload(entry: OutboxEntry): Record<string, unknown> {
  return {
    channelId: entry.channelId,
    serverId: entry.serverId,
    content: entry.content,
    ...(entry.messageType === 'file' ? {
      type: 'file', fileUrl: entry.fileUrl, fileName: entry.fileName, fileType: entry.fileType,
    } : {}),
    ...(entry.messageType === 'sticker' ? {
      type: 'sticker', stickerPackId: entry.stickerPackId, stickerId: entry.stickerId,
    } : {}),
    ...(entry.replyToId ? { replyToId: entry.replyToId } : {}),
    ackId: entry.ackId,
    _tmpId: entry.ackId,
  };
}

export function optimisticOutboxMessage(entry: OutboxEntry, me: Record<string, unknown>): Record<string, unknown> {
  return {
    _id: `pending:${entry.ackId}`,
    _key: `pending:${entry.ackId}`,
    ackId: entry.ackId,
    pending: entry.state !== 'failed',
    queued: entry.state === 'queued',
    failed: entry.state === 'failed',
    lastError: entry.lastError,
    channelId: entry.channelId,
    userId: me._id ?? me.id,
    username: me.username,
    displayName: me.displayName ?? me.username,
    avatarColor: me.avatarColor,
    content: entry.content,
    type: entry.messageType === 'file' ? 'file' : entry.messageType === 'sticker' ? 'sticker' : 'normal',
    ...(entry.messageType === 'file' ? {
      fileUrl: entry.fileUrl, fileName: entry.fileName, fileType: entry.fileType,
    } : {}),
    ...(entry.messageType === 'sticker' ? { sticker: entry.stickerSnapshot } : {}),
    createdAt: entry.createdAt,
    ...(entry.replyPreview ? { replyTo: entry.replyPreview } : {}),
  };
}

export function draftKindOf(channel: { type?: string } | null): DraftKind {
  const type = String(channel?.type ?? 'text').toLowerCase();
  if (type === 'group-dm' || type === 'group_dm' || type === 'gdm') return 'gdm';
  return type === 'dm' ? 'dm' : 'channel';
}

export function draftContextKey(
  userId: string,
  channelId: string,
  kind: DraftKind,
  serverScope: string,
): string {
  return userId && channelId && serverScope ? `${userId}:${kind}:${serverScope}:${channelId}` : '';
}

export function isTextChannel(channel: { type?: string } | null): boolean {
  const type = String(channel?.type ?? 'text').toLowerCase();
  return type !== 'voice' && type !== 'stage';
}
