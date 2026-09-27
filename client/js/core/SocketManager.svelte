<!-- client/js/core/SocketManager.svelte -->
<!-- Sprint 116 — socket.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- WebSocket bağlantı yöneticisi -->
<!--
  Faz 1 (toparlama): Uygulamadaki TEK Socket.IO bağlantısının sahibi burasıdır.

  Sözleşme (server/socket/index.ts:130 — verifyToken(socket.handshake.auth.token)):
    io(API, { auth: { token }, transports: ['websocket', 'polling'] })
  Legacy servers.ts:63-66 ile aynı seçenekler; backend sözleşmesi değişmedi.

  Paylaşım yalnızca BridgeRegistry üzerinden yapılır (window.socket YOK).
  socket-svelte.ts:36-45 proxy'si 'socket' kaydını okuyarak çalışmaya devam eder.
-->
<script module lang="ts">
  // Modül kapsamı = uygulama ömrü boyunca tek örnek.
  // Bileşen iki kez mount edilse bile ikinci bir bağlantı açılmaz.
  interface SocketLike {
    connected: boolean;
    id?: string;
    on(event: string, handler: (...args: unknown[]) => void): void;
    /** Tek seferlik dinleyici — `userAuthenticated` hazır sinyali için. */
    once(event: string, handler: (...args: unknown[]) => void): void;
    emit(event: string, ...args: unknown[]): void;
    disconnect(): void;
  }
  type IoFactory = (url: string, opts: Record<string, unknown>) => SocketLike;

  let _socket: SocketLike | null = null;
  let _socketToken: string | null = null;
  let _readyDispatched = false;

  // ── Auth kurtarma durumu (Faz 7) ───────────────────────────────────────────
  /** Aynı anda yalnızca tek yenileme+yeniden bağlanma denemesi. */
  let _reauthInFlight = false;
  /** Art arda başarısız auth denemesi — backoff ve döngü koruması için. */
  let _reauthAttempts = 0;
  let _reauthTimer: ReturnType<typeof setTimeout> | null = null;
  /** İlk bağlantıdan sonraki her başarılı bağlantı bir "reconnect"tir. */
  let _hasConnectedOnce = false;

  /** `userAuthenticated` beklerken üst sınır — sinyal kaybolursa ürün kilitlenmesin. */
  const READY_SIGNAL_FALLBACK_MS = 3000;

  const MAX_REAUTH_ATTEMPTS = 5;
  const BASE_BACKOFF_MS     = 1000;
  const MAX_BACKOFF_MS      = 30_000;
</script>

<script lang="ts">
  import { onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry, type AnyFn } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  import { getAPI } from './globals.js';
  import { readToken, logout } from './auth-compat.js';
  import { t } from './i18n/index.js';
  // Faz 7: token yenileme REST katmanıyla ORTAK (tek uçuşlu paylaşılan promise).
  import { refreshAccessToken, wasLastRefreshFailureTransient } from './api-fetch.js';
  const log = createLogger('SocketManager');

  let { children }: { children?: Snippet } = $props();

  // User-visible copy must never echo transport/auth middleware internals.
  // Detailed reasons stay in the structured logger below.
  let lastError = $state('');

  function connectionProblemMessage(): string {
    return t('socket_connection_problem', 'Gerçek zamanlı bağlantı kurulamadı. Yeniden bağlanılıyor…');
  }

  function socketClientUnavailableMessage(): string {
    return t('socket_client_unavailable', 'Gerçek zamanlı özellikler yüklenemedi. Sayfayı yenileyin.');
  }

  function setConnectedState(value: boolean): void {
    // Bağlantı durumunun kanonik sahibi AppState'tir (tek state kaynağı kuralı).
    BridgeRegistry.call('setSocketConnected', value);
  }

  /** Socket hazır sinyali. Mevcut dinleyicilerin tamamı `document` üzerinde
   *  (app.ts:54 ve ~100 adet *-svelte.ts shim'i), bu nedenle her iki hedefe de
   *  yayılır; window'a dispatch edilen olay document dinleyicilerine ulaşmaz. */
  function dispatchSocketReady(): void {
    if (_readyDispatched) return;
    _readyDispatched = true;
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    window.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    log.info('bridge:socket-ready yayıldı');
  }

  function bindLifecycle(socket: SocketLike, userId: string | undefined): void {
    socket.on('connect', () => {
      setConnectedState(true);
      lastError = '';
      _reauthAttempts = 0;   // sağlıklı bağlantı → backoff sıfırlanır
      _reauthInFlight = false;
      // Kişisel oda: DM/bildirim yönlendirmesi için (server/socket/index.ts:183)
      if (userId) socket.emit('user:join-room', userId);
      // Registry kaydı: bağlantı gerçekten kurulduktan sonra.
      // register() imzası fonksiyon bekliyor (bridge-registry.ts:42), proxy ise
      // 'socket' altında OBJE okuyor (socket-svelte.ts:38) — API'yi değiştirmemek
      // için tek noktada cast ediliyor.
      BridgeRegistry.register('socket', socket as unknown as AnyFn);
      log.info(`Socket bağlandı (id: ${socket.id ?? '?'})`);

      // ══════════════════════════════════════════════════════════════════════
      // HAZIR SİNYALLERİ `connect` DEĞİL, `userAuthenticated` İLE TETİKLENİR
      // ══════════════════════════════════════════════════════════════════════
      // KAPATILAN GERÇEK KUSUR: `bridge:socket-ready` ve
      // `bridge:socket-reconnected` doğrudan `connect` içinde yayılıyordu.
      // Dinleyiciler (özellikle MessageLoader) bu sinyalde HEMEN
      // `channel:join` yayar.
      //
      // Sunucu ise özellik dinleyicilerini (`channel:join`, `message:*`,
      // `voice:*` …) DÖRT ardışık `await` SONRASINDA kaydeder
      // (server/socket/index.ts: findById → trackSocket → Users.update →
      // setupMemberships). Socket.IO, dinleyicisi olmayan olayı SESSİZCE
      // ATAR — hata yok, log yok, ack yok (`channel:join` zaten ack'sizdir).
      //
      // DOĞRUDAN ÖLÇÜLDÜ (iki gerçek sunucu, deterministik):
      //     connect → join gecikmesi = 0 ms    → teslim 0/1  (6 denemede)
      //     connect → join gecikmesi ≥ 500 ms  → teslim 1/1
      //
      // GERÇEK ETKİ yeniden bağlanmada ağırdır: kopukken sunucudaki oda
      // üyeliği düşer (aşağıdaki `disconnect` ve MessageLoader notları).
      // Yeniden bağlanınca gönderilen `channel:join` düşerse kullanıcı
      // BAĞLI görünür ama CANLI MESAJ ALMAZ — kanal değiştirene veya sayfayı
      // yenileyene kadar. Wi-Fi kesintisi, uyku/uyanma ve sunucu yeniden
      // başlatması bu yolu her gün tetikler.
      //
      // Sunucu `userAuthenticated`ı TÜM dinleyiciler kaydedildikten SONRA
      // yayar (server/socket/index.ts — "HAZIR SİNYALİ" notu). Doğru sözleşme
      // budur; istemci de artık onu bekler.
      //
      // YEDEK SÜRE: sinyal beklenmedik biçimde gelmezse (eski sunucu, ağ
      // kaybı) sinyaller yine de yayılır — özellik kaybı yerine kısa bir
      // yarış riski tercih edilir. Bu, E2E `openSocket` yardımcısındaki
      // kalıbın aynısıdır (e2e/helpers/socket.ts).
      const wasReconnect = _hasConnectedOnce;
      _hasConnectedOnce = true;

      let signalled = false;
      const emitReadySignals = (): void => {
        if (signalled) return;
        signalled = true;
        if (wasReconnect) {
          // Yeniden bağlanma: oda üyelikleri kaybolmuştur ve kopukken gelen
          // mesajlar kaçmıştır. Dinleyen katmanlar (MessageLoader) kanala
          // yeniden katılıp eksik mesajları çeker.
          log.info('Socket yeniden bağlandı — senkronizasyon sinyali yayılıyor');
          document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
        }
        dispatchSocketReady();
      };

      const fallback = setTimeout(() => {
        log.warn('userAuthenticated gelmedi — hazır sinyali yedek süreyle yayılıyor');
        emitReadySignals();
      }, READY_SIGNAL_FALLBACK_MS);

      socket.once('userAuthenticated', () => {
        clearTimeout(fallback);
        emitReadySignals();
      });
    });

    socket.on('disconnect', (...args: unknown[]) => {
      setConnectedState(false);
      document.dispatchEvent(new CustomEvent('bridge:socket-disconnected'));
      log.warn('Socket bağlantısı koptu:', args[0] ?? '');
      // Socket.IO kendi reconnect döngüsünü yürütür; burada müdahale edilmez.
    });

    socket.on('connect_error', (...args: unknown[]) => {
      setConnectedState(false);
      const err = args[0] as { message?: string } | undefined;
      const technicalMessage = err?.message ?? 'bilinmeyen bağlantı hatası';
      lastError = connectionProblemMessage();

      // Auth hatasında Socket.IO'nun kendi döngüsü AYNI bayat token'la tekrar
      // dener ve asla toparlanmaz. Token'ı yenileyip yeni bağlantı kuruyoruz.
      if (isAuthError(technicalMessage)) {
        log.warn('Socket auth hatası:', technicalMessage);
        scheduleReauth();
        return;
      }
      log.error('Socket bağlantı hatası:', technicalMessage);
    });

    // Sunucu tarafı uzun ömürlü bağlantıyı fail-closed kapatabilir. Sebep
    // önemlidir: token süresinin dolması / auth-store geçici arızası YENİDEN
    // KİMLİK DOĞRULAMA gerektirir; parola değişimi / logout-all / token-version
    // iptali ise gerçekten oturumu bitirir. Eski kod her sebepte yalnız
    // `teardown()` yapıyordu: access token süresi dolunca UI giriş yapmış
    // görünmeye devam ediyor ama realtime kalıcı olarak ölüyordu.
    socket.on('auth:revoked', (...args: unknown[]) => {
      const payload = args[0] as { reason?: unknown } | undefined;
      const reason = typeof payload?.reason === 'string' ? payload.reason : 'unknown';

      if (reason === 'token_expired' || reason === 'auth_check_failed') {
        log.warn(`Socket kimliği yeniden doğrulanmalı (${reason})`);
        teardown();
        lastError = connectionProblemMessage();
        scheduleReauth();
        return;
      }

      log.warn(`Oturum sunucu tarafında iptal edildi (${reason}) — çıkış yapılıyor`);
      teardown();
      logout();
    });
  }

  /** Sunucunun auth middleware'inin döndürdüğü hatalar (socket/index.ts:131-140). */
  function isAuthError(message: string): boolean {
    return /unauthorized|token revoked|auth check failed|jwt|expired/i.test(message);
  }

  /**
   * Auth hatasından kurtarma: access token'ı yenile, eski soketi tamamen kapat
   * (dinleyiciler dahil) ve taze token'la yeniden bağlan.
   *
   * - Tek uçuş: aynı anda yalnızca bir deneme (_reauthInFlight).
   * - Exponential backoff: 1s, 2s, 4s, 8s, 16s (max 30s).
   * - Döngü koruması: MAX_REAUTH_ATTEMPTS sonrası vazgeçilir ve oturum kapatılır.
   * - Yenileme mantığı api-fetch.ts ile ORTAK (paylaşılan promise) — REST tarafı
   *   aynı anda yenileme yapıyorsa ikinci bir /api/refresh isteği gitmez.
   */
  function scheduleReauth(): void {
    if (_reauthInFlight) return;

    if (_reauthAttempts >= MAX_REAUTH_ATTEMPTS) {
      log.error(`Socket yeniden kimlik doğrulama ${MAX_REAUTH_ATTEMPTS} denemede başarısız — oturum kapatılıyor`);
      teardown();
      logout();
      return;
    }

    _reauthInFlight = true;
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** _reauthAttempts, MAX_BACKOFF_MS);
    _reauthAttempts += 1;
    log.info(`Socket yeniden bağlanma denemesi ${_reauthAttempts}/${MAX_REAUTH_ATTEMPTS} — ${delay} ms sonra`);

    if (_reauthTimer) clearTimeout(_reauthTimer);
    _reauthTimer = setTimeout(() => {
      _reauthTimer = null;
      void (async () => {
        try {
          const refreshed = await refreshAccessToken();
          // Eski soketi (ve tüm dinleyicilerini) bırak — duplicate bağlantı ve
          // listener sızıntısı olmaz.
          teardown();

          if (!refreshed) {
            if (wasLastRefreshFailureTransient()) {
              // DB/refresh servisi gecici olarak yoksa oturumu silmek fail-open
              // degildir: sunucu socket'i zaten fail-closed kapatmistir. Kimlik
              // reddedilmedigi icin kullaniciyi login ekranina atmak yerine
              // kontrollu backoff ile yeniden deneriz.
              log.warn('Token yenileme geçici olarak kullanılamıyor — oturum korunuyor');
              _reauthInFlight = false;
              _reauthAttempts = Math.min(_reauthAttempts, MAX_REAUTH_ATTEMPTS - 1);
              scheduleReauth();
              return;
            }
            log.warn('Token yenilenemedi — oturum kapatılıyor');
            logout();
            return;
          }
          connect(); // taze token localStorage'da; connect() onu okur
        } catch (error) {
          log.error('Yeniden kimlik doğrulama hatası', error);
          _reauthInFlight = false;
        }
      })();
    }, delay);
  }

  function connect(): void {
    if (typeof window === 'undefined') return;

    const token = readToken();
    if (!token) return; // Oturum yok — auth-success beklenecek.

    // Aynı token ile zaten bağlıysa ikinci bağlantı açma.
    if (_socket && _socketToken === token) return;

    // Kullanıcı değiştiyse (logout → başka hesapla login) eski soketi kapat.
    if (_socket && _socketToken !== token) teardown();

    const io = (globalThis as { io?: IoFactory }).io;
    if (typeof io !== 'function') {
      lastError = socketClientUnavailableMessage();
      log.error('window.io bulunamadı — /socket.io/socket.io.js yüklenmemiş olabilir');
      return;
    }

    const user = BridgeRegistry.call<{ _id?: string; id?: string } | null>('getMe')
      ?? (globalThis as { currentUser?: { _id?: string; id?: string } }).currentUser
      ?? null;

    _socketToken = token;
    _socket = io(getAPI(), {
      auth: { token },
      transports: ['websocket', 'polling'],
    });
    bindLifecycle(_socket, user?._id ?? user?.id);
    log.info('Socket bağlantısı başlatıldı');
  }

  function teardown(): void {
    if (_reauthTimer) { clearTimeout(_reauthTimer); _reauthTimer = null; }
    // `refreshAccessToken() === false` yolunda teardown() sonrası logout()
    // gerçekleşir. Bu bayrak serbest bırakılmazsa kullanıcı daha sonra tekrar
    // giriş yaptığında bir sonraki socket auth hatası sonsuza kadar yutulur.
    _reauthInFlight = false;
    if (!_socket) return;
    try { _socket.disconnect(); } catch { /* bağlantı zaten kapalı olabilir */ }
    _socket = null;
    _socketToken = null;
    _readyDispatched = false;
    BridgeRegistry.unregister('socket');
    setConnectedState(false);
  }

  function onAuthSuccess(): void { connect(); }
  document.addEventListener('bridge:auth-success', onAuthSuccess);

  // Diğer katmanların (Faz 2+, logout) kullanabilmesi için.
  BridgeRegistry.register('connectSocket', connect);
  BridgeRegistry.register('disconnectSocket', teardown);

  // Geç mount senaryosu: auth-success bu bileşen yüklenmeden önce yayılmış olabilir.
  connect();

  onDestroy(() => {
    document.removeEventListener('bridge:auth-success', onAuthSuccess);
    teardown();
    if (BridgeRegistry.get('connectSocket') === connect) BridgeRegistry.unregister('connectSocket');
    if (BridgeRegistry.get('disconnectSocket') === teardown) BridgeRegistry.unregister('disconnectSocket');
    log.info('SocketManager destroyed');
  });
</script>

{#if lastError}
  <div class="socket-manager-error" role="status" aria-live="polite">{lastError}</div>
{/if}
{@render children?.()}

<style>
.socket-manager-error {
  position: fixed;
  bottom: 8px;
  left: 8px;
  /* Baglanti hatasi bildirimi — toast katmani. */
    z-index: var(--z-toast);
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--bridge-surface, #1e2124);
  color: var(--bridge-danger, #e05260);
  font-size: .75rem;
  pointer-events: none;
}
</style>
