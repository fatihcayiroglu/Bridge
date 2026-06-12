<!-- client/js/core/ChannelListManager.svelte -->
<!-- Sprint 116 — channel-list.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Kanal listesi ve kategori ağacı -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ChannelListManager');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showChannelListManager', () => { isVisible = true; });
    BridgeRegistry.register('hideChannelListManager', () => { isVisible = false; });
    isReady = true;
    log.info('ChannelListManager mounted');
  });
  onDestroy(() => {
    log.info('ChannelListManager destroyed');
  });
</script>

{#if isVisible}
<div class="channel-list-manager" role="region" aria-label="Kanal listesi ve kategori ağacı">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.channel-list-manager {
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
