<!-- client/js/core/MessageListPanel.svelte -->
<!-- Sprint 116 — messages.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Mesaj listesi paneli -->
<!--
  Faz 4 (toparlama): Mesaj listesinin görünümü + scroll davranışı.

  State sahibi DEĞİLDİR — mesajları AppState'ten (BridgeRegistry) okur ve
  MessageLoader'ın yaydığı `bridge:messages-updated` sinyalinde yeniden okur.
  Buradaki dizi yalnızca render önbelleğidir, ikinci bir state kaynağı değildir.

  Mount noktası mevcut kabuk: #messages-area (index.html:213).
  Legacy referansı: messages/scroll.ts (dibe yapış / eski sayfa yükle).
-->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { apiFetch } from './api-fetch.js';
  import { getAPI } from './globals.js';
  import { createLogger } from './logger.js';
  import { canManageMessages } from './permissions/myPermissions.ts';
  import { safeApiErrorMessage } from './api-error.ts';
  import { queueReactionMessageOperation } from './local-first/message-operation-sync.ts';
  import { toast } from './utils.js';
  import MessageRenderer, { type MessageData } from './MessageRenderer.svelte';
  const log = createLogger('MessageListPanel');

  let { children }: { children?: Snippet } = $props();

  let messages     = $state<MessageData[]>([]);
  let isLoading    = $state(false);
  let loadError    = $state('');
  let isOffline    = $state(false);
  let hasMore      = $state(false);
  let hasChannel   = $state(false);
  /** Sunucuda kullanıcıdan başka üye yok (U-06): boş kanal davete yönlendirir. */
  let aloneInServer = $state(false);
  let currentUserId = $state<string | null>(null);
  let currentChannelType = $state('');
  let publishingAnnouncementId = $state('');
  // Sabitleme yetkisi görünürlük sinyali (fail-closed). Gerçek sınır arka uçta.
  let canPin = $state(false);
  let awayFromBottom = $state(false);
  let firstUnreadMessageId = $state<string | null>(null);
  let unreadJumpBusy = $state(false);

  let scroller: HTMLElement | null = null;   // #messages-area
  let stickToBottom = true;                   // kullanıcı dipteyse yeni mesajda kaydır
  let loadingOlder = false;
  let jumpTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingJumpId: string | null = null;
  let lastAutoUnreadJumpId: string | null = null;

  const NEAR_BOTTOM_PX = 120;

  // Final21 UX (U-06): yeni sunucu kuran kullanıcı boş #general'de "ilk mesajı sen gönder"
  // görüyordu; tek başına olduğu bir sunucuda asıl sonraki adım insanları çağırmaktır ve davet
  // sunucu menüsünün içindeydi. Üye listesi yalnız kullanıcının kendisiyse boş durum daveti sunar.
  function syncAlone(): void {
    const members = BridgeRegistry.call<unknown[]>('getCurrentServerMembers');
    aloneInServer = Array.isArray(members) && members.length === 1 && BridgeRegistry.has('openInvitePanel');
  }

  function syncFromState(): void {
    messages      = (BridgeRegistry.call<MessageData[]>('getMessages') ?? []).slice();
    isLoading     = BridgeRegistry.call<boolean>('getMessagesLoading') ?? false;
    loadError     = BridgeRegistry.call<string>('getMessagesError') ?? '';
    isOffline     = BridgeRegistry.call<boolean>('getMessagesOffline') ?? false;
    hasMore       = BridgeRegistry.call<boolean>('getMessagesHasMore') ?? false;
    firstUnreadMessageId = BridgeRegistry.call<string | null>('getFirstUnreadMessageId') ?? null;
    const currentChannel = BridgeRegistry.call<{ _id?: string; type?: string } | null>('getCurrentChannel');
    hasChannel    = Boolean(currentChannel?._id);
    currentChannelType = String(currentChannel?.type ?? '');
    const currentUser = BridgeRegistry.call<{ _id?: string; id?: string } | null>('getMe');
    currentUserId = currentUser?._id ?? currentUser?.id ?? null;

    // Sabitleme yetkisini geçerli sunucu için çöz (sunucu başına önbellekli).
    // Kanıtlanana kadar `false` — yetkisiz kullanıcıya ölü kontrol gösterilmez.
    const server = BridgeRegistry.call<{ _id?: string } | null>('getCurrentServer');
    const sid = server?._id;
    if (sid) { void canManageMessages(sid).then(v => { canPin = v; }); }
    else canPin = false;

    // Karşılama ekranı yalnızca kanal seçilmemişken görünsün (legacy davranışı).
    syncAlone();

    const welcome = document.getElementById('ch-welcome');
    if (welcome) welcome.style.display = hasChannel ? 'none' : '';

    const unreadLoaded = Boolean(firstUnreadMessageId && messages.some(m => m._id === firstUnreadMessageId));
    if (unreadLoaded && firstUnreadMessageId && firstUnreadMessageId !== lastAutoUnreadJumpId) {
      lastAutoUnreadJumpId = firstUnreadMessageId;
      stickToBottom = false;
      awayFromBottom = true;
      queueMicrotask(() => scrollToUnreadBoundary(firstUnreadMessageId!));
    } else if (stickToBottom) queueMicrotask(scrollToBottom);
  }

  /** Yanıt önizlemesi için hızlı arama — orijinal mesaj yüklüyse güncel halini verir. */
  const byId = $derived(new Map(messages.map(m => [m._id, m])));

  /**
   * Tasarım denetimi: ardışık mesaj gruplama.
   *
   * Önce aynı kişinin peş peşe attığı her mesaj tam başlık (avatar + ad +
   * saat) ile çiziliyordu; üç mesajlık bir cevap 3×49px yer kaplıyor ve
   * sohbet "kart listesi" gibi görünüyordu. Modern sohbet uygulamalarında
   * takip mesajları başlıksız çizilir — içerik öne çıkar, tarama kolaylaşır.
   *
   * Gruplama koşulu: aynı yazar + 5 dakika içinde + arada sistem mesajı yok.
   * Yanıt içeren mesaj DAİMA kendi başlığını alır (yanıt bağlamı kaybolmasın).
   */
  const GROUP_WINDOW_MS = 5 * 60 * 1000;

  // Final21 UX (U-11): henüz teslim edilmemiş (bekleyen/sıradaki/başarısız) mesajlar HER ZAMAN
  // teslim edilmişlerin ALTINDA, kendi sıralarıyla çizilir. Sıradaki bir mesaj yerel zamanını
  // taşır; ondan önce yazılıp daha sonra teslim edilen mesaj sunucu zamanı alır. Zamana göre
  // sıralı listede sıradaki mesajlar, sonradan teslim edilenlerin ÜSTÜNDE kalıyordu (ölçüldü).
  const ordered = $derived.by(() => {
    const unsent = (m: MessageData) => Boolean(m.pending || m.queued || m.failed);
    return [...messages.filter((m) => !unsent(m)), ...messages.filter(unsent)];
  });

  const grouped = $derived.by(() => ordered.map((message, index) => {
    const prev = index > 0 ? ordered[index - 1] : null;
    const compact = Boolean(
      prev &&
      message.type !== 'system' &&
      prev.type !== 'system' &&
      !message.replyTo &&
      message.userId &&
      prev.userId === message.userId &&
      Number(message.createdAt) - Number(prev.createdAt) < GROUP_WINDOW_MS,
    );
    return { message, compact };
  }));


  async function publishAnnouncement(message: MessageData): Promise<void> {
    if (publishingAnnouncementId || currentChannelType !== 'announcement' || !message?._id || !message.channelId) return;
    publishingAnnouncementId = message._id;
    try {
      const response = await apiFetch(`${getAPI()}/api/v1/channels/${encodeURIComponent(message.channelId)}/messages/${encodeURIComponent(message._id)}/crosspost`, { method: 'POST' });
      if (!response.ok) {
        toast(safeApiErrorMessage(response, t("ui_duyuru_yayinlanamadi", "Duyuru yayınlanamadı."), { report: true }), 'error');
        return;
      }
      const payload = await response.json().catch(() => null) as { ok?: unknown; crosspostedTo?: unknown } | null;
      if (payload?.ok !== true || !Number.isSafeInteger(payload.crosspostedTo) || Number(payload.crosspostedTo) < 0) {
        toast(t("ui_duyuru_yaniti_dogrulanamadi_tekrar_deneyin", "Duyuru yanıtı doğrulanamadı. Tekrar deneyin."), 'error');
        return;
      }
      const count = Number(payload.crosspostedTo);
      toast(count > 0 ? t('announcement_published_count', 'Duyuru {count} takipçi kanala yayınlandı.', { count }) : t("ui_duyuru_yayinlandi_henuz_takipci_kanal_yok", "Duyuru yayınlandı; henüz takipçi kanal yok."), 'success');
    } catch (cause) {
      toast(safeApiErrorMessage(cause, t("ui_duyuru_yayinlanamadi", "Duyuru yayınlanamadı."), { report: true }), 'error');
    } finally {
      publishingAnnouncementId = '';
    }
  }

  function scrollToBottom(): void {
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    stickToBottom = true;
    awayFromBottom = false;
  }

  function jumpToLatest(): void {
    if (!scroller) return;
    const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    scroller.scrollTo?.({ top: scroller.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
    if (typeof scroller.scrollTo !== 'function') scroller.scrollTop = scroller.scrollHeight;
    stickToBottom = true;
    awayFromBottom = false;
  }

  /**
   * Yanıt önizlemesine tıklanınca orijinal mesaja git.
   * Yalnızca yüklü mesajlar için çağrılır (MessageRenderer replySource ile karar verir).
   */
  function jumpToMessage(messageId: string): void {
    const target = scroller?.querySelector<HTMLElement>(`.msg[data-id="${CSS.escape(messageId)}"]`);
    if (!target) { pendingJumpId = messageId; return; }
    pendingJumpId = null;
    stickToBottom = false; // kullanıcıyı yukarı taşıyoruz; yeni mesaj zorla aşağı çekmesin
    const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    if (jumpTimer) window.clearTimeout(jumpTimer);
    target.classList.add('msg-jump-highlight');
    jumpTimer = window.setTimeout(() => {
      target.classList.remove('msg-jump-highlight');
      jumpTimer = null;
    }, reduceMotion ? 1 : 1600);
  }

  function scrollToUnreadBoundary(messageId: string): boolean {
    const marker = scroller?.querySelector<HTMLElement>(`[data-first-unread="${CSS.escape(messageId)}"]`);
    const target = marker ?? scroller?.querySelector<HTMLElement>(`.msg[data-id="${CSS.escape(messageId)}"]`);
    if (!target) return false;
    stickToBottom = false;
    awayFromBottom = true;
    const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    return true;
  }

  async function jumpToFirstUnread(): Promise<void> {
    const targetId = firstUnreadMessageId;
    if (!targetId || unreadJumpBusy) return;
    if (scrollToUnreadBoundary(targetId)) return;

    unreadJumpBusy = true;
    stickToBottom = false;
    try {
      // Keep the timeline continuous: page backwards from the current latest
      // window rather than replacing it with a disconnected slice. Cap one
      // click at 500 messages to avoid freezing enormous channels.
      for (let page = 0; page < 10; page += 1) {
        syncFromState();
        if (scrollToUnreadBoundary(targetId)) return;
        if (!hasMore || !BridgeRegistry.has('loadOlderMessages')) break;
        await Promise.resolve(BridgeRegistry.call('loadOlderMessages'));
        syncFromState();
      }
      if (!scrollToUnreadBoundary(targetId)) {
        BridgeRegistry.call('toast', hasMore
          ? t("ui_ilk_okunmamis_mesaj_daha_eski_500_mesaj_yuklendi_dev", "İlk okunmamış mesaj daha eski. 500 mesaj yüklendi; devam etmek için tekrar deneyin.")
          : t("ui_ilk_okunmamis_mesaj_artik_mevcut_degil", "İlk okunmamış mesaj artık mevcut değil."), 'info');
      }
    } finally {
      unreadJumpBusy = false;
    }
  }

  function onScroll(): void {
    if (!scroller) return;
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    stickToBottom = distance <= NEAR_BOTTOM_PX;
    awayFromBottom = !stickToBottom;

    // Üste yaklaşınca eski sayfayı iste (cursor akışı MessageLoader'da).
    if (scroller.scrollTop <= 40 && hasMore && !loadingOlder && !isLoading) {
      loadingOlder = true;
      const before = scroller.scrollHeight;
      // Start from a resolved promise so a synchronous owner failure is also
      // contained.  A rejected page must never become an unhandled browser
      // rejection or permanently hold the pagination lock.
      void Promise.resolve()
        .then(() => BridgeRegistry.call('loadOlderMessages'))
        .catch((error: unknown) => log.warn('Eski mesaj sayfası yüklenemedi', error))
        .finally(() => {
        // Eski mesajlar başa eklendiğinde görünür konum kaymasın.
        requestAnimationFrame(() => {
          if (scroller) scroller.scrollTop += scroller.scrollHeight - before;
          loadingOlder = false;
        });
        });
    }
  }

  async function reportMessage(message: MessageData, reason: string, detail: string): Promise<boolean> {
    try {
      const response = await apiFetch(`${getAPI()}/api/messages/${encodeURIComponent(message._id)}/report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, detail }),
      });
      if (!response.ok) {
        BridgeRegistry.call('toast', response.status === 400 ? t("ui_bu_mesaj_raporlanamiyor", "Bu mesaj raporlanamıyor.") : t("ui_rapor_gonderilemedi_tekrar_deneyin", "Rapor gönderilemedi. Tekrar deneyin."), 'error');
        return false;
      }
      const data = await response.json().catch(() => null) as { reported?: unknown; created?: unknown; id?: unknown } | null;
      if (data?.reported !== true || typeof data.created !== 'boolean' || typeof data.id !== 'string' || !data.id) {
        BridgeRegistry.call('toast', t("ui_rapor_yaniti_dogrulanamadi_tekrar_deneyin", "Rapor yanıtı doğrulanamadı. Tekrar deneyin."), 'error');
        return false;
      }
      BridgeRegistry.call('toast', data.created === false ? t("ui_bu_mesaj_icin_acik_bir_raporun_zaten_var", "Bu mesaj için açık bir raporun zaten var.") : t("ui_rapor_moderatorlere_gonderildi", "Rapor moderatörlere gönderildi."), 'success');
      return true;
    } catch {
      BridgeRegistry.call('toast', t("ui_rapor_gonderilemedi_baglantini_kontrol_edip_tekrar_d", "Rapor gönderilemedi. Bağlantını kontrol edip tekrar dene."), 'error');
      return false;
    }
  }

  function onMessagesUpdated(): void {
    syncFromState();
    if (pendingJumpId) queueMicrotask(() => { if (pendingJumpId) jumpToMessage(pendingJumpId); });
  }
  function onChannelSelected(): void {
    stickToBottom = true;
    lastAutoUnreadJumpId = null;
    unreadJumpBusy = false;
    syncFromState();
  }

  onMount(() => {
    scroller = document.getElementById('messages-area');
    scroller?.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('bridge:messages-updated', onMessagesUpdated);
    document.addEventListener('bridge:members-updated', syncAlone);
    document.addEventListener('bridge:channel-selected', onChannelSelected);
    BridgeRegistry.register('jumpToMessage', jumpToMessage);
    syncFromState();
    log.info('Mesaj listesi hazır');
  });

  // ══════════════════════════════════════════════════════════════════════
  // DOLASAN TABINDEX — KLAVYE ERISIMI (WCAG 2.1.1)
  // ══════════════════════════════════════════════════════════════════════
  // Kusur: mesaj eylem cubugu temel durumda `visibility: hidden` oldugu icin
  // icindeki dugmeler ODAKLANAMIYORDU; `.msg` de odaklanabilir degildi.
  // Bu yuzden `.msg:focus-within` kurali duz metin mesajlarinda HIC
  // ateslenemiyor, eylemler YALNIZCA FAREYLE erisilebiliyordu.
  //
  // Her dugmeyi odaklanabilir yapmak yanlis cozumdu: 50 mesaj ≈ 300 tab
  // duragi. Kanonik ARIA deseni uygulanir — gunlugun TAMAMI TEK bir tab
  // duragidir, mesajlar arasinda ok tuslariyla gezilir.
  let activeId = $state<string | null>(null);

  /** Odaklanabilir mesaj: kullanicinin sectigi, yoksa SON mesaj. */
  const rovingId = $derived(
    activeId && grouped.some(g => String(g.message._id) === activeId)
      ? activeId
      : (grouped.length ? String(grouped[grouped.length - 1].message._id) : null),
  );

  function focusMessageAt(index: number): void {
    const clamped = Math.max(0, Math.min(index, grouped.length - 1));
    const target = grouped[clamped];
    if (!target) return;
    activeId = String(target.message._id);
    // Svelte durumu isledikten SONRA odagi tasi.
    queueMicrotask(() => {
      const el = document.querySelector<HTMLElement>(`.msg[data-id="${CSS.escape(activeId!)}"]`);
      el?.focus();
      el?.scrollIntoView({ block: 'nearest' });
    });
  }

  function onListKeydown(e: KeyboardEvent): void {
    // Yalnizca mesaj gunlugunde gezinirken; yazma alani veya bir dugme
    // odaktayken ok tuslari o ogenin kendi isidir.
    const active = document.activeElement as HTMLElement | null;
    if (!active?.classList.contains('msg')) return;

    const current = grouped.findIndex(g => String(g.message._id) === activeId);
    const at = current >= 0 ? current : grouped.length - 1;

    switch (e.key) {
      case 'ArrowUp':   e.preventDefault(); focusMessageAt(at - 1); break;
      case 'ArrowDown': e.preventDefault(); focusMessageAt(at + 1); break;
      case 'Home':      e.preventDefault(); focusMessageAt(0); break;
      case 'End':       e.preventDefault(); focusMessageAt(grouped.length - 1); break;
      default: break;
    }
  }

  onDestroy(() => {
    scroller?.removeEventListener('scroll', onScroll);
    // Relinquish the DOM owner before any pending page promise/RAF settles.
    // Otherwise an unmounted panel can still move a recycled shell scroller.
    scroller = null;
    document.removeEventListener('bridge:messages-updated', onMessagesUpdated);
    document.removeEventListener('bridge:members-updated', syncAlone);
    document.removeEventListener('bridge:channel-selected', onChannelSelected);
    BridgeRegistry.unregister('jumpToMessage');
    if (jumpTimer) window.clearTimeout(jumpTimer);
  });
</script>

{#if hasChannel && firstUnreadMessageId && !messages.some(m => m._id === firstUnreadMessageId)}
  <button class="jump-first-unread" type="button" onclick={jumpToFirstUnread} disabled={unreadJumpBusy}
    aria-label={t("unread_jump_first")}>
    {unreadJumpBusy ? t("surface_eski_mesajlar_yukleniyor_ca0b31") : t("surface_ilk_okunmam_sa_git_677750")}
  </button>
{/if}

{#if hasChannel && awayFromBottom && messages.length > 0}
  <button class="jump-latest" type="button" onclick={jumpToLatest} aria-label={t('markup_en_yeni_mesaja_git_fbddaa7', "En yeni mesaja git")}>
    <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m5 7 5 5 5-5M10 3v9M4 16h12"/></svg>
    {t('markup_en_yeni_mesaja_git_fbddaa7', "En yeni mesaja git")}
  </button>
{/if}

<!--
  DOLASAN TABINDEX — OLAY DELEGASYONU KASITLIDIR

  Svelte derleyicisi burada `a11y_no_noninteractive_element_interactions`
  uyarisi verir: `role="log"` etkilesimli bir rol degildir ama uzerinde
  `onkeydown` vardir. Bu, ARIA bilesik-widget (composite widget) kalibinin
  DOGRU uygulamasidir ve linter bunu ayirt edemez:

    · Odaklanabilir ogeler mesajlarin KENDISIDIR (`.msg`, dolasan tabindex:
      biri `tabindex="0"`, digerleri `tabindex="-1"`).
    · Ok tuslari gunlukte gezinir; dinleyici TEK bir yerde (kapsayicida)
      durur — her mesaja ayri dinleyici baglamak yerine delegasyon kullanilir.
    · `role="log"` sohbet dokumu icin dogru roldur ve DEGISTIRILMEZ.

  Davranis varsayim degil, OLCUMDUR: `e2e/tests/keyboard-journeys.spec.ts`
  ok tuslarini, tek-tab-duragini ve odak korunmasini gercek tarayicida surer.
-->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="msg-list"
  class:msg-list-busy={isLoading}
  role="log"
  aria-label={t('mlp_channel_msgs', 'Kanal mesajları')}
  aria-live="off"
  aria-busy={isLoading}
  onkeydown={onListKeydown}
>
  {#if hasChannel}
    {#if isOffline && messages.length > 0}
      <div class="msg-note" role="status" data-message-cache-state="offline">
        {t('ui_offline_waiting')}
      </div>
    {/if}
    {#if hasMore && messages.length > 0}
      <div class="msg-note">{t('mlp_scroll_up', 'Daha eski mesajlar için yukarı kaydır')}</div>
    {/if}

    {#each grouped as { message, compact } (message._key ?? message._id)}
      {#if firstUnreadMessageId === message._id}
        <div class="first-unread-divider" role="separator" aria-label={t("unread_first")} data-first-unread={message._id}>
          <span>{t('markup_yeni_mesajlar_552eaca', "Yeni mesajlar")}</span>
        </div>
      {/if}
      <MessageRenderer
        {message}
        {compact}
        {currentUserId}
        tabIndex={String(message._id) === rovingId ? 0 : -1}
        onFocusMessage={(id) => { activeId = id; }}
        replySource={message.replyTo?._id ? (byId.get(message.replyTo._id) ?? null) : null}
        onJumpToReply={jumpToMessage}
        onRetry={(ackId) => BridgeRegistry.call('retrySend', ackId)}
        onDiscard={(ackId) => BridgeRegistry.call('discardSend', ackId)}
        onReply={(m) => BridgeRegistry.call('setReplyTarget', m)}
        onThread={(m) => BridgeRegistry.call('openThread', m._id, typeof m.content === 'string' ? m.content : '')}
        onEdit={(m) => BridgeRegistry.call('startEditMessage', m)}
        onDelete={(m) => BridgeRegistry.call('deleteMessage', m._id)}
        {canPin}
        onPin={(m) => {
          // Retry-safe target state: replaying an ACK-lost request cannot invert
          // the pin a second time. Legacy clients may still omit `pinned`.
          const sock = BridgeRegistry.get<{ emit(ev: string, p: unknown): void }>('socket');
          const server = BridgeRegistry.call<{ _id?: string } | null>('getCurrentServer');
          sock?.emit('message:pin', {
            messageId: m._id, channelId: m.channelId, serverId: m.serverId ?? server?._id,
            pinned: !Boolean(m.pinned),
          });
        }}
        canCrosspost={currentChannelType === 'announcement' && (message.userId === currentUserId || canPin)}
        crosspostBusy={publishingAnnouncementId === message._id}
        onCrosspost={(m) => void publishAnnouncement(m)}
        onReport={reportMessage}
        onSave={(m) => {
          const channel = BridgeRegistry.call<{ _id?: string } | null>('getCurrentChannel');
          const destinationId = m.channelId || channel?._id;
          if (destinationId) BridgeRegistry.call('saveForLater', {
            destinationType: 'channel', destinationId, messageId: m._id,
          });
        }}
        onReact={(m, emoji) => {
          // P7 A5: reaction is a durable desired-state operation. The encrypted
          // operation log is written before the single replay owner emits it;
          // no toggle semantics are used during reconnect replay.
          const raw = m.reactions && typeof m.reactions === 'object'
            ? (m.reactions as Record<string, unknown>)[emoji] : undefined;
          const users = Array.isArray(raw) ? raw.map(String) : [];
          const channel = BridgeRegistry.call<{ _id?: string } | null>('getCurrentChannel');
          const destinationId = m.channelId || channel?._id;
          if (!destinationId) return;

          void queueReactionMessageOperation({
            messageId: m._id,
            channelId: destinationId,
            emoji,
            desired: !users.includes(currentUserId ?? ''),
          }).then(({ dispatched }) => {
            if (!dispatched) toast(t('ui_offline_waiting'), 'info');
          }).catch((error: unknown) => {
            log.warn('reaction.oplog.enqueue.failed', error);
            toast(t('mutation_connection_failed', 'İşlem tamamlanamadı. Bağlantını kontrol edip tekrar dene.'), 'error');
          });
        }}
      />
    {/each}

    {#if isLoading && messages.length === 0}
      <div class="msg-state msg-state-loading" role="status">
        <span class="msg-state-spinner" aria-hidden="true"></span>
        <div><strong>{t('mlp_loading', 'Mesajlar yükleniyor')}</strong><span>{t('mlp_preparing', 'Sohbet geçmişi hazırlanıyor…')}</span></div>
      </div>
    {:else if loadError}
      <div class="msg-state msg-state-error" role="alert">
        <div><strong>{t('mlp_failed', 'Mesajlar yüklenemedi')}</strong><span>{loadError}</span></div>
        <button type="button" onclick={() => BridgeRegistry.call('loadMessages')}>{t('retry')}</button>
      </div>
    {:else if !isLoading && messages.length === 0}
      <div class="msg-state msg-state-empty">
        {#if aloneInServer}
          <div><strong>{t('mlp_start_here', 'Sohbet burada başlıyor')}</strong><span>{t('mlp_alone_hint', 'Bu sunucuda şimdilik yalnızsın. Arkadaşlarını davet et ya da ilk mesajı sen gönder.')}</span></div>
          <button type="button" class="msg-state-cta" onclick={() => BridgeRegistry.call('openInvitePanel')}>{t('inv_title', 'Arkadaşlarını davet et')}</button>
        {:else}
          <div><strong>{t('mlp_start_here', 'Sohbet burada başlıyor')}</strong><span>{t('mlp_be_first', 'Bu kanaldaki ilk mesajı sen gönder.')}</span></div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

{@render children?.()}

<style>
  .msg-list { display: flex; clear: both; flex-direction: column; gap: 0; min-height: 100%; padding: 8px 0 12px; }
  .msg-note {
    justify-content: center; padding: 8px 16px;
    font-size: var(--text-xs, 11px);
    color: var(--text-3);
    display: flex; align-items: center; gap: 8px;
  }
  .msg-state {
    width: min(420px, calc(100% - 40px)); margin: auto; padding: 28px 24px;
    display: flex; align-items: center; justify-content: center; gap: 14px;
    color: var(--text-3); text-align: center;
  }
  .msg-state > div { display: grid; gap: 4px; }
  .msg-state strong { color: var(--text-1); font-size: 14px; font-weight: 650; }
  .msg-state span { font-size: 12px; line-height: 1.45; }
  .msg-state-error { color: var(--danger); }
  .msg-state-error button {
    flex: none; min-height: 32px; padding: 5px 10px; border: 1px solid currentColor;
    border-radius: var(--r-md, 6px); background: transparent; color: inherit; cursor: pointer;
    font: inherit; font-size: 12px;
  }
  .msg-state-empty { flex-direction: column; }
  .msg-state .msg-state-cta {
    border: 0; background: var(--brand); color: var(--text-on-solid);
    min-height: 36px; padding: 8px 16px; font-size: 13px; font-weight: 650;
  }
  .msg-state .msg-state-cta:hover { background: var(--brand-hover, var(--brand)); }
  .msg-state .msg-state-cta:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  .msg-state-spinner {
    width: 18px; height: 18px; flex: none; border: 2px solid var(--bg-5);
    border-top-color: var(--brand); border-radius: 50%; animation: msg-spin .7s linear infinite;
  }
  @keyframes msg-spin { to { transform: rotate(360deg); } }
  /* :global — sınıf, MessageRenderer'ın (scoped) kök öğesine imperatif eklenir. */
  :global(.msg.msg-jump-highlight) {
    background: var(--brand-subtle);
    transition: background .3s ease;
  }
  .first-unread-divider {
    display: flex; align-items: center; gap: 10px; margin: 8px 16px 6px;
    color: var(--brand); font-size: 11px; font-weight: 700; letter-spacing: .01em;
  }
  .first-unread-divider::before, .first-unread-divider::after { content: ''; height: 1px; flex: 1; background: currentColor; opacity: .55; }
  .first-unread-divider span { flex: none; }
  .jump-first-unread {
    position: sticky; top: 10px; z-index: 5; float: right;
    min-height: 34px; margin: 0 20px -34px 0; padding: 6px 11px;
    border: 1px solid color-mix(in srgb, var(--brand) 55%, var(--bg-5)); border-radius: 999px;
    background: var(--bg-2); color: var(--brand); box-shadow: var(--shadow-sm, 0 4px 14px rgba(0,0,0,.22));
    cursor: pointer; font: inherit; font-size: 12px; font-weight: 650;
  }
  .jump-first-unread:disabled { opacity: .7; cursor: progress; }
  .jump-first-unread:hover:not(:disabled) { background: var(--brand-subtle); }
  .jump-latest {
    position: sticky; top: calc(100% - 50px); z-index: 4; float: right;
    display: inline-flex; align-items: center; gap: 7px; min-height: 34px;
    padding: 6px 11px; border: 1px solid var(--bg-5); border-radius: 999px;
    background: var(--bg-2); box-shadow: var(--shadow-sm, 0 4px 14px rgba(0,0,0,.22));
    margin: 0 20px -34px 0; color: var(--text-2); cursor: pointer; font: inherit; font-size: 12px; font-weight: 600;
  }
  .jump-latest:hover { background: var(--bg-3); color: var(--text-1); }
  .jump-latest svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
  @media (prefers-reduced-motion: reduce) { .msg-state-spinner { animation: none; border-top-color: var(--bg-5); } }
</style>
