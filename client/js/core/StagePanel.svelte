<!-- client/js/core/StagePanel.svelte -->
<!-- Sprint 116 — stage.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Stage kanal paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('StagePanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showStagePanel', () => { isVisible = true; });
    BridgeRegistry.register('hideStagePanel', () => { isVisible = false; });
    isReady = true;
    log.info('StagePanel mounted');
  });
  onDestroy(() => {
    log.info('StagePanel destroyed');
  });
</script>

{#if isVisible}
<div class="stage-panel" role="region" aria-label="Stage kanal paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.stage-panel {
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
