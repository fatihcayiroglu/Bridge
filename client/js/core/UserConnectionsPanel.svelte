<!-- client/js/core/UserConnectionsPanel.svelte -->
<!-- Sprint 116 — user-connections.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Kullanıcı harici platform bağlantıları -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('UserConnectionsPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showUserConnectionsPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideUserConnectionsPanel', () => { isVisible = false; });
    isReady = true;
    log.info('UserConnectionsPanel mounted');
  });
  onDestroy(() => {
    log.info('UserConnectionsPanel destroyed');
  });
</script>

{#if isVisible}
<div class="user-connections-panel" role="region" aria-label="Kullanıcı harici platform bağlantıları">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.user-connections-panel {
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
