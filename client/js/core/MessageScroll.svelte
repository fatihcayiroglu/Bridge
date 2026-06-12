<!-- client/js/core/MessageScroll.svelte -->
<!-- Sprint 116 — messages-scroll.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Mesaj listesi scroll yönetimi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('MessageScroll');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showMessageScroll', () => { isVisible = true; });
    BridgeRegistry.register('hideMessageScroll', () => { isVisible = false; });
    isReady = true;
    log.info('MessageScroll mounted');
  });
  onDestroy(() => {
    log.info('MessageScroll destroyed');
  });
</script>

{#if isVisible}
<div class="message-scroll" role="region" aria-label="Mesaj listesi scroll yönetimi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.message-scroll {
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
