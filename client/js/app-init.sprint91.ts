// client/js/app-init.sprint91.ts
// Sprint 91 — Tüm yeni modüllerin mevcut sisteme bağlantı noktaları
// Bu dosya app-init.ts içindeki initApp() fonksiyonuna eklenir.

/**
 * ENTEGRASYON TALİMATLARI
 * ========================
 * Her bölüm, mevcut hangi dosyada ne değiştirileceğini açıklar.
 */

// ════════════════════════════════════════════════════════════════════════════
// 1. CSS — index.html
// ════════════════════════════════════════════════════════════════════════════
/*
  <head> içine şunu ekle:
  <link rel="stylesheet" href="css/modules/sprint91.css">
*/

// ════════════════════════════════════════════════════════════════════════════
// 2. Server routes — server/index.ts (veya server/app.ts)
// ════════════════════════════════════════════════════════════════════════════
/*
  import serverMemberProfileRoutes from './routes/serverMemberProfile';
  import notificationPrefsRoutes   from './routes/notificationPrefs';

  // Mevcut app.use('/api/servers', ...) bloğuna ekle:
  app.use('/api/servers/:serverId', serverMemberProfileRoutes);

  // Bağımsız route:
  app.use('/api/notification-prefs', notificationPrefsRoutes);

  // DB index'lerini başlatmada çalıştır:
  import { ensureNotifPrefIndexes } from './db/repositories/NotificationRepository.extension';
  await ensureNotifPrefIndexes();
*/

// ════════════════════════════════════════════════════════════════════════════
// 3. Bildirim tercihleri — moderation.ts ID bug fix
// ════════════════════════════════════════════════════════════════════════════
/*
  client/js/core/moderation.ts satır 196 ve 206:
    document.getElementById('notif-ctx')
  →
    document.getElementById('notif-ctx-menu')
*/

// ════════════════════════════════════════════════════════════════════════════
// 4. Kanal listesi — channel-list.ts
// ════════════════════════════════════════════════════════════════════════════
/*
  openChannelMenu() içindeki menu.innerHTML listesine:

  <div class="ctx-item" id="ctx-notif">🔔 Bildirim Tercihleri</div>
  <div class="ctx-item" id="ctx-threads">🧵 Thread'ler</div>

  Handler'ları da ekle:
  document.getElementById('ctx-notif')?.addEventListener('click', () => {
    menu.remove();
    import('./notification-prefs.js').then(m =>
      m.openChannelNotifPanel(channelId, channelName));
  });

  document.getElementById('ctx-threads')?.addEventListener('click', () => {
    menu.remove();
    import('./thread-archive.js').then(m =>
      m.openThreadListPanel(channelId, channelName));
  });
*/

// ════════════════════════════════════════════════════════════════════════════
// 5. Kanal başlığı — channel-header.ts (veya messages/renderer.ts)
// ════════════════════════════════════════════════════════════════════════════
/*
  Kanal adı render edildiği yerde thread sayacı rozeti ekle:

  <span class="thread-count-badge"
    id="thread-count-badge-${channelId}"
    style="display:none"
    onclick="window.BridgeRegistry?.call('openThreadListPanel', '${channelId}', '${channelName}')">
  </span>

  Kanal yüklendiğinde:
  import('./thread-archive.js').then(m => m.updateThreadCountBadge(channelId));
*/

// ════════════════════════════════════════════════════════════════════════════
// 6. Sunucu menüsü — server-list.ts veya settings menüsü
// ════════════════════════════════════════════════════════════════════════════
/*
  Sunucu sağ tık menüsü veya ayarlar sayfasına:

  <div class="ctx-item" onclick="import('./server-profile.js').then(m => m.openServerProfileModal())">
    🎭 Sunucu Profilimi Düzenle
  </div>

  <div class="ctx-item" onclick="import('./notification-prefs.js').then(m => m.openServerNotifSettings())">
    🔔 Sunucu Bildirim Ayarları
  </div>

  <div class="ctx-item" onclick="import('./bot-marketplace/index.js').then(m => m.openBotMarketplace())">
    🤖 Bot Marketi
  </div>
*/

// ════════════════════════════════════════════════════════════════════════════
// 7. Sesli kanal araç çubuğu — voice.ts veya voice-controls.ts
// ════════════════════════════════════════════════════════════════════════════
/*
  Sesli kanala bağlanıldığında:
  import('./soundboard-ui.js').then(m => m.injectSoundboardToolbarBtn());

  Kanaldan ayrılınca:
  document.getElementById('sb-toolbar-btn')?.remove();
  document.getElementById('soundboard-panel')?.remove();
*/

// ════════════════════════════════════════════════════════════════════════════
// 8. Discover sayfası — discover.ts içindeki init fonksiyonu
// ════════════════════════════════════════════════════════════════════════════
/*
  Mevcut discover.ts'deki initDiscover() yerine:
  import { initDiscoverEnhanced } from './discover-enhanced.ts';

  // Discover sayfası açılırken:
  initDiscoverEnhanced();
*/

// ════════════════════════════════════════════════════════════════════════════
// 9. Mobil kapasitör başlangıcı — capacitor-bridge.js
// ════════════════════════════════════════════════════════════════════════════
/*
  capacitor-bridge.js sonuna:
  import { initMobileVoicePersistence } from './capacitor-bridge-voice.ts';
  initMobileVoicePersistence();
*/

// ════════════════════════════════════════════════════════════════════════════
// 10. App başlangıcında notification prefs yükleme — app-init.ts
// ════════════════════════════════════════════════════════════════════════════
/*
  Sunucu yüklendiğinde (loadServer() veya selectServer() içinde):
  import('./notification-prefs.js').then(m => m.loadServerNotifPrefs());
  import('./notification-prefs.js').then(m => m.bindNotifPrefSocketEvents());
*/

// ════════════════════════════════════════════════════════════════════════════
// 11. Socket.io server events — server/socket.ts
// ════════════════════════════════════════════════════════════════════════════
/*
  // Ses kanalındaki kullanıcılara soundboard oynatma bildirimi
  socket.on('soundboard:playing', ({ soundId }) => {
    const channelId = getUserVoiceChannel(socket.userId);
    if (!channelId) return;
    socket.to(`voice:${channelId}`).emit('soundboard:playing', {
      userId: socket.userId,
      soundId,
    });
  });

  // Bildirim tercihleri senkronizasyonu (diğer sekmelere)
  socket.on('notif:pref', (data) => {
    socket.to(`user:${socket.userId}`).emit('notif:pref:sync', data);
  });

  // Discover: online count broadcast (her 30 saniyede)
  setInterval(async () => {
    const counts = await getServerOnlineCounts();
    for (const [serverId, count] of Object.entries(counts)) {
      io.to('discover:watching').emit('discover:online_update', { serverId, count });
    }
  }, 30000);
*/

export {}; // TypeScript module marker
