<!-- client/js/core/ThreadArchivePanel.svelte -->
<!-- Sprint 116 — thread-archive.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Thread arşiv ve liste paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ThreadArchivePanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showThreadArchivePanel', () => { isVisible = true; });
    BridgeRegistry.register('hideThreadArchivePanel', () => { isVisible = false; });
    isReady = true;
    log.info('ThreadArchivePanel mounted');
  });
  onDestroy(() => {
    log.info('ThreadArchivePanel destroyed');
  });
</script>

{#if isVisible}
<div class="thread-archive-panel" role="region" aria-label="Thread arşiv ve liste paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.thread-archive-panel {
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
