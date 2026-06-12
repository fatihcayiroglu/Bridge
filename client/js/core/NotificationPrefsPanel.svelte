<!-- client/js/core/NotificationPrefsPanel.svelte -->
<!-- Sprint 116 — notification-prefs.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Bildirim tercih yöneticisi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('NotificationPrefsPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showNotificationPrefsPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideNotificationPrefsPanel', () => { isVisible = false; });
    isReady = true;
    log.info('NotificationPrefsPanel mounted');
  });
  onDestroy(() => {
    log.info('NotificationPrefsPanel destroyed');
  });
</script>

{#if isVisible}
<div class="notification-prefs-panel" role="region" aria-label="Bildirim tercih yöneticisi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.notification-prefs-panel {
  display: flex;
  flex-direction: column;
  background: var(--bridge-surface, #1e2124);
  color: var(--bridge-text, #fff);
  border-radius: 8px;
}
.bridge-error {
  padding: 12px;
  color: var(--bridge-danger, #f04747);
  font-size: .875rem;
  text-align: center;
}
</style>
