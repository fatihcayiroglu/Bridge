<!-- client/js/core/ChannelStagePanel.svelte -->
<!-- Sprint 116 — channel-stage.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Stage kanal kontrol paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ChannelStagePanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showChannelStagePanel', () => { isVisible = true; });
    BridgeRegistry.register('hideChannelStagePanel', () => { isVisible = false; });
    isReady = true;
    log.info('ChannelStagePanel mounted');
  });
  onDestroy(() => {
    log.info('ChannelStagePanel destroyed');
  });
</script>

{#if isVisible}
<div class="channel-stage-panel" role="region" aria-label="Stage kanal kontrol paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.channel-stage-panel {
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
