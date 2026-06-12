<!-- client/js/core/OfflineBanner.svelte -->
<!-- Sprint 116 — offline-banner.ts (272 satır) → Svelte 5 Runes -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('OfflineBanner');

  let isOffline      = $state(false);
  let isReconnecting = $state(false);
  let pendingCount   = $state(0);
  let reconnectSecs  = $state(0);

  let reconnectInterval: ReturnType<typeof setInterval> | null = null;
  let RECONNECT_DELAY = 5;

  function setOffline() {
    isOffline = true;
    isReconnecting = false;
    reconnectSecs = RECONNECT_DELAY;
    reconnectInterval = setInterval(() => {
      reconnectSecs--;
      if (reconnectSecs <= 0) {
        clearInterval(reconnectInterval!);
        isReconnecting = true;
        reconnectSecs = 0;
      }
    }, 1000);
    log.warn('Connection lost — banner shown');
  }

  function setOnline(pending = 0) {
    isOffline = false;
    isReconnecting = false;
    pendingCount = pending;
    if (reconnectInterval) { clearInterval(reconnectInterval); reconnectInterval = null; }
    if (pending > 0) {
      setTimeout(() => { pendingCount = 0; }, 4000);
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

  onMount(() => {
    BridgeRegistry.register('setOffline', setOffline);
    BridgeRegistry.register('setOnline',  setOnline);

    window.addEventListener('online',  _onOnline);
    window.addEventListener('offline', _onOffline);
    navigator.serviceWorker?.addEventListener('message', onSWMessage);

    if (!navigator.onLine) setOffline();
  });

  onDestroy(() => {
    window.removeEventListener('online',  _onOnline);
    window.removeEventListener('offline', _onOffline);
    navigator.serviceWorker?.removeEventListener('message', onSWMessage);
    if (reconnectInterval) clearInterval(reconnectInterval);
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
        Yeniden bağlanılıyor…
      {:else}
        Bağlantı kesildi. {reconnectSecs}s sonra yeniden deneniyor.
      {/if}
    </span>
    {#if isReconnecting}
      <span class="ob-spinner" aria-hidden="true"></span>
    {/if}
  {:else if pendingCount > 0}
    <span class="ob-icon" aria-hidden="true">☁️</span>
    <span class="ob-text">{pendingCount} bekleyen mesaj gönderildi.</span>
  {/if}
</div>
{/if}

<style>
.offline-banner {
  position: fixed; top: 0; left: 0; right: 0;
  display: flex; align-items: center; justify-content: center;
  gap: 8px; padding: 8px 16px;
  font-size: .875rem; font-weight: 500;
  z-index: 10000;
  animation: slideDown .25s ease;
}
.offline-banner.offline  { background: var(--bridge-danger, #f04747); color: #fff; }
.offline-banner.syncing  { background: var(--bridge-green, #43b581); color: #fff; }
.ob-icon { font-size: 1rem; }
@keyframes slideDown { from { transform: translateY(-100%); } to { transform: translateY(0); } }
.ob-spinner {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,.4);
  border-top-color: #fff;
  animation: spin .6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
