<!-- client/js/core/DiscordImportPanel.svelte -->
<!-- Sprint 116 — discord-import.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Discord veri içe aktarma sihirbazı -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('DiscordImportPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showDiscordImportPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideDiscordImportPanel', () => { isVisible = false; });
    isReady = true;
    log.info('DiscordImportPanel mounted');
  });
  onDestroy(() => {
    log.info('DiscordImportPanel destroyed');
  });
</script>

{#if isVisible}
<div class="discord-import-panel" role="region" aria-label="Discord veri içe aktarma sihirbazı">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.discord-import-panel {
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
