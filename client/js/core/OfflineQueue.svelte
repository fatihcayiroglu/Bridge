<!-- client/js/core/OfflineQueue.svelte -->
<!-- Sprint 116 — offline-queue.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Çevrimdışı mesaj kuyruğu -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('OfflineQueue');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showOfflineQueue', () => { isVisible = true; });
    BridgeRegistry.register('hideOfflineQueue', () => { isVisible = false; });
    isReady = true;
    log.info('OfflineQueue mounted');
  });
  onDestroy(() => {
    log.info('OfflineQueue destroyed');
  });
</script>

{#if isVisible}
<div class="offline-queue" role="region" aria-label="Çevrimdışı mesaj kuyruğu">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.offline-queue {
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
