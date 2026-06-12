<!-- client/js/core/MessageLoader.svelte -->
<!-- Sprint 116 — messages-loader.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Mesaj yükleme, cursor tabanlı sayfalama -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('MessageLoader');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showMessageLoader', () => { isVisible = true; });
    BridgeRegistry.register('hideMessageLoader', () => { isVisible = false; });
    isReady = true;
    log.info('MessageLoader mounted');
  });
  onDestroy(() => {
    log.info('MessageLoader destroyed');
  });
</script>

{#if isVisible}
<div class="message-loader" role="region" aria-label="Mesaj yükleme, cursor tabanlı sayfalama">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.message-loader {
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
