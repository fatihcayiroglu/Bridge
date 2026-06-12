<!-- client/js/core/MessageListPanel.svelte -->
<!-- Sprint 116 — messages.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Ana mesaj liste paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('MessageListPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showMessageListPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideMessageListPanel', () => { isVisible = false; });
    isReady = true;
    log.info('MessageListPanel mounted');
  });
  onDestroy(() => {
    log.info('MessageListPanel destroyed');
  });
</script>

{#if isVisible}
<div class="message-list-panel" role="region" aria-label="Ana mesaj liste paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.message-list-panel {
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
