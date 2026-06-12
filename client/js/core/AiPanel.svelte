<!-- client/js/core/AiPanel.svelte -->
<!-- Sprint 116 — ai.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- AI asistan ve öneriler paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('AiPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showAiPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideAiPanel', () => { isVisible = false; });
    isReady = true;
    log.info('AiPanel mounted');
  });
  onDestroy(() => {
    log.info('AiPanel destroyed');
  });
</script>

{#if isVisible}
<div class="ai-panel" role="region" aria-label="AI asistan ve öneriler paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.ai-panel {
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
