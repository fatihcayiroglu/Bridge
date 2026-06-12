<!-- client/js/core/AnnouncementPanel.svelte -->
<!-- Sprint 116 — announcement-ui.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Duyuru kanalı UI paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('AnnouncementPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showAnnouncementPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideAnnouncementPanel', () => { isVisible = false; });
    isReady = true;
    log.info('AnnouncementPanel mounted');
  });
  onDestroy(() => {
    log.info('AnnouncementPanel destroyed');
  });
</script>

{#if isVisible}
<div class="announcement-panel" role="region" aria-label="Duyuru kanalı UI paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.announcement-panel {
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
