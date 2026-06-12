<!-- client/js/core/IpBanPanel.svelte -->
<!-- Sprint 116 — ip-ban.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- IP ban yönetim paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('IpBanPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showIpBanPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideIpBanPanel', () => { isVisible = false; });
    isReady = true;
    log.info('IpBanPanel mounted');
  });
  onDestroy(() => {
    log.info('IpBanPanel destroyed');
  });
</script>

{#if isVisible}
<div class="ip-ban-panel" role="region" aria-label="IP ban yönetim paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.ip-ban-panel {
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
