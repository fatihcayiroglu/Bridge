<!-- client/js/core/SoundboardPanel.svelte -->
<!-- Sprint 116 — soundboard-ui.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Soundboard sesi tetikleme paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('SoundboardPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showSoundboardPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideSoundboardPanel', () => { isVisible = false; });
    isReady = true;
    log.info('SoundboardPanel mounted');
  });
  onDestroy(() => {
    log.info('SoundboardPanel destroyed');
  });
</script>

{#if isVisible}
<div class="soundboard-panel" role="region" aria-label="Soundboard sesi tetikleme paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.soundboard-panel {
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
