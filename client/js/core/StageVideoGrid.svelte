<!-- client/js/core/StageVideoGrid.svelte -->
<!-- Sprint 116 — stage-video-grid.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Stage kanal video grid layout -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('StageVideoGrid');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showStageVideoGrid', () => { isVisible = true; });
    BridgeRegistry.register('hideStageVideoGrid', () => { isVisible = false; });
    isReady = true;
    log.info('StageVideoGrid mounted');
  });
  onDestroy(() => {
    log.info('StageVideoGrid destroyed');
  });
</script>

{#if isVisible}
<div class="stage-video-grid" role="region" aria-label="Stage kanal video grid layout">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.stage-video-grid {
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
