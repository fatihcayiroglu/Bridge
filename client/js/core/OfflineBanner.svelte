<!-- client/js/core/OfflineBanner.svelte -->
<!-- Sprint 116 — offline-banner.ts (272 satır) → Svelte 5 Runes -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  import { t } from './i18n/reactive.svelte.ts';
  const log = createLogger('OfflineBanner');

  let isOffline      = $state(false);
  let isReconnecting = $state(false);
  let pendingCount   = $state(0);
  let pendingClearTimer: ReturnType<typeof setTimeout> | null = null;

  function setOffline() {
    isOffline = true;
    isReconnecting = false;
    log.warn('Network unavailable — banner shown');
  }

  function setSocketReconnecting(): void {
    if (!navigator.onLine) { setOffline(); return; }
    isOffline = true;
    isReconnecting = true;
    log.warn('Realtime connection lost — waiting for Socket.IO reconnect');
  }

  function setOnline(pending = 0) {
    isOffline = false;
    isReconnecting = false;
    pendingCount = pending;
    if (pendingClearTimer) { clearTimeout(pendingClearTimer); pendingClearTimer = null; }
    if (pending > 0) {
      pendingClearTimer = setTimeout(() => { pendingCount = 0; pendingClearTimer = null; }, 4000);
    }
    log.info('Connection restored');
  }

  function onSWMessage(e: MessageEvent) {
    if (e.data?.type === 'SW_NETWORK_STATUS') {
      e.data.online ? setOnline(e.data.pendingCount ?? 0) : setOffline();
    }
    if (e.data?.type === 'SW_OUTBOX_FLUSHED') {
      pendingCount = 0;
    }
  }

  // BUGFIX: Store stable references for proper cleanup
  const _onOnline  = () => setOnline();
  const _onOffline = () => setOffline();
  const _onSocketDisconnected = () => setSocketReconnecting();
  const _onSocketReconnected = () => setOnline();

  onMount(() => {
    BridgeRegistry.register('setOffline', setOffline);
    BridgeRegistry.register('setOnline',  setOnline);

    window.addEventListener('online',  _onOnline);
    window.addEventListener('offline', _onOffline);
    navigator.serviceWorker?.addEventListener('message', onSWMessage);
    document.addEventListener('bridge:socket-disconnected', _onSocketDisconnected);
    document.addEventListener('bridge:socket-reconnected', _onSocketReconnected);
    document.addEventListener('bridge:socket-ready', _onSocketReconnected);

    if (!navigator.onLine) setOffline();
  });

  onDestroy(() => {
    window.removeEventListener('online',  _onOnline);
    window.removeEventListener('offline', _onOffline);
    navigator.serviceWorker?.removeEventListener('message', onSWMessage);
    document.removeEventListener('bridge:socket-disconnected', _onSocketDisconnected);
    document.removeEventListener('bridge:socket-reconnected', _onSocketReconnected);
    document.removeEventListener('bridge:socket-ready', _onSocketReconnected);
    if (BridgeRegistry.get('setOffline') === setOffline) BridgeRegistry.unregister('setOffline');
    if (BridgeRegistry.get('setOnline') === setOnline) BridgeRegistry.unregister('setOnline');
    if (pendingClearTimer) clearTimeout(pendingClearTimer);
  });
</script>

{#if isOffline || pendingCount > 0}
<div
  class="offline-banner {isOffline ? 'offline' : 'syncing'}"
  role="status"
  aria-live="assertive"
  aria-atomic="true"
>
  {#if isOffline}
    <span class="ob-icon" aria-hidden="true">📡</span>
    <span class="ob-text">
      {#if isReconnecting}
        {t("ui_realtime_reconnecting")}
      {:else}
        {t("ui_offline_waiting")}
      {/if}
    </span>
    {#if isReconnecting}
      <span class="ob-spinner" aria-hidden="true"></span>
    {/if}
  {:else if pendingCount > 0}
    <span class="ob-icon" aria-hidden="true">☁️</span>
    <span class="ob-text">{t("ui_pending_messages_sent", undefined, { count: pendingCount })}</span>
  {/if}
</div>
{/if}

<style>
.offline-banner {
  position: fixed; top: 0; left: 0; right: 0;
  display: flex; align-items: center; justify-content: center;
  gap: 8px; padding: 8px 16px;
  font-size: .875rem; font-weight: 500;
  /* Baglanti seridi bir bildirim yuzeyidir: kabugun ustunde, ama cokme ortusunun altinda. */
    z-index: var(--z-toast);
  animation: slideDown .25s ease;
}
.offline-banner.offline  { background: var(--bridge-danger, #e05260); color: var(--text-on-solid); }
.offline-banner.syncing  { background: var(--bridge-green, #2ecc9a); color: var(--text-on-solid); }
.ob-icon { font-size: 1rem; }
@keyframes slideDown { from { transform: translateY(-100%); } to { transform: translateY(0); } }
.ob-spinner {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--text-on-solid) 40%, transparent);
  border-top-color: var(--text-on-solid);
  animation: spin .6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
