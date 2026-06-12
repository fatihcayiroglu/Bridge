<!-- client/js/core/AiStreamingPanel.svelte -->
<!-- Sprint 116 — ai-streaming.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Streaming AI yanıt paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('AiStreamingPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showAiStreamingPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideAiStreamingPanel', () => { isVisible = false; });
    isReady = true;
    log.info('AiStreamingPanel mounted');
  });
  onDestroy(() => {
    log.info('AiStreamingPanel destroyed');
  });
</script>

{#if isVisible}
<div class="ai-streaming-panel" role="region" aria-label="Streaming AI yanıt paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.ai-streaming-panel {
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
