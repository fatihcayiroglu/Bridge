// server/socket/handlers/messages-send.ts
// Mesaj gönderme, dosya gönderme, delivery ACK, E2EE, link önizleme, bridge forwarding.
// Sprint 107: messages.ts (505 satır) modüler yapıya ayrıldı.
//   messages-send.ts  → gönderme akışı (bu dosya)
//   messages-edit.ts  → düzenleme, silme, reaksiyon
//   messages-thread.ts → thread socket events
//   messages.ts       → barrel export (geriye dönük uyumluluk)

import { v4 as uuidv4 } from 'uuid';
import {
  Messages, Members, Channels, Users,
  Notifications, Bridges,
} from '../../db/repositories';
import { hasPermission, PERMS, resolvePermissions } from '../../routes/roles';
import { sanitizeUser } from '../../lib/userUtils';
import { getCachedPerms } from '../../lib/permCache';
import { extractUrls, fetchLinkPreview } from '../../lib/linkPreview';
import { checkSpamAsync } from '../../lib/security';
// Sprint 120: T5 — Server-side DOMPurify sanitization eklendi
// sanitizeMessage() (regex tabanlı) yerine sanitizeMessageContent() (DOMPurify/jsdom) kullanılıyor
import { sanitizeMessageContent } from '../../lib/contentSanitizer';
import { cache } from '../../lib/redisAdapter';
import { processNotifications } from '../../lib/notifications';
import logger from '../../lib/logger';
import { isChannelE2EEEnabled } from '../../lib/channelE2EE';
import { getAckRecord, setAckRecord, sendAck, sendTmpAck } from '../../lib/deliveryAck';
import { tryRequire } from '../../lib/_optional-require';
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
import type { SandboxedHooks } from '../../plugins/loader';
import type { AuthUser, SendMessagePayload, SocketUser } from './messages-types';
import type { Server as IOServer, Socket } from 'socket.io';

// ── Opsiyonel bağımlılıklar ───────────────────────────────────
const _outgoingWebhooks = tryRequire<{
  dispatchEvent: (sid: string, ev: string, d: unknown) => Promise<unknown>;
}>('../../routes/outgoingWebhooks');
const _dispatchEvent = _outgoingWebhooks?.dispatchEvent ?? null;

const _pluginLoader = tryRequire<{ hooks: SandboxedHooks }>('../../plugins/loader');
const _pluginHooks = _pluginLoader?.hooks ?? null;

// ── Sprint 121 FIX 1: Slowmode — kullanıcı başına son mesaj zamanı ─────────
// Redis varsa Redis'te tutulur; yoksa process-local Map (cluster'da her node ayrı sayar,
// kabul edilebilir: kötü niyetli kullanıcı en fazla node sayısı kadar burst yapabilir)
const _slowmodeLastMsg = new Map<string, number>(); // key: `${userId}:${channelId}`

async function checkSlowmode(userId: string, channel: { _id: string; slowmode?: number }): Promise<number> {
  const interval = channel.slowmode ?? 0;
  if (interval <= 0) return 0; // Slowmode kapalı

  const key = `slowmode:${userId}:${channel._id}`;
  const now = Date.now();

  // Redis üzerinden kontrol (cluster-safe)
  try {
    const lastStr = await cache.get<string>(key);
    const last = lastStr ? parseInt(String(lastStr), 10) : 0;
    const elapsed = (now - last) / 1000;
    if (elapsed < interval) return Math.ceil(interval - elapsed);
    // İzin verildi — son mesaj zamanını güncelle
    await cache.set(key, String(now), interval + 5);
    return 0;
  } catch {
    // Redis yoksa in-memory fallback
    const last = _slowmodeLastMsg.get(key) ?? 0;
    const elapsed = (now - last) / 1000;
    if (elapsed < interval) return Math.ceil(interval - elapsed);
    _slowmodeLastMsg.set(key, now);
    // Bellek sızıntısını önle: 100k+ entry'de eski girişleri temizle
    if (_slowmodeLastMsg.size > 100_000) {
      const cutoff = now - 3_600_000;
      for (const [k, v] of _slowmodeLastMsg) { if (v < cutoff) _slowmodeLastMsg.delete(k); }
    }
    return 0;
  }
}

// ── sendChannelMessage ────────────────────────────────────────
export async function sendChannelMessage(
  payload: SendMessagePayload,
  socket: Socket,
  io: IOServer,
  user: AuthUser,
  socketUsers: Map<string, SocketUser>,
): Promise<void> {
  const {
    channelId, content, serverId, replyToId, type, fileUrl, fileName, fileType,
    encryptedContent, iv, ackId, _tmpId,
  } = payload;

  // Input validation
  const { valid } = validateSocketPayload(
    { channelId, content, serverId, replyToId, type, fileUrl, fileName, fileType },
    socketSchemas.sendMessage,
  );
  if (!valid) return;
  if (type !== 'file' && type !== 'e2ee' && !content?.trim()) return;
  if (content && content.length > 2000) return;

  // Sprint 89: E2EE mesaj tip kontrolü
  if (type === 'e2ee') {
    if (!encryptedContent || !iv) {
      socket.emit('error:e2ee', { error: 'E2EE mesaj: encryptedContent ve iv zorunlu.' });
      return;
    }
    if (encryptedContent.length > 8192 || iv.length > 64) {
      socket.emit('error:e2ee', { error: 'E2EE payload çok büyük.' });
      return;
    }
    const e2eeEnabled = await isChannelE2EEEnabled(channelId);
    if (!e2eeEnabled) {
      socket.emit('error:e2ee', { error: 'Bu kanal için E2EE kurulmamış.' });
      return;
    }
  }

  const membership = await Members.findOne(user._id, serverId);
  if (!membership) return;

  if (membership.timeoutUntil && membership.timeoutUntil > Date.now()) {
    socket.emit('error:timeout', { remaining: Math.ceil((membership.timeoutUntil - Date.now()) / 1000) });
    return;
  }

  const channel = await Channels.findByIdAndServer(channelId, serverId);
  if (!channel) return;

  const sendPerms = await getCachedPerms(user._id, serverId, resolvePermissions);
  if (!hasPermission(sendPerms, PERMS.SEND_MESSAGES)) return;

  // Sprint 121 FIX 1: Slowmode kontrolü — ADMINISTRATOR ve MANAGE_MESSAGES muaf
  if (type !== 'file') {
    const isExempt = hasPermission(sendPerms, PERMS.ADMINISTRATOR) || hasPermission(sendPerms, PERMS.MANAGE_MESSAGES);
    if (!isExempt) {
      const remaining = await checkSlowmode(user._id, channel as { _id: string; slowmode?: number });
      if (remaining > 0) {
        socket.emit('error:slowmode', { remaining, channelId });
        return;
      }
    }
  }

  // Anti-spam kontrolü
  if (type !== 'file' && content?.trim()) {
    const spamResult = await checkSpamAsync(user._id, content);
    if (spamResult.blocked) {
      socket.emit('error:spam', { reason: spamResult.reason, remainingMs: spamResult.remainingMs || 30000 });
      return;
    }
    if (spamResult.warning) {
      socket.emit('warn:spam', { message: 'Çok hızlı mesaj gönderiyorsunuz. Yavaşlayın.' });
    }
  }

  // Müzik komutları
  if (content?.startsWith('!')) {
    const musicModule = tryRequire<{
      handleMusicCommand: (opts: Record<string, unknown>) => Promise<boolean>;
    }>('./music');
    if (musicModule) {
      const handled = await musicModule.handleMusicCommand({ content, channelId, serverId, user, io, socket });
      if (handled) return;
    }
  }

  const msgData: Record<string, unknown> = {
    _id: uuidv4(), channelId, serverId,
    userId: user._id, username: user.username,
    displayName: membership.nickname || user.displayName,
    avatarColor: user.avatarColor, avatarUrl: user.avatarUrl || null,
    content: content ? sanitizeMessageContent(content) : '',
    type: type || 'normal',
    reactions: {},
    createdAt: Date.now(),
  };

  if (type === 'file') {
    msgData.fileUrl = fileUrl;
    msgData.fileName = fileName;
    msgData.fileType = fileType;
  }
  if (type === 'e2ee') {
    msgData.content          = ''; // plaintext asla saklanmaz
    msgData.encryptedContent = encryptedContent;
    msgData.iv               = iv;
  }

  if (replyToId) {
    const replyTo = await Messages.findById(replyToId);
    // Güvenlik: replyTo mesajının aynı kanal ve sunucuya ait olduğunu doğrula.
    // Bu kontrol olmadan saldırgan, erişimi olmayan kanalların mesaj içeriğini
    // replyTo önizlemesi üzerinden okuyabilir (bilgi sızıntısı).
    if (replyTo && replyTo.channelId === channelId && replyTo.serverId === serverId) {
      msgData.replyTo = {
        _id: replyTo._id,
        displayName: replyTo.displayName,
        content: replyTo.content?.slice(0, 100),
      };
    }
  }

  // Sprint 89: ACK deduplication
  if (ackId && typeof ackId === 'string' && ackId.length <= 64) {
    const existing = await getAckRecord(ackId);
    if (existing) {
      sendAck(socket, ackId, existing);
      return;
    }
  }

  const msg = await Messages.create(msgData);
  io.to(`channel:${channelId}`).emit('message:new', msg);

  // Delivery ACK
  const validTmpId = _tmpId && typeof _tmpId === 'string' && _tmpId.length <= 64;
  if (ackId && typeof ackId === 'string' && ackId.length <= 64) {
    const ackRecord = {
      messageId: String(msg._id), channelId, userId: user._id, ts: Date.now(),
      ...(validTmpId ? { tmpId: _tmpId } : {}),
    };
    await setAckRecord(ackId, ackRecord);
    sendAck(socket, ackId, ackRecord);
  } else if (validTmpId && _tmpId) {
    sendTmpAck(socket, _tmpId, String(msg._id), channelId);
  }

  // Outgoing webhooks
  if (_dispatchEvent) {
    _dispatchEvent(serverId, 'message:new', {
      channelId, messageId: msg._id, content: msg.content?.slice(0, 500), username: msg.displayName,
    }).catch(() => {});
  }

  // Plugin hooks
  if (_pluginHooks) {
    _pluginHooks.emit('message:created', {
      messageId: msg._id, channelId, serverId, userId: user._id,
      content: msg.content, displayName: msg.displayName,
    })?.catch?.(() => {});
  }

  // Otomatik link önizleme (non-blocking) — Sprint 121 FIX 14: seri → paralel
  if (type !== 'file' && content) {
    const urls = extractUrls(content, 3);
    if (urls.length) {
      (async () => {
        try {
          const previews = await Promise.all(urls.map(u => fetchLinkPreview(u).catch(() => null)));
          const embeds = previews.filter((p): p is NonNullable<typeof p> => p !== null);
          if (embeds.length) {
            await Messages.update(msg._id, { embeds: JSON.stringify(embeds) });
            io.to(`channel:${channelId}`).emit('message:embedUpdate', { messageId: msg._id, embeds });
          }
        } catch { /* non-fatal */ }
      })();
    }
  }

  // Cache invalidate
  try {
    await cache.del(`messages:${channelId}:first:50`);
    await cache.del(`messages:${channelId}:first:100`);
  } catch { /* non-fatal */ }

  // Mention notification sistemi
  try {
    await processNotifications(msg, io, socketUsers);
  } catch { /* non-fatal */ }

  // Bridge forwarding
  try {
    const bridges = await Bridges.findActiveFromSourceChannel(channelId);
    for (const bridge of bridges) {
      if (type === 'file') continue;
      const bMsg = await Messages.create({
        _id: uuidv4(), channelId: bridge.targetChannelId, serverId: bridge.targetServerId,
        userId: user._id, username: user.username, displayName: user.displayName,
        avatarColor: user.avatarColor, avatarUrl: user.avatarUrl || null,
        content: `🌉 **[${bridge.label || 'Bridge'}]** ${content?.trim() || ''}`,
        type: 'normal', reactions: {}, createdAt: Date.now(),
        bridgedFrom: { channelId, serverId },
      });
      io.to(`channel:${bridge.targetChannelId}`).emit('message:new', bMsg);
    }
  } catch { /* non-fatal */ }

  // Sprint 121 FIX 11: @mention bildirimleri — O(n) socketUsers taraması yerine
  // userId → [socketId] ters index kullanılıyor (büyük sunucularda 10x daha hızlı)
  const mentionIds: string[] = [];
  const newMentions = content?.match(/<@([a-zA-Z0-9_-]+)>/g);
  if (newMentions) mentionIds.push(...newMentions.map((m: string) => m.slice(2, -1)));
  const oldMentions = content?.match(/@([a-zA-Z0-9_]+)/g);
  if (oldMentions) {
    const usernames = oldMentions.map((m: string) => m.slice(1).toLowerCase());
    const found = await Users.findByUsernames(usernames);
    mentionIds.push(...found.map((u: AuthUser) => u._id));
  }

  // Ters index oluştur: userId → socketId[]
  const userSocketIndex = new Map<string, string[]>();
  for (const [sid, su] of socketUsers) {
    const uid = String(su._id || su.id || '');
    if (!uid) continue;
    const existing = userSocketIndex.get(uid);
    if (existing) existing.push(sid);
    else userSocketIndex.set(uid, [sid]);
  }

  for (const uid of [...new Set(mentionIds)]) {
    if (uid === user._id) continue;
    const pref = await Notifications.findPref(uid, channelId);
    if (pref && pref.level === 'mute') continue;
    const sids = userSocketIndex.get(uid) ?? [];
    for (const sid of sids) {
      io.to(sid).emit('mention:received', {
        fromUser: sanitizeUser(user), channelId, serverId,
        messageId: msg._id, preview: content!.slice(0, 80),
      });
    }
  }
}

// ── registerSendHandlers ──────────────────────────────────────
export function registerSendHandlers(
  socket: Socket,
  io: IOServer,
  user: AuthUser,
  socketUsers: Map<string, SocketUser>,
): void {
  socket.on('message:send', (data: SendMessagePayload) =>
    sendChannelMessage(data, socket, io, user, socketUsers),
  );
  socket.on('message:reply', (data: SendMessagePayload & { replyToId: string }) =>
    sendChannelMessage({ ...data, replyToId: data.replyToId }, socket, io, user, socketUsers),
  );

  socket.on('file:send', async ({
    channelId, serverId, fileName, fileUrl, fileType,
  }: {
    channelId: string; serverId: string; fileName: string; fileUrl: string; fileType: string;
  }) => {
    if (!validateSocketPayload({ channelId, serverId, fileName, fileUrl, fileType }, socketSchemas.fileSend).valid) return;
    if (!fileUrl || !fileName) return;
    // Güvenlik: path traversal koruması — normalize edilmiş URL /uploads/ ile başlamalı.
    // startsWith kontrolü tek başına yeterli değil: "/uploads/../secret" gibi değerleri geçirebilir.
    if (!fileUrl.startsWith('/uploads/')) return;
    // URL normalize ederek path traversal karakterlerini temizle
    try {
      const normalizedUrl = new URL(fileUrl, 'http://localhost').pathname;
      if (!normalizedUrl.startsWith('/uploads/') || normalizedUrl.includes('..')) return;
    } catch { return; }
    const safeFileName = String(fileName).replace(/[<>"']/g, '_').slice(0, 200);
    const membership = await Members.findOne(user._id, serverId);
    if (!membership) return;
    if (membership.timeoutUntil && membership.timeoutUntil > Date.now()) {
      socket.emit('error:timeout', { remaining: Math.ceil((membership.timeoutUntil - Date.now()) / 1000) });
      return;
    }
    const channel = await Channels.findByIdAndServer(channelId, serverId);
    if (!channel) return;
    const sendPerms = await getCachedPerms(user._id, serverId, resolvePermissions);
    if (!hasPermission(sendPerms, PERMS.SEND_MESSAGES)) return;
    const msg = await Messages.create({
      _id: uuidv4(), channelId, serverId, userId: user._id, username: user.username,
      displayName: user.displayName, avatarColor: user.avatarColor, avatarUrl: user.avatarUrl || null,
      content: '', type: 'file', fileName: safeFileName, fileUrl, fileType,
    });
    io.to(`channel:${channelId}`).emit('message:new', msg);
  });

  const emitTyping = (channelId: unknown, typing: boolean) => {
    if (typeof channelId !== 'string' || channelId.length === 0) return;
    socket.to(`channel:${channelId}`).emit('typing:update', {
      channelId,
      userId: user._id,
      username: user.username,
      typing,
    });
  };

  socket.on('typing:start', (payload: { channelId?: unknown }) => emitTyping(payload?.channelId, true));
  socket.on('typing:stop',  (payload: { channelId?: unknown }) => emitTyping(payload?.channelId, false));
}
