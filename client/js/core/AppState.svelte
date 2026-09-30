<!-- client/js/core/AppState.svelte -->
<!-- Sprint 116 — state.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Global uygulama durumu yöneticisi -->
<!--
  Faz 1 (toparlama): Bu bileşen uygulamanın TEK state sahibidir.

  Kural: legacy `globals.ts` state container'ı geri getirilmez. Düz TS modülleri
  (örn. core/globals.ts proxy'leri) state'e yalnızca BridgeRegistry üzerinden
  erişir; ikinci bir kopya tutulmaz.

  core/globals.ts:10-45 içindeki Proxy'ler registry'den gelen değeri
  "fonksiyonsa çağır, değilse doğrudan kullan" şeklinde okuduğu için buradaki
  kayıtlar getter fonksiyonu olarak yapılır — böylece her okuma güncel değeri alır.
-->
<script lang="ts">
  import { onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('AppState');

  let { children }: { children?: Snippet } = $props();

  interface AppUser    { _id?: string; id?: string; username?: string; displayName?: string; [key: string]: unknown }
  interface AppServer  { _id: string; name?: string; icon?: string; iconUrl?: string | null; [key: string]: unknown }
  interface AppChannel { _id: string; name?: string; type?: string; categoryId?: string | null; [key: string]: unknown }

  // ── Merkezi durum ──────────────────────────────────────────────────────────
  let me                    = $state<AppUser | null>(null);
  let currentServer         = $state<AppServer | null>(null);
  let currentChannel        = $state<AppChannel | null>(null);
  let currentServerChannels = $state<AppChannel[]>([]);
  // userId → displayName. Faz 4 (typing bar) bu haritayı okuyacak.
  let typingUsers           = $state<Map<string, string>>(new Map());
  // Socket yaşam döngüsünün sahibi SocketManager.svelte'dir; burada yalnızca
  // diğer katmanların okuyabilmesi için durum yansıtılır.
  let socketConnected       = $state(false);

  // ── Faz 4: mesaj durumu (tek sahip burasıdır, ikinci store yok) ────────────
  interface AppMessage { _id: string; _key?: string; channelId?: string; content?: string; createdAt?: number; ackId?: string; [key: string]: unknown }
  let messages        = $state<AppMessage[]>([]);
  let messagesLoading = $state(false);
  let messagesError   = $state('');
  /** REST prevCursor — daha eski sayfa için (server/routes/messages.ts:199). */
  let messageCursor   = $state<string | null>(null);
  let messagesHasMore = $state(false);
  // User-specific chronological boundary from the first page response. It is
  // never persisted in shared/local caches; changing channel clears it.
  let firstUnreadMessageId = $state<string | null>(null);

  /** Kanal/sunucu değişiminde mesaj bağlamını sıfırlar (eski kanalın mesajları görünmesin). */
  function resetMessageState(): void {
    messages = [];
    messageCursor = null;
    messagesHasMore = false;
    messagesError = '';
    firstUnreadMessageId = null;
    typingUsers = new Map();
  }

  type OwnedRegistryFn = (...args: unknown[]) => unknown;
  const ownedRegistry = new Map<string, OwnedRegistryFn>();
  function registerOwned<T extends (...args: never[]) => unknown>(name: string, fn: T): void {
    BridgeRegistry.register(name, fn);
    ownedRegistry.set(name, fn as unknown as OwnedRegistryFn);
  }

  // ── Registry köprüsü ───────────────────────────────────────────────────────
  // Kayıtlar script gövdesinde yapılır (onMount değil): mount() sonrası ilk
  // okuma anına kadar hazır olmaları gerekiyor.
  registerOwned('getMe',                    () => me);
  registerOwned('getCurrentServer',         () => currentServer);
  registerOwned('getCurrentChannel',        () => currentChannel);
  registerOwned('getCurrentServerChannels', () => currentServerChannels);
  registerOwned('getTypingUsers',           () => typingUsers);
  registerOwned('getSocketConnected',       () => socketConnected);

  // core/globals.ts Proxy'lerinin aradığı kısa adlar
  registerOwned('me',                    () => me);
  registerOwned('currentServer',         () => currentServer);
  registerOwned('currentChannel',        () => currentChannel);
  registerOwned('currentServerChannels', () => currentServerChannels);
  registerOwned('typingUsers',           () => typingUsers);

  registerOwned('setMe', (user: AppUser | null) => { me = user; });
  registerOwned('setCurrentServer', (server: AppServer | null) => {
    if (server?._id === currentServer?._id) { currentServer = server; return; }
    currentServer = server;
    // Sunucu gerçekten değiştiyse kanal bağlamı geçersizdir — Faz 2/3 yeniden doldurur.
    currentChannel = null;
    currentServerChannels = [];
    resetMessageState(); // eski sunucunun mesajları sızmasın
  });
  registerOwned('setCurrentChannel', (channel: AppChannel | null) => {
    if (channel?._id !== currentChannel?._id) resetMessageState();
    currentChannel = channel;
  });
  registerOwned('setCurrentServerChannels', (channels: AppChannel[]) => { currentServerChannels = channels ?? []; });
  registerOwned('setSocketConnected',       (value: boolean) => { socketConnected = Boolean(value); });

  // ── Faz 4: mesaj state erişimi ─────────────────────────────────────────────
  registerOwned('getMessages',        () => messages);
  registerOwned('messages',           () => messages);
  registerOwned('getMessagesLoading', () => messagesLoading);
  registerOwned('getMessagesError',   () => messagesError);
  registerOwned('getMessageCursor',   () => messageCursor);
  registerOwned('getMessagesHasMore', () => messagesHasMore);
  registerOwned('getFirstUnreadMessageId', () => firstUnreadMessageId);

  /**
   * Mesajlar her zaman eskiden→yeniye sıralı tutulur.
   * REST (routes/messages.ts:192) sayfayı yeniden→eskiye döndürüyor, socket
   * message:new ise en yeniyi veriyor; tek sıralama noktası burasıdır.
   * createdAt REST'te string, socket'te number gelebilir → Number() ile normalize.
   */
  function sortByTime(list: AppMessage[]): AppMessage[] {
    return list.slice().sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0));
  }

  /**
   * Sunucudan gelen liste ile tazele. Faz 7: henüz sunucuya işlenmemiş YEREL
   * kayıtlar (pending/failed) korunur — aksi halde reconnect resync'i veya
   * yeniden yükleme, kullanıcının başarısız mesajını sessizce yok ederdi.
   * Kanal değişiminde `resetMessageState()` zaten hepsini temizler.
   */
  registerOwned('setMessages', (list: AppMessage[], liveIds?: Iterable<string>) => {
    const server = Array.isArray(list) ? list : [];
    const serverIds = new Set(server.map(m => m._id));
    // P3: `liveIds` — istek uçuştayken soketten gelmiş (anlık görüntüden yeni)
    // mesajlar; yanıtta olmamaları silindikleri anlamına gelmez.
    const live = new Set(liveIds ?? []);
    const localOnly = messages.filter(m => (m.pending || m.failed || live.has(m._id)) && !serverIds.has(m._id));
    messages = sortByTime([...server, ...localOnly]);
  });
  registerOwned('setMessagesLoading', (value: boolean) => { messagesLoading = Boolean(value); });
  registerOwned('setMessagesError',   (value: string) => { messagesError = value ?? ''; });
  registerOwned('setMessageCursor',   (cursor: string | null) => { messageCursor = cursor ?? null; });
  registerOwned('setMessagesHasMore', (value: boolean) => { messagesHasMore = Boolean(value); });
  registerOwned('setFirstUnreadAnchor', (messageId: string | null) => {
    firstUnreadMessageId = typeof messageId === 'string' && messageId ? messageId : null;
  });

  /** Yeni mesaj — aynı _id iki kez eklenmez (socket + REST çakışması). */
  registerOwned('appendMessage', (message: AppMessage) => {
    if (!message?._id || messages.some(m => m._id === message._id)) return false;
    messages = sortByTime([...messages, message]);
    return true;
  });
  /** Daha eski sayfa — mevcut olanlar tekrarlanmaz, birleşim zamana göre sıralanır. */
  registerOwned('prependMessages', (list: AppMessage[]) => {
    const known = new Set(messages.map(m => m._id));
    const fresh = (list ?? []).filter(m => m?._id && !known.has(m._id));
    if (fresh.length) messages = sortByTime([...fresh, ...messages]);
    return fresh.length;
  });
  /**
   * Faz 7 — teslim durumu uzlaştırma (optimistic → gerçek mesaj).
   *
   * `message:new` ve `message:ack` hangi sırada gelirse gelsin sonuç aynıdır:
   *   - gerçek mesaj listeye zaten girdiyse → pending kayıt düşürülür
   *   - girmediyse → pending kaydın _id'si gerçek messageId ile değiştirilir
   * Böylece aynı mesaj asla iki kez render edilmez.
   */
  registerOwned('replaceMessage', (oldId: string, patch: AppMessage) => {
    const index = messages.findIndex(m => m._id === oldId);
    if (index < 0) return false;

    const newId = patch?._id;
    if (newId && newId !== oldId && messages.some(m => m._id === newId)) {
      // ODAK KORUMASI: pending satir dusuyor, gercek satir kaliyor. Liste
      // `_key` ile anahtarlandigi icin, gercek satir pending'in anahtarini
      // DEVRALIRSA Svelte ayni DOM dugumunu yeniden kullanir ve odak yerinde
      // kalir. Devralmazsa dugum yok edilir ve odak `<body>`'ye duser.
      const stableKey = messages[index]?._key;
      messages = messages
        .filter(m => m._id !== oldId)
        .map(m => (m._id === newId && stableKey ? { ...m, _key: stableKey } : m));
      return true;
    }

    const next = messages.slice();
    next[index] = { ...next[index], ...patch };
    messages = sortByTime(next);
    return true;
  });

  registerOwned('updateMessage', (message: AppMessage) => {
    if (!message?._id) return false;
    const index = messages.findIndex(m => m._id === message._id);
    if (index < 0) return false;
    const next = messages.slice();
    next[index] = { ...next[index], ...message };
    messages = next;
    return true;
  });
  registerOwned('removeMessage', (messageId: string) => {
    if (!messages.some(m => m._id === messageId)) return false;
    messages = messages.filter(m => m._id !== messageId);
    return true;
  });

  registerOwned('setTypingUser', (userId: string, displayName: string) => {
    const next = new Map(typingUsers);
    next.set(userId, displayName);
    typingUsers = next;
  });
  registerOwned('clearTypingUser', (userId: string) => {
    if (!typingUsers.has(userId)) return;
    const next = new Map(typingUsers);
    next.delete(userId);
    typingUsers = next;
  });
  registerOwned('clearTypingUsers', () => { typingUsers = new Map(); });

  // ── Auth köprüsü ───────────────────────────────────────────────────────────
  // auth-compat.ts:145 login/session-restore sonrası bridge:auth-success yayar.
  // Kullanıcı bilgisinin tek kaydı buradan geçer.
  function onAuthSuccess(event: Event): void {
    const detail = (event as CustomEvent<AppUser>).detail;
    if (detail && typeof detail === 'object') {
      me = detail;
      log.info('Oturum kullanıcısı state\'e alındı');
    }
  }
  document.addEventListener('bridge:auth-success', onAuthSuccess);

  // Modül auth-success'ten sonra yüklendiyse (geç mount) kullanıcıyı yakala.
  const bootUser = (globalThis as { currentUser?: AppUser }).currentUser;
  if (bootUser && typeof bootUser === 'object') me = bootUser;

  log.info('AppState hazır');

  onDestroy(() => {
    document.removeEventListener('bridge:auth-success', onAuthSuccess);
    for (const [name, fn] of ownedRegistry) {
      if (BridgeRegistry.get(name) === fn) BridgeRegistry.unregister(name);
    }
    ownedRegistry.clear();
    log.info('AppState destroyed');
  });
</script>

{@render children?.()}
