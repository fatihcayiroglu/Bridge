<!-- client/js/core/EmbedRenderer.svelte -->
<!-- Sprint 116 — messages-embeds.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- URL embed önizleme -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('EmbedRenderer');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showEmbedRenderer', () => { isVisible = true; });
    BridgeRegistry.register('hideEmbedRenderer', () => { isVisible = false; });
    isReady = true;
    log.info('EmbedRenderer mounted');
  });
  onDestroy(() => {
    log.info('EmbedRenderer destroyed');
  });
</script>

{#if isVisible}
<div class="embed-renderer" role="region" aria-label="URL embed önizleme">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.embed-renderer {
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
