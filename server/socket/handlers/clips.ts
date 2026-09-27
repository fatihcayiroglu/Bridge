// server/socket/handlers/clips.ts
// Sprint 82: Clips socket handler — klip meta verisi kaydı

import type { HandlerSocket } from '../handler-contracts';
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
import logger from '../../lib/logger';
import { resolvePermissions, hasPermission, PERMS } from '../../lib/permissions';
import { Channels } from '../../db/repositories';
import { isolateSocketHandler } from '../handlerIsolation';


// In-memory clip metadata (production'da DB tablosuna taşı)
interface ClipMeta {
  id:         string;
  channelId:  string;
  userId:     string;
  filename:   string;
  mimeType:   string;
  sizeBytes:  number;
  durationMs: number;
  savedAt:    number;
}

// ════════════════════════════════════════════════════════════════════════════
// SINIRLI BELLEK
// ════════════════════════════════════════════════════════════════════════════
// `_clips` sinirsiz buyuyordu: her `clip:save` bir kayit ekliyor, HICBIR SEY
// silmiyordu. Surec omru boyunca tek yonlu buyume — bu depo zaten gecicidir
// (yeniden baslatmada kaybolur, ornekler arasinda paylasilmaz), dolayisiyla
// sinirsiz tutmanin bir faydasi da yoktu.
//
// Ayni sinif kusur icin bu depoda onceden is yapilmis (tests/socket-room-
// leak.test.ts): Map ve dizi sizintilari kesin temizlemeyle kapatilir.
const MAX_CLIPS_PER_USER = 50;
const MAX_CLIPS_TOTAL    = 5_000;

const _clips: ClipMeta[] = [];

/** En eskiden budar: kullanici basina ve toplamda. */
function pruneClips(userId: string): void {
  let mine = 0;
  for (let i = _clips.length - 1; i >= 0; i--) {
    if (_clips[i]?.userId !== userId) continue;
    if (++mine > MAX_CLIPS_PER_USER) _clips.splice(i, 1);
  }
  while (_clips.length > MAX_CLIPS_TOTAL) _clips.shift();
}

export function registerClipHandlers(socket: HandlerSocket, userId: string): void {

  socket.on('clip:save', isolateSocketHandler(socket, 'clip:save', async (payload: {
    channelId:  string;
    filename:   string;
    mimeType:   string;
    sizeBytes:  number;
    durationMs: number;
  }) => {
    if (!validateSocketPayload(payload, socketSchemas.clipSave).valid) return;
    try {
      const { channelId, filename, mimeType, sizeBytes, durationMs } = payload ?? {};
      if (!channelId || !filename) return;

      // ── KANAL ERISIM DENETIMI ────────────────────────────────────────
      // Bu denetim HIC YAZILMAMISTI: dosyanin basindaki uc izin yardimcisi
      // (`resolvePermissions`, `hasPermission`, `PERMS`) import edilmis ama
      // KULLANILMAMISTI — niyet acikti, uygulama eksikti.
      //
      // SIDDET: dusuk. `clip:list` yalnizca kendi kayitlarini dondurur
      // (`c.userId === userId`), yani baskasinin verisi SIZMIYORDU. Yine de
      // kullanici goremedigi bir kanala kayit iliskilendirebiliyordu.
      // Denetim ucuzdur ve niyetle uyumludur.
      //
      // Hata durumunda FAIL-CLOSED.
      const channel = await Channels.findById(channelId).catch(() => null);
      if (!channel?.serverId) return;
      const perms = await resolvePermissions(userId, String(channel.serverId), channelId)
        .catch(() => 0);
      if (!hasPermission(perms, PERMS.VIEW_CHANNELS)) return;

      if (sizeBytes > 100 * 1024 * 1024) { // 100 MB limit
        socket.emit('clip:error', { message: 'Klip dosyası çok büyük (maks 100 MB).' });
        return;
      }

      const clip: ClipMeta = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        channelId,
        userId,
        filename,
        mimeType:   mimeType ?? 'video/webm',
        sizeBytes:  sizeBytes ?? 0,
        durationMs: Math.min(durationMs ?? 30000, 60000),
        savedAt:    Date.now(),
      };

      _clips.push(clip);
      pruneClips(userId);

      socket.emit('clip:saved', { clipId: clip.id, filename: clip.filename });

      logger.info(
        { event: 'clip.saved', clipId: clip.id, channelId, userId, sizeBytes, durationMs },
        'Clip metadata saved',
      );
    } catch (err) {
      logger.error({ event: 'clip.save.error', err }, 'clip:save error');
    }
  }));

  // Kullanıcının kliplerine bak
  socket.on('clip:list', isolateSocketHandler(socket, 'clip:list', async (payload: { channelId?: string }) => {
    if (!validateSocketPayload(payload ?? {}, socketSchemas.clipList).valid) return;
    const userClips = _clips.filter(c =>
      c.userId === userId && (!payload?.channelId || c.channelId === payload.channelId)
    );
    socket.emit('clip:list_result', userClips);
  }));
}
