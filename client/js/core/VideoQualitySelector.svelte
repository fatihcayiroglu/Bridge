<!-- client/js/core/VideoQualitySelector.svelte -->
<!-- Sprint 116 — video-quality.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Video kalite ayar paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('VideoQualitySelector');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showVideoQualitySelector', () => { isVisible = true; });
    BridgeRegistry.register('hideVideoQualitySelector', () => { isVisible = false; });
    isReady = true;
    log.info('VideoQualitySelector mounted');
  });
  onDestroy(() => {
    log.info('VideoQualitySelector destroyed');
  });
</script>

{#if isVisible}
<div class="video-quality-selector" role="region" aria-label="Video kalite ayar paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.video-quality-selector {
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
