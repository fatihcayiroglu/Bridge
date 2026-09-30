<script lang="ts">
  import { avatarStyle } from './avatar-color.ts';
  import { t } from './i18n/reactive.svelte.ts';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { onMount, onDestroy, tick } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  import { closeExclusivePeers } from './exclusive-surface.ts';
  import { connectionLostDeliveryError, messageDeliveryError } from './message-delivery-error.ts';
  import { ApiResponseError, safeApiErrorMessage } from './api-error.ts';
  import { readDraft, writeDraft, clearDraft, type DraftIdentity } from './draft-store.ts';
  const log = createLogger('DmPanel');

  interface User { _id: string; username?: string; displayName?: string; avatarColor?: string; avatarUrl?: string | null; status?: string }
  /** `unreadCount` sunucuda TÜRETİLİR (routes/dm.ts) — istemci sayaç uydurmaz. */
  interface Conversation { _id: string; dmId?: string; participants?: string[]; other: User; lastMessage?: Message | null; unreadCount?: number }
  interface Message { _id?: string; dmId?: string; userId: string; displayName?: string; avatarColor?: string; content: string; createdAt?: number | string; clientNonce?: string; pending?: boolean; failed?: boolean; lastError?: string }

  let isVisible = $state(false);

  // ── KABUKTA OKUNMAMIŞ DM GÖSTERGESİ ────────────────────────────────────────
  // BULUNAN KUSUR (canlı ölçüm): B, A'ya DM gönderirken A bir kanala bakıyordu.
  // A'da HİÇBİR belirti oluşmadı — rozet yok, başlık değişmedi. Yani kullanıcı
  // yeni bir DM geldiğini ANLAYAMIYORDU.
  //
  // İKİNCİ BİR DOĞRULUK KAYNAĞI YARATILMAZ: konuşma başına okunmamış sayısı
  // SUNUCUDA tutulur ve liste her yüklemede oradan türetilir (aşağıdaki
  // `onMessage` yorumuna bakın). Buradaki sayaç yalnızca GEÇİCİ bir kabuk
  // göstergesidir: "yeni DM var". Panel açılınca sıfırlanır.
  let shellUnread = $state(0);

  let isLoading = $state(false);
  let isSending = $state(false);
  let conversations = $state<Conversation[]>([]);
  let active = $state<Conversation | null>(null);
  let messages = $state<Message[]>([]);
  let draft = $state('');
  let errorMsg = $state('');
  // Async responses must not restore a conversation/list after the user has
  // navigated elsewhere or logged out. Each newer operation invalidates the
  // older operation before it can commit private data to the mounted panel.
  let listSeq = 0;
  let openSeq = 0;
  const SEND_TIMEOUT_MS = 10_000;
  /**
   * Geçmiş sayfa boyutu. Sunucu `before` + `beforeId` bileşik imlecini zaten
   * destekliyordu (tests/dm-pagination.test.ts) ama istemci yalnız son 50
   * mesajı istiyordu: daha eski DM geçmişine ARAYÜZDEN hiç ulaşılamıyordu (P3).
   */
  const DM_PAGE = 50;
  let hasOlder = $state(false);
  let loadingOlder = $state(false);
  let messagesEl = $state<HTMLDivElement | null>(null);
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const apiFetch = (url: string, options?: RequestInit): Promise<Response> => {
    const fn = BridgeRegistry.get<(u: string, o?: RequestInit) => Promise<Response>>('apiFetch');
    if (!fn) return Promise.reject(new Error(t("ui_guvenli_api_istemcisi_kullanilamiyor", "Güvenli API istemcisi kullanılamıyor.")));
    return fn(url, options);
  };
  const apiBase = (): string => {
    const api = (globalThis as { BRIDGE_API?: string }).BRIDGE_API;
    return api || location.origin;
  };
  type SocketLike = {
    on?: (event: string, fn: (value: unknown) => void) => void;
    off?: (event: string, fn: (value: unknown) => void) => void;
    emit?: (event: string, payload: unknown) => void;
  };
  const currentSocket = (): SocketLike | null => BridgeRegistry.get('socket');

  /**
   * Faz 10.4 — SOCKET KİMLİĞİNE DUYARLI BAĞLAMA.
   *
   * SocketManager iki farklı yoldan "yeniden bağlanır":
   *   A) Socket.IO iç reconnect → AYNI nesne, dinleyiciler yaşar
   *   B) Auth token yenilemesi → teardown() + connect() → YENİ io() nesnesi
   *
   * Önceden dinleyici yalnız onMount'ta, o anki nesneye bağlanıyordu. (B)
   * gerçekleştiğinde dinleyici ölü nesnede kalıyor ve DM mesajları SESSİZCE
   * gelmemeye başlıyordu (panel yeniden mount edilene kadar).
   *
   * Çözüm: hangi nesneye bağlı olduğumuzu referansla takip et. Aynı nesneyse
   * hiçbir şey yapma (çift dinleyici olmaz), farklıysa eskisinden çöz + yenisine
   * bir kez bağlan. Bu, olaylar arka arkaya gelse de idempotenttir.
   *
   * Taşıma/yeniden bağlanma sahibi DAİMA SocketManager'dır; burada yalnız
   * mevcut nesneye bağlanılır.
   */
  let boundSocket: SocketLike | null = null;

  function unbindSocket(): void {
    if (!boundSocket) return;
    // Yalnız KENDİ dinleyicimizi çözüyoruz; removeAllListeners başka
    // özelliklerin dinleyicilerini de yok ederdi.
    boundSocket.off?.('dm:message', onMessage);
    boundSocket.off?.('error:message', onSendError);
    boundSocket.off?.('error:dm_rate', onSendError);
    boundSocket.off?.('error:dm_privacy', onSendError);
    boundSocket.off?.('disconnect', onSocketDisconnect);
    boundSocket = null;
  }

  function syncSocketBinding(): void {
    const socket = currentSocket();
    if (!socket) { unbindSocket(); return; }
    if (boundSocket === socket) return;   // zaten bu nesneye bağlıyız
    unbindSocket();
    socket.on?.('dm:message', onMessage);
    socket.on?.('error:message', onSendError);
    socket.on?.('error:dm_rate', onSendError);
    socket.on?.('error:dm_privacy', onSendError);
    socket.on?.('disconnect', onSocketDisconnect);
    boundSocket = socket;
  }
  const initials = (user: User): string => (user.displayName || user.username || '?').slice(0, 2).toUpperCase();
  const name = (user: User): string => user.displayName || user.username || t('ui_bridge_user');

  /** `silent`: arka planda tazeleme — yükleniyor metni ve hata sıfırlaması yok. */
  async function loadConversations(silent = false): Promise<void> {
    const seq = ++listSeq;
    if (!silent) { isLoading = true; errorMsg = ''; }
    try {
      const response = await apiFetch(`${apiBase()}/api/dm`);
      if (seq !== listSeq) return;
      // Durumu TASIYAN kanonik hata; `safeApiErrorMessage` bunu duruma uygun
      // (ve yine de govde sizdirmayan) metne esler.
      if (!response.ok) throw new ApiResponseError(response);
      const data = await response.json() as unknown;
      if (seq !== listSeq) return;
      if (!Array.isArray(data)) throw new Error(t("ui_dm_listesi_gecersiz", "DM listesi geçersiz."));
      conversations = data as Conversation[];
    } catch (error) {
      if (seq === listSeq && !silent) {
        // Panel her basarisizligi TEK bir genel metne indiriyordu: cevrimdisi
        // bir kullaniciya da, 500 donen bir sunucuya da ayni sey yaziliyordu.
        // Uygulamanin geri kalani `safeApiErrorMessage` ile duruma uygun ve
        // yine de govde sizdirmayan metni gosterir; DM listesi de ayni
        // sozlesmeyi kullanir.
        errorMsg = safeApiErrorMessage(
          error, t('dm_list_load_failed', 'DM listesi yüklenemedi.'), { report: true });
      }
    }
    finally { if (seq === listSeq) isLoading = false; }
  }

  /**
   * Açık OLMAYAN bir konuşmaya mesaj geldiğinde yan liste (okunmamış sayısı,
   * son mesaj, sıra) panel yeniden açılana kadar bayat kalıyordu. Sayaç yerelde
   * artırılmaz (çift teslim şişirirdi); sunucunun türettiği liste kısa bir
   * gecikmeyle sessizce yeniden okunur.
   */
  let listRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  function refreshConversationsSoon(): void {
    if (listRefreshTimer) clearTimeout(listRefreshTimer);
    listRefreshTimer = setTimeout(() => { listRefreshTimer = null; void loadConversations(true); }, 300);
  }

  function nearBottom(): boolean {
    const el = messagesEl;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  /** En yeni mesaja kaydır — açılışta, kendi gönderiminde, altta okurken gelen mesajda. */
  async function scrollToLatest(): Promise<void> {
    await tick();
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function openConversation(userId: string, displayName?: string, avatarColor?: string, messageId?: string): Promise<boolean> {
    closeExclusivePeers('dm');
    const seq = ++openSeq;
    isVisible = true;
    errorMsg = '';
    try {
      persistDmDraft();
      let conversation = conversations.find(item => item.other?._id === userId) ?? null;
      if (!conversation) {
        const response = await apiFetch(`${apiBase()}/api/dm/${encodeURIComponent(userId)}`, { method: 'POST' });
        if (seq !== openSeq) return false;
        if (!response.ok) { errorMsg = t("ui_bu_kullaniciyla_dm_baslatilamadi", "Bu kullanıcıyla DM başlatılamadı."); return false; }
        conversation = await response.json() as Conversation;
        if (seq !== openSeq) return false;
        if (!conversation.other) conversation.other = { _id: userId, displayName, avatarColor };
        conversations = [conversation, ...conversations.filter(item => item._id !== conversation?._id)];
      }
      active = conversation;
      draft = restoreDmDraft(conversation);
      messages = [];
      const dmId = convId(conversation);
      currentSocket()?.emit?.('dm:join', dmId);
      // Önceki konuşmanın yarım kalmış eski-sayfa isteği bu konuşmayı kilitlemez.
      hasOlder = false; loadingOlder = false;
      const response = await apiFetch(`${apiBase()}/api/dm/${encodeURIComponent(dmId)}/messages?limit=${DM_PAGE}`);
      if (seq !== openSeq) return false;
      if (!response.ok) {
        // History or a stale list may point at a DM the user can no longer
        // access. Do not leave even its conversation shell open.
        active = null;
        draft = '';
        messages = [];
        errorMsg = t("gdm_gone", "Bu konuşma artık kullanılamıyor.");
        return false;
      }
      const history = await response.json() as unknown;
      if (seq !== openSeq) return false;
      if (!Array.isArray(history)) throw new Error('Invalid DM history response');
      messages = history as Message[];
      hasOlder = history.length >= DM_PAGE;
      // Konuşma EN YENİ mesajda açılır (eskiden en üstte, 50 mesajın en
      // eskisinde açılıyordu); kaydedilmiş bir mesaja gidiliyorsa o öne çıkar.
      if (messageId) void tick().then(() => jumpToMessage(messageId));
      else void scrollToLatest();
      // Konuşma gerçekten AÇILDI → okundu bildir (Faz 10.3.4).
      markRead(conversation);
      const other = conversation.other ?? { _id: userId, displayName, avatarColor };
      if (BridgeRegistry.has('recordNavigationLocation')) {
        BridgeRegistry.call('recordNavigationLocation', {
          type: 'dm',
          user: { _id: userId, displayName: name(other), avatarColor: other.avatarColor },
          ...(messageId ? { messageId } : {}),
        });
      }
      return true;
    } catch (error) {
      if (seq !== openSeq) return false;
      log.error('DM open failed', error);
      active = null;
      draft = '';
      messages = [];
      errorMsg = t("ui_bu_konusma_acilamadi", "Bu konuşma açılamadı.");
      return false;
    }
  }

  function jumpToMessage(messageId: string): void {
    const target = document.querySelector<HTMLElement>(`.dm-message[data-id="${CSS.escape(messageId)}"]`);
    if (!target) { BridgeRegistry.call('toast', t("gdm_not_in_page", "Kaydedilen mesaj son geçmiş sayfasında değil."), 'warning'); return; }
    const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    target.classList.add('dm-message-highlight');
    setTimeout(() => target.classList.remove('dm-message-highlight'), reduceMotion ? 1 : 1600);
  }

  /** Bir önceki geçmiş sayfası — en eski yüklü mesajın bileşik imleciyle. */
  async function loadOlder(): Promise<void> {
    const conversation = active;
    if (!conversation || loadingOlder || !hasOlder) return;
    const oldest = messages.find(item => item._id && !item.pending && !item.failed && item.createdAt !== undefined);
    const before = oldest ? (typeof oldest.createdAt === 'number' ? oldest.createdAt : Date.parse(String(oldest.createdAt))) : NaN;
    if (!oldest?._id || !Number.isFinite(before)) { hasOlder = false; return; }
    const seq = openSeq;
    const list = messagesEl;
    const prevHeight = list?.scrollHeight ?? 0;
    const prevTop = list?.scrollTop ?? 0;
    loadingOlder = true;
    try {
      const params = new URLSearchParams({ limit: String(DM_PAGE), before: String(before), beforeId: oldest._id });
      const response = await apiFetch(`${apiBase()}/api/dm/${encodeURIComponent(convId(conversation))}/messages?${params}`);
      if (seq !== openSeq) return;
      if (!response.ok) throw new ApiResponseError(response);
      const page = await response.json() as unknown;
      if (seq !== openSeq) return;
      if (!Array.isArray(page)) throw new Error('Invalid DM history response');
      const known = new Set(messages.map(item => item._id));
      const older = (page as Message[]).filter(item => item._id && !known.has(item._id));
      messages = [...older, ...messages];
      hasOlder = page.length >= DM_PAGE;
      // Okuma yeri korunur: eklenen içerik kadar aşağı kaydırılır.
      await tick();
      if (list && messagesEl === list) list.scrollTop = prevTop + (list.scrollHeight - prevHeight);
    } catch (error) {
      if (seq === openSeq) {
        errorMsg = safeApiErrorMessage(error, t('dm_history_load_failed', 'Daha eski mesajlar yüklenemedi.'), { report: true });
      }
    } finally {
      if (seq === openSeq) loadingOlder = false;
    }
  }

  function onMessagesScroll(): void {
    if (messagesEl && messagesEl.scrollTop < 48) void loadOlder();
  }

  /** Enter gönderir, Shift+Enter satır ekler — kanal ve grup DM yazma alanlarıyla aynı. */
  function onComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    sendMessage();
  }

  function saveForLater(message: Message): void {
    if (!active || !message._id || message.pending || message.failed) return;
    BridgeRegistry.call('saveForLater', {
      destinationType: 'dm', destinationId: convId(active), messageId: message._id,
    });
  }

  /** Konuşmanın kanonik kimliği — liste ve socket aynı değeri kullanmalı. */
  const convId = (c: Conversation): string => c.dmId || c._id;


  function dmDraftIdentity(conversation: Conversation | null = active): DraftIdentity | null {
    if (!conversation) return null;
    const current = BridgeRegistry.get<() => { id?: string; _id?: string } | null>('getMe')?.();
    const userId = String(current?._id ?? current?.id ?? '').trim();
    const conversationId = convId(conversation);
    return userId && conversationId ? { userId, kind: 'dm', conversationId } : null;
  }

  function persistDmDraft(text = draft, conversation: Conversation | null = active): void {
    const identity = dmDraftIdentity(conversation);
    if (identity) writeDraft(identity, text);
  }

  function restoreDmDraft(conversation: Conversation): string {
    return readDraft(dmDraftIdentity(conversation));
  }

  /**
   * Konuşmayı okundu işaretler (Faz 10.3).
   * Sunucudaki mevcut sözleşme kullanılır: `dm:read` → dmConversations.readAt.
   * İkinci bir onay sistemi kurulmaz. Yalnız GERÇEKTEN açılan konuşma için
   * çağrılır — liste yüklendi diye tüm konuşmalar okundu yapılmaz.
   */
  function markRead(conversation: Conversation): void {
    const id = convId(conversation);
    currentSocket()?.emit?.('dm:read', { dmId: id });
    // Yerel sayaç sunucu gerçeğine yakınsar; tahmini artırma yapılmaz.
    conversations = conversations.map(c => (convId(c) === id ? { ...c, unreadCount: 0 } : c));
  }

  function newClientNonce(): string {
    return globalThis.crypto?.randomUUID?.() ?? `dm-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function clearPendingTimer(clientNonce: string): void {
    const timer = pendingTimers.get(clientNonce);
    if (timer) clearTimeout(timer);
    pendingTimers.delete(clientNonce);
  }

  function clearAllPendingTimers(): void {
    for (const timer of pendingTimers.values()) clearTimeout(timer);
    pendingTimers.clear();
  }

  function markSendFailed(clientNonce: string, message = t('ui_message_send_failed_retry', 'Mesaj gönderilemedi. Yeniden deneyin.')): void {
    clearPendingTimer(clientNonce);
    messages = messages.map(item => item.clientNonce === clientNonce
      ? { ...item, pending: false, failed: true, lastError: message } : item);
    isSending = false;
  }

  function scheduleSendTimeout(clientNonce: string): void {
    clearPendingTimer(clientNonce);
    pendingTimers.set(clientNonce, setTimeout(() => {
      markSendFailed(clientNonce, t("ui_sunucudan_teslim_onayi_alinamadi_yeniden_deneyin", "Sunucudan teslim onayı alınamadı. Yeniden deneyin."));
    }, SEND_TIMEOUT_MS));
  }

  function onSendError(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const payload = value as { event?: unknown; clientNonce?: unknown; code?: unknown };
    if (payload.event && payload.event !== 'dm:send') return;
    if (typeof payload.clientNonce !== 'string' || !pendingTimers.has(payload.clientNonce)) return;
    markSendFailed(payload.clientNonce, messageDeliveryError(payload.code, 'dm'));
  }

  function onSocketDisconnect(): void {
    // A send can commit server-side immediately before the transport drops.
    // Mark it retryable instead of pretending success or leaving it pending.
    // The SAME clientNonce is reused on retry; the server's unique nonce
    // contract returns the existing canonical row rather than duplicating it.
    for (const clientNonce of [...pendingTimers.keys()]) {
      markSendFailed(clientNonce, connectionLostDeliveryError());
    }
  }

  function onMessage(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const message = value as Partial<Message>;
    // Socket input crosses a trust boundary. Invalid events must not increment
    // unread state, create unstable keyed rows, or crash the mounted shell.
    if (typeof message._id !== 'string' || !message._id
      || typeof message.dmId !== 'string' || !message.dmId
      || typeof message.userId !== 'string' || !message.userId
      || typeof message.content !== 'string') return;
    const activeId = active ? convId(active) : null;

    // Kabuk göstergesi: kendi mesajım değilse ve o konuşmaya BAKMIYORSAM say.
    const meNow = BridgeRegistry.get<() => { id?: string; _id?: string } | null>('getMe')?.();
    const myIdNow = meNow?._id ?? meNow?.id;
    const fromSomeoneElse = Boolean(message.userId && message.userId !== myIdNow);
    if (fromSomeoneElse && (!isVisible || message.dmId !== activeId)) shellUnread += 1;

    // AKTİF OLMAYAN konuşmaya gelen mesaj → sunucuda okunmamış olarak durur.
    // Burada yerel sayaç ARTIRILMAZ: çift socket teslimi sayacı şişirirdi.
    // Liste bir sonraki yüklemede sunucudan türetilmiş doğru değeri alır.
    if (message.dmId !== activeId) {
      if (isVisible) refreshConversationsSoon();
      return;
    }

    const followLatest = nearBottom() || !fromSomeoneElse;
    const clientNonce = typeof message.clientNonce === 'string' ? message.clientNonce : undefined;
    if (clientNonce) clearPendingTimer(clientNonce);
    // Exact nonce reconciliation is authoritative. `_id` dedupe keeps event
    // ordering harmless when a retry/reconnect replays an already delivered row.
    if (messages.some(item => item._id === message._id && !item.pending && !item.failed)) {
      isSending = false;
      return;
    }
    messages = messages
      .filter(item => clientNonce ? item.clientNonce !== clientNonce
        : !(item.pending && item.content === message.content && item.userId === message.userId))
      .concat({ ...(message as Message), pending: false, failed: false, lastError: '' });
    isSending = false;
    if (followLatest) void scrollToLatest();

    // Aktif konuşmaya gelen mesaj yanlış "okunmamış" bırakmamalı.
    // Kendi mesajımız için okundu göndermeye gerek yok (self-unread zaten yok).
    const me = BridgeRegistry.get<() => { id?: string; _id?: string } | null>('getMe')?.();
    const myId = me?._id ?? me?.id;
    if (active && message.userId && message.userId !== myId) markRead(active);
  }

  function sendMessage(): void {
    if (!active || !draft.trim() || isSending) return;
    const content = draft.trim();
    if (content.length > 2000) { errorMsg = 'Mesajlar en fazla 2000 karakter olabilir.'; return; }
    const me = BridgeRegistry.get<() => { id?: string; displayName?: string; avatarColor?: string } | null>('getMe')?.();
    const clientNonce = newClientNonce();
    const pending: Message = {
      _id: `pending:${clientNonce}`, dmId: active.dmId || active._id, userId: me?.id || 'self',
      displayName: me?.displayName || 'Sen', avatarColor: me?.avatarColor, content, createdAt: Date.now(),
      clientNonce, pending: true, failed: false,
    };
    messages = messages.concat(pending);
    void scrollToLatest();
    clearDraft(dmDraftIdentity(active));
    draft = ''; isSending = true;
    currentSocket()?.emit?.('dm:send', { toUserId: active.other._id, content, clientNonce });
    scheduleSendTimeout(clientNonce);
    // Each optimistic row owns its own delivery state, so the composer remains
    // usable while another message is awaiting authoritative confirmation.
    isSending = false;
  }

  function retryMessage(message: Message): void {
    if (!active || !message.failed || !message.clientNonce) return;
    messages = messages.map(item => item.clientNonce === message.clientNonce
      ? { ...item, pending: true, failed: false, lastError: '' } : item);
    currentSocket()?.emit?.('dm:send', {
      toUserId: active.other._id, content: message.content, clientNonce: message.clientNonce,
    });
    scheduleSendTimeout(message.clientNonce);
  }

  function openPanel(): void {
    closeExclusivePeers('dm');
    isVisible = true;
    shellUnread = 0;
    void loadConversations();
  }

  function close(): void { persistDmDraft(); openSeq += 1; clearAllPendingTimers(); isVisible = false; active = null; messages = []; draft = ''; }

  function backToDmList(): void {
    persistDmDraft();
    openSeq += 1;
    active = null;
    messages = [];
    draft = '';
    errorMsg = '';
  }

  function openFriends(): void {
    close();
    BridgeRegistry.call('showFriendsPanel');
  }

  /**
   * Faz 10.7 — ÇIKIŞTA ÖZEL DURUM TEMİZLİĞİ.
   *
   * Bu bileşen çıkış sırasında UNMOUNT EDİLMEZ; mount kalır. Temizlik
   * olmadan bir sonraki kullanıcı, önceki kullanıcının DM listesini, seçili
   * konuşmasını, ÖZEL MESAJ İÇERİĞİNİ ve yazmakta olduğu taslağı görüyordu.
   * Socket bağı korunur (SocketManager yeni oturumda yeni nesne verir ve
   * `syncSocketBinding` onu devralır).
   */
  function onLogout(): void {
    listSeq += 1;
    openSeq += 1;
    conversations = [];
    active = null;
    messages = [];
    draft = '';
    errorMsg = '';
    clearAllPendingTimers();
    isVisible = false;
    isSending = false;
  }

  /**
   * Faz E — ESCAPE İLE KAPANMA (ürün genelinde tek sözleşme).
   *
   * Denetim: `role="dialog"` taşıyan 17 yüzeyin 4'ünde Escape yoktu. Bu panel
   * `aria-modal="true"` bir modaldır; klavye kullanıcısının onu kapatmak için
   * odağı kapatma düğmesine kadar TAB'lamak zorunda kalması, tüm diğer
   * modalların (SettingsModal, ServerSettingsModal, StickerPanel…) uyduğu
   * sözleşmeyi bozuyordu.
   *
   * `isVisible` DEĞİLSE hiçbir şey yapılmaz: dinleyici panel gizliyken de
   * mount hâlinde durur ve koşulsuz kapatma, başka yüzeylerin Escape'ini
   * sessizce yutardı.
   */
  function onEscape(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !isVisible) return;
    close();
  }

  /**
   * Statik kabuk düğmesine yansıtma. Yeni bir DM durumu SAHİBİ yaratılmaz;
   * yalnızca mevcut düğmeye küçük bir sayaç ve erişilebilir ad eklenir.
   */
  $effect(() => {
    const btn = document.querySelector<HTMLElement>('[data-bridge-action="showDmPanel"]');
    if (!btn) return;
    let dot = btn.querySelector<HTMLElement>('.h-unread');
    if (shellUnread > 0) {
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'h-unread';
        dot.setAttribute('aria-hidden', 'true');
        btn.appendChild(dot);
      }
      dot.textContent = shellUnread > 9 ? '9+' : String(shellUnread);
      btn.setAttribute('aria-label', t('dm_open_unread', 'Direkt mesajları aç — {count} yeni mesaj', { count: shellUnread }));
    } else {
      dot?.remove();
      btn.setAttribute('aria-label', t('ui_open_direct_messages', 'Direkt mesajları aç'));
    }
  });

  onMount(() => {
    syncSocketBinding();
    window.addEventListener('keydown', onEscape);
    document.addEventListener('bridge:auth-logout', onLogout);
    // Socket geç hazır olabilir veya auth yenilemesiyle DEĞİŞEBİLİR; her iki
    // yaşam döngüsü olayında da mevcut nesneye yeniden bağlanılır.
    document.addEventListener('bridge:socket-ready', syncSocketBinding);
    document.addEventListener('bridge:socket-reconnected', syncSocketBinding);
    BridgeRegistry.register('showDmPanel', openPanel);
    BridgeRegistry.register('openDmPanel', openPanel);
    // Salt-okunur keşif yüzeyi. Komut paleti konuşma durumu oluşturmaz;
    // kullanıcı seçince aşağıdaki kanonik `openDm` sahibine geri döner.
    BridgeRegistry.register('getDmConversations', () => conversations);
    BridgeRegistry.register('openDm', (userId: string, displayName?: string, avatarColor?: string, messageId?: string) => {
      shellUnread = 0;
      return openConversation(userId, displayName, avatarColor, messageId);
    });
    BridgeRegistry.register('closeDmPanel', close);
    void loadConversations();
    log.info('DmPanel mounted');
  });
  onDestroy(() => {
    persistDmDraft();
    listSeq += 1;
    openSeq += 1;
    window.removeEventListener('keydown', onEscape);
    document.removeEventListener('bridge:auth-logout', onLogout);
    document.removeEventListener('bridge:socket-ready', syncSocketBinding);
    document.removeEventListener('bridge:socket-reconnected', syncSocketBinding);
    clearAllPendingTimers();
    if (listRefreshTimer) { clearTimeout(listRefreshTimer); listRefreshTimer = null; }
    // Bağlı olduğumuz nesneden çöz — `currentSocket()` bu anda başka bir
    // nesne olabilir; o zaman eski nesnede dinleyici kalırdı.
    unbindSocket();
    for (const key of ['showDmPanel', 'openDmPanel', 'getDmConversations', 'openDm', 'closeDmPanel']) BridgeRegistry.unregister(key);
    log.info('DmPanel destroyed');
  });
</script>

{#if isVisible}
<div class="dm-panel" class:conversation-open={Boolean(active)} role="dialog" aria-modal="true" aria-label={t('attr_direkt_mesajlar_676de62', "Direkt mesajlar")} use:focusTrap>
  <aside class="dm-sidebar">
    <div class="dm-heading"><h2>{t('markup_mesajlar_1eaab9c', "Mesajlar")}</h2><button type="button" aria-label={t('attr_dm_panelini_kapat_3725cce', "DM panelini kapat")} onclick={close}>×</button></div>
    <button type="button" class="friends-link" onclick={openFriends}>{t('dm_friends_requests', 'Arkadaşlar ve istekler')}</button>
    {#if errorMsg}<p class="bridge-error" role="alert">{errorMsg}</p>{/if}
    {#if isLoading}<p class="dm-muted">{t('sso_loading', 'Yükleniyor…')}</p>{:else if !conversations.length}<p class="dm-muted">{t('dm_none', 'Henüz bir DM konuşmanız yok.')}</p>{/if}
    {#each conversations as conversation (conversation._id)}
      <button type="button" class:active={active?._id === conversation._id} aria-current={active?._id === conversation._id ? 'page' : undefined} class="dm-conversation" onclick={() => openConversation(conversation.other._id)}>
        <span class="dm-avatar" style={avatarStyle(conversation.other.avatarColor)}>{initials(conversation.other)}</span>
        <span class="dm-person"><strong>{name(conversation.other)}</strong><small>{conversation.lastMessage?.content || t("surface_konusmay_ac_0749f6")}</small></span>
        {#if (conversation.unreadCount ?? 0) > 0}
          <!-- Sunucuda türetilen sayaç. Büyük değerler 99+ olarak kısaltılır;
               genişlik sabit kalır, yerleşim zıplamaz. -->
          <span class="dm-unread" aria-label={t('unread_messages_aria', undefined, { count: conversation.unreadCount ?? 0 })}>
            {(conversation.unreadCount ?? 0) > 99 ? '99+' : conversation.unreadCount}
          </span>
        {/if}
      </button>
    {/each}
  </aside>
  <section class="dm-chat" aria-label={t('dm_conversation', 'DM konuşması')}>
    {#if active}
      <header class="dm-chat-header">
        <button type="button" class="dm-mobile-back" aria-label={t("nav_back_dm_list")} onclick={backToDmList}>←</button>
        <span class="dm-avatar" style={avatarStyle(active.other.avatarColor)}>{initials(active.other)}</span>
        <strong>{name(active.other)}</strong>
        <!-- FAZ 8/1 — ARAMA GIRISI. `DmCallPanel` gercek bir uygulamaydi ama
             hicbir yerden ACILAMIYORDU; DM aramasi urunde YOKTU. Dugmeler
             yalnizca kanonik sahip kayitliysa cizilir (olu dugme uretilmez). -->
        {#if BridgeRegistry.has('startDmCall')}
          {@const callPeerId = active.other._id}
          <span class="dm-call-actions">
            <button
              type="button" class="dm-call-btn"
              aria-label={t('dm_start_voice_call_aria', undefined, { name: name(active.other) })}
              title={t('attr_sesli_ara_a216f6d', "Sesli ara")}
              onclick={() => BridgeRegistry.call('startDmCall', callPeerId, 'voice')}
            >
              <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M5 3.5h3l1.5 3.5-2 1.5a9 9 0 0 0 4 4l1.5-2 3.5 1.5v3c0 .6-.4 1-1 1A13.5 13.5 0 0 1 4 4.5c0-.6.4-1 1-1z"/></svg>
            </button>
            <button
              type="button" class="dm-call-btn"
              aria-label={t('dm_start_video_call_aria', undefined, { name: name(active.other) })}
              title={t('dm_video_call', 'Görüntülü ara')}
              onclick={() => BridgeRegistry.call('startDmCall', callPeerId, 'video')}
            >
              <svg aria-hidden="true" viewBox="0 0 20 20"><rect x="2.5" y="5" width="10" height="10" rx="2"/><path d="m12.5 9 5-2.5v7L12.5 11z"/></svg>
            </button>
          </span>
        {/if}
      </header>
      <div class="dm-messages" aria-live="polite" bind:this={messagesEl} onscroll={onMessagesScroll}>
        {#if hasOlder}
          <button type="button" class="dm-load-older" onclick={() => void loadOlder()} disabled={loadingOlder}>
            {loadingOlder ? t('sso_loading', 'Yükleniyor…') : t('dm_load_older', 'Daha eski mesajları yükle')}
          </button>
        {/if}
        {#each messages as message (message._id)}
          <article class:pending={message.pending} class:failed={message.failed} class="dm-message" data-id={message._id}><span class="dm-avatar small" style={avatarStyle(message.avatarColor)}>{(message.displayName || '?').slice(0, 2).toUpperCase()}</span><div class="dm-message-copy"><strong>{message.displayName || t('ui_bridge_user')}</strong><p>{message.content}</p>{#if message.pending}<small>{t('dm_sending', 'Gönderiliyor…')}</small>{:else if message.failed}<small class="dm-failed" role="alert">{message.lastError || t('dm_send_failed', 'Gönderilemedi.')}</small><button type="button" class="dm-retry" onclick={() => retryMessage(message)}>{t('retry', 'Yeniden dene')}</button>{/if}</div>{#if message._id && !message.pending && !message.failed}<button type="button" class="dm-save" aria-label={t('msg_action_save')} title={t('msg_action_save')} onclick={() => saveForLater(message)}>⌑</button>{/if}</article>
        {/each}
      </div>
      <form class="dm-composer" onsubmit={(event) => { event.preventDefault(); sendMessage(); }}>
        <textarea bind:value={draft} oninput={(e) => persistDmDraft(e.currentTarget.value)} onkeydown={onComposerKeydown} maxlength="2000" rows="1" placeholder={t('attr_mesaj_yaz_410bf7e', "Mesaj yaz…")} aria-label={t('dm_message', 'DM mesajı')}></textarea>
        <button class="btn btn-primary" type="submit" disabled={!draft.trim() || isSending}>{t('dm_send', 'Gönder')}</button>
      </form>
    {:else}
      <div class="dm-empty"><h3>{t('dm_private_convos', 'Özel konuşmalarınız')}</h3><p>{t('dm_start_hint', 'Profilinden bir kullanıcıya mesaj göndererek başlayın.')}</p></div>
    {/if}
  </section>
</div>
{/if}

<style>
/* Tek satır görünür alana SINIRLANIR: örtük `auto` satır içerikle büyüyordu —
   uzun bir konuşmada sohbet sütunu ekrandan uzadı, mesaj listesi hiç kaymadı ve
   yazma alanı görünür alanın altında kaldı (1280×720'de 50 mesaj: y=3899). */
.dm-panel{position:fixed;inset:0;z-index:1200;display:grid;grid-template-columns:280px minmax(0,1fr);grid-template-rows:minmax(0,1fr);background:var(--surface-1);color:var(--text-primary)}
.dm-sidebar{display:flex;flex-direction:column;min-width:0;padding:16px;background:var(--surface-2);border-right:1px solid var(--border-subtle);overflow:auto}.dm-heading,.dm-chat-header{display:flex;align-items:center;gap:10px;padding-bottom:12px}.dm-heading h2{font-size:18px;margin:0;flex:1}.dm-heading button{border:0;background:transparent;color:inherit;font-size:24px;cursor:pointer}.friends-link{border:1px solid var(--border-subtle);background:var(--surface-hover);color:var(--text-primary);border-radius:var(--radius-control);padding:8px;text-align:left;cursor:pointer;margin-bottom:10px}.dm-conversation{display:flex;align-items:center;gap:10px;border:0;background:transparent;color:inherit;padding:9px 6px;text-align:left;border-radius:var(--radius-control);cursor:pointer}.dm-conversation:hover,.dm-conversation.active{background:var(--surface-selected)}.dm-avatar{display:grid;place-items:center;width:34px;height:34px;border-radius:50%;color:var(--text-on-solid);font-size:12px;font-weight:700;flex:none}.dm-avatar.small{width:28px;height:28px;font-size:10px}.dm-person{display:grid;min-width:0;flex:1}
.dm-unread{display:grid;place-items:center;min-width:20px;height:20px;padding:0 6px;border-radius:var(--radius-pill);background:var(--brand);color:var(--text-on-solid);font-size:var(--type-badge);font-weight:700;font-variant-numeric:tabular-nums;flex:none}.dm-person strong,.dm-person small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dm-person small,.dm-muted,.dm-message small{color:var(--text-muted);font-size:12px}.dm-chat{display:grid;grid-template-rows:auto minmax(0,1fr) auto;min-width:0;min-height:0}.dm-chat-header{padding:16px;border-bottom:1px solid var(--border-subtle)}.dm-messages{overflow:auto;padding:18px}.dm-message{display:flex;gap:9px;margin-bottom:14px;padding:4px;border-radius:8px}.dm-message-copy{min-width:0;flex:1}.dm-message p{margin:3px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.dm-message.pending{opacity:.65}.dm-message.failed{opacity:.9}.dm-failed{display:block;color:var(--danger)!important}.dm-retry{margin-top:4px;border:0;background:transparent;color:var(--brand);cursor:pointer;padding:0;font:inherit;font-size:12px}.dm-retry:hover,.dm-retry:focus-visible{text-decoration:underline}:global(.dm-message.dm-message-highlight){background:var(--brand-subtle)}.dm-save{align-self:flex-start;flex:none;width:30px;height:30px;border:0;border-radius:7px;background:transparent;color:var(--text-muted);cursor:pointer}.dm-save:hover,.dm-save:focus-visible{background:var(--surface-hover);color:var(--text-primary)}.dm-composer{display:flex;gap:8px;padding:14px;border-top:1px solid var(--border-subtle)}.dm-composer .btn{flex:none;width:auto}.dm-composer textarea{flex:1;resize:none;min-height:38px;padding:10px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-2);color:inherit;font:inherit}.dm-empty{display:grid;place-content:center;text-align:center;color:var(--text-muted)}.bridge-error{padding:8px;color:var(--danger);font-size:12px}
.dm-load-older{display:block;margin:0 auto 14px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-2);color:var(--text-primary);padding:6px 12px;cursor:pointer;font:inherit;font-size:12px}.dm-load-older:hover,.dm-load-older:focus-visible{background:var(--surface-hover)}.dm-load-older:disabled{opacity:.6;cursor:default}
.dm-mobile-back{display:none}.dm-call-actions{margin-inline-start:auto;display:flex;gap:6px}
.dm-call-btn{display:grid;place-items:center;width:32px;height:32px;border:1px solid var(--border-subtle);border-radius:8px;background:transparent;color:var(--text-muted);cursor:pointer}
.dm-call-btn:hover,.dm-call-btn:focus-visible{background:var(--surface-hover);color:var(--text-primary)}
.dm-call-btn svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
@media(max-width:700px){
  .dm-panel{grid-template-columns:1fr;height:var(--bridge-visual-viewport-height,100dvh);padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}
  .dm-sidebar{width:100%;max-height:none;border-right:0;border-bottom:0;padding:12px 12px calc(12px + env(safe-area-inset-bottom));}
  .dm-chat{display:none;min-height:0}
  .dm-panel.conversation-open .dm-sidebar{display:none}
  .dm-panel.conversation-open .dm-chat{display:grid}
  .dm-mobile-back{display:grid;place-items:center;width:40px;height:40px;flex:none;border:0;border-radius:var(--radius-control);background:transparent;color:var(--text-primary);font-size:21px;cursor:pointer}
  .dm-mobile-back:hover,.dm-mobile-back:focus-visible{background:var(--surface-hover)}
  .dm-chat-header{min-height:56px;padding:8px 10px}
  .dm-messages{padding:12px 10px;overscroll-behavior:contain}
  .dm-composer{padding:10px calc(10px + env(safe-area-inset-right)) calc(10px + env(safe-area-inset-bottom)) calc(10px + env(safe-area-inset-left))}
  .dm-composer textarea,.dm-composer button{min-height:44px}
}
</style>
