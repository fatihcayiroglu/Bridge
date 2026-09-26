<script lang="ts">
  // client/js/core/PinnedMessagesPanel.svelte
  // Kanal başlığındaki 📌 düğmesine bağlı sabitlenmiş-mesaj görüntüleyici.
  //
  // Arka uç sözleşmesi (doğrulandı):
  //   GET  /api/channels/:cid/pinned        → sabitli mesaj dizisi (perm: VIEW)
  //   soket message:pin (toggle)            → MANAGE_MESSAGES; message:pinned yayını
  // Bu bileşen İKİNCİ bir sabitleme servisi kurmaz; kanonik yolları kullanır.
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.ts';
  import { closeExclusivePeers } from './exclusive-surface.ts';
  import { getAPI, safeServerUrl } from './globals.ts';
  import { createLogger } from './logger.ts';
  import { canManageMessages } from './permissions/myPermissions.ts';
  import { t } from './i18n/reactive.svelte.ts';
  import { messageText } from './messages/message-format.ts';
  import { focusTrap } from './a11y/focusTrap.ts';

  const log = createLogger('PinnedMessages');

  interface PinnedMsg {
    _id: string; userId?: string; displayName?: string; avatarColor?: string;
    // `createdAt` sunucudan sayısal STRING gelebilir (Postgres bigint); Number()
    // ile normalize edilir — MessageRenderer ile aynı sözleşme.
    avatarUrl?: string | null; content?: string; createdAt?: number | string;
  }

  let isVisible   = $state(false);
  let isLoading   = $state(false);
  let error       = $state<string | null>(null);
  let pins        = $state<PinnedMsg[]>([]);
  let canManage   = $state(false);
  let channelId   = $state<string | null>(null);
  let channelName = $state('');
  let dialogEl: HTMLElement | undefined = $state();
  let returnFocusEl: HTMLElement | null = null;

  function apiFetch(url: string): Promise<Response> | null {
    const fn = BridgeRegistry.get<(u: string) => Promise<Response>>('apiFetch');
    return fn ? fn(url) : null;
  }
  function cssColor(c?: string): string {
    if (!c) return 'var(--brand, #2d9cdb)';
    return (BridgeRegistry.get('cssColor') as ((c: string) => string | undefined) | undefined)?.(c) ?? c;
  }
  function initials(name?: string): string {
    const n = (name ?? '?').trim() || '?';
    return (BridgeRegistry.get('initials') as ((n: string) => string | undefined) | undefined)?.(n)
      ?? [...n].slice(0, 2).join('').toUpperCase();
  }
  function fmtTime(ts?: number | string): string {
    if (ts === undefined || ts === null || ts === '') return '';
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) return '';
    return `${d.toLocaleDateString([], { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  async function load(): Promise<void> {
    const ch = BridgeRegistry.call<{ _id?: string; name?: string } | null>('getCurrentChannel');
    channelId   = typeof ch?._id === 'string' ? ch._id : null;
    channelName = typeof ch?.name === 'string' ? ch.name : '';
    if (!channelId) { pins = []; error = null; isLoading = false; return; }

    const server = BridgeRegistry.call<{ _id?: string } | null>('getCurrentServer');
    if (server?._id) void canManageMessages(server._id).then(v => { canManage = v; });

    isLoading = true; error = null;
    const req = apiFetch(`${getAPI()}/api/channels/${encodeURIComponent(channelId)}/pinned`);
    if (!req) { error = t('pin_load_error', 'Sabitlenenler yüklenemedi.'); isLoading = false; return; }
    try {
      const res = await req;
      if (!res.ok) throw Object.assign(new Error('http'), { status: res.status });
      const data = await res.json() as unknown;
      const rows = Array.isArray(data) ? data : ((data as { items?: unknown[] })?.items ?? []);
      // En yeni sabitlenen üstte (createdAt azalan) — okunabilir sıra.
      pins = (rows as PinnedMsg[]).slice().sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
    } catch (e) {
      log.warn('Sabitlenenler yüklenemedi', e);
      error = t('pin_load_error', 'Sabitlenenler yüklenemedi.');
      pins = [];
    } finally {
      isLoading = false;
    }
  }

  function open(): void {
    closeExclusivePeers('pins');
    returnFocusEl = (document.activeElement as HTMLElement | null) ?? null;
    isVisible = true;
    void load();
    queueMicrotask(() => dialogEl?.focus());
  }
  function close(restoreFocus: boolean | Event = true): void {
    if (!isVisible) return;
    const shouldRestoreFocus = typeof restoreFocus === 'boolean' ? restoreFocus : true;
    isVisible = false;
    pins = []; error = null;
    const target = returnFocusEl;
    returnFocusEl = null;
    // Odak iadesi ERTELENİR. Senkron `focus()` çağrısı, odak tuzağı HÂLÂ etkin
    // olduğu için tuzağın koruyucusu tarafından geri alınır; hemen ardından
    // diyalog DOM'dan kalkınca odak `<body>`ye düşerdi. Yani kapatma sonrası
    // klavye kullanıcısı yerini kaybediyordu. Diğer yüzeylerle (Polls,
    // ServerEvents) aynı kalıp kullanılır.
    if (shouldRestoreFocus && target?.isConnected) {
      queueMicrotask(() => { if (target.isConnected) target.focus(); });
    }
  }

  function jump(id: string): void {
    close();
    BridgeRegistry.call('jumpToMessage', id);
  }
  function unpin(id: string): void {
    const sock = BridgeRegistry.get<{ emit(ev: string, p: unknown): void }>('socket');
    const server = BridgeRegistry.call<{ _id?: string } | null>('getCurrentServer');
    // No optimistic removal: only the authoritative `message:pinned` event
    // refreshes the panel. This avoids a false-success row disappearing when
    // the server rejects or the socket drops the mutation.
    sock?.emit('message:pin', { messageId: id, channelId, serverId: server?._id, pinned: false });
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }
  // Gerçek zamanlı: başka bir istemci sabitleyince/kaldırınca açık panel tazelenir.
  function onPinChanged(): void { if (isVisible) void load(); }

  onMount(() => {
    BridgeRegistry.register('openPinnedMessages', open);
    BridgeRegistry.register('closePinnedMessages', close);
    document.addEventListener('bridge:pin-changed', onPinChanged);
    log.info('Sabitlenmiş mesajlar hazır');
  });
  onDestroy(() => {
    BridgeRegistry.unregister('openPinnedMessages');
    BridgeRegistry.unregister('closePinnedMessages');
    document.removeEventListener('bridge:pin-changed', onPinChanged);
  });
</script>

{#if isVisible}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="pin-overlay" role="presentation" onclick={close}></div>
  <div
    class="pin-panel"
    role="dialog"
    aria-modal="true"
    aria-label={t('pinned_title', 'Sabitlenmiş Mesajlar')}
    tabindex="-1"
    bind:this={dialogEl}
    use:focusTrap={{ active: isVisible, initialFocus: '.pin-close', returnFocus: false }}
    onkeydown={onKeydown}
  >
    <header class="pin-head">
      <div class="pin-head-copy">
        <span class="pin-eyebrow">{t('pinned_title', 'Sabitlenmiş Mesajlar')}</span>
        {#if channelName}<strong class="pin-chan">#{channelName}</strong>{/if}
      </div>
      <button type="button" class="pin-close" onclick={close} aria-label={t('close', 'Kapat')}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
    </header>

    <div class="pin-body">
      {#if isLoading}
        <div class="pin-state" aria-live="polite">
          <span class="pin-spinner" aria-hidden="true"></span>
          <p>{t('loading', 'Yükleniyor…')}</p>
        </div>
      {:else if error}
        <div class="pin-state" role="alert">
          <p class="pin-state-title">{error}</p>
          <button type="button" class="pin-retry" onclick={() => void load()}>{t('retry', 'Yeniden dene')}</button>
        </div>
      {:else if pins.length === 0}
        <div class="pin-state">
          <span class="pin-empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m14 4 6 6-3 1-4 4-1 4-2-2-3 3-1-1 3-3-2-2 4-1 4-4z"/></svg>
          </span>
          <p class="pin-state-title">{t('pinned_empty', 'Henüz sabitlenmiş mesaj yok')}</p>
          <p class="pin-state-hint">{t('pinned_empty_hint', 'Bir mesajın işlem menüsünden Sabitle’yi seçerek buraya ekleyebilirsin.')}</p>
        </div>
      {:else}
        <ul class="pin-list">
          {#each pins as p (p._id)}
            <li class="pin-item">
              <span class="pin-avatar" style="background:{cssColor(p.avatarColor)};color:#fff" aria-hidden="true">
                {#if p.avatarUrl}<img src={safeServerUrl(p.avatarUrl)} alt="" />{:else}{initials(p.displayName)}{/if}
              </span>
              <div class="pin-item-main">
                <div class="pin-item-head">
                  <span class="pin-author">{p.displayName || t('unknown_user', 'Bilinmeyen')}</span>
                  <span class="pin-time">{fmtTime(p.createdAt)}</span>
                </div>
                <p class="pin-content">{messageText(p)}</p>
                <div class="pin-item-actions">
                  <button type="button" class="pin-jump" onclick={() => jump(p._id)}>{t('pin_jump', 'Mesaja git')}</button>
                  {#if canManage}
                    <button type="button" class="pin-unpin" onclick={() => unpin(p._id)}>{t('unpin', 'Sabitlemeyi Kaldır')}</button>
                  {/if}
                </div>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
{/if}

<style>
  .pin-overlay {
    position: fixed; inset: 0; z-index: var(--z-modal);
    background: color-mix(in srgb, var(--bg-0, #1e1f22) 62%, transparent);
  }
  .pin-panel {
    position: fixed; z-index: var(--z-modal); top: 64px; right: 24px;
    width: min(420px, calc(100vw - 32px));
    max-height: min(640px, calc(var(--bridge-visual-viewport-height, 100dvh) - 96px));
    display: flex; flex-direction: column;
    background: var(--bg-1, #2b2d31); color: var(--text-1, #f2f3f5);
    border: 1px solid var(--border); border-radius: 14px;
    box-shadow: 0 12px 40px -12px rgba(0,0,0,.5); overflow: hidden;
  }
  .pin-head {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 14px 16px; border-bottom: 1px solid var(--border);
  }
  .pin-head-copy { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .pin-eyebrow { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--text-3, #949ba4); }
  .pin-chan { font-size: 15px; font-weight: 650; color: var(--text-1, #f2f3f5); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pin-close {
    flex: none; width: 30px; height: 30px; display: grid; place-items: center;
    border: 0; border-radius: 8px; background: transparent; color: var(--text-3, #949ba4); cursor: pointer;
  }
  .pin-close:hover { background: var(--bg-3, #3f4147); color: var(--text-1, #f2f3f5); }
  .pin-close svg { width: 18px; height: 18px; }

  .pin-body { overflow-y: auto; padding: 6px; }

  .pin-state { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; padding: 40px 24px; color: var(--text-2, #b5bac1); }
  .pin-state-title { margin: 0; font-weight: 600; color: var(--text-1, #f2f3f5); }
  .pin-state-hint { margin: 0; font-size: 13px; color: var(--text-3, #949ba4); max-width: 34ch; }
  .pin-empty-icon { color: var(--text-3, #949ba4); }
  .pin-empty-icon svg { width: 34px; height: 34px; }
  .pin-retry, .pin-jump, .pin-unpin {
    border: 1px solid var(--border); background: var(--bg-3, #3f4147);
    color: var(--text-1, #f2f3f5); border-radius: 7px; padding: 5px 12px; font-size: 13px;
    font-weight: 600; cursor: pointer;
  }
  .pin-retry:hover, .pin-jump:hover { background: var(--brand, #2d9cdb); border-color: transparent; color: var(--text-on-solid); }
  .pin-spinner {
    width: 22px; height: 22px; border-radius: 50%;
    border: 2px solid var(--border); border-top-color: var(--brand, #2d9cdb);
    animation: pin-spin .7s linear infinite;
  }
  @keyframes pin-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .pin-spinner { animation: none; } }

  .pin-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .pin-item {
    display: grid; grid-template-columns: 36px 1fr; gap: 10px;
    padding: 10px; border-radius: 10px;
  }
  .pin-item:hover { background: var(--bg-2, #313338); }
  .pin-item + .pin-item { border-top: 1px solid var(--border-faint, var(--border)); }
  .pin-avatar {
    /* Ön plan (sabit beyaz) ÜRETİLEN kimlik arka planıyla BİRLİKTE satır-içinde
       verilir (server-rail ile aynı desen): arka plan temadan bağımsız bir
       kullanıcı rengidir, bu yüzden tema-dönen `--text-on-solid` UYGUN DEĞİLDİR. */
    width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center;
    font-size: 13px; font-weight: 700; overflow: hidden;
  }
  .pin-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .pin-item-main { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .pin-item-head { display: flex; align-items: baseline; gap: 8px; }
  .pin-author { font-weight: 650; font-size: 14px; color: var(--text-1, #f2f3f5); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pin-time { font-size: 11px; color: var(--text-3, #949ba4); flex: none; }
  .pin-content {
    margin: 0; font-size: 14px; line-height: 1.4; color: var(--text-2, #dbdee1);
    overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4;
    -webkit-box-orient: vertical; overflow: hidden;
  }
  .pin-item-actions { display: flex; gap: 8px; margin-top: 4px; }
  .pin-jump, .pin-unpin { padding: 3px 10px; font-size: 12px; }

  @media (max-width: 560px) {
    .pin-overlay { background: color-mix(in srgb, var(--bg-0, #1e1f22) 72%, transparent); backdrop-filter: blur(5px); }
    .pin-panel {
      top: auto; right: 0; bottom: 0; left: 0;
      width: 100%;
      max-height: min(82dvh, var(--bridge-visual-viewport-height, 82dvh));
      border-right: 0; border-bottom: 0; border-left: 0;
      border-radius: var(--radius-modal) var(--radius-modal) 0 0;
      box-shadow: var(--shadow-xl);
    }
    .pin-head { padding: 14px 16px 12px; }
    .pin-close { width: 40px; height: 40px; }
    .pin-body { padding-bottom: calc(8px + env(safe-area-inset-bottom)); overscroll-behavior: contain; }
    .pin-item-actions { flex-wrap: wrap; }
    .pin-jump, .pin-unpin { min-height: 36px; }
  }
</style>
