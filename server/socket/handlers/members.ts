// server/socket/handlers/members.ts
// Sprint 108: join/leave/membership mantığı socket/index.ts'den ayrıştırıldı.
// setupMemberships() çağrısı index.ts'de ~40 satırın yerini alır.

import logger from '../../lib/logger';
import { Members, Channels }    from '../../db/repositories';
import { getMembershipsCached } from '../../lib/presenceCache';
import type { Socket }          from 'socket.io';

interface UserRef { _id: string }

export type MemberEntry = { serverId: string; [k: string]: unknown };

export interface MembershipsHandle {
  /** Güncel üyelik listesi (referans — refreshMemberships sonrası otomatik güncellenir) */
  memberships:        MemberEntry[];
  /** Üyelikleri DB'den yeniden yükler ve socket odalarına join eder */
  refreshMemberships: () => Promise<void>;
}

/**
 * Kullanıcının server üyeliklerini yükler, socket odalarına join eder
 * ve channel:join / channel:leave event handler'larını kaydeder.
 *
 * @param socket  Bağlı Socket.IO soketi
 * @param user    { _id } içeren kullanıcı referansı
 */
export async function setupMemberships(
  socket: Socket,
  user:   UserRef,
): Promise<MembershipsHandle> {

  const handle: MembershipsHandle = {
    memberships:        [],
    refreshMemberships: async () => { /* aşağıda tanımlanır */ },
  };

  async function refreshMemberships(): Promise<void> {
    try {
      handle.memberships = await getMembershipsCached(
        user._id,
        () => Members.findByUser(user._id),
      );
      for (const m of handle.memberships) socket.join(`server:${m.serverId}`);
    } catch (e) {
      logger.warn(
        { userId: user._id, event: 'socket.memberships.load_error', err: (e as Error).message },
        'Üyelik listesi yüklenemedi; boş listeyle devam ediliyor.',
      );
    }
  }

  handle.refreshMemberships = refreshMemberships;

  // İlk yükleme
  await refreshMemberships();

  // ── CHANNEL JOIN ────────────────────────────────────────────
  socket.on('channel:join', async (channelId: unknown) => {
    if (typeof channelId !== 'string') return;
    try {
      const channel = await Channels.findById(channelId);
      if (!channel) return;
      const membership = await Members.findOne(user._id, channel.serverId);
      if (!membership) return;
      // Önceki text kanalından çık
      for (const room of socket.rooms) {
        if (room.startsWith('channel:') && room !== `channel:${channelId}`) {
          socket.leave(room);
        }
      }
      socket.join(`channel:${channelId}`);
      (socket as typeof socket & { currentChannel?: string }).currentChannel = channelId;
    } catch (e) {
      logger.warn(
        { userId: user._id, channelId, event: 'socket.channel_join.error', err: (e as Error).message },
        'channel:join işlemi başarısız.',
      );
    }
  });

  // ── CHANNEL LEAVE ───────────────────────────────────────────
  // Explicit leave (text kanal değiştirme, voice leave vb.)
  // infra.ts disconnect handler'ı tüm odaları zaten temizler;
  // bu handler explicit event'ler için ek güvence sağlar.
  socket.on('channel:leave', (channelId: unknown) => {
    if (typeof channelId !== 'string') return;
    try {
      if (socket.rooms.has(`channel:${channelId}`)) {
        socket.leave(`channel:${channelId}`);
      }
      const s = socket as typeof socket & { currentChannel?: string };
      if (s.currentChannel === channelId) s.currentChannel = undefined;
    } catch (e) {
      logger.warn(
        { userId: user._id, channelId, event: 'socket.channel_leave.error', err: (e as Error).message },
        'channel:leave işlemi başarısız.',
      );
    }
  });

  return handle;
}
