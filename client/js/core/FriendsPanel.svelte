<!-- client/js/core/FriendsPanel.svelte -->
<!-- Sprint 116 — friends.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Arkadaş listesi ve istek yönetimi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('FriendsPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showFriendsPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideFriendsPanel', () => { isVisible = false; });
    isReady = true;
    log.info('FriendsPanel mounted');
  });
  onDestroy(() => {
    log.info('FriendsPanel destroyed');
  });
</script>

{#if isVisible}
<div class="friends-panel" role="region" aria-label="Arkadaş listesi ve istek yönetimi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.friends-panel {
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
