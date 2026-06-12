<!-- client/js/core/ClipsPanel.svelte -->
<!-- Sprint 116 — clips.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Video klip kayıt ve paylaşım paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ClipsPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showClipsPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideClipsPanel', () => { isVisible = false; });
    isReady = true;
    log.info('ClipsPanel mounted');
  });
  onDestroy(() => {
    log.info('ClipsPanel destroyed');
  });
</script>

{#if isVisible}
<div class="clips-panel" role="region" aria-label="Video klip kayıt ve paylaşım paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.clips-panel {
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
