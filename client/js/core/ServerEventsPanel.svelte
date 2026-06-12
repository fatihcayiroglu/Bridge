<!-- client/js/core/ServerEventsPanel.svelte -->
<!-- Sprint 116 — server-events.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Sunucu etkinlik yönetimi paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ServerEventsPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showServerEventsPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideServerEventsPanel', () => { isVisible = false; });
    isReady = true;
    log.info('ServerEventsPanel mounted');
  });
  onDestroy(() => {
    log.info('ServerEventsPanel destroyed');
  });
</script>

{#if isVisible}
<div class="server-events-panel" role="region" aria-label="Sunucu etkinlik yönetimi paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.server-events-panel {
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
