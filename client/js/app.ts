// client/js/app.ts — Uygulama giriş noktası (koordinatör)
// ─────────────────────────────────────────────────────────────────────────────
// Sprint 30: window.* global erişimleri kaldırıldı; socket/bindGroupDmSocketEvents import.
// Sprint 31: Boot katmanı ESM'e geçti. Yeni import'lar:
//   - errorBoundary → error-boundary.ts
//   - BridgeState   → state.ts
//   - loadTheme     → theme.ts
//   - getAPI        → globals.ts
//
// Yükleme sırası (scripts/build.js CHUNKS tanımına bakın):
//   chunk-boot     → error-boundary, utils, theme, i18n, state, globals, auth
//   chunk-core     → offline, servers, channel-list, messages,
//                    upload, members, socket, ui, settings, emoji
//   chunk-comms    → dm, dm-call, group-dm, voice, emoji-picker
//   chunk-webrtc   → noise-suppression, webrtc-sfu, webrtc, video
//   chunk-features → server-settings, discord-ui-kit, channel-perms,
//                    e2e, ai, search, friends, moderation, ...
//   chunk-pages    → app (bu dosya), federation, threads, slash, ...
//   chunk-heavy    → discord-import, bot-marketplace, admin
// ─────────────────────────────────────────────────────────────────────────────

// Boot sırası önemlidir (Faz 1): state-svelte → socket-svelte → auth-compat.
// AppState registry kayıtlarını yapmadan SocketManager bağlanırsa durum
// güncellemeleri sessizce kaybolur.
import { BridgeState }               from './core/state-svelte.ts';
// ─── YAN ETKİ IMPORT'U — SİLMEYİN, `{ socket }` ile DEĞİŞTİRMEYİN ──────────
// KAPATILAN GERÇEK KUSUR (P0): burada yalnızca `import { socket } from
// './core/socket-svelte.ts'` vardı. `socket` bu dosyada HİÇ kullanılmıyordu.
// TypeScript'in import elision kuralı, bir import'un TÜM bağlantıları
// kullanılmıyorsa (tip-only olabileceği için) DEYİMİN TAMAMINI siler; esbuild
// de bunu uygular. Sonuç: `socket-svelte.ts` derlemeye HİÇ girmedi, kendini
// mount eden yan etkisi çalışmadı ve `SocketManager` ASLA bağlanmadı.
//
// ÖLÇÜLEN ETKİ (yayın derlemesi): sıfır WebSocket, sıfır socket.io handshake.
// Mesajlar iyimser olarak çizilip `queued` durumunda KALICI olarak asılı
// kaldı; ACK gelmediği için hiçbiri gerçekten gönderilmedi. Gerçek zamanlı
// her şey (teslimat, varlık, yazıyor, ses sinyalleşmesi) sessizce ölüydü.
//
// KANIT: derlemede `AppStateShim` VARDI ama `socket-root` YOKTU.
//
// Yan etki import'u elision'a UĞRAMAZ; modül her zaman derlemeye girer.
import './core/socket-svelte.ts';
import './core/api-error-toast-svelte.ts'; // Faz 8: bildirim (toast) sunucusu — 199 çağrı yerinin alıcısı
// App-level back/forward is registered before canonical channel/DM/GDM owners
// mount, so their first successful destination can establish the baseline.
import './core/navigation-history.ts';
// Faz 8.1: bu iki bileşen gerçek implementasyona sahipti ama hiç import edilmediği
// için kullanıcıya ulaşmıyordu (kod var, özellik yok).
import './core/command-palette-svelte.ts';   // Ctrl/Cmd+K komut paleti
import './core/onboarding-wizard-svelte.ts'; // ilk giriş sihirbazı
// Faz 8.2: taslak yöneticisi — MessageInputPanel'den ÖNCE mount edilmeli ki
// composer ilk kanal seçiminde getDraft/setDraft sözleşmesini hazır bulsun.
import './core/drafts-svelte.ts';            // kanal başına mesaj taslakları
// Tasarım Fazı 2: tanımsız satır içi handler'lara tıklayınca ReferenceError
// yerine dürüst bildirim gösterilir (özellik yazmaz, çökmeyi kapatır).
import './core/dead-control-guard.ts';
// Faz 12 sonrası — ÇEVRİMDIŞI BANNER BAĞLANDI.
// Bileşen (OfflineBanner.svelte, 121 satır) gerçek bir uygulamaydı: window
// online/offline dinleyicileri, service-worker SW_NETWORK_STATUS köprüsü,
// yeniden bağlanma sayacı ve onDestroy temizliği. Ancak shim'i hiçbir yerden
// import edilmiyordu; kullanıcı bağlantı kaybında HİÇBİR gösterge görmüyordu.
// Shim `_instance` koruması ile tek örnek garantisi verir.
import './core/offline-banner-svelte.ts';
// Faz 8.3: kanal sahne yönlendiricisi — seçili kanalın türüne göre hangi ana
// içeriğin görüneceğine karar verir (mesaj/socket işini duplicate etmez).
import './core/channel-stage-svelte.ts';
// Faz 8.3 — SES ZİNCİRİ.
// Bu üç modül derleniyordu (webrtc.js / webrtc-sfu.js ayrı chunk'lar) ama
// sayfaya HİÇ yüklenmiyordu: index.html yalnızca app.js'i çekiyor. Sonuç:
// `BridgeRegistry.get('BridgeRTC')` her zaman null, `getRtc()` null, ses
// kanalı seçilince VoicePanel hiç mount edilmiyordu.
// Sıra önemli: webrtc önce kaydolmalı ki VoicePanel mount olduğunda rtc hazır olsun.
// Faz K2: webrtc.ts katilirken `_bridgeStartLocalVAD`, ayrilirken
// `_bridgeStopLocalVAD` ve `VoiceActivityUI.init(socket)` ariyor. Bu adlar
// hicbir yerde KAYITLI DEGILDI; sunucudaki yetkilendirilmis `voice:activity`
// yayini bu yuzden hic tetiklenmiyordu. Kayit, webrtc.ts'ten ONCE yapilmali.
import { registerVoiceActivityWiring } from './core/voice-activity-wiring.ts';
registerVoiceActivityWiring();
// Register the SFU-capable engine factory before the canonical singleton owner
// boots. `webrtc.ts` remains the only registry/lifecycle owner; the selected
// engine negotiates server SFU capability and falls back to P2P when absent.
import './webrtc-sfu.ts';
import './webrtc.ts';        // canonical ensureRtc()/destroy()/registry owner
// Cursor-paged soundboard. The module owns its popup and socket lifecycle;
// VoicePanel only delegates its user action through BridgeRegistry.
import './soundboard.ts';
import './core/voice-check-svelte.ts'; // Local-only microphone/device/connection diagnostics
import './core/voice-svelte.ts';  // VoicePanel mount (#voice-view)
import './core/shell-voice-controls.ts'; // Faz 9: compact controls mirror canonical VoicePanel
import './core/channel-list-svelte.ts'; // Faz 3: kanal listesi (#channel-list) — dinleyici önce kurulur
import './core/members-svelte.ts';      // Faz 9: canonical member list (#member-list-content)
import './core/messages-loader-svelte.ts'; // Faz 4: mesaj yükleme + socket olayları
import './core/messages-svelte.ts';        // Faz 4: mesaj listesi (#messages-area)
import './core/messages-input-svelte.ts';  // Faz 4: composer (#msg-input)
import './core/servers-svelte.ts';   // Faz 2: sunucu rail'i (#server-list)
import { errorBoundary }             from './core/error-boundary-svelte.ts';
import { loadTheme }                 from './core/theme-svelte.ts';
// ════════════════════════════════════════════════════════════════════════════
// FAZ K+/7 — SPRINT 116 "SVELTE 5 GECISI" HAYALETLERI KALDIRILDI
// ════════════════════════════════════════════════════════════════════════════
// Sprint 116'da bir grup ozellik ".ts -> Svelte 5 Runes" diye tasindi. Gercekte
// olan sey su: her biri icin 50 satirlik AYNI bos kabuk uretildi ve asil
// uygulama `client/historical pre-Svelte implementation (removed from the release tree): ` altina alindi. Kabuklar
// yalnizca `showX`/`hideX` kaydediyor ve `{@render children?.()}` ciziyordu —
// yani ekranda HICBIR SEY.
//
// Olcum (bu temizlikten once):
//   · 10 kabugun `showX` kaydi icin CAGIRAN sayisi: 0 (hepsi)
//   · asil uygulamalar arsivde: analytics-dashboard 433, boost 298,
//     desktop-voice-bar 179 satir …
//
// Muhafiz bu 10'unu "ULASILABILIR hayalet" diye sayiyor ve silinemez
// sanmistik: mount shim'leri ayni zamanda gercek yardimcilar da disa
// aktariyordu. Tek tek bakildiginda dordu NO-OP cikti:
//   · onNativePushLogin()      -> bos kabugu mount ediyordu
//   · initStageVideoGrid()     -> bos kabugu mount ediyordu
//   · applyBoostFeatures()     -> bos kabugu mount ediyordu, tuketicisi de yok
//   · bindGroupDmSocketEvents()-> `BridgeRegistry.get('bindGroupDmSocketEvents')`
//        arar; bu anahtari KIMSE kaydetmiyor. Grup DM soket olaylari zaten
//        GroupDmPanel'in kendi `syncSocketBinding()` fonksiyonunda baglanir.
//   · getAPI()                 -> `globals.ts`teki KANONIK surumun birebir
//        kopyasiydi; app.ts artik kanonik olani kullanir.
//
// EKSIK OZELLIKLER SESSIZCE SILINMEDI: kayip yuzeyler
// docs/PHANTOM_COMPONENT_FINAL_AUDIT.md icinde ABSENT olarak kayitlidir.
import { getAPI }                    from './core/globals.ts';
import './core/auth-compat.ts';
// PASSKEY / WEBAUTHN — kabuktaki iki dugmenin GERCEK sahibi.
// Olculdu: `index.html` "Passkey ile giris yap" / "Passkey ile kayit ol"
// dugmelerini gosteriyordu ve `BridgeWebAuthn` global'ini cagiriyordu; o
// global'i tanimlayan `js/webauthn.ts` HICBIR giristen import edilmiyordu.
// Sonuc: iki gorunur guvenlik dugmesi ReferenceError uretip sessizce hicbir
// sey yapmiyordu — sunucu WebAuthn'i tam desteklerken.
//
// Eski dosya OLDUGU GIBI baglanmadi (mojibake, tanimsiz showToast, ikinci
// dugme enjeksiyonu). Yetenek kanonik mimariye yeniden yazildi; `auth-compat`
// SONRASINDA import edilir cunku oturum kurulumu icin `startApp`a dayanir.
import './core/webauthn-svelte.ts';
import { BridgeRegistry }            from './core/bridge-registry.ts';
import './core/empty-server-start-svelte.ts';

import { createLogger } from './core/logger.ts';
// Faz 12 sonrası — I18N GERÇEKTEN BAĞLANDI.
// `index.html` 11 düğümde `data-i18n` taşıyor ve 10 dil için tam çeviri
// tabloları mevcuttu, ama bu nitelikleri okuyan tek satır bile yoktu: dil
// değiştirmek arayüzde HİÇBİR ŞEYİ değiştirmiyordu. Uygulayıcı locale
// aboneliğine bağlanır ve her değişimde metinleri yeniden yazar.
import { initI18nDom } from './core/i18n-dom.ts';
// Faz 12 — `initA11yWcagAA` boot çağrısı KALDIRILDI. Ürün kararı:
// WCAG denetim özelliği DORMANT / SEVK EDİLMEDİ. Ayrıntı için aşağıdaki
// boot bloğundaki nota bakın.
import { initDesktopUpdater } from './core/desktop-updater.ts'; // Desktop: Discord benzeri otomatik güncelleme UI
import { initDesktopDeepLinks } from './core/desktop-deeplink.ts'; // Desktop: bridge:// bağlantılarını kanonik gezinmeye yönlendirir
import { initNativePush } from './core/native-push.ts'; // P4: yerel cihaz jetonu uygulamanın kimlikli istemcisiyle kaydedilir
import { initNativeDeepLinks } from './core/native-deeplink.ts'; // P4: bridge://… ve bildirim dokunuşu → izin denetimli gezinme
import { bindWebPushToSession } from './core/notifications/web-push-client.ts'; // P4: çıkışta bu tarayıcının Web Push aboneliği biter
// Sprint 82: Yeni özellik modülleri
// import { initActivities }    from './core/activities/index.ts';
// import { initSuperReactions } from './core/super-reactions/index.ts';
// import { initClips }         from './core/clips/index.ts';
// import { initStickers }      from './core/stickers/index.ts';
// Faz 12 sonrası temizlik — Spotify/müzik istemcisi KALDIRILDI.
// `spotify-widget-svelte.ts` her sayfa yüklemesinde 52 satırlık boş bir
// kabuğu mount ediyordu; onu görünür kılacak hiçbir çağıran yoktu
// (showSpotifyWidget = 0). Ürün kararı: MUSIC/SPOTIFY = ABSENT.
import './core/e2ee-toggle-svelte.ts';                                     // Sprint 93: E2EE production toggle
import './core/product-preferences.ts';                                    // v1.125: density + privacy-first optional AI consent
import './core/settings-modal-svelte.ts';                                  // Faz 9: reachable canonical settings modal
import './core/dm-svelte.ts';                                               // Faz 10: reachable direct messages
import './core/inbox-svelte.ts';                                            // Unified Inbox: one canonical attention surface
import './core/saved-svelte.ts';                                            // Personal Saved / Follow-up, separate from server pins
import './core/friends-svelte.ts';
// UX/P0 — DAVET AKISI BAGLANDI.
// Olcum: istemcinin tamaminda `POST /api/servers/invites` cagrisi YOKTU;
// yani hicbir kullanici davet OLUSTURAMIYORDU (yalniz koda katilma vardi).
// Kanonik backend sozlesmesi aynen kullanilir; ikinci davet servisi YOK.
import './core/invite-svelte.ts';
// UX/P1 — sunucu menusu (Davet / Kanal olustur / Ayarlar / Ayril).
// Menu YALNIZ gercek yetenekleri gosterir; yetki sunucudan okunur.
// UX/P1 — kabuk eylem koprusu: index.html'deki KLASIK dispatcher ESM registry'ye
// ulasamadigi icin DM/Arkadaslar/Ara/Sunucu-ekle dugmeleri OLUYDU (canli olcum).
import './core/shell-actions.ts';
import './core/server-menu-svelte.ts';
import './core/server-events-svelte.ts'; // P2: production server events + RSVP
// UX/P0 — kanal olusturma: ucu vardi, istemcide CAGRI YOKTU.
import './core/create-channel-svelte.ts';
// UX/P1 — UYE PROFILI ERISILEBILIR HALE GETIRILDI.
// Olcum: `js/profile.ts` gercek profil davranisi tasiyordu ama uretimde
// HIC yuklenmiyordu (index.html yalniz app.js ceker). Kompakt popover
// kanonik `GET /api/users/:id` ucunu kullanir ve Mesaj icin kanonik
// `openDm` sahibine delege eder; ikinci profil/DM sahibi YOK.
import './core/member-profile-svelte.ts';
// FAZ F — ARAMA BAGLANDI.
// SearchPanel.svelte (287 satir) gercek bir uygulamaydi: /api/search cagrisi,
// sekmeler, sayfalama, yukleme/bos/hata durumlari. Ancak shim'i HICBIR giris
// noktasindan import edilmiyordu (16 girisin import kapanisinda YOKTU), yani
// uretim bundle'ina hic girmiyordu: SEARCH_CLIENT = DORMANT idi.
// Uyandirmadan ONCE uc sozlesme uyumsuzlugu duzeltildi (bkz. SearchPanel.svelte).
import './core/search-svelte.ts';                                          // Faz 10: reachable friends surface
// FAZ K/1 — KURESEL ARAMA BAGLANDI.
// `GET /api/search/unified` sunucuda hazirdi ama istemcide HICBIR cagiran
// yoktu: DM, grup DM ve thread yanitlari kullanici icin ARANAMIYORDU.
// Mevcut `SearchPanel` yalnizca ACIK SUNUCU icindeki kanal mesajlarini arar.
// Kisayol: Ctrl/Cmd+F (ve Ctrl/Cmd+Shift+K). Ctrl/Cmd+K komut paletinde
// KALIR — orasi hizli gecis yuzeyidir ve devralmak onu bozardi.
import './core/global-search-svelte.ts';
import './core/thread-svelte.ts';                                             // P1: production thread panel
import './core/pinned-messages-svelte.ts';
import './core/polls-svelte.ts';                                            // v1.125: safe reachable channel polls                                  // Faz 1: kanal sabitlenmiş mesajları
// FAZ K/4 — COMPOSER EMOJI SECICI BAGLANDI.
// Composer'da emoji eklemenin HICBIR yolu yoktu: kabukta yalnizca dosya
// ekle, textarea ve gonder vardi. Tepki seti (MessageRenderer) mesaja
// TEPKI verir, mesaj YAZMAZ. Seciciler gomulu bir kurate emoji kumesi
// kullanir; disari istek atmaz ve paket butcesini zorlamaz.
import './core/emoji-picker-svelte.ts';
// FAZ K/5 — BILDIRIM TERCIHLERI BAGLANDI.
// Sunucu tarafi TAMDI (kanal/sunucu seviyesi, `muteUntil` ile erteleme,
// varsayilana donus) ama istemcideki panel 50 satirlik BOS bir kabuktu ve
// uretim girisinden HIC import edilmiyordu: kullanici bir kanali
// SUSTURAMIYORDU. Panel gercek uygulamayla degistirildi ve baglandi.
import './core/notification-prefs-svelte.ts';
// FAZ K+/4 — MESAJ KALICI BAGLANTILARI.
// Arama bir mesaja ATLAYABILIYORDU ama kimse bir mesaja BAGLANTI
// VEREMIYORDU. Rota hash tabanlidir: uygulama statik bir kabuk ve sunucuda
// SPA fallback yok — `/servers/x/...` yolu 404 donerdi.
// FAZ 8/6 — YAVAS MOD GORUNUR KILINDI.
// Sunucu yavas modu ZATEN uyguluyor ve `error:slowmode` yayiyordu; istemcide
// bu olayi dinleyen kimse yoktu, mesaj SESSIZCE gitmiyordu. Arka uc
// davranisi degismedi — yalnizca aciklama eklendi.
// FAZ 8/1 — DM ARAMASI BAGLANDI.
// Panel gercek bir uygulamaydi ama sunucununkinden FARKLI bir protokol
// konusuyordu (istemci `callId` uyduruyor, `targetUserId` gondermiyor,
// yayilmayan `dm:call:answered` olayini dinliyordu): arama CALAR ama asla
// BAGLANMAZDI. Sinyallesme sunucu sozlesmesine hizalandi ve baglandi.
// FAZ 8/2 — OKUNMAMIS SISTEMI BAGLANDI.
// Sunucu okunmamislari ZATEN sayiyor ve VIEW_CHANNELS ile suzulmus halde
// sunuyordu; `UnreadBadge` de gercek bir durum sahibiydi. Aradaki tel
// YOKTU: kullanici nerede yeni mesaj oldugunu goremiyordu.
import './core/unread-svelte.ts';
import './core/dm-call-svelte.ts';
import './core/slow-mode-svelte.ts';
import { initPermalinkRouter } from './core/permalink/permalink-router.ts';
initPermalinkRouter();
// Faz 12 sonrası — KEŞFET BAĞLANDI.
// DiscoverPanel.svelte (798 satır) gerçek bir uygulamaydı: /api/discover,
// /featured, /categories çağrıları, kategori/arama/sıralama/sayfalama ve
// katılma akışı. Ancak shim'i hiçbir yerden import edilmiyor, `#discover-root`
// hiç var olmuyor ve onu açacak bir kontrol bulunmuyordu — özellik tümüyle
// erişilemezdi. Açıcı: sunucu rail'indeki "Keşfet" düğmesi.
import './core/discover-svelte.ts';
// Faz C1.3 — SUNUCU AYARLARI BAĞLANDI.
// ServerSettingsModal (250 satır + 7 sekme) gerçek bir uygulamaydı ama shim'i
// hiçbir yerden import edilmiyor ve onu açacak bir kontrol bulunmuyordu.
// Açıcı, kanal başlığındaki mevcut araç çubuğuna yerleşir ve YALNIZCA sunucu
// sahibine görünür — arka uç `PATCH /api/servers/:sid` sahip-only olduğu için
// (routes/servers/core.ts:348) sıradan üyeye kaydedemeyeceği bir yüzey
// vaat edilmez. Yetki sınırı arka uçtadır; görünürlük yalnızca UX'tir.
import './core/server-settings-opener-svelte.ts';

// Faz C2 — KANAL İZİNLERİ BAĞLANDI.
// Arka uç (GET/PUT/DELETE .../permissions) çalışıyordu ama istemcide ne bir
// kontrolcü ne de bir açıcı vardı: `ChannelItem` üç nokta butonunu yalnızca
// `openChannelMenu` sahibi varsa çizer ve o kayıt HİÇ yapılmamıştı.
// Menü, MANAGE_CHANNELS KANITLANABİLİYORSA açılır (fail-closed) ve düzenleyici
// tarihsel `{@html}` kabuğu yerine güvenli, veri tabanlı editördür.
import './core/channel-perms/channel-action-menu-svelte.ts';

// Faz C3 — STICKER PAKETLERİ BAĞLANDI.
// Paket kalıcılığı (sticker_packs / sticker_pack_items) ve rotalar çalışıyordu
// ama istemci yüzeyi ABSENT'ti. Panel paketleri LİSTELER (VIEW_CHANNELS) ve
// MANAGE_SERVER kanıtlanırsa yönetim sunar. P3'te gönderim, message outbox'ın
// canonical `type:'sticker'` + server-verified snapshot sözleşmesine bağlandı.
import './core/stickers/sticker-opener-svelte.ts';
import './core/bot-marketplace/bot-marketplace-svelte.ts'; // 10/10: canonical executable marketplace owner
import './admin/admin-launcher.ts'; // 10/10: lazy site-admin registry owner; global-admin gated
import './core/group-dm-svelte.ts';                                         // Faz 10: reachable group DM surface
import './mobile.ts';                                                       // Faz 9: reachable narrow-window navigation
const log = createLogger('App');


// İlk girişte boş sunucu listesini kontrol et.
// bridge:auth-success event'i auth.ts tarafından login sonrası tetiklenir
document.addEventListener('bridge:auth-success', () => {
  // Final21 Faz 16: kişinin okuduğu dil sunucuya bildirilir; sunucunun yazdığı push metni
  // artık herkese Türkçe gitmiyor. Oturum açmadan önce bildirilemez, bu yüzden burada da.
  void import('./core/i18n/locale-sync.ts')
    .then(m => m.reportLocaleToServer(document.documentElement.getAttribute('lang') || 'tr'))
    .catch(() => {});
  // Kısa gecikme: app shell render ve oturum depolaması tamamlansın.
  setTimeout(() => {
    void BridgeRegistry.call('checkEmptyServerStart');
  }, 800);
});

// Boot hatalarını yakala.
//
// ── BOOT SÖZÜ DIŞA AÇILIR ─────────────────────────────────────────────────
// Bu blok bir "kayıp söz"dü: `wrap(...)()` bir Promise döndürüyor ama kimse
// onu tutmuyordu. Boot'un BİTTİĞİNİ gözlemenin tek yolu mikro-görev sayısını
// TAHMİN etmekti; testler `await Promise.resolve()` çağrılarını sayarak
// ilerliyor ve makinenin hızına göre bazen boot bitmeden iddiaya geçiyordu
// (ölçülen kırılganlık: `app-entrypoint-boot` süresiz/rastgele düşüyordu).
// Sözü dışa açmak hem o belirsizliği kaldırır hem de kabuk/E2E tarafına
// "uygulama hazır" için gerçek bir kanca verir.
export const bootReady: Promise<void> = errorBoundary.wrap(async () => {
  await loadTheme();
  // Tema ile aynı katman: kullanıcı tercihi olan sunum ayarları, ilk boyamadan
  // önce uygulanır ki kullanıcı yanlış dilde bir kare görmesin.
  initI18nDom();
  BridgeState.initState();
  // Sprint 82: Yeni özellikler
  // Faz 12 — DÜRÜSTLÜK DÜZELTMESİ: burada `initA11yWcagAA()` çağrılıyor ve
  // yorumu "WCAG 2.1 AA — skip-link, landmark, reduced-motion" vaat ediyordu.
  // Gerçek zincir yalnızca şuydu:
  //     initA11yWcagAA() → mountWcagAudit() → WcagAudit.svelte
  // ve WcagAudit 52 satırlık boş kabuktur (isVisible=false, hiçbir şey çizmez).
  // Skip-link, landmark yamaları, reduced-motion, ARIA yamaları ve kontrast
  // yardımcıları ÜRETİMDE HİÇ YOKTU — boot'ta yanlış bir yetenek iddiası
  // duruyordu. Çağrı kaldırıldı; kaynak ileride gerçek bir özellik için
  // dormant bırakıldı. Gerçek erişilebilirlik davranışı (ChannelItem klavye
  // /aria-current, composer aria, MessageRenderer semantiği) kendi canlı
  // bileşenlerinde durur ve kendi testleriyle korunur.
  initDesktopUpdater();  // Desktop: otomatik güncelleme durumu + yeniden başlatma akışı
  initDesktopDeepLinks(); // Desktop: bridge://invite|servers|channels (Final21 Faz 12)
  initNativePush();       // P4: Capacitor push jetonu → /api/mobile/push/register-native (CSRF + API kökü)
  initNativeDeepLinks();  // P4: Capacitor derin bağlantıları ve bildirim dokunuşları (sunucu izinli yollarla)
  bindWebPushToSession(); // P4: çıkış → tarayıcı aboneliği ve bu kurulumun kaydı temizlenir
  log.log(`[Bridge] Boot tamamlandı — API: ${getAPI()}`);
}, 'app:boot')();
