// server/socket/handlers/members.ts
// Sprint 108: join/leave/membership mantığı socket/index.ts'den ayrıştırıldı.
// setupMemberships() çağrısı index.ts'de ~40 satırın yerini alır.

import type { HandlerSocket } from '../handler-contracts';
import logger from '../../lib/logger';
import { canViewChannel } from '../../lib/permissions';
import { Members, Channels }    from '../../db/repositories';
import { getMembershipsCached } from '../../lib/presenceCache';
import { isolateSocketHandler } from '../handlerIsolation';
import { watchServerChannels } from '../../lib/channelActivity';


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
  socket: HandlerSocket,
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
  socket.on('channel:join', isolateSocketHandler(socket, 'channel:join', async (channelId: unknown) => {
    if (typeof channelId !== 'string') return;
    try {
      const channel = await Channels.findById(channelId);
      if (!channel) return;
      const membership = await Members.findOne(user._id, channel.serverId);
      if (!membership) return;

      // FAZ G5 — KANAL GORUNURLUGU (CANLI YAYIN SIZINTISI KAPATILDI).
      //
      // Onceden yalniz SUNUCU UYELIGI denetleniyordu. Oysa `channel:<id>`
      // odasina `message:new`, `message:edited`, `message:deleted` ve
      // `message:reaction` yayinlanir (messages-send.ts:212, messages-edit.ts).
      // Yani sunucunun sirade bir uyesi, GOREMEDIGI ozel bir kanalin odasina
      // katilip TUM canli mesaj trafigini surekli olarak alabiliyordu.
      //
      // Bu, HTTP tarafinda Faz D/F/G'de kapatilan ayni kusur sinifinin
      // gercek zamanli esdegeridir ve daha agirdir: tek seferlik bir okuma
      // degil, sureklilik arz eden bir akistir.
      if (!await canViewChannel(user._id, String(channel.serverId), channelId)) return;

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
  }));

  // ── CHANNEL LEAVE ───────────────────────────────────────────
  // Explicit leave (text kanal değiştirme, voice leave vb.)
  // infra.ts disconnect handler'ı tüm odaları zaten temizler;
  // bu handler explicit event'ler için ek güvence sağlar.
  // ── CHANNEL WATCH (Final21 Phase 15) ─────────────────────────
  // Live unread state for the server the user is looking at: the socket joins
  // `watch:<channelId>` for each message channel it can VIEW and receives only
  // content-free `channel:activity` there. Re-sent on server switch/reconnect.
  socket.on('channels:watch', isolateSocketHandler(socket, 'channels:watch', async (payload: unknown, ack?: unknown) => {
    const serverId = typeof (payload as { serverId?: unknown } | null)?.serverId === 'string'
      ? String((payload as { serverId: string }).serverId) : '';
    const watched = await watchServerChannels(socket as unknown as Parameters<typeof watchServerChannels>[0], user._id, serverId);
    if (typeof ack === 'function') ack({ ok: true, channels: watched.length });
  }));

  socket.on('channel:leave', isolateSocketHandler(socket, 'channel:leave', (channelId: unknown) => {
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
  }));

  return handle;
}
