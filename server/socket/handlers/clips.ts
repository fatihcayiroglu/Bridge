// server/socket/handlers/clips.ts
// Sprint 82: Clips socket handler — klip meta verisi kaydı

import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
import logger from '../../lib/logger';
import { resolvePermissions, hasPermission, PERMS } from '../../lib/permissions';
import type { Socket } from 'socket.io';

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

const _clips: ClipMeta[] = [];

export function registerClipHandlers(socket: Socket, userId: string): void {

  socket.on('clip:save', async (payload: {
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

      socket.emit('clip:saved', { clipId: clip.id, filename: clip.filename });

      logger.info(
        { event: 'clip.saved', clipId: clip.id, channelId, userId, sizeBytes, durationMs },
        'Clip metadata saved',
      );
    } catch (err) {
      logger.error({ event: 'clip.save.error', err }, 'clip:save error');
    }
  });

  // Kullanıcının kliplerine bak
  socket.on('clip:list', async (payload: { channelId?: string }) => {
    if (!validateSocketPayload(payload ?? {}, socketSchemas.clipList).valid) return;
    const userClips = _clips.filter(c =>
      c.userId === userId && (!payload?.channelId || c.channelId === payload.channelId)
    );
    socket.emit('clip:list_result', userClips);
  });
}
