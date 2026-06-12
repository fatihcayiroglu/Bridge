// server/socket/handlers/channelE2EEHandlers.ts
// Sprint 89 — Kanal E2EE socket handler'ları
//
// Events (client → server):
//   channel:e2ee:setup          — Kanal için ilk anahtar paketini kur
//   channel:e2ee:keys:get       — Kendi wrappedKey'ini iste
//   channel:e2ee:keys:add       — Yeni üye için anahtar ekle (rotasyon/invite)
//   channel:e2ee:status         — Kanalın E2EE aktif olup olmadığını sor
//
// Events (server → client):
//   channel:e2ee:setup:ok       — Kurulum tamamlandı, epoch döner
//   channel:e2ee:setup:err      — Kurulum başarısız
//   channel:e2ee:keys:result    — wrappedKey + epoch
//   channel:e2ee:keys:err       — Anahtar bulunamadı
//   channel:e2ee:status:result  — { enabled: boolean, epoch?: number }

import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
import type { Socket, Server as IOServer } from 'socket.io';
import { Members, Channels } from '../../db/repositories';
import {
  setChannelKeyPackage,
  getWrappedKeyForUser,
  addMemberKey,
  isChannelE2EEEnabled,
  getChannelKeyPackage,
} from '../../lib/channelE2EE';
import logger from '../../lib/logger';

// ── Sprint 93: E2EE Production Toggle ────────────────────────────────────────
// BRIDGE_E2EE_ENABLED=true env flag ile production'da aktif edilir.
// Varsayılan: true (Sprint 115) — BRIDGE_E2EE_ENABLED=false ile devre dışı bırakılabilir
const E2EE_ENABLED = process.env.BRIDGE_E2EE_ENABLED !== 'false'; // Sprint 115: default true — E2EE production-ready

export function isE2EEProductionEnabled(): boolean { return E2EE_ENABLED; }


interface AuthUser {
  _id: string;
  username: string;
}

interface SetupPayload {
  channelId:   string;
  serverId:    string;
  /** userId → base64 wrappedKey */
  wrappedKeys: Record<string, string>;
}

interface KeysGetPayload {
  channelId: string;
  serverId:  string;
}

interface KeysAddPayload {
  channelId:  string;
  serverId:   string;
  userId:     string;
  wrappedKey: string;
}

interface StatusPayload {
  channelId: string;
  serverId:  string;
}

export function registerChannelE2EEHandlers(
  socket: Socket,
  _io:    IOServer,
  user:   AuthUser,
): void {
  // Sprint 93: Production flag guard
  if (!E2EE_ENABLED) {
    // E2EE kapalı — status sorgularına false döndür, setup'ı reddet
    socket.on('channel:e2ee:status', (payload: { channelId: string }) => {
      if (!validateSocketPayload(payload, socketSchemas.e2eeChannelId).valid) return;
      socket.emit('channel:e2ee:status:result', { channelId: payload?.channelId, enabled: false, disabled: true });
    });
    socket.on('channel:e2ee:setup', () => {
      socket.emit('channel:e2ee:setup:err', { error: 'E2EE is not enabled on this server instance', code: 'E2EE_DISABLED' });
    });
    return;
  }


  // ── channel:e2ee:setup ─────────────────────────────────────────────────
  // Kanalı E2EE'ye açar. Çağıran üye olmalı; wrappedKeys'in tüm kanal
  // üyelerini kapsayıp kapsamadığını kontrol ETMEZ (client sorumluluğu) —
  // server yalnızca paket bütünlüğünü ve yetkilendirmeyi doğrular.
  socket.on('channel:e2ee:setup', async (payload: SetupPayload) => {
    try {
      const { channelId, serverId, wrappedKeys } = payload;

      if (!channelId || !serverId || !wrappedKeys || typeof wrappedKeys !== 'object') {
        socket.emit('channel:e2ee:setup:err', { error: 'Geçersiz payload.' });
        return;
      }

      // Üyelik + kanal sahipliği kontrolü
      const membership = await Members.findOne(user._id, serverId);
      if (!membership) {
        socket.emit('channel:e2ee:setup:err', { error: 'Yetkisiz.' });
        return;
      }

      const channel = await Channels.findByIdAndServer(channelId, serverId);
      if (!channel) {
        socket.emit('channel:e2ee:setup:err', { error: 'Kanal bulunamadı.' });
        return;
      }

      // wrappedKeys değerlerinin string olduğunu doğrula
      for (const [uid, wk] of Object.entries(wrappedKeys)) {
        if (typeof uid !== 'string' || typeof wk !== 'string' || wk.length === 0) {
          socket.emit('channel:e2ee:setup:err', { error: 'Geçersiz wrappedKey formatı.' });
          return;
        }
      }

      const pkg = await setChannelKeyPackage(channelId, wrappedKeys);
      logger.info(`[E2EE] Kanal E2EE kuruldu: ${channelId} (epoch ${pkg.epoch}, ${Object.keys(wrappedKeys).length} üye)`);
      socket.emit('channel:e2ee:setup:ok', { channelId, epoch: pkg.epoch });
    } catch (err) {
      logger.error('[E2EE] setup hatası:', (err as Error).message);
      socket.emit('channel:e2ee:setup:err', { error: 'Sunucu hatası.' });
    }
  });

  // ── channel:e2ee:keys:get ──────────────────────────────────────────────
  // Çağıranın kendi wrappedKey'ini döner. Başka kullanıcının anahtarını
  // isteyemez — her zaman user._id kullanılır.
  socket.on('channel:e2ee:keys:get', async (payload: KeysGetPayload) => {
    if (!validateSocketPayload(payload, socketSchemas.e2eeKeysGet).valid) return;
    try {
      const { channelId, serverId } = payload;
      if (!channelId || !serverId) {
        socket.emit('channel:e2ee:keys:err', { error: 'Geçersiz payload.' });
        return;
      }

      const membership = await Members.findOne(user._id, serverId);
      if (!membership) {
        socket.emit('channel:e2ee:keys:err', { error: 'Yetkisiz.' });
        return;
      }

      const result = await getWrappedKeyForUser(channelId, user._id);
      if (!result) {
        socket.emit('channel:e2ee:keys:err', { error: 'Bu kanal için E2EE anahtarı bulunamadı.' });
        return;
      }

      socket.emit('channel:e2ee:keys:result', {
        channelId,
        wrappedKey: result.wrappedKey,
        epoch:      result.epoch,
      });
    } catch (err) {
      logger.error('[E2EE] keys:get hatası:', (err as Error).message);
      socket.emit('channel:e2ee:keys:err', { error: 'Sunucu hatası.' });
    }
  });

  // ── channel:e2ee:keys:add ──────────────────────────────────────────────
  // Kanal E2EE kuruluysa yeni bir üyeye wrappedKey ekler.
  // Çağıran kanala üye olmalı; hedef userId de sunucu üyesi olmalı.
  socket.on('channel:e2ee:keys:add', async (payload: KeysAddPayload) => {
    try {
      const { channelId, serverId, userId, wrappedKey } = payload;
      if (!channelId || !serverId || !userId || !wrappedKey) {
        socket.emit('channel:e2ee:keys:err', { error: 'Geçersiz payload.' });
        return;
      }

      const [callerMembership, targetMembership] = await Promise.all([
        Members.findOne(user._id, serverId),
        Members.findOne(userId,   serverId),
      ]);

      if (!callerMembership) {
        socket.emit('channel:e2ee:keys:err', { error: 'Yetkisiz.' });
        return;
      }
      if (!targetMembership) {
        socket.emit('channel:e2ee:keys:err', { error: 'Hedef kullanıcı sunucu üyesi değil.' });
        return;
      }

      await addMemberKey(channelId, userId, wrappedKey);
      const pkg = await getChannelKeyPackage(channelId);
      socket.emit('channel:e2ee:keys:result', {
        channelId,
        addedFor: userId,
        epoch:    pkg?.epoch ?? 0,
      });
    } catch (err) {
      logger.error('[E2EE] keys:add hatası:', (err as Error).message);
      socket.emit('channel:e2ee:keys:err', { error: 'Sunucu hatası.' });
    }
  });

  // ── channel:e2ee:status ────────────────────────────────────────────────
  socket.on('channel:e2ee:status', async (payload: StatusPayload) => {
    if (!validateSocketPayload(payload, socketSchemas.e2eeChannelId).valid) return;
    try {
      const { channelId, serverId } = payload;
      if (!channelId || !serverId) {
        socket.emit('channel:e2ee:status:result', { channelId, enabled: false });
        return;
      }

      const membership = await Members.findOne(user._id, serverId);
      if (!membership) {
        socket.emit('channel:e2ee:status:result', { channelId, enabled: false });
        return;
      }

      const enabled = await isChannelE2EEEnabled(channelId);
      const pkg     = enabled ? await getChannelKeyPackage(channelId) : null;

      socket.emit('channel:e2ee:status:result', {
        channelId,
        enabled,
        epoch: pkg?.epoch ?? null,
      });
    } catch (err) {
      logger.error('[E2EE] status hatası:', (err as Error).message);
      socket.emit('channel:e2ee:status:result', { channelId: payload?.channelId, enabled: false });
    }
  });
}
