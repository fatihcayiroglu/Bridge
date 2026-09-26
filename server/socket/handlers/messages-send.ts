// server/socket/handlers/messages-send.ts
// Mesaj gönderme, dosya gönderme, delivery ACK, E2EE, link önizleme, bridge forwarding.
// Sprint 107: messages.ts (505 satır) modüler yapıya ayrıldı.
//   messages-send.ts  → gönderme akışı (bu dosya)
//   messages-edit.ts  → düzenleme, silme, reaksiyon
//   messages-thread.ts → thread socket events
//   messages.ts       → barrel export (geriye dönük uyumluluk)

import type { HandlerSocket, HandlerServer } from '../handler-contracts';
import { v4 as uuidv4 } from 'uuid';
import { effectiveNotificationPref, isMuted } from '../../lib/notificationMute';
import {
  Messages, Members, Channels, Users,
  Notifications, Bridges, Automod, ServerAssets,
} from '../../db/repositories';
import { hasPermission, PERMS, resolvePermissions } from '../../routes/roles';
import { canViewChannel, explainResolvedPermission, resolvePermissionResolution } from '../../lib/permissions';
import { sanitizeUser } from '../../lib/userUtils';
import { getCachedPerms } from '../../lib/permCache';
import { extractUrls, fetchLinkPreview } from '../../lib/linkPreview';
import { checkSpamAsync } from '../../lib/security';
import { evaluateAutomodRules } from '../../lib/automodPolicy';
import { normalizeAutomodMemberRoleIds, writeAutomodLogs } from '../../lib/automodRuntime';
// Sprint 120: T5 — Server-side DOMPurify sanitization eklendi
// sanitizeMessage() (regex tabanlı) yerine sanitizeMessageContent() (DOMPurify/jsdom) kullanılıyor
import { normalizeMessageText, RAW_TEXT_FORMAT } from '../../lib/storedText';
import { cache, isRedisAvailable } from '../../lib/redisAdapter';
import { invalidateChannelMessages } from '../../lib/messageCache';
import { announceChannelActivity, publishPersistedMessage } from '../../lib/channelActivity';
import { processNotifications, incrementUnread } from '../../lib/notifications';
import logger from '../../lib/logger';
import { isChannelE2EEEnabled } from '../../lib/channelE2EE';
import { getAckRecord, setAckRecord, sendAck, sendTmpAck } from '../../lib/deliveryAck';
import { tryRequire } from '../../lib/_optional-require';
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
import type { SandboxedHooks } from '../../plugins/loader';
import type { AuthUser, SendMessagePayload, SocketUser } from './messages-types';
import { isolateSocketHandler } from '../handlerIsolation';
import { dispatchRegisteredBotCommand } from '../../lib/botCommandDispatch';
import { isMemberTimedOut, parseMemberTimeoutUntil } from '../../lib/memberTimeout';

// ── Opsiyonel bağımlılıklar ───────────────────────────────────
const _outgoingWebhooks = tryRequire<{
  dispatchEvent: (sid: string, ev: string, d: unknown) => Promise<unknown>;
}>('../../routes/outgoingWebhooks', require);
const _dispatchEvent = _outgoingWebhooks?.dispatchEvent ?? null;

const _pluginLoader = tryRequire<{ hooks: SandboxedHooks }>('../../plugins/loader', require);
const _pluginHooks = _pluginLoader?.hooks ?? null;

// ── Sprint 121 FIX 1: Slowmode — kullanıcı başına son mesaj zamanı ─────────
// Redis varsa Redis'te tutulur; yoksa process-local Map (cluster'da her node ayrı sayar,
// kabul edilebilir: kötü niyetli kullanıcı en fazla node sayısı kadar burst yapabilir)
const _slowmodeLastMsg = new Map<string, number>();
const REDIS_CONFIGURED = Boolean(process.env.REDIS_URL); // key: `${userId}:${channelId}`

async function checkSlowmode(userId: string, channel: { _id: string; slowmode?: number }): Promise<number> {
  const interval = channel.slowmode ?? 0;
  if (interval <= 0) return 0; // Slowmode kapalı

  const key = `slowmode:${userId}:${channel._id}`;
  const now = Date.now();
  const intervalMs = interval * 1000;

  // Canonical adapter path. With Redis this is one Lua operation rather than
  // the old GET -> SET TOCTOU window that let concurrent sends both pass.
  // Without Redis the adapter performs the same claim atomically in-process.
  if (REDIS_CONFIGURED && !isRedisAvailable()) return interval;
  if (typeof cache.claimCooldown === 'function') {
    try {
      const remainingMs = await cache.claimCooldown(key, intervalMs, intervalMs + 5_000, now);
      return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
    } catch {
      if (REDIS_CONFIGURED) return interval;
    }
  }

  // Compatibility-only fallback for older test adapters/plugins. Production's
  // canonical redisAdapter always exposes claimCooldown.
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

/** Only references created by the canonical upload route may become file messages. */
/**
 * Dosya basvurusunun BICIMI guvenli mi?
 *
 * Yalnizca yol sekliyle ilgilenir: `/uploads/` altinda mi, dizin gecisi
 * iceriyor mu. Basvurunun GERCEK olup olmadigini SOYLEMEZ — onun icin
 * `isOwnedUploadReference` kullanilir.
 */
function isSafeUploadReference(fileUrl: unknown, fileName: unknown): fileUrl is string {
  if (typeof fileUrl !== 'string' || typeof fileName !== 'string' || !fileUrl || !fileName) return false;
  if (!fileUrl.startsWith('/uploads/')) return false;
  try {
    const pathname = new URL(fileUrl, 'http://localhost').pathname;
    const decoded = decodeURIComponent(pathname);
    return pathname.startsWith('/uploads/') && decoded.startsWith('/uploads/') && !decoded.includes('..');
  } catch {
    return false;
  }
}

/**
 * ════════════════════════════════════════════════════════════════════════════
 * KAPATILAN GERCEK ACIK — SAHTE DOSYA BASVURUSU
 * ════════════════════════════════════════════════════════════════════════════
 * `isSafeUploadReference` YALNIZCA yol seklini dogruluyordu. Adi ve E2E testi
 * ("kayitli olmayan bir fileUrl ile file:send mesaj olusturmaz") KAYIT
 * denetimi vaat ediyordu ama boyle bir denetim YOKTU: `/uploads/` ile baslayan
 * HERHANGI bir yol kabul ediliyordu.
 *
 * Sonuclari:
 *   · Hic yuklenmemis bir dosyaya isaret eden mesajlar olusturulabiliyordu
 *     (canli veritabaninda 28 ornek bulundu).
 *   · Daha kotusu: BASKASININ yukledigi dosyanin yolu tahmin/ele gecirilirse,
 *     saldirgan onu KENDI kanalinda mesaj olarak yayimlayabiliyordu. Ek
 *     erisimi mesaj gorunurlugu uzerinden cozuldugu icin bu, dosyayi hic
 *     gormemesi gereken kisilere acardi.
 *
 * Kusur, mesaj listesi onbelleginin bayat kalmasi yuzunden E2E testinde
 * GORUNMUYORDU: test sahte mesaji hic okumuyordu. Onbellek gecersiz kilma
 * duzeltilince ortaya cikti.
 *
 * Kural: basvuru `uploads` tablosunda KAYITLI olmali VE cagirana ait olmali.
 * Kayit yazimi en iyi cabadir (`recordUpload` sessizce basarisiz olabilir),
 * bu yuzden hata durumunda FAIL-CLOSED davranilir: dogrulanamayan basvuru
 * reddedilir.
 */
async function isOwnedUploadReference(fileUrl: string, userId: string): Promise<boolean> {
  try {
    const pathname = new URL(fileUrl, 'http://localhost').pathname;
    // `uploads` tablosu anahtari BASTAKI SLASH OLMADAN saklar
    // (`uploads/<uuid>.png`), yol ise `/uploads/...` bicimindedir.
    const key = decodeURIComponent(pathname).replace(/^\/+/, '');
    if (!key.startsWith('uploads/')) return false;

    const { default: db } = await import('../../db/loader');
    const record = await (db as unknown as {
      uploads: { findOne(q: Record<string, unknown>): Promise<Record<string, unknown> | null> };
    }).uploads.findOne({ key, userId });
    return Boolean(record);
  } catch {
    return false;   // fail-closed
  }
}

// ── sendChannelMessage ────────────────────────────────────────
export async function sendChannelMessage(
  payload: SendMessagePayload,
  socket: HandlerSocket,
  io: HandlerServer,
  user: AuthUser,
  socketUsers: Map<string, SocketUser>,
): Promise<void> {
  const {
    channelId, content, serverId, replyToId, type, fileUrl, fileName, fileType,
    stickerPackId, stickerId, encryptedContent, iv, ackId, _tmpId,
  } = payload;
  const validAckId = typeof ackId === 'string' && ackId.length > 0 && ackId.length <= 64;
  const validTmpId = typeof _tmpId === 'string' && _tmpId.length > 0 && _tmpId.length <= 64;

  // Input validation
  const { valid } = validateSocketPayload(
    { channelId, content, serverId, replyToId, type, fileUrl, fileName, fileType, stickerPackId, stickerId },
    socketSchemas.sendMessage,
  );
  // ════════════════════════════════════════════════════════════════════════
  // KAPATILAN GERCEK KUSUR — SESSIZ DUSURME "ZAMAN ASIMI" GIBI GORUNUYORDU
  // ════════════════════════════════════════════════════════════════════════
  // Bu uc kontrol `return;` ile SESSIZCE cikiyordu: ne ACK ne hata.
  // Istemci (`MessageInputPanel`) 10 sn bekleyip KENDI zaman asimini yazar:
  // "Sunucu onayi zaman asimina ugradi."
  //
  // Sonuc: KASITLI BIR REDDETME, SUNUCU CEVAP VERMIYOR gibi gorunuyordu.
  // Bunlar farkli sorunlardir ve farkli davranis gerektirir (duzelt vs.
  // yeniden dene). Hemen ASAGIDAKI dosya kontrolu zaten dogru sozlesmeyi
  // uyguluyordu (`INVALID_FILE_REFERENCE` + ackId/tmpId yankisi); eksik olan
  // dogrulama dallariydi.
  //
  // OLCUM: `type: 'text'` iceren — tamamen makul gorunen — bir yuk sema
  // enum'una (`['normal','file']`) uymadigi icin sessizce dusuruldu; ayni yuk
  // `type` alani olmadan ACK aldi.
  //
  // GUVENLIK: kod SABIT ve makine-okunur; sema/ic hata metni SIZDIRILMAZ.
  const reject = (code: string, message: string): void => {
    socket.emit('error:message', {
      event: 'message:send', code, message,
      ...(validAckId ? { ackId } : {}), ...(validTmpId ? { tmpId: _tmpId } : {}),
    });
  };

  // UZUNLUK once kontrol edilir. Sema de `content` icin `max: 2000` uygular;
  // sema ONCE calisirsa asiri uzun mesaj genel `INVALID_PAYLOAD` ile reddedilir
  // ve kullanici NEDEN reddedildigini ogrenemez (olculdu: 2500 karakter →
  // INVALID_PAYLOAD). Sema yine de asagida calisir — dogrulama ZAYIFLAMAZ,
  // yalnizca sebep DOGRU adlandirilir.
  if (typeof content === 'string' && content.length > 2000) {
    reject('MESSAGE_TOO_LONG', 'Mesaj çok uzun (en fazla 2000 karakter).');
    return;
  }
  if (!valid) {
    reject('INVALID_PAYLOAD', 'Mesaj isteği geçersiz.');
    return;
  }
  if (type !== 'file' && type !== 'e2ee' && type !== 'sticker' && !content?.trim()) {
    reject('EMPTY_MESSAGE', 'Boş mesaj gönderilemez.');
    return;
  }

  if (type === 'file'
      && (!isSafeUploadReference(fileUrl, fileName)
          || !await isOwnedUploadReference(fileUrl, user._id))) {
    socket.emit('error:message', {
      event: 'message:send', code: 'INVALID_FILE_REFERENCE', message: 'Dosya başvurusu geçersiz veya artık kullanılamıyor.',
      ...(validAckId ? { ackId } : {}), ...(validTmpId ? { tmpId: _tmpId } : {}),
    });
    return;
  }

  if (type === 'sticker' && (!stickerPackId || !stickerId)) {
    reject('INVALID_STICKER_REFERENCE', 'Sticker başvurusu geçersiz veya artık kullanılamıyor.');
    return;
  }

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
  if (!membership) {
    socket.emit('error:message', {
      event: 'message:send', code: 'NOT_A_MEMBER', message: 'Bu sunucunun üyesi değilsiniz.',
      ...(validAckId ? { ackId } : {}), ...(validTmpId ? { tmpId: _tmpId } : {}),
    });
    return;
  }

  if (isMemberTimedOut(membership.timeoutUntil)) {
    const timeoutUntil = parseMemberTimeoutUntil(membership.timeoutUntil)!;
    socket.emit('error:timeout', { remaining: Math.ceil((timeoutUntil - Date.now()) / 1000), ...(validAckId ? { ackId } : {}), ...(validTmpId ? { tmpId: _tmpId } : {}) });
    return;
  }

  const channel = await Channels.findByIdAndServer(channelId, serverId);
  if (!channel) {
    socket.emit('error:message', {
      event: 'message:send', code: 'CHANNEL_NOT_FOUND', message: 'Kanal artık kullanılamıyor.',
      ...(validAckId ? { ackId } : {}), ...(validTmpId ? { tmpId: _tmpId } : {}),
    });
    return;
  }

  const sendPerms = await getCachedPerms(user._id, serverId, resolvePermissions, channelId);
  // Knowing a channel id must never be enough to write into a channel the
  // current user cannot view. SEND_MESSAGES alone is not a visibility grant.
  if (!hasPermission(sendPerms, PERMS.VIEW_CHANNELS)) {
    reject('MISSING_PERMISSION', 'Bu kanalı görüntüleme yetkiniz yok.');
    return;
  }
  if (!hasPermission(sendPerms, PERMS.SEND_MESSAGES)) {
    const resolution = await resolvePermissionResolution(user._id, serverId, channelId);
    const resolvedExplanation = explainResolvedPermission(
      resolution,
      PERMS.SEND_MESSAGES,
      'Bu kanala mesaj gönderme yetkiniz yok.',
    );
    const explanation = resolvedExplanation.allowed
      ? { reasonCode: 'MISSING_PERMISSION', message: 'Bu kanala mesaj gönderme yetkiniz yok.' }
      : resolvedExplanation;
    socket.emit('error:message', {
      event: 'message:send', code: explanation.reasonCode, message: explanation.message,
      ...(validAckId ? { ackId } : {}), ...(validTmpId ? { tmpId: _tmpId } : {}),
    });
    return;
  }
  if (type === 'file' && !hasPermission(sendPerms, PERMS.ATTACH_FILES)) {
    reject('MISSING_PERMISSION', 'Bu kanala dosya gönderme yetkiniz yok.');
    return;
  }

  let stickerSnapshot: { id: string; packId: string; name: string; url: string; width: number; height: number } | null = null;
  if (type === 'sticker') {
    // Resolve only after membership/channel authorization so sticker ids cannot
    // become a cross-server existence oracle. Pack and item identities are both
    // scoped by the current server before a message snapshot is created.
    const pack = await ServerAssets.findStickerPackByIdAndServer(String(stickerPackId), serverId);
    const item = pack
      ? await ServerAssets.findStickerItemByIdAndPack(String(stickerId), String(stickerPackId))
      : null;
    const safeUrl = item && typeof item.url === 'string'
      && /^\/uploads\/stickers\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.url)
      && !item.url.includes('..');
    if (!pack || !item || !safeUrl) {
      reject('INVALID_STICKER_REFERENCE', 'Sticker başvurusu geçersiz veya artık kullanılamıyor.');
      return;
    }
    const width = Number(item.width);
    const height = Number(item.height);
    stickerSnapshot = {
      id: String(item._id),
      packId: String(pack._id),
      name: String(item.name ?? '').slice(0, 100),
      url: String(item.url),
      width: Number.isSafeInteger(width) && width > 0 && width <= 4096 ? width : 160,
      height: Number.isSafeInteger(height) && height > 0 && height <= 4096 ? height : 160,
    };
  }

  // Authorization must be re-evaluated before revealing a prior delivery or
  // durable message identifier. A user whose membership/permission was revoked
  // after the first send may no longer use an old ACK id as a read side-channel.
  // Once current access is established, idempotency still precedes every
  // mutable policy/rate-limit side effect below.
  if (validAckId) {
    const existing = await getAckRecord(ackId, user._id);
    if (existing) {
      sendAck(socket, ackId, existing);
      return;
    }

    // Redis/in-memory is only an acceleration layer. Database truth survives
    // a backend restart and closes the ACK-lost -> replay duplicate window.
    const durable = await Messages.findByAckIdForUser(ackId, user._id);
    if (durable) {
      const record = {
        messageId: String(durable._id), channelId: String(durable.channelId),
        userId: user._id, ts: Number(durable.createdAt ?? Date.now()),
        ...(validTmpId ? { tmpId: _tmpId } : {}),
      };
      await setAckRecord(ackId, record);
      sendAck(socket, ackId, record);
      return;
    }
  }

  // Sprint 121 FIX 1: Slowmode kontrolü — ADMINISTRATOR ve MANAGE_MESSAGES muaf
  if (type !== 'file') {
    const isExempt = hasPermission(sendPerms, PERMS.ADMINISTRATOR) || hasPermission(sendPerms, PERMS.MANAGE_MESSAGES);
    if (!isExempt) {
      const remaining = await checkSlowmode(user._id, channel as { _id: string; slowmode?: number });
      if (remaining > 0) {
        socket.emit('error:slowmode', { remaining, channelId, ...(validAckId ? { ackId } : {}), ...(validTmpId ? { tmpId: _tmpId } : {}) });
        return;
      }
    }
  }

  // Anti-spam kontrolü
  // Final21 UX (U-11): ret olayları gönderimin ackId'sini TAŞIR. Eskiden taşımıyordu;
  // istemci hangi bekleyen mesajın reddedildiğini bilemedi, 10 sn ACK bekledi ve
  // kullanıcıya gerçek nedeni ("çok hızlı") değil "sunucu onayı zaman aşımına
  // uğradı" gösterdi. Ek alan yalnız yankıdır; karar ve süre DEĞİŞMEDİ.
  if (type !== 'file' && content?.trim()) {
    const spamResult = await checkSpamAsync(user._id, content);
    if (spamResult.blocked) {
      socket.emit('error:spam', { reason: spamResult.reason, remainingMs: spamResult.remainingMs || 30000, ...(validAckId ? { ackId } : {}), ...(validTmpId ? { tmpId: _tmpId } : {}) });
      return;
    }
    if (spamResult.warning) {
      socket.emit('warn:spam', { message: 'Çok hızlı mesaj gönderiyorsunuz. Yavaşlayın.', ...(validAckId ? { ackId } : {}), ...(validTmpId ? { tmpId: _tmpId } : {}) });
    }
  }

  // Persisted realtime AutoMod rules. Rule lookup failure propagates to `isolate` so
  // a storage outage cannot silently disable configured moderation (fail-closed).
  if (type !== 'file' && type !== 'e2ee' && content?.trim()) {
    const automodRules = await Automod.findByServer(serverId);
    const decision = await evaluateAutomodRules(
      automodRules,
      {
        serverId,
        userId: user._id,
        content,
        memberRoleIds: normalizeAutomodMemberRoleIds((membership as { roles?: unknown }).roles),
      },
      (key, ttlSeconds) => cache.increment(key, ttlSeconds),
    );

    if (decision.matched) {
      if (decision.timeoutMs) {
        // Durable timeout is part of the action. If this fails, do not persist the triggering
        // message and pretend the moderation action succeeded.
        await Members.setTimeout(serverId, user._id, Date.now() + decision.timeoutMs);
      }
      await writeAutomodLogs(
        decision,
        {
          serverId,
          channelId,
          userId: user._id,
          displayName: membership.nickname || user.displayName || user.username,
          content,
        },
        io,
      );
      if (decision.deleteMessage) {
        reject('AUTOMOD_BLOCKED', decision.reasons.join(', ') || 'Mesaj AutoMod tarafından engellendi.');
        return;
      }
    }
  }

  // Müzik komutları
  if (content?.startsWith('!')) {
    const musicModule = tryRequire<{
      handleMusicCommand: (opts: Record<string, unknown>) => Promise<boolean>;
    }>('./music', require);
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
    // RAW text (Final21 Phase 16): the HTML sanitizer destroyed ordinary text such as
    // `Vec<String>` and protected nothing — no surface renders message content as HTML.
    content: normalizeMessageText(content),
    contentFormat: RAW_TEXT_FORMAT,
    type: type || 'normal',
    reactions: {},
    createdAt: Date.now(),
    ...(validAckId ? { ackId } : {}),
  };
  let replyTargetUserId: string | null = null;

  if (type === 'file') {
    msgData.fileUrl = fileUrl;
    msgData.fileName = fileName;
    msgData.fileType = fileType;
  }
  if (type === 'sticker' && stickerSnapshot) {
    msgData.sticker = stickerSnapshot;
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
      replyTargetUserId = String(replyTo.userId ?? '') || null;
      msgData.replyTo = {
        _id: replyTo._id,
        displayName: replyTo.displayName,
        content: replyTo.content?.slice(0, 100),
        // The snapshot is a copy of the referenced row, so it keeps that row's format.
        contentFormat: replyTo.contentFormat ?? 0,
      };
    }
  }

  let msg;
  try {
    msg = await Messages.create(msgData);
  } catch (error) {
    // Concurrent emits can both miss the preflight lookup. The per-user unique
    // index chooses one winner; the loser resolves to that canonical row.
    if (validAckId) {
      const durable = await Messages.findByAckIdForUser(ackId, user._id);
      if (durable) {
        const record = {
          messageId: String(durable._id), channelId: String(durable.channelId),
          userId: user._id, ts: Number(durable.createdAt ?? Date.now()),
          ...(validTmpId ? { tmpId: _tmpId } : {}),
        };
        await setAckRecord(ackId, record);
        sendAck(socket, ackId, record);
        return;
      }
    }
    throw error;
  }
  const publicMsg = { ...msg } as Record<string, unknown>;
  delete publicMsg.ackId;
  io.to(`channel:${channelId}`).emit('message:new', publicMsg);
  announceChannelActivity(io, publicMsg);
  // Bot slash delivery is direct-to-bot rather than broad channel subscription.
  // The chat message is already durable; bot delivery is an optional realtime
  // side effect and therefore never weakens message persistence semantics.
  if (hasPermission(sendPerms, PERMS.USE_BOT_COMMANDS)) {
    void dispatchRegisteredBotCommand(io, publicMsg as unknown as import('../../lib/botCommandDispatch').SlashDispatchMessage);
  }

  // Delivery ACK
  if (validAckId) {
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
    }).catch((err: unknown) => {
      logger.warn({ event: 'outgoing_webhook_dispatch_failed', serverId, channelId,
        messageId: String(msg._id), err: err instanceof Error ? err.message : String(err) },
      'Outgoing webhook dispatch failed after message persistence');
    });
  }

  // Plugin hooks
  if (_pluginHooks) {
    _pluginHooks.emit('message:created', {
      messageId: msg._id, channelId, serverId, userId: user._id,
      content: msg.content, displayName: msg.displayName,
    })?.catch?.((err: unknown) => {
      logger.warn({ event: 'plugin_message_created_hook_failed', serverId, channelId,
        messageId: String(msg._id), err: err instanceof Error ? err.message : String(err) },
      'Plugin message:created hook failed');
    });
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

  // Cache invalidate — ONEK BAZLI.
  //
  // Onceden yalnizca `first:50` ve `first:100` siliniyordu; oysa limit
  // 1..100 arasi HERHANGI bir deger olabilir. `?limit=25` ile okuyan bir
  // istemci, adaptif TTL suresince (sessiz kanalda 45s) BAYAT liste
  // aliyordu.
  await invalidateChannelMessages(String(channelId));

  // Mention notification sistemi
  try {
    const excluded = new Set<string>();
    if (replyTargetUserId && replyTargetUserId !== user._id
      && await canViewChannel(replyTargetUserId, serverId, channelId)) {
      const [channelPref, serverPref] = await Promise.all([
        Notifications.findPref(replyTargetUserId, channelId),
        Notifications.findServerPref(replyTargetUserId, serverId),
      ]);
      const pref = effectiveNotificationPref(channelPref, serverPref);
      if (!isMuted(pref)) {
        const inserted = await Notifications.insertChannelAttention({
          userId: replyTargetUserId,
          type: 'reply',
          serverId,
          channelId,
          messageId: String(msg._id),
          actorId: user._id,
          createdAt: Number(msg.createdAt ?? Date.now()),
        });
        if (inserted) {
          excluded.add(replyTargetUserId);
          await incrementUnread(replyTargetUserId, channelId);
          io.to(`user:${replyTargetUserId}`).emit('notification:reply', {
            type: 'reply', messageId: msg._id, channelId, serverId,
            fromUser: msg.displayName, fromUserId: user._id,
            preview: String(msg.content ?? '').slice(0, 100), createdAt: msg.createdAt,
          });
          io.to(`user:${replyTargetUserId}`).emit('inbox:changed', { reason: 'reply' });
        }
      }
    }
    await processNotifications(msg, io, socketUsers, excluded);
  } catch (err) {
    logger.warn({ event: 'message_notification_pipeline_failed', serverId, channelId,
      messageId: String(msg._id), err: err instanceof Error ? err.message : String(err) },
    'Message persisted but notification pipeline failed');
  }

  // Bridge forwarding
  try {
    const bridges = await Bridges.findActiveFromSourceChannel(channelId);
    for (const bridge of bridges) {
      if (type === 'file' || type === 'sticker') continue;
      // Persistent bridge rows are not authority by themselves: legacy/corrupt
      // rows must not be able to cross tenants by pairing arbitrary ids.
      if (String(bridge.sourceChannelId) !== channelId || String(bridge.sourceServerId) !== serverId) {
        logger.warn({ bridgeId: bridge._id, channelId, serverId, event: 'bridge.integrity.source_mismatch' },
          'Bridge forwarding skipped because source tenant identity is inconsistent.');
        continue;
      }
      const targetChannel = await Channels.findByIdAndServer(String(bridge.targetChannelId), String(bridge.targetServerId)).catch(() => null);
      if (!targetChannel) {
        logger.warn({ bridgeId: bridge._id, targetChannelId: bridge.targetChannelId, targetServerId: bridge.targetServerId,
          event: 'bridge.integrity.target_mismatch' }, 'Bridge forwarding skipped because target tenant identity is invalid.');
        continue;
      }
      const bMsg = await Messages.create({
        _id: uuidv4(), channelId: bridge.targetChannelId, serverId: bridge.targetServerId,
        userId: user._id, username: user.username, displayName: user.displayName,
        avatarColor: user.avatarColor, avatarUrl: user.avatarUrl || null,
        content: `🌉 **[${bridge.label || 'Bridge'}]** ${content?.trim() || ''}`,
        type: 'normal', reactions: {}, createdAt: Date.now(),
        bridgedFrom: { channelId, serverId },
      });
      await publishPersistedMessage(io, bMsg);
    }
  } catch (err) {
    logger.error({ event: 'bridge_forwarding_failed', serverId, channelId,
      sourceMessageId: String(msg._id), err: err instanceof Error ? err.message : String(err) },
    'Bridge forwarding failed after source message persistence');
  }

  // @mention realtime delivery is cluster-wide via authenticated user:<id> rooms.
  // Do not derive delivery from this process's socketUsers index.
  const mentionIds: string[] = [];
  const newMentions = content?.match(/<@([a-zA-Z0-9_-]+)>/g);
  if (newMentions) mentionIds.push(...newMentions.map((m: string) => m.slice(2, -1)));
  const oldMentions = content?.match(/@([a-zA-Z0-9_]+)/g);
  if (oldMentions) {
    const usernames = oldMentions.map((m: string) => m.slice(1).toLowerCase());
    const found = await Users.findByUsernames(usernames);
    mentionIds.push(...found.map((u: AuthUser) => u._id));
  }

  for (const uid of [...new Set(mentionIds)]) {
    if (uid === user._id) continue;
    if (!await canViewChannel(uid, serverId, channelId)) continue;
    const [channelPref, serverPref] = await Promise.all([
      Notifications.findPref(uid, channelId),
      Notifications.findServerPref(uid, serverId),
    ]);
    const pref = effectiveNotificationPref(channelPref, serverPref);
    if (isMuted(pref)) continue;
    // user:<id> is shared by the Socket.IO Redis adapter and reaches every
    // active socket for this account across nodes/tabs. Never gate realtime
    // mention delivery on this process's socketUsers map.
    io.to(`user:${uid}`).emit('mention:received', {
      fromUser: sanitizeUser(user), channelId, serverId,
      messageId: msg._id, preview: content!.slice(0, 80),
    });
  }
}

// ── registerSendHandlers ──────────────────────────────────────
export function registerSendHandlers(
  socket: HandlerSocket,
  io: HandlerServer,
  user: AuthUser,
  socketUsers: Map<string, SocketUser>,
): void {
  socket.on('message:send', isolateSocketHandler(socket, 'message:send', (data: SendMessagePayload) =>
    sendChannelMessage(data, socket, io, user, socketUsers),
  ));
  socket.on('message:reply', isolateSocketHandler(socket, 'message:reply', (data: SendMessagePayload & { replyToId: string }) =>
    sendChannelMessage({ ...data, replyToId: data.replyToId }, socket, io, user, socketUsers),
  ));

  socket.on('file:send', isolateSocketHandler(socket, 'file:send', async ({
    channelId, serverId, fileName, fileUrl, fileType,
  }: {
    channelId: string; serverId: string; fileName: string; fileUrl: string; fileType: string;
  }) => {
    const rejectFile = (code: string, message: string): void => {
      socket.emit('error:message', { event: 'file:send', code, message });
    };
    if (!validateSocketPayload({ channelId, serverId, fileName, fileUrl, fileType }, socketSchemas.fileSend).valid) {
      logger.debug({ event: 'file_send.drop', reason: 'invalid_payload', channelId, serverId }, '[file:send] gecersiz govde');
      rejectFile('INVALID_PAYLOAD', 'Dosya gönderme isteği geçersiz.');
      return;
    }
    if (!isSafeUploadReference(fileUrl, fileName)) {
      logger.debug({ event: 'file_send.drop', reason: 'unsafe_upload_ref', fileUrl }, '[file:send] yukleme referansi bicimsel olarak gecersiz');
      socket.emit('error:message', {
        event: 'file:send', code: 'INVALID_FILE_REFERENCE',
        message: 'Dosya başvurusu geçersiz veya artık kullanılamıyor.',
      });
      return;
    }
    // KAYIT + SAHIPLIK: sekli dogru olmasi yetmez.
    if (!await isOwnedUploadReference(fileUrl, user._id)) {
      logger.warn({ event: 'file_send.drop', reason: 'unregistered_upload', userId: user._id },
        '[file:send] kayitli olmayan ya da baskasina ait yukleme basvurusu reddedildi');
      socket.emit('error:message', {
        event: 'file:send', code: 'INVALID_FILE_REFERENCE',
        message: 'Dosya başvurusu geçersiz veya artık kullanılamıyor.',
      });
      return;
    }
    const safeFileName = String(fileName).replace(/[<>"']/g, '_').slice(0, 200);
    const membership = await Members.findOne(user._id, serverId);
    if (!membership) {
      logger.debug({ event: 'file_send.drop', reason: 'not_member', serverId }, '[file:send] uyelik yok');
      rejectFile('NOT_A_MEMBER', 'Bu sunucunun üyesi değilsiniz.');
      return;
    }
    if (isMemberTimedOut(membership.timeoutUntil)) {
      const timeoutUntil = parseMemberTimeoutUntil(membership.timeoutUntil)!;
      socket.emit('error:timeout', { remaining: Math.ceil((timeoutUntil - Date.now()) / 1000) });
      return;
    }
    const channel = await Channels.findByIdAndServer(channelId, serverId);
    if (!channel) {
      logger.debug({ event: 'file_send.drop', reason: 'channel_not_found', channelId, serverId }, '[file:send] kanal bulunamadi');
      rejectFile('CHANNEL_NOT_FOUND', 'Kanal artık kullanılamıyor.');
      return;
    }
    const sendPerms = await getCachedPerms(user._id, serverId, resolvePermissions, channelId);
    if (!hasPermission(sendPerms, PERMS.VIEW_CHANNELS)) {
      socket.emit('error:message', {
        event: 'file:send', code: 'MISSING_PERMISSION', message: 'Bu kanalı görüntüleme yetkiniz yok.',
      });
      return;
    }
    if (!hasPermission(sendPerms, PERMS.SEND_MESSAGES)) {
      const resolution = await resolvePermissionResolution(user._id, serverId, channelId);
      const resolvedExplanation = explainResolvedPermission(
        resolution,
        PERMS.SEND_MESSAGES,
        'Bu kanala dosya gönderme yetkiniz yok.',
      );
      const explanation = resolvedExplanation.allowed
        ? { reasonCode: 'MISSING_PERMISSION', message: 'Bu kanala dosya gönderme yetkiniz yok.' }
        : resolvedExplanation;
      socket.emit('error:message', {
        event: 'file:send', code: explanation.reasonCode, message: explanation.message,
      });
      return;
    }
    if (!hasPermission(sendPerms, PERMS.ATTACH_FILES)) {
      socket.emit('error:message', {
        event: 'file:send', code: 'MISSING_PERMISSION', message: 'Bu kanala dosya gönderme yetkiniz yok.',
      });
      return;
    }
    // ════════════════════════════════════════════════════════════════════════
    // CANLI URUNDE YAKALANDI — DOSYA GONDERIMI HIC CALISMIYORDU.
    //
    // Bu `create` cagrisi `createdAt` ve `reactions` alanlarini ATLIYORDU.
    // `messages.createdAt` semada NOT NULL oldugu icin her dosya gonderimi
    // su hatayla dusuyordu:
    //   null value in column "createdAt" of relation "messages"
    //     violates not-null constraint
    // Hata `isolate()` tarafindan yakalanip istemciye yalnizca genel bir
    // "Mesaj islenemedi" olarak donuyordu; bu yuzden sessiz kaldi.
    //
    // OLCUM: ayni sokette `message:send` BASARILI, `file:send` HER SEFERINDE
    // `error:message` donuyordu. Metin yolu (`msgData`) bu iki alani zaten
    // dogru sekilde dolduruyor; dosya yolu ondan AYRISMIS.
    //
    // Duzeltme kanonik metin yoluyla BIREBIR ayni alanlari verir.
    const msg = await Messages.create({
      _id: uuidv4(), channelId, serverId, userId: user._id, username: user.username,
      displayName: user.displayName, avatarColor: user.avatarColor, avatarUrl: user.avatarUrl || null,
      content: '', type: 'file', fileName: safeFileName, fileUrl, fileType,
      reactions: {}, createdAt: Date.now(),
    });
    // Dosya gonderimi ONCEDEN onbellegi HIC dusurmuyordu: mesaj kaliciydi
    // ama REST okuma yolu 45 saniyeye kadar eski listeyi donduruyordu.
    // Acik istemci socket push'uyla gorur; sayfayi yenileyen ya da ikinci
    // cihazdan bakan kullanici GORMEZDI.
    await publishPersistedMessage(io, msg);
  }));

  // TYPING — Final21 Faz 16'da TEK SAHİBE taşındı: `handlers/infra.ts`.
  //
  // Burada da `typing:start`/`typing:stop` dinleniyordu; aynı olayın iki
  // handler'ı vardı ve her tuş olayı kanal odasına iki kat yayın üretiyordu.
  // Sahiplik, zamanlayıcıları + `activeTyping` istatistiğini + şema
  // doğrulamasını zaten tutan infra.ts'te toplandı. İstemcinin dinlediği olay
  // (`typing:update`) ve Faz 15'in görünen ad düzeltmesi oraya taşındı.
}
