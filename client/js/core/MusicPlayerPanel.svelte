<!-- client/js/core/MusicPlayerPanel.svelte -->
<!-- Sprint 116 — music-player.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Sunucu müzik çalar paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('MusicPlayerPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showMusicPlayerPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideMusicPlayerPanel', () => { isVisible = false; });
    isReady = true;
    log.info('MusicPlayerPanel mounted');
  });
  onDestroy(() => {
    log.info('MusicPlayerPanel destroyed');
  });
</script>

{#if isVisible}
<div class="music-player-panel" role="region" aria-label="Sunucu müzik çalar paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.music-player-panel {
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
