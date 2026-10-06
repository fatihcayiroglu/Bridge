<!-- client/js/core/MessageLoader.svelte -->
<!-- Sprint 116 — messages/loader.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Mesaj yükleyici ve sayfalayıcı -->
<!--
  Faz 4 (toparlama): Mesaj katmanının okuma tarafı ve socket köprüsü.

  Legacy karşılıkları (kod import edilmedi, davranış referans alındı):
    messages/loader.ts:67-132   loadMessages()  — ?limit=50 + cursor
    messages/loader.ts:134-182  loadOlderMessagesImpl()
    socket.ts:84-160            message:new/edited/deleted/reaction/pinned/embedUpdate
    socket.ts:202-207           typing:update  (+ updateTypingBar)

  Backend sözleşmesi:
    GET /api/channels/:cid/messages?limit=50[&cursor=…]
      → { messages, hasMore, nextCursor, prevCursor, limit, count }  (eski→yeni sıralı)
    socket: channel:join / message:* / typing:*   (adlar değiştirilmedi)

  State sahibi AppState'tir; burada yerel kopya tutulmaz.
-->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  import { messageDeliveryError } from './message-delivery-error.js';
  import { getAPI } from './globals.js';
  import { apiFetch } from './api-fetch.js';
  import { handleApiError, ApiResponseError, unwrapApiError } from './api-error.js';
  import {
    rejectMessageOperation,
    resolveMessageOperation,
  } from './local-first/message-operation-sync.ts';
  import {
    appendLocalFirstHistory,
    clearLocalFirstHistoryChannel,
    closeLocalFirstHistoryRuntime,
    mergeOlderLocalFirstHistory,
    readLocalFirstHistory,
    replaceLocalFirstHistory,
    tombstoneLocalFirstHistory,
    updateLocalFirstHistory,
  } from './local-first/history-runtime.ts';
  const log = createLogger('MessageLoader');

  let { children }: { children?: Snippet } = $props();

  interface Message { _id: string; channelId?: string; content?: string; createdAt?: number; [key: string]: unknown }
  interface MessagesResponse { messages?: Message[]; hasMore?: boolean; prevCursor?: string | null; nextCursor?: string | null }

  const PAGE_SIZE = 50;
  const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

  let channelId: string | null = null;
  let requestSeq = 0;
  let lastHistoryUserId = '';
  /**
   * P3 — BAYAT ANLIK GÖRÜNTÜ. Geçmiş isteği uçuştayken soketten gelen olaylar
   * yanıttan YENİ olabilir. Ölçüldü (yeniden bağlanma): kuyruktaki mesaj
   * gönderildi, `message:new` + `message:ack` geldi, ardından istekten ÖNCE
   * alınmış 0 mesajlık yanıt listeyi ezdi — teslim edilmiş mesaj kayboldu ve
   * kullanıcı onu "sırada" gördü. Uçuş süresince gelen ekleme/silme/düzenleme
   * kaydedilir ve anlık görüntü uygulanırken korunur.
   */
  type LiveSinceLoad = { added: Set<string>; removed: Set<string>; edited: Map<string, Message> };
  let liveSinceLoad: LiveSinceLoad | null = null;
  let joinedChannel: string | null = null;
  // Faz 10.4: `socketBound` boolean'ı kaldırıldı — yerine `boundSocket`
  // referansı kullanılıyor (bkz. bindSocketEvents). Boolean guard, socket
  // nesnesi değiştiğinde yeniden bağlamayı engelleyerek ölü dinleyici
  // bırakıyordu.
  let typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function notifyUpdated(): void {
    document.dispatchEvent(new CustomEvent('bridge:messages-updated'));
  }

  /** Faz 10.4: `off` eklendi — bayat sockete bağlı dinleyicileri çözebilmek için. */
  type SocketLike = {
    emit(event: string, ...args: unknown[]): void;
    on(event: string, handler: (...args: unknown[]) => void): void;
    off?(event: string, handler: (...args: unknown[]) => void): void;
  };

  function getSocket(): SocketLike | null {
    return BridgeRegistry.get('socket');
  }

  function currentHistoryUserId(): string | null {
    const me = BridgeRegistry.call<{ _id?: string; id?: string } | null>('getMe');
    const userId = me?._id ?? me?.id ?? null;
    if (userId) lastHistoryUserId = userId;
    return userId;
  }

  function applyCachedHistory(
    target: string,
    seq: number,
    live: LiveSinceLoad,
    messages: unknown[],
  ): boolean {
    if (seq !== requestSeq || target !== channelId) return false;
    BridgeRegistry.call('setMessages', messages, live.added);
    for (const edited of live.edited.values()) BridgeRegistry.call('updateMessage', edited);
    BridgeRegistry.call('setFirstUnreadAnchor', null);
    // Cursor paging is network-authoritative. An offline cached window must not
    // expose a "load older" affordance that can only fail.
    BridgeRegistry.call('setMessageCursor', null);
    BridgeRegistry.call('setMessagesHasMore', false);
    BridgeRegistry.call('setMessagesError', '');
    BridgeRegistry.call('setMessagesOffline', true);
    notifyUpdated();
    return true;
  }

  // ── İlk yükleme ────────────────────────────────────────────────────────────
  /**
   * A deleted message is audit state, not content: the server scrubs the payload and keeps the
   * row with a placeholder. The list endpoints stopped returning those rows in Final21 Phase 16,
   * but a page cached before that deploy can still carry one, so the view drops them as well —
   * otherwise a deleted message reappears after a reload (measured: "[Mesaj silindi]" shown to
   * every locale).
   */
  function withoutDeleted(rows: unknown): unknown[] {
    return Array.isArray(rows) ? rows.filter((row) => !(row as { deletedAt?: unknown } | null)?.deletedAt) : [];
  }

  async function loadMessages(targetChannelId?: string): Promise<void> {
    const target = targetChannelId ?? channelId;
    if (!target) return;

    const seq = ++requestSeq;
    channelId = target;
    const userId = currentHistoryUserId();
    const live: LiveSinceLoad = { added: new Set(), removed: new Set(), edited: new Map() };
    liveSinceLoad = live;
    let networkSettled = false;
    let cacheApplied = false;

    const cachedPromise = userId
      ? readLocalFirstHistory(userId, target).catch(error => {
          log.warn('Şifreli mesaj geçmişi okunamadı', error);
          return null;
        })
      : Promise.resolve(null);

    void cachedPromise.then(snapshot => {
      if (!snapshot || networkSettled) return;
      cacheApplied = applyCachedHistory(target, seq, live, snapshot.messages);
    });

    BridgeRegistry.call('setMessagesLoading', true);
    BridgeRegistry.call('setMessagesError', '');
    notifyUpdated();

    try {
      const response = await apiFetch<MessagesResponse>(
        `${getAPI()}/api/channels/${encodeURIComponent(target)}/messages?limit=${PAGE_SIZE}`,
      );
      if (!response.ok) throw new ApiResponseError(response);
      const data = await response.typed();
      if (data.messages !== undefined && !Array.isArray(data.messages)) throw new Error('Invalid messages response');
      const firstUnreadId = response.headers.get('X-Bridge-First-Unread-Id');
      networkSettled = true;

      // Race guard: geç dönen eski kanalın yanıtı yeni kanalı ezemez.
      if (seq !== requestSeq || target !== channelId) {
        log.info(`Bayat mesaj yanıtı yok sayıldı (kanal ${target.slice(0, 8)})`);
        return;
      }

      const rows = withoutDeleted(data.messages)
        .filter((row) => !live.removed.has(String((row as { _id?: unknown } | null)?._id ?? '')));
      BridgeRegistry.call('setMessages', rows, live.added);
      for (const edited of live.edited.values()) BridgeRegistry.call('updateMessage', edited);
      BridgeRegistry.call('setFirstUnreadAnchor', firstUnreadId);
      BridgeRegistry.call('setMessageCursor', data.prevCursor ?? null);
      BridgeRegistry.call('setMessagesHasMore', Boolean(data.hasMore));
      BridgeRegistry.call('setMessagesOffline', false);

      if (userId) {
        const canonical = BridgeRegistry.call<Message[]>('getMessages') ?? [];
        void replaceLocalFirstHistory(userId, target, canonical)
          .catch(error => log.warn('Şifreli mesaj geçmişi yazılamadı', error));
      }
      log.info(`${(data.messages ?? []).length} mesaj yüklendi`);
    } catch (error) {
      if (seq !== requestSeq) return;
      networkSettled = true;

      // Faz 8.1: kullanıcıya "HTTP 403" gibi ham teknik metin gösterilmez.
      // silent → mesaj listesinde zaten satır içi gösteriliyor, ayrıca toast
      // açmak aynı hatayı iki kez bildirmek olurdu.
      const info = handleApiError(unwrapApiError(error), { silent: true, report: true });

      if (info.status === 401 || info.status === 403 || info.status === 404) {
        // Server-authoritative denial beats past authorization. Purge cached
        // content and never use it as a permission bypass.
        if (userId) {
          await clearLocalFirstHistoryChannel(userId, target)
            .catch(cause => log.warn('Yetki sonrası yerel geçmiş temizlenemedi', cause));
        }
        if (seq !== requestSeq || target !== channelId) return;
        BridgeRegistry.call('setMessages', [], live.added);
        BridgeRegistry.call('setMessagesOffline', false);
        BridgeRegistry.call('setMessagesError', info.message);
      } else if (info.network) {
        const cached = await cachedPromise;
        if (seq !== requestSeq || target !== channelId) return;
        if (cached) {
          if (!cacheApplied) applyCachedHistory(target, seq, live, cached.messages);
          BridgeRegistry.call('setMessagesError', '');
          BridgeRegistry.call('setMessagesOffline', true);
        } else {
          BridgeRegistry.call('setMessagesOffline', false);
          BridgeRegistry.call('setMessagesError', info.message);
        }
      } else {
        BridgeRegistry.call('setMessagesOffline', false);
        BridgeRegistry.call('setMessagesError', info.message);
      }
    } finally {
      if (liveSinceLoad === live) liveSinceLoad = null;
      if (seq === requestSeq) BridgeRegistry.call('setMessagesLoading', false);
      notifyUpdated();
    }
  }

  // ── Sayfalama (daha eski) ──────────────────────────────────────────────────
  async function loadOlderMessages(): Promise<void> {
    const cursor = BridgeRegistry.call<string | null>('getMessageCursor');
    const target = channelId;
    if (!cursor || !target) return;

    const seq = requestSeq; // yeni kanal seçilirse seq değişir → yanıt atılır
    try {
      const response = await apiFetch<MessagesResponse>(
        `${getAPI()}/api/channels/${encodeURIComponent(target)}/messages?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`,
      );
      if (!response.ok) throw new ApiResponseError(response);
      const data = await response.typed();
      if (data.messages !== undefined && !Array.isArray(data.messages)) throw new Error('Invalid messages response');
      if (seq !== requestSeq || target !== channelId) return;

      const olderRows = withoutDeleted(data.messages);
      const added = BridgeRegistry.call<number>('prependMessages', olderRows) ?? 0;
      const userId = currentHistoryUserId();
      if (userId) {
        void mergeOlderLocalFirstHistory(userId, target, olderRows)
          .catch(error => log.warn('Eski mesajlar yerel geçmişe yazılamadı', error));
      }
      BridgeRegistry.call('setMessageCursor', data.prevCursor ?? null);
      BridgeRegistry.call('setMessagesHasMore', Boolean(data.hasMore));
      log.info(`${added} eski mesaj eklendi`);
    } catch (error) {
      // The user has already moved elsewhere; an error from the abandoned
      // page must not surface as a warning for the new channel.
      if (seq !== requestSeq || target !== channelId) return;
      // Faz 8.1: sayfalama hatasının satır içi gösterim alanı yok — sessizce
      // yutulup "buton çalışmıyor" hissi vermesin diye bildirim gösterilir.
      handleApiError(unwrapApiError(error), { report: true });
    } finally {
      notifyUpdated();
    }
  }

  // ── Kanal geçişi ───────────────────────────────────────────────────────────
  function onChannelSelected(event: Event): void {
    const detail = (event as CustomEvent<{ channelId?: string }>).detail;
    const next = detail?.channelId;
    if (!next) return;

    channelId = next;
    clearTypingTimers();
    updateTypingBar();

    // Kanal odası — server/socket/handlers/members.ts:59
    const socket = getSocket();
    if (socket) {
      if (joinedChannel && joinedChannel !== next) socket.emit('channel:leave', joinedChannel);
      socket.emit('channel:join', next);
      joinedChannel = next;
    }

    void loadMessages(next);
  }

  // ── Socket olayları ────────────────────────────────────────────────────────
  /**
   * Faz 10.4 — SOCKET KİMLİĞİNE DUYARLI BAĞLAMA.
   *
   * Önceden `socketBound` bir kez true yapılıyor ve HİÇ sıfırlanmıyordu.
   * SocketManager auth token yenilemesinde `teardown()` + `connect()` ile
   * YEPYENİ bir `io()` nesnesi üretir; `bridge:socket-ready` yeniden yayılsa
   * bile bu bayrak yüzünden `bindSocketEvents()` erken dönüyor ve
   * `message:new` / `message:ack` / `error:message` dinleyicileri ÖLÜ nesnede
   * kalıyordu. Reconnect'teki REST yeniden yükleme bunu kısmen maskeliyordu:
   * kullanıcı mesajları görüyordu ama CANLI socket teslimi ölüydü.
   *
   * Çözüm: bağlı olunan nesneyi referansla takip et ve kendi dinleyicilerimizi
   * çözebilmek için kayıt altına al. Aynı nesne → hiçbir şey yapma (normal
   * Socket.IO reconnect gereksiz yeniden bağlama üretmez). Farklı nesne →
   * eskisinden çöz, yenisine bir kez bağlan.
   */
  let boundSocket: SocketLike | null = null;
  const boundHandlers: Array<[string, (...args: unknown[]) => void]> = [];

  /** Dinleyiciyi bağlar ve sonradan çözebilmek için referansını saklar. */
  function bindOne(socket: SocketLike, event: string, handler: (...args: unknown[]) => void): void {
    socket.on(event, handler);
    boundHandlers.push([event, handler]);
  }

  /** Yalnız KENDİ dinleyicilerimizi çözer (removeAllListeners kullanılmaz). */
  function unbindSocketEvents(): void {
    if (!boundSocket) { boundHandlers.length = 0; return; }
    for (const [event, handler] of boundHandlers) boundSocket.off?.(event, handler);
    boundHandlers.length = 0;
    boundSocket = null;
  }

  function bindSocketEvents(): void {
    const socket = getSocket();
    if (!socket) { unbindSocketEvents(); return; }
    if (boundSocket === socket) return;   // zaten bu nesneye bağlıyız
    unbindSocketEvents();                 // bayat nesneden çöz
    boundSocket = socket;

    bindOne(socket, 'message:new', (...args: unknown[]) => {
      const msg = args[0] as Message;
      if (!isNonEmptyString(msg?._id) || !isNonEmptyString(msg.channelId) || msg.channelId !== channelId) return;
      liveSinceLoad?.added.add(msg._id);
      if (BridgeRegistry.call<boolean>('appendMessage', msg)) notifyUpdated();
      const userId = currentHistoryUserId();
      if (userId) {
        void appendLocalFirstHistory(userId, msg.channelId, msg)
          .catch(error => log.warn('Canlı mesaj yerel geçmişe yazılamadı', error));
      }
    });

    // Faz 7 — teslim ACK'i: optimistic pending kaydı gerçek mesajla uzlaştır.
    // Sunucu önce message:new, sonra message:ack yollar; sıra ne olursa olsun
    // replaceMessage duplicate oluşturmadan doğru sonuca ulaşır.
    bindOne(socket, 'message:ack', (...args: unknown[]) => {
      const payload = args[0] as { ackId?: string; tmpId?: string; messageId?: string; ts?: number };
      const key = payload?.ackId ?? payload?.tmpId;
      if (!isNonEmptyString(key) || !isNonEmptyString(payload?.messageId)) return;
      liveSinceLoad?.added.add(payload.messageId);

      BridgeRegistry.call('replaceMessage', `pending:${key}`, {
        _id: payload.messageId,
        pending: false,
        queued: false,
        failed: false,
        ...(payload.ts ? { createdAt: payload.ts } : {}),
      });
      BridgeRegistry.call('resolvePendingSend', key);
      notifyUpdated();
    });

    // Sunucu handler'ı hata verdiyse (Faz 5 isolate) ilgili gönderimi failed yap.
    bindOne(socket, 'error:message', (...args: unknown[]) => {
      const payload = args[0] as { ackId?: string; tmpId?: string; clientNonce?: string; code?: string; event?: string };
      const key = payload?.ackId ?? payload?.tmpId;
      if (isNonEmptyString(key)) BridgeRegistry.call('failPendingSend', key, messageDeliveryError(payload.code, 'channel'));

      if (isNonEmptyString(payload.clientNonce)) {
        if (payload.event === 'message:edit' || payload.event === 'message:delete' || payload.event === 'message:react') {
          void rejectMessageOperation(payload.clientNonce, payload.code);
        }
        if (payload.event === 'message:edit') {
          BridgeRegistry.call('failEditMutation', payload.clientNonce, payload.code);
        } else if (payload.event === 'message:delete') {
          BridgeRegistry.call('failDeleteMutation', payload.clientNonce, payload.code);
        } else if (payload.event === 'message:react') {
          BridgeRegistry.call('toast', t('mutation_connection_failed', 'İşlem tamamlanamadı. Bağlantını kontrol edip tekrar dene.'), 'error');
        }
      }
    });

    // Final21 UX (U-11): gönderim retleri artık ackId taşır. Eskiden bu olaylar hiç
    // dinlenmiyordu; reddedilen mesaj 10 sn sonra "sunucu onayı zaman aşımı" ile düşüyordu.
    bindOne(socket, 'error:spam', (...args: unknown[]) => {
      const payload = args[0] as { reason?: string; remainingMs?: number; ackId?: string; tmpId?: string };
      const key = payload?.ackId ?? payload?.tmpId;
      if (!isNonEmptyString(key)) return;
      BridgeRegistry.call('rejectPendingSend', key, payload.reason === 'spam_duplicate' ? 'duplicate' : 'rate', Number(payload.remainingMs));
    });
    bindOne(socket, 'error:slowmode', (...args: unknown[]) => {
      const payload = args[0] as { remaining?: number; ackId?: string; tmpId?: string };
      const key = payload?.ackId ?? payload?.tmpId;
      if (isNonEmptyString(key)) BridgeRegistry.call('rejectPendingSend', key, 'slowmode', Number(payload.remaining));
    });
    bindOne(socket, 'error:timeout', (...args: unknown[]) => {
      const payload = args[0] as { remaining?: number; ackId?: string; tmpId?: string };
      const key = payload?.ackId ?? payload?.tmpId;
      if (isNonEmptyString(key)) BridgeRegistry.call('rejectPendingSend', key, 'timeout', Number(payload.remaining));
    });
    bindOne(socket, 'warn:spam', () => { BridgeRegistry.call('noteSpamWarning'); });

    bindOne(socket, 'message:edited', (...args: unknown[]) => {
      const msg = args[0] as Message & { clientNonce?: string };
      if (!isNonEmptyString(msg?._id)) return;
      const clientNonce = isNonEmptyString(msg.clientNonce) ? msg.clientNonce : '';
      const { clientNonce: _mutationNonce, ...canonical } = msg;
      if (BridgeRegistry.call<boolean>('updateMessage', canonical)) notifyUpdated();
      if (clientNonce) {
        void resolveMessageOperation(clientNonce);
        BridgeRegistry.call('resolveEditMutation', clientNonce, msg._id);
      }
      liveSinceLoad?.edited.set(msg._id, canonical as Message);
      const userId = currentHistoryUserId();
      if (userId && channelId) {
        void updateLocalFirstHistory(userId, channelId, canonical)
          .catch(error => log.warn('Düzenlenen mesaj yerel geçmişe yazılamadı', error));
      }
    });

    bindOne(socket, 'message:deleted', (...args: unknown[]) => {
      const payload = args[0] as { id?: string; clientNonce?: string };
      if (!isNonEmptyString(payload?.id)) return;
      if (liveSinceLoad) {
        liveSinceLoad.removed.add(payload.id);
        liveSinceLoad.added.delete(payload.id);
        liveSinceLoad.edited.delete(payload.id);
      }

      // Bu mesaja yapılmış yanıtların önizlemesini "silindi" olarak işaretle.
      // Sunucu aynı işareti kalıcı olarak da yazıyor (lib/deleteMessageCascade.ts);
      // burası açık oturumun reload beklemeden güncellenmesi içindir.
      const loaded = BridgeRegistry.call<Message[]>('getMessages') ?? [];
      let markedAny = false;
      for (const m of loaded) {
        const ref = (m as { replyTo?: { _id?: string; deleted?: boolean } }).replyTo;
        if (ref?._id === payload.id && !ref.deleted) {
          BridgeRegistry.call('updateMessage', { _id: m._id, replyTo: { ...ref, deleted: true } });
          markedAny = true;
        }
      }

      const removed = BridgeRegistry.call<boolean>('removeMessage', payload.id);
      if (removed || markedAny) notifyUpdated();
      const userId = currentHistoryUserId();
      if (userId && channelId) {
        void tombstoneLocalFirstHistory(userId, channelId, payload.id)
          .catch(error => log.warn('Silinen mesaj tombstone yazılamadı', error));
      }
      if (isNonEmptyString(payload.clientNonce)) {
        void resolveMessageOperation(payload.clientNonce);
        BridgeRegistry.call('resolveDeleteMutation', payload.clientNonce, payload.id);
      }
    });

    bindOne(socket, 'message:reaction', (...args: unknown[]) => {
      const payload = args[0] as { messageId?: string; reactions?: Record<string, unknown>; clientNonce?: string };
      if (!isNonEmptyString(payload?.messageId)) return;
      const patch = { _id: payload.messageId, ...(channelId ? { channelId } : {}), reactions: payload.reactions ?? {} };
      if (BridgeRegistry.call<boolean>('updateMessage', patch)) notifyUpdated();
      const userId = currentHistoryUserId();
      if (userId && channelId) void updateLocalFirstHistory(userId, channelId, patch).catch(error => log.warn('Reaction yerel geçmişe yazılamadı', error));
      if (isNonEmptyString(payload.clientNonce)) void resolveMessageOperation(payload.clientNonce);
    });

    bindOne(socket, 'message:pinned', (...args: unknown[]) => {
      const payload = args[0] as { messageId?: string; pinned?: boolean };
      if (!isNonEmptyString(payload?.messageId)) return;
      const patch = { _id: payload.messageId, ...(channelId ? { channelId } : {}), pinned: payload.pinned };
      if (BridgeRegistry.call<boolean>('updateMessage', patch)) notifyUpdated();
      const userId = currentHistoryUserId();
      if (userId && channelId) void updateLocalFirstHistory(userId, channelId, patch).catch(error => log.warn('Pin yerel geçmişe yazılamadı', error));
      // Açık sabitlenmiş-mesaj paneli gerçek zamanlı tazelensin (başka bir
      // kullanıcı sabitlese/kaldırsa da). Panel yalnızca açıkken tepki verir.
      document.dispatchEvent(new CustomEvent('bridge:pin-changed', { detail: { messageId: payload.messageId, pinned: payload.pinned } }));
    });

    bindOne(socket, 'message:embedUpdate', (...args: unknown[]) => {
      const payload = args[0] as { messageId?: string; embeds?: unknown[] };
      if (!isNonEmptyString(payload?.messageId)) return;
      const patch = { _id: payload.messageId, ...(channelId ? { channelId } : {}), embeds: payload.embeds ?? [] };
      if (BridgeRegistry.call<boolean>('updateMessage', patch)) notifyUpdated();
      const userId = currentHistoryUserId();
      if (userId && channelId) void updateLocalFirstHistory(userId, channelId, patch).catch(error => log.warn('Embed yerel geçmişe yazılamadı', error));
    });

    bindOne(socket, 'typing:update', (...args: unknown[]) => {
      const payload = args[0] as { channelId?: string; userId?: string; username?: string; displayName?: string; typing?: boolean };
      if (!isNonEmptyString(payload?.userId)
        || (payload.channelId !== undefined && (!isNonEmptyString(payload.channelId) || payload.channelId !== channelId))) return;
      const label = payload.displayName || payload.username || t('typing_someone', 'Birisi');

      const existing = typingTimers.get(payload.userId);
      if (existing) clearTimeout(existing);

      if (payload.typing) {
        BridgeRegistry.call('setTypingUser', payload.userId, label);
        // Emniyet: stop event'i kaybolursa gösterge takılı kalmasın.
        typingTimers.set(payload.userId, setTimeout(() => {
          BridgeRegistry.call('clearTypingUser', payload.userId);
          typingTimers.delete(payload.userId!);
          updateTypingBar();
        }, 8000));
      } else {
        BridgeRegistry.call('clearTypingUser', payload.userId);
        typingTimers.delete(payload.userId);
      }
      updateTypingBar();
    });

    log.info('Mesaj socket olayları bağlandı');
  }

  // ── Typing göstergesi (mevcut kabuk: #typing-bar / #typing-text) ───────────
  function updateTypingBar(): void {
    const bar  = document.getElementById('typing-bar');
    const text = document.getElementById('typing-text');
    if (!bar || !text) return;

    const users = BridgeRegistry.call<Map<string, string>>('getTypingUsers');
    const names = users ? [...users.values()] : [];
    if (names.length === 0) { bar.style.display = 'none'; text.textContent = ''; return; }

    text.textContent = names.length === 1
      ? t('typing_one', '{name} yazıyor…', { name: names[0] })
      : names.length === 2
        ? t('typing_two', '{first} ve {second} yazıyor…', { first: names[0], second: names[1] })
        : t('typing_many', '{count} kişi yazıyor…', { count: names.length });
    bar.style.display = '';
  }

  function clearTypingTimers(): void {
    typingTimers.forEach(timer => clearTimeout(timer));
    typingTimers = new Map();
    BridgeRegistry.call('clearTypingUsers');
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  function onSocketReady(): void {
    bindSocketEvents();
    // Socket geç bağlandıysa mevcut kanala katıl.
    const socket = getSocket();
    if (socket && channelId && joinedChannel !== channelId) {
      socket.emit('channel:join', channelId);
      joinedChannel = channelId;
    }
  }

  /**
   * Faz 7 — yeniden bağlanma senkronizasyonu.
   * Kopukken sunucudaki oda üyeliği düşer ve bu sürede gelen `message:new`
   * olayları kaçar. Yeniden bağlanınca kanala tekrar katılıp mesajları
   * yeniden yüklüyoruz; `setMessages` _id bazlı olduğu için duplicate oluşmaz.
   */
  function onAuthLogout(): void {
    requestSeq += 1;
    liveSinceLoad = null;
    BridgeRegistry.call('setMessagesOffline', false);
    if (lastHistoryUserId) closeLocalFirstHistoryRuntime(lastHistoryUserId);
    lastHistoryUserId = '';
  }

  function onSocketReconnected(): void {
    const socket = getSocket();
    if (!socket || !channelId) return;
    socket.emit('channel:join', channelId);
    joinedChannel = channelId;
    log.info('Yeniden bağlanma sonrası mesajlar senkronize ediliyor');
    void loadMessages(channelId);
  }

  onMount(() => {
    document.addEventListener('bridge:channel-selected', onChannelSelected);
    document.addEventListener('bridge:socket-ready', onSocketReady);
    document.addEventListener('bridge:socket-reconnected', onSocketReconnected);
    document.addEventListener('bridge:auth-logout', onAuthLogout);
    bindSocketEvents(); // socket zaten hazırsa

    // Bu bileşen kanal seçiminden sonra mount olduysa mevcut kanalı yakala.
    const channel = BridgeRegistry.call<{ _id?: string } | null>('getCurrentChannel');
    if (channel?._id) {
      channelId = channel._id;
      getSocket()?.emit('channel:join', channel._id);
      joinedChannel = channel._id;
      void loadMessages(channel._id);
    }
  });

  BridgeRegistry.register('loadMessages', (id?: string) => { void loadMessages(id); });
  BridgeRegistry.register('loadOlderMessages', () => loadOlderMessages());
  BridgeRegistry.register('getActiveChannelId', () => channelId);

  onDestroy(() => {
    // Invalidate every in-flight request before unregistering the shared state
    // bridge. A late response must not write into a later session/mount.
    requestSeq += 1;
    channelId = null;
    joinedChannel = null;
    document.removeEventListener('bridge:channel-selected', onChannelSelected);
    document.removeEventListener('bridge:socket-ready', onSocketReady);
    document.removeEventListener('bridge:socket-reconnected', onSocketReconnected);
    document.removeEventListener('bridge:auth-logout', onAuthLogout);
    if (lastHistoryUserId) closeLocalFirstHistoryRuntime(lastHistoryUserId);
    lastHistoryUserId = '';
    // Faz 10.4: bağlı olduğumuz sockete ait dinleyicileri bırak.
    unbindSocketEvents();
    clearTypingTimers();
    BridgeRegistry.unregister('loadMessages');
    BridgeRegistry.unregister('loadOlderMessages');
    BridgeRegistry.unregister('getActiveChannelId');
  });
</script>

{@render children?.()}
