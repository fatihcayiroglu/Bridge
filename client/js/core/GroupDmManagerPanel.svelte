<!-- client/js/core/GroupDmManagerPanel.svelte -->
<!-- Sprint 116 — group-dm.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Grup DM yönetim paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('GroupDmManagerPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showGroupDmManagerPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideGroupDmManagerPanel', () => { isVisible = false; });
    isReady = true;
    log.info('GroupDmManagerPanel mounted');
  });
  onDestroy(() => {
    log.info('GroupDmManagerPanel destroyed');
  });
</script>

{#if isVisible}
<div class="group-dm-manager-panel" role="region" aria-label="Grup DM yönetim paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.group-dm-manager-panel {
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
