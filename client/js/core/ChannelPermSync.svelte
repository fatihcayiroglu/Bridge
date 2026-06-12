<!-- client/js/core/ChannelPermSync.svelte -->
<!-- Sprint 116 — channel-perms-sync.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Kanal izni senkronizasyon yöneticisi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ChannelPermSync');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showChannelPermSync', () => { isVisible = true; });
    BridgeRegistry.register('hideChannelPermSync', () => { isVisible = false; });
    isReady = true;
    log.info('ChannelPermSync mounted');
  });
  onDestroy(() => {
    log.info('ChannelPermSync destroyed');
  });
</script>

{#if isVisible}
<div class="channel-perm-sync" role="region" aria-label="Kanal izni senkronizasyon yöneticisi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.channel-perm-sync {
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
