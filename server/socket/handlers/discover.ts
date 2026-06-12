// server/socket/handlers/discover.ts
// Gerçek zamanlı keşif: üye sayısı push
//
// Nasıl çalışır:
//   1. Kullanıcı keşif sayfasını açtığında socket.emit('discover:subscribe') gönderir.
//   2. Sunucu bu kullanıcıyı "discover" odasına alır.
//   3. Bir sunucuya üye eklenince/ayrılınca `pushMemberCount(serverId)` çağrılır.
//   4. Discover odasındaki tüm istemcilere `discover:memberCount` eventi gönderilir.
//
// Bağımlılıklar:
//   • server/socket/index.ts — io nesnesi
//   • server/routes/discover.ts — invalidateMemberCount
//   • server/db/repositories — Members


import type { Server as IOServer, Socket } from 'socket.io';
import { Members } from '../../db/repositories';
import { isUserOnline } from '../../lib/presenceCache';
import { invalidateMemberCount } from '../../routes/discover';

import logger from '../../lib/logger';
const DISCOVER_ROOM = 'discover:live';

// ── Socket event handler — io.on('connection') içinde çağrılır ───────────────
export function registerDiscoverHandlers(io: IOServer, socket: Socket): void {
  // Kullanıcı keşif sayfasını açtı
  socket.on('discover:subscribe', () => {
    socket.join(DISCOVER_ROOM);
  });

  // Kullanıcı keşif sayfasını kapattı / sayfadan ayrıldı
  socket.on('discover:unsubscribe', () => {
    socket.leave(DISCOVER_ROOM);
  });
}

// ── pushMemberCount — üye sayısı değiştiğinde çağrılır ───────────────────────
// Üye ekleme / çıkarma yapan herhangi bir handler bu fonksiyonu çağırmalı.
//
// Örnek kullanım (server/socket/handlers/infra.ts içinde):
//   const { pushMemberCount } = require('./discover');
//   await pushMemberCount(io, serverId);
//
export async function pushMemberCount(
  io: IOServer,
  serverId: string
): Promise<void> {
  try {
    // Cache'i önce geçersiz kıl (discover route'daki yardımcı)
    await invalidateMemberCount(serverId);

    // Güncel sayıyı DB'den al
    const members    = await Members.findByServer(serverId);
    const memberCount = members.length;

    // Online üye sayısı (presence cache)
    const checks     = await Promise.all(members.map((m: { userId: string }) => isUserOnline(m.userId)));
    const onlineCount = checks.filter(Boolean).length;

    // Discover sayfasına abone olan tüm clientlere push
    io.to(DISCOVER_ROOM).emit('discover:memberCount', {
      serverId,
      memberCount,
      onlineCount,
      ts: Date.now(),
    });
  } catch (err) {
    logger.error({ detail: err }, '[discover-socket] pushMemberCount error:');
  }
}
