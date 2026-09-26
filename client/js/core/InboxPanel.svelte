<script lang="ts">
  import { avatarStyle } from './avatar-color.ts';
  import { t } from './i18n/reactive.svelte.ts';
  import { onMount, onDestroy } from 'svelte';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { BridgeRegistry } from './bridge-registry.ts';
  import { closeExclusivePeers } from './exclusive-surface.ts';
  import { createLogger } from './logger.ts';
  import { ApiResponseError, safeApiErrorMessage } from './api-error.ts';

  const log = createLogger('InboxPanel');
  type InboxFilter = 'all' | 'mentions' | 'watches' | 'replies' | 'dms' | 'reminders';
  type SocketLike = {
    on?: (event: string, fn: () => void) => void;
    off?: (event: string, fn: () => void) => void;
  };

  interface InboxUser {
    _id: string;
    displayName?: string;
    username?: string;
    avatarColor?: string;
  }
  interface InboxItem {
    id: string;
    kind: 'mention' | 'watch' | 'reply' | 'dm' | 'gdm' | 'reminder';
    unreadCount: number;
    createdAt: number;
    preview: string;
    sender?: InboxUser | null;
    destination: {
      type: 'channel' | 'dm' | 'gdm' | 'saved';
      messageId?: string;
      channelId?: string;
      serverId?: string;
      dmId?: string;
      groupId?: string;
      savedId?: string;
      channel?: { _id: string; name: string; type?: string };
      server?: { _id: string; name?: string; iconUrl?: string | null };
      user?: InboxUser;
      group?: { _id: string; name: string; icon?: string | null; ownerId?: string };
    };
  }
  interface InboxResponse {
    items: InboxItem[];
    counts: { all: number; mentions: number; watches: number; replies: number; dms: number; reminders: number };
    filter?: InboxFilter;
  }

  const EMPTY_COUNTS = { all: 0, mentions: 0, watches: 0, replies: 0, dms: 0, reminders: 0 };
  let visible = $state(false);
  let loading = $state(false);
  let error = $state('');
  let filter = $state<InboxFilter>('all');
  let items = $state<InboxItem[]>([]);
  let counts = $state({ ...EMPTY_COUNTS });
  let requestSeq = 0;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let returnFocus: HTMLElement | null = null;
  let boundSocket: SocketLike | null = null;

  const apiBase = (): string => (globalThis as { BRIDGE_API?: string }).BRIDGE_API || location.origin;
  const apiFetch = (url: string, options?: RequestInit): Promise<Response> => {
    const fn = BridgeRegistry.get<(u: string, o?: RequestInit) => Promise<Response>>('apiFetch');
    if (!fn) return Promise.reject(new Error(t("ui_guvenli_api_istemcisi_kullanilamiyor", "Güvenli API istemcisi kullanılamıyor.")));
    return fn(url, options);
  };
  const currentSocket = (): SocketLike | null => BridgeRegistry.get('socket');

  function displayName(user?: InboxUser | null): string {
    return user?.displayName || user?.username || 'Bridge user';
  }

  function initials(user?: InboxUser | null): string {
    return displayName(user).slice(0, 2).toUpperCase();
  }

  function normalizeCount(value: unknown): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.min(999_999, Math.floor(numeric))) : 0;
  }

  function normalizeResponse(value: unknown): InboxResponse {
    const record = value && typeof value === 'object' ? value as Partial<InboxResponse> : {};
    const seen = new Set<string>();
    const normalizedItems: InboxItem[] = [];
    if (Array.isArray(record.items)) {
      for (const candidate of record.items) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        const item = candidate as Partial<InboxItem>;
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        const destination = item.destination;
        if (!id || seen.has(id)
          || !['mention', 'watch', 'reply', 'dm', 'gdm', 'reminder'].includes(String(item.kind))
          || !destination || typeof destination !== 'object'
          || !['channel', 'dm', 'gdm', 'saved'].includes(String(destination.type))) continue;
        seen.add(id);
        normalizedItems.push({
          ...(item as InboxItem),
          id,
          unreadCount: normalizeCount(item.unreadCount),
          createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : 0,
          preview: typeof item.preview === 'string' ? item.preview.slice(0, 500) : '',
          sender: item.sender && typeof item.sender === 'object' ? item.sender : null,
          destination,
        });
      }
    }
    const rawCounts = record.counts && typeof record.counts === 'object' ? record.counts : EMPTY_COUNTS;
    return {
      items: normalizedItems,
      counts: {
        all: normalizeCount(rawCounts.all),
        mentions: normalizeCount(rawCounts.mentions),
        watches: normalizeCount(rawCounts.watches),
        replies: normalizeCount(rawCounts.replies),
        dms: normalizeCount(rawCounts.dms),
        reminders: normalizeCount(rawCounts.reminders),
      },
    };
  }

  function kindLabel(item: InboxItem): string {
    if (item.kind === 'mention') return t('inbox_kind_mention', 'Bahsetme');
    if (item.kind === 'watch') return t("ui_takip", "Takip");
    if (item.kind === 'reply') return t("ui_yanit", "Yanıt");
    if (item.kind === 'gdm') return t('markup_grup_dm_93b0607', 'Grup DM');
    if (item.kind === 'reminder') return t("ui_hatirlatici", "Hatırlatıcı");
    return 'DM';
  }

  function destinationLabel(item: InboxItem): string {
    if (item.kind === 'mention' || item.kind === 'watch' || item.kind === 'reply') {
      return `${item.destination.server?.name || 'Bridge'} · #${item.destination.channel?.name || t('ui_channel_fallback', 'kanal')}`;
    }
    if (item.kind === 'gdm') return item.destination.group?.name || 'Grup DM';
    if (item.kind === 'reminder') return 'Kaydedilenler';
    return displayName(item.destination.user || item.sender);
  }

  function relativeTime(value: number): string {
    const delta = Math.max(0, Date.now() - Number(value || 0));
    if (delta < 60_000) return t("ui_simdi", "şimdi");
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} dk`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} sa`;
    return new Date(value).toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  async function load(nextFilter: InboxFilter = filter): Promise<void> {
    const seq = ++requestSeq;
    loading = true;
    error = '';
    try {
      const response = await apiFetch(`${apiBase()}/api/inbox?filter=${encodeURIComponent(nextFilter)}`);
      const data = await response.json() as unknown;
      if (seq !== requestSeq) return;
      // Durumu TASIYAN kanonik hata: `safeApiErrorMessage` bunu duruma uygun
      // metne eslerken sunucu govdesini yine SIZDIRMAZ. Duz bir
      // `new Error('inbox-load-failed')` siniflandirilamiyor ve her HTTP
      // hatasi genel yedek metne dusuyordu.
      if (!response.ok) throw new ApiResponseError(response);
      const normalized = normalizeResponse(data);
      items = normalized.items;
      counts = normalized.counts;
    } catch (cause) {
      if (seq !== requestSeq) return;
      // Her basarisizlik TEK bir genel metne indirgeniyordu: cevrimdisi bir
      // kullaniciya da, 500 donen bir sunucuya da ayni sey yaziliyordu.
      // Uygulamanin geri kalani `safeApiErrorMessage` ile duruma uygun (ve
      // yine de govde sizdirmayan) metni gosterir.
      error = safeApiErrorMessage(cause, t('inb_failed', 'Gelen kutusu açılamadı'), { report: true });
    } finally {
      if (seq === requestSeq) loading = false;
    }
  }

  function scheduleReload(): void {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { reloadTimer = null; void load(); }, 90);
  }

  function scheduleNavigationReload(): void {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { reloadTimer = null; void load(); }, 500);
  }

  function setFilter(next: InboxFilter): void {
    if (filter === next) return;
    filter = next;
    void load(next);
  }

  function open(): void {
    closeExclusivePeers('inbox');
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    visible = true;
    void load();
  }

  function close(restoreFocus: boolean | Event = true): void {
    const shouldRestoreFocus = typeof restoreFocus === 'boolean' ? restoreFocus : true;
    visible = false;
    const target = returnFocus;
    returnFocus = null;
    if (!shouldRestoreFocus) return;
    queueMicrotask(() => target?.isConnected && target.focus());
  }

  async function markAllRead(): Promise<void> {
    const seq = ++requestSeq;
    loading = false;
    try {
      const response = await apiFetch(`${apiBase()}/api/inbox/read-all`, { method: 'PATCH' });
      if (seq !== requestSeq) return;
      if (!response.ok) {
        error = 'Okundu bilgisi kaydedilemedi.';
        return;
      }
      items = [];
      counts = { ...EMPTY_COUNTS };
      error = '';
    } catch {
      if (seq === requestSeq) error = 'Okundu bilgisi kaydedilemedi.';
    }
  }

  function openItem(item: InboxItem): void {
    close();
    if (item.destination.type === 'channel' && item.destination.channelId) {
      BridgeRegistry.call(
        'navigateToChannel',
        item.destination.channelId,
        item.destination.messageId,
        item.destination.server,
      );
    } else if (item.destination.type === 'dm' && item.destination.user?._id) {
      const user = item.destination.user;
      BridgeRegistry.call('openDm', user._id, displayName(user), user.avatarColor);
    } else if (item.destination.type === 'gdm' && item.destination.group) {
      BridgeRegistry.call('groupDmPanel:openGroupDm', item.destination.group);
    } else if (item.destination.type === 'saved') {
      void apiFetch(`${apiBase()}/api/inbox/${encodeURIComponent(item.id)}/read`, { method: 'PATCH' }).catch(() => {});
      BridgeRegistry.call('showSaved');
    } else {
      BridgeRegistry.call('toast', t("gdm_gone", "Bu konuşma artık kullanılamıyor."), 'warning');
    }
    // Destination reads are durable on their canonical GET/socket path. Re-read
    // shortly after navigation so the shell badge converges to server truth.
    scheduleNavigationReload();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (visible && event.key === 'Escape') close();
  }

  function unbindSocket(): void {
    if (!boundSocket) return;
    boundSocket.off?.('inbox:changed', scheduleReload);
    boundSocket.off?.('dm:message', scheduleReload);
    boundSocket.off?.('gdm:message', scheduleReload);
    boundSocket = null;
  }

  function bindSocket(): void {
    const socket = currentSocket();
    if (!socket) { unbindSocket(); return; }
    if (socket === boundSocket) return;
    unbindSocket();
    socket.on?.('inbox:changed', scheduleReload);
    socket.on?.('dm:message', scheduleReload);
    socket.on?.('gdm:message', scheduleReload);
    boundSocket = socket;
  }

  function onLogout(): void {
    requestSeq += 1;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = null;
    visible = false;
    items = [];
    counts = { ...EMPTY_COUNTS };
    error = '';
  }

  $effect(() => {
    const button = document.querySelector<HTMLElement>('[data-bridge-action="showInbox"]');
    if (!button) return;
    let badge = button.querySelector<HTMLElement>('.h-unread');
    if (counts.all > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'h-unread';
        badge.setAttribute('aria-hidden', 'true');
        button.appendChild(badge);
      }
      badge.textContent = counts.all > 99 ? '99+' : String(counts.all);
      button.setAttribute('aria-label', t('inbox_open_pending', 'Gelen kutusunu aç — {count} bekleyen öğe', { count: counts.all }));
    } else {
      badge?.remove();
      button.setAttribute('aria-label', t('ui_open_inbox', 'Gelen kutusunu aç'));
    }
  });

  onMount(() => {
    BridgeRegistry.register('showInbox', open);
    BridgeRegistry.register('openInbox', open);
    BridgeRegistry.register('closeInbox', close);
    BridgeRegistry.register('markAllRead', () => void markAllRead());
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('bridge:socket-ready', bindSocket);
    document.addEventListener('bridge:socket-reconnected', bindSocket);
    document.addEventListener('bridge:auth-success', scheduleReload);
    document.addEventListener('bridge:auth-logout', onLogout);
    bindSocket();
    void load();
  });

  onDestroy(() => {
    requestSeq += 1;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = null;
    unbindSocket();
    window.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('bridge:socket-ready', bindSocket);
    document.removeEventListener('bridge:socket-reconnected', bindSocket);
    document.removeEventListener('bridge:auth-success', scheduleReload);
    document.removeEventListener('bridge:auth-logout', onLogout);
    for (const key of ['showInbox', 'openInbox', 'closeInbox', 'markAllRead']) BridgeRegistry.unregister(key);
    log.info('InboxPanel destroyed');
  });
</script>

{#if visible}
  <div class="inbox-backdrop" role="presentation" onclick={close}>
    <div
      class="inbox-panel"
      role="dialog"
      aria-modal="true"
      aria-label={t('markup_inbox_44caf74', "Gelen kutusu")}
      tabindex="-1"
      use:focusTrap={{ active: visible, initialFocus: '.inbox-close' }}
      onclick={(event) => event.stopPropagation()}
      onkeydown={(event) => {
        // Final21 UX: olay burada durduruluyordu ve pencere düzeyindeki Esc işleyicisine
        // hiç ulaşmıyordu — Inbox, diğer tüm yüzeylerin aksine Esc ile KAPANMIYORDU.
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        event.stopPropagation();
      }}
    >
      <header class="inbox-header">
        <div><span class="eyebrow">{t('markup_dikkat_gerekenler_a253097')}</span><h2>{t('markup_inbox_44caf74', "Gelen kutusu")}</h2></div>
        <div class="header-actions">
          {#if counts.all > 0}<button type="button" class="mark-read" onclick={() => void markAllRead()}>{t('inb_mark_all_read', 'Tümünü okundu yap')}</button>{/if}
          <button type="button" class="inbox-close" aria-label={t('attr_inbox_u_kapat_0adab9e', "Gelen kutusunu kapat")} onclick={close}>×</button>
        </div>
      </header>

      <nav class="inbox-filters" aria-label={t('attr_inbox_filtreleri_8146452', "Gelen kutusu filtreleri")}>
        <button type="button" class:active={filter === 'all'} aria-pressed={filter === 'all'} onclick={() => setFilter('all')}>{t('inb_all', 'Tümü')} <span>{counts.all}</span></button>
        <button type="button" class:active={filter === 'mentions'} aria-pressed={filter === 'mentions'} onclick={() => setFilter('mentions')}>{t('markup_mention_5125802', "Bahsetmeler")} <span>{counts.mentions}</span></button>
        <button type="button" class:active={filter === 'watches'} aria-pressed={filter === 'watches'} onclick={() => setFilter('watches')}>{t('ui_takip')} <span>{counts.watches}</span></button>
        <button type="button" class:active={filter === 'replies'} aria-pressed={filter === 'replies'} onclick={() => setFilter('replies')}>{t('inb_replies', 'Yanıtlar')} <span>{counts.replies}</span></button>
        <button type="button" class:active={filter === 'dms'} aria-pressed={filter === 'dms'} onclick={() => setFilter('dms')}>{t('markup_dm_ler_50d56d4', "DM'ler")} <span>{counts.dms}</span></button>
        <button type="button" class:active={filter === 'reminders'} aria-pressed={filter === 'reminders'} onclick={() => setFilter('reminders')}>{t("reminders")} <span>{counts.reminders}</span></button>
      </nav>

      <section class="inbox-list" aria-live="polite" aria-busy={loading}>
        {#if error}
          <div class="inbox-state error" role="alert"><strong>{t('inb_failed', 'Gelen kutusu açılamadı')}</strong><span>{error}</span><button type="button" onclick={() => void load()}>{t('retry')}</button></div>
        {:else if loading && items.length === 0}
          <div class="inbox-state"><strong>{t('sso_loading', 'Yükleniyor…')}</strong><span>{t('inb_checking', 'Dikkat bekleyen konuşmalar kontrol ediliyor.')}</span></div>
        {:else if items.length === 0}
          <div class="inbox-state"><strong>{t('markup_hepsi_tamam_39c2a56', "Hepsi tamam")}</strong><span>{t('inb_empty', 'Bu filtrede dikkat bekleyen bir konuşma yok.')}</span></div>
        {:else}
          {#each items as item (item.id)}
            <button type="button" class="inbox-item" onclick={() => openItem(item)}>
              <span class="item-avatar" style={avatarStyle(item.sender?.avatarColor)}>{item.kind === 'reminder' ? '⏰' : initials(item.sender)}</span>
              <span class="item-body">
                <span class="item-topline"><strong>{kindLabel(item)}</strong><time>{relativeTime(item.createdAt)}</time></span>
                <span class="item-title">{destinationLabel(item)}</span>
                <span class="item-preview">{item.preview || t("notif_message")}</span>
              </span>
              {#if item.unreadCount > 1}<span class="item-count" aria-label={t('unread_count', undefined, { count: item.unreadCount })}>{item.unreadCount > 99 ? '99+' : item.unreadCount}</span>{/if}
              <svg class="item-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
            </button>
          {/each}
        {/if}
      </section>
    </div>
  </div>
{/if}

<style>
  .inbox-backdrop { position: fixed; inset: 0; height: var(--bridge-visual-viewport-height, 100dvh); z-index: var(--layer-modal); display: flex; justify-content: flex-end; background: color-mix(in srgb, var(--bg-0) 64%, transparent); backdrop-filter: blur(5px); }
  .inbox-panel { display: grid; grid-template-rows: auto auto minmax(0, 1fr); width: min(470px, 100%); height: 100%; color: var(--text-primary); background: var(--bg-2); border-left: 1px solid var(--border-strong); box-shadow: var(--shadow-xl); }
  .inbox-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 72px; padding: 14px 16px 12px 20px; background: var(--bg-3); border-bottom: 1px solid var(--border); }
  .eyebrow { display: block; color: var(--brand); font: 750 var(--text-2xs)/1 var(--font-sans); letter-spacing: .12em; }
  h2 { margin: 5px 0 0; font-size: var(--text-xl); line-height: 1; }
  .header-actions { display: flex; align-items: center; gap: 8px; }
  .mark-read, .inbox-close { color: var(--text-secondary); cursor: pointer; background: transparent; border: 0; border-radius: var(--radius-control); }
  .mark-read { padding: 7px 9px; font-size: var(--text-xs); font-weight: 650; }
  .mark-read:hover { color: var(--brand); background: var(--brand-bg); }
  .inbox-close { display: grid; width: 34px; height: 34px; font-size: 25px; place-items: center; }
  .inbox-close:hover { color: var(--text-primary); background: var(--bg-hover); }
  .inbox-filters { display: flex; gap: 4px; padding: 10px 12px; overflow-x: auto; background: var(--bg-2); border-bottom: 1px solid var(--border); }
  .inbox-filters button { display: flex; align-items: center; gap: 6px; min-height: 32px; padding: 6px 10px; color: var(--text-secondary); font: 650 var(--text-xs)/1 var(--font-sans); cursor: pointer; background: transparent; border: 1px solid transparent; border-radius: var(--radius-pill); white-space: nowrap; }
  .inbox-filters button:hover { color: var(--text-primary); background: var(--bg-hover); }
  .inbox-filters button.active { color: var(--text-primary); background: var(--brand-bg); border-color: color-mix(in srgb, var(--brand) 38%, transparent); }
  .inbox-filters span { color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .inbox-list { min-height: 0; padding: 8px; overflow-y: auto; }
  .inbox-item { display: flex; align-items: center; gap: 11px; width: 100%; min-height: 82px; padding: 11px 10px; color: var(--text-primary); text-align: left; cursor: pointer; background: transparent; border: 0; border-bottom: 1px solid var(--border); border-radius: var(--radius-control); }
  .inbox-item:hover, .inbox-item:focus-visible { background: var(--bg-hover); outline: 0; }
  .item-avatar { display: grid; flex: 0 0 36px; width: 36px; height: 36px; color: var(--text-on-solid); font-size: 11px; font-weight: 750; border-radius: 50%; place-items: center; }
  .item-body { display: grid; flex: 1; gap: 3px; min-width: 0; }
  .item-topline { display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: var(--text-2xs); }
  .item-topline strong { color: var(--brand); font-size: var(--text-2xs); letter-spacing: .04em; text-transform: uppercase; }
  .item-topline time { margin-left: auto; }
  .item-title, .item-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item-title { font-size: var(--text-sm); font-weight: 675; }
  .item-preview { color: var(--text-secondary); font-size: var(--text-xs); }
  .item-count { display: grid; min-width: 22px; height: 22px; padding: 0 6px; color: var(--text-on-solid); font-size: var(--type-badge); font-weight: 750; background: var(--brand); border-radius: var(--radius-pill); place-items: center; }
  .item-arrow { flex: 0 0 16px; width: 16px; height: 16px; fill: none; stroke: var(--text-muted); stroke-linecap: round; stroke-linejoin: round; stroke-width: 2; }
  .inbox-state { display: grid; gap: 7px; padding: 58px 24px; color: var(--text-muted); text-align: center; place-items: center; }
  .inbox-state strong { color: var(--text-primary); font-size: var(--text-base); }
  .inbox-state span { max-width: 280px; font-size: var(--text-sm); line-height: 1.5; }
  .inbox-state button { padding: 7px 11px; color: var(--text-primary); cursor: pointer; background: var(--bg-4); border: 1px solid var(--border-strong); border-radius: var(--radius-control); }
  .inbox-state.error strong { color: var(--danger); }
  @media (max-width: 600px) {
    .inbox-panel { width: 100%; height: var(--bridge-visual-viewport-height, 100dvh); }
    .inbox-header { padding: calc(12px + env(safe-area-inset-top)) 14px 10px 16px; }
    .inbox-filters { scrollbar-width: none; }
    .inbox-filters::-webkit-scrollbar { display: none; }
    .inbox-item { min-height: 76px; }
  }
  @media (prefers-reduced-motion: no-preference) { .inbox-panel { animation: inbox-in var(--duration-base) var(--ease-out); } @keyframes inbox-in { from { opacity: .7; transform: translateX(18px); } } }
</style>
