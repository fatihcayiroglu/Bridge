<!-- client/js/core/VirtualScrollList.svelte -->
<!-- Sprint 116 — virtual-scroll.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Büyük liste sanal scroll bileşeni -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('VirtualScrollList');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showVirtualScrollList', () => { isVisible = true; });
    BridgeRegistry.register('hideVirtualScrollList', () => { isVisible = false; });
    isReady = true;
    log.info('VirtualScrollList mounted');
  });
  onDestroy(() => {
    log.info('VirtualScrollList destroyed');
  });
</script>

{#if isVisible}
<div class="virtual-scroll-list" role="region" aria-label="Büyük liste sanal scroll bileşeni">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.virtual-scroll-list {
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
